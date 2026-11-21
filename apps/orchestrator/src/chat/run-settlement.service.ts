import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ModelErrorCode, RunSettledOutcome } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { StructuredLogger } from '../logging/structured-logger.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { MessagesService } from '../messages/messages.service.js';
import { SpokenReplyService } from '../voice/spoken-reply.service.js';
import type { TurnBot } from '../agent/turn-assembly.js';
import { readMaxContinuations } from '../agent/agent-loop.config.js';
import {
  continuationInstruction,
  turnLimitCopy,
  type TurnLimitStop,
} from '../agent/turn-limits.js';
import { stallNoticeCopy, type StallDetail } from '../agent/execution/stall-guard.js';
import { retryContinuationInstruction, retryOperatorCopy } from '../agent/turn-retry.js';
import { isRetryableModelCode } from '../models/normalize-error.js';
import type { RunLease } from '../agent/persistence/run-lease.js';
import type { ProducedTrigger, StoredTriggerStarter } from './chat-run.types.js';

/** Bounds how far back a settled run scans for stored messages it folded in. */
const FOLD_WINDOW = 25;

export type SettlementOutcome = {
  readonly status: string;
  readonly stoppedBy?: TurnLimitStop;
  readonly stall?: StallDetail;
  readonly error?: { readonly code: ModelErrorCode; readonly message: string };
};

/**
 * Handles post-run settlement after a producer releases its lease and seat:
 * spoken-reply handoff, waiting-trigger folding, limit continuations, and
 * bounded retryable-failure handoffs.
 */
@Injectable()
export class RunSettlementService {
  private readonly maxContinuations = readMaxContinuations(process.env['AGENT_MAX_CONTINUATIONS']);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(MessagesService) private readonly messages: MessagesService,
    // Optional so test suites that assemble chat services without voice still wire cleanly.
    @Optional() @Inject(SpokenReplyService) private readonly spokenReplies?: SpokenReplyService,
  ) {}

  /**
   * Decides what follows a settled run: fold any queued trigger into one new
   * run, carry on past a ceiling or transient provider failure within the
   * trigger's run budget, or announce the terminal outcome.
   */
  async settle(
    lease: RunLease,
    bot: TurnBot,
    trigger: ProducedTrigger,
    outcome: SettlementOutcome,
    logger: StructuredLogger,
    runStored: StoredTriggerStarter,
  ): Promise<void> {
    try {
      if (outcome.status === 'completed') {
        // Trigger voice synthesis detached so a waiting trigger starts without waiting on TTS.
        if (outcome.stoppedBy === undefined && outcome.stall === undefined) {
          this.spokenReplies?.replyAloud({
            userId: lease.userId,
            botId: lease.botId,
            threadId: lease.threadId,
            runId: lease.runId,
            triggerMessageId: trigger.triggerMessageId,
          });
        }
        // Only a ceiling stop may be carried on; anything else is the final answer.
        const carriesOn = outcome.stoppedBy !== undefined && outcome.stall === undefined;
        if (!carriesOn) await this.announceSettled(lease, trigger, 'completed', logger);
        if (
          await this.answerWaitingTrigger(lease, bot, trigger.triggerMessageId, logger, runStored)
        ) {
          // The waiting message took over, so this run's work stops here.
          if (carriesOn) await this.announceSettled(lease, trigger, 'completed', logger);
          return;
        }
        if (outcome.stall !== undefined) {
          // A stall stop already gave the model its closing call; continuing
          // automatically would restart the loop it just broke.
          await this.postSystemMessage(bot.id, stallNoticeCopy(outcome.stall));
          return;
        }
        if (outcome.stoppedBy === undefined) return;
        if (
          !(await this.continueAfterLimit(
            lease,
            bot,
            trigger,
            outcome.stoppedBy,
            logger,
            runStored,
          ))
        )
          await this.announceSettled(lease, trigger, 'completed', logger);
        return;
      }
      // Step-level checkpointing lets a fresh run resume after a transient provider fault.
      if (
        outcome.status === 'failed' &&
        outcome.error !== undefined &&
        isRetryableModelCode(outcome.error.code)
      ) {
        const retried =
          !(await this.answerWaitingTrigger(
            lease,
            bot,
            trigger.triggerMessageId,
            logger,
            runStored,
          )) &&
          (await this.continueAfterRetryableFailure(
            lease,
            bot,
            trigger,
            outcome.error,
            logger,
            runStored,
          ));
        if (!retried) await this.announceSettled(lease, trigger, 'failed', logger);
        return;
      }
      // A paused run is answered by its resume, which settles through here.
      if (outcome.status === 'interrupted') return;
      await this.announceSettled(
        lease,
        trigger,
        outcome.status === 'aborted' ? 'stopped' : 'failed',
        logger,
      );
    } catch (error) {
      // A failed handoff must not look like a failed run; the reply is already stored.
      logger.warn('turn.settle.failed', {
        detail: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  async postSystemMessage(botId: string, content: string): Promise<void> {
    const row = await this.messages.createSystemMessage({ botId, content });
    this.events.emitCreated(botId, { ...row, attachments: [] });
  }

  /**
   * Starts one run for the newest unanswered trigger (folding older waiting
   * messages into its history rather than draining one by one).
   */
  private async answerWaitingTrigger(
    lease: RunLease,
    bot: TurnBot,
    triggerMessageId: string,
    logger: StructuredLogger,
    runStored: StoredTriggerStarter,
  ): Promise<boolean> {
    const newest = await this.prisma.message.findFirst({
      where: {
        conversationId: lease.threadId,
        conversation: { bot: { id: bot.id, userId: lease.userId } },
        runId: null,
        OR: [
          { author: 'USER' },
          // Explicit null + negation avoids SQL three-valued NULL pitfalls on this bot's own replies.
          {
            AND: [{ author: 'BOT' }, { fromBotId: { not: null } }, { NOT: { fromBotId: bot.id } }],
          },
        ],
      },
      orderBy: { sequence: 'desc' },
      select: { id: true, content: true, chainId: true, hopCount: true },
    });
    if (newest === null || newest.id === triggerMessageId) return false;
    const claimed = await this.prisma.agentTurn.findFirst({
      where: { triggerMessageId: newest.id, botId: bot.id, bot: { userId: lease.userId } },
      select: { id: true },
    });
    if (claimed !== null) return false;
    logger.info('turn.deferred.answering', { triggerMessageId: newest.id });
    // Not awaited because the settling run is the one calling this.
    const started = await runStored(lease.userId, bot, lease.threadId, {
      id: newest.id,
      content: newest.content,
      chainId: newest.chainId,
      hopCount: newest.hopCount,
    });
    return started !== null;
  }

  /**
   * Announces the run's trigger and any older unanswered messages it folded in.
   * Never throws so a missed notification cannot block a queued handoff.
   */
  private async announceSettled(
    lease: RunLease,
    trigger: ProducedTrigger,
    outcome: RunSettledOutcome,
    logger: StructuredLogger,
  ): Promise<void> {
    try {
      const { userId, botId, threadId } = lease;
      const waiting = await this.prisma.message.findMany({
        where: {
          conversationId: threadId,
          conversation: { bot: { id: botId, userId } },
          runId: null,
          OR: [
            { author: 'USER' },
            {
              AND: [{ author: 'BOT' }, { fromBotId: { not: null } }, { NOT: { fromBotId: botId } }],
            },
          ],
        },
        orderBy: { sequence: 'desc' },
        take: FOLD_WINDOW,
        select: { id: true },
      });
      const ids = waiting.map((row) => row.id);
      const start = ids.indexOf(trigger.triggerMessageId);
      const older = start === -1 ? [] : ids.slice(start + 1);
      const claimed = await this.prisma.agentTurn.findMany({
        where: { botId, bot: { userId }, triggerMessageId: { in: older } },
        select: { triggerMessageId: true },
      });
      const taken = new Set(claimed.map((row) => row.triggerMessageId));
      const boundary = older.findIndex((id) => taken.has(id));
      const folded = boundary === -1 ? older : older.slice(0, boundary);
      // Look across all runs for this trigger: a run ending on a tool call may write no text.
      const reply = await this.prisma.message.findFirst({
        where: {
          conversationId: threadId,
          author: 'BOT',
          content: { not: '' },
          run: { triggerMessageId: trigger.triggerMessageId, botId, bot: { userId } },
        },
        orderBy: { sequence: 'desc' },
        select: { content: true },
      });
      this.events.emitRunSettled({
        botId,
        threadId,
        runId: lease.runId,
        messageIds: [trigger.triggerMessageId, ...folded],
        outcome,
        reply: reply?.content ?? null,
      });
    } catch (error) {
      logger.warn('turn.settled.announce.failed', {
        detail: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /**
   * Continues work stopped by a turn ceiling, bounded by durable runs for this
   * trigger so restarts cannot drift or loop past `maxContinuations`.
   */
  private async continueAfterLimit(
    lease: RunLease,
    bot: TurnBot,
    trigger: ProducedTrigger,
    stop: TurnLimitStop,
    logger: StructuredLogger,
    runStored: StoredTriggerStarter,
  ): Promise<boolean> {
    if (this.maxContinuations === 0) {
      await this.announceLimit(bot.id, stop, logger);
      return false;
    }
    const runs = await this.runsForTrigger(lease, bot, trigger.triggerMessageId);
    const used = Math.max(0, runs - 1);
    const remaining = this.maxContinuations - used;
    if (remaining <= 0) {
      logger.info('turn.continuation.exhausted', { limit: stop.kind, continuations: used });
      await this.announceLimit(bot.id, stop, logger);
      return false;
    }
    logger.info('turn.continuation.started', {
      limit: stop.kind,
      continuation: used + 1,
      of: this.maxContinuations,
    });
    const started =
      (await runStored(lease.userId, bot, lease.threadId, {
        id: trigger.triggerMessageId,
        content: trigger.triggerContent,
        chainId: trigger.chainId,
        hopCount: trigger.hopCount,
        continuation: continuationInstruction(stop),
      })) !== null;
    // If continuation could not start, surface the ceiling stop copy to the operator.
    if (!started) await this.announceLimit(bot.id, stop, logger);
    return started;
  }

  /** Counts durable runs spent on this trigger so every handoff shares one budget. */
  private async runsForTrigger(
    lease: RunLease,
    bot: TurnBot,
    triggerMessageId: string,
  ): Promise<number> {
    return this.prisma.agentTurn.count({
      where: { triggerMessageId, botId: bot.id, bot: { userId: lease.userId } },
    });
  }

  /**
   * Retries a transient provider failure using the same trigger run budget so
   * a persistent fault cannot loop indefinitely.
   */
  private async continueAfterRetryableFailure(
    lease: RunLease,
    bot: TurnBot,
    trigger: ProducedTrigger,
    error: { readonly code: ModelErrorCode; readonly message: string },
    logger: StructuredLogger,
    runStored: StoredTriggerStarter,
  ): Promise<boolean> {
    const runs = await this.runsForTrigger(lease, bot, trigger.triggerMessageId);
    const used = Math.max(0, runs - 1);
    const remaining = this.maxContinuations - used;
    if (remaining <= 0) {
      logger.info('turn.retry.exhausted', { code: error.code, continuations: used });
      return false;
    }
    const started = await runStored(lease.userId, bot, lease.threadId, {
      id: trigger.triggerMessageId,
      content: trigger.triggerContent,
      chainId: trigger.chainId,
      hopCount: trigger.hopCount,
      continuation: retryContinuationInstruction(error.code),
    });
    if (started === null) return false;
    await this.postSystemMessage(bot.id, retryOperatorCopy());
    logger.info('turn.retry.started', {
      code: error.code,
      attempt: used + 1,
      of: this.maxContinuations,
    });
    return true;
  }

  private async announceLimit(
    botId: string,
    stop: TurnLimitStop,
    logger: StructuredLogger,
  ): Promise<void> {
    try {
      await this.postSystemMessage(botId, turnLimitCopy(stop));
    } catch (error) {
      // Failing to store the explanation must not turn a completed run into a failure.
      logger.warn('turn.limit.announce.failed', {
        limit: stop.kind,
        detail: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}
