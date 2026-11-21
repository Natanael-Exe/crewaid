import { Inject, Injectable } from '@nestjs/common';

import { TanStackTurns } from '../agent/tanstack-turns.js';
import { MessagesService } from '../messages/messages.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { ChainBudgetService } from './chain-budget.service.js';
import { ChainNoticeService } from './chain-notice.service.js';
import {
  botGoneNotice,
  deliveryReceiptNotice,
  effectiveTokenBudget,
  hopLimitNotice,
  isWithinHopLimit,
  isWithinRepeatCap,
  isWithinTokenBudget,
  repeatCapNotice,
  tokenBudgetNotice,
} from './chain.js';
import { CHAIN_LIMITS, type ChainLimits } from './chain.config.js';
import type { BotMessageJobData } from './bot-message.queue.js';

/**
 * Why a delivery did not happen, when it did not happen.
 *
 * A closed union rather than a boolean, because the three outcomes are three
 * different things to an operator — a chain that hit its ceiling is working
 * as designed, a bot that vanished is M7-BE-05's case, and a bot with no
 * conversation row is a corrupt database — and M7-BE-02 attaches a different
 * system message to the first of them. An unhandled variant should be a
 * compile error at the point that decides what to say.
 */
export type DeliveryOutcome =
  | { readonly kind: 'delivered'; readonly messageId: string }
  | { readonly kind: 'hop-limit'; readonly maxHops: number }
  | { readonly kind: 'token-budget'; readonly spent: number; readonly budget: number }
  | { readonly kind: 'repeat-cap'; readonly alreadySent: number; readonly cap: number }
  | { readonly kind: 'bot-gone'; readonly missing: 'sender' | 'receiver' | 'both' };

/**
 * One hop of §6/M7's bot-to-bot delivery: the worker's whole job.
 *
 * Every authority question is re-asked here
 *
 * The job carries ids, not permission. Between `send_message` returning and
 * this running, a bot can be deleted, and the two bots being under one
 * `userId` is the only thing that makes this delivery legal at all. So
 * both are re-resolved against the job's principal, in one scoped query, and
 * a job naming a bot that is gone is DROPPED rather than delivered to
 * whatever still exists.
 *
 * A refused delivery is not a failed job
 *
 * Returning an outcome rather than throwing. A hop over the ceiling and a
 * deleted bot are both correct, expected endings for a chain — throwing would
 * make BullMQ record a failure, and M7-QA-05's "no stuck jobs" is a claim
 * about exactly this path. The job machinery failing is a different thing and
 * still throws, which is what the processor's `failed` handler is for.
 */
@Injectable()
export class BotMessageDeliveryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(TanStackTurns) private readonly turns: TanStackTurns,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(ChainNoticeService) private readonly notice: ChainNoticeService,
    @Inject(ChainBudgetService) private readonly budget: ChainBudgetService,
    @Inject(CHAIN_LIMITS) private readonly limits: ChainLimits,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  async deliver(job: BotMessageJobData): Promise<DeliveryOutcome> {
    const context = this.logger.child({
      botId: job.toBotId,
      chainId: job.chainId,
    });

    // One query for both bots, scoped to the principal the job names.
    // Two `findFirst`s would be two allowlist entries and one more round trip
    // for the same fact.
    const bots = await this.prisma.bot.findMany({
      where: { userId: job.userId, id: { in: [job.fromBotId, job.toBotId] } },
      select: { id: true, name: true },
    });
    const sender = bots.find((bot) => bot.id === job.fromBotId);
    const receiver = bots.find((bot) => bot.id === job.toBotId);
    if (sender === undefined || receiver === undefined) {
      const missing =
        sender === undefined && receiver === undefined
          ? 'both'
          : sender === undefined
            ? 'sender'
            : 'receiver';
      context.info('interbot.delivery.dropped', { reason: 'bot-gone', missing });
      // The chain ends here, and CLEAN is not the same as SILENT.
      // When the receiver is the one deleted, the sender is still here and
      // still believes it delegated work: it is holding a plan whose next
      // step is a reply that can never arrive. Telling it is the difference
      // between a chain that terminated and a bot that is quietly waiting
      // forever — the "dead-lettering" §6/M7 asks us to avoid, seen from the
      // side that can still act.
      // When the SENDER is the one deleted there is nobody to tell: the
      // intended recipient never knew a message existed, and a note in its
      // transcript would be the first it heard of a conversation that never
      // happened.
      if (sender !== undefined) {
        await this.notice.post(sender.id, job.chainId, botGoneNotice(job.toBotName));
      }
      return { kind: 'bot-gone', missing };
    }

    const { maxHops } = this.limits;
    if (!isWithinHopLimit({ chainId: job.chainId, hopCount: job.hopCount }, maxHops)) {
      // Checked again here, not only at send: the two are separated by a
      // queue, and a job enqueued while the chain was under the bound must
      // not be delivered after something else pushed it over.
      context.info('interbot.delivery.dropped', {
        reason: 'hop-limit',
        hopCount: job.hopCount,
        maxHops,
      });
      // "delivery is dropped and a system message posted to BOTH
      // bots". Both, here and not at the send path, because a message really
      // was in flight: the sender believes it delegated work, and the
      // receiver's operator would otherwise never learn that a teammate
      // tried to reach it. Sequential rather than concurrent so the two
      // transcripts cannot interleave with a third chain's notice.
      const notice = hopLimitNotice(maxHops);
      await this.notice.post(sender.id, job.chainId, notice);
      await this.notice.post(receiver.id, job.chainId, notice);
      return { kind: 'hop-limit', maxHops };
    }

    // §6/M7's per-pair cap. Checked here as well as at send for the reason
    // every ceiling is: a queue separates the two, and two messages enqueued
    // while the pair was one under the cap must not both land.
    const { maxRepeatSends } = this.limits;
    if (maxRepeatSends > 0) {
      const alreadySent = await this.budget.sendsBetween(
        job.userId,
        job.chainId,
        sender.id,
        receiver.id,
      );
      if (!isWithinRepeatCap(alreadySent, maxRepeatSends)) {
        context.info('interbot.delivery.dropped', {
          reason: 'repeat-cap',
          alreadySent,
          cap: maxRepeatSends,
        });
        const notice = repeatCapNotice(receiver.name, maxRepeatSends);
        await this.notice.post(sender.id, job.chainId, notice);
        await this.notice.post(receiver.id, job.chainId, notice);
        return { kind: 'repeat-cap', alreadySent, cap: maxRepeatSends };
      }
    }

    // "Exhaustion terminates the chain with a system message." After
    // the hop check, because a chain over BOTH ceilings should report the
    // cheaper fact first, and before anything is written, because the point
    // is to not start the turn that would spend the next tokens.
    const budget = effectiveTokenBudget(this.limits.maxTokens, undefined);
    if (budget > 0) {
      const spent = await this.budget.spentTokens(job.userId, job.chainId);
      if (!isWithinTokenBudget(spent, budget)) {
        context.info('interbot.delivery.dropped', {
          reason: 'token-budget',
          spent,
          budget,
        });
        const notice = tokenBudgetNotice(spent, budget);
        await this.notice.post(sender.id, job.chainId, notice);
        await this.notice.post(receiver.id, job.chainId, notice);
        return { kind: 'token-budget', spent, budget };
      }
    }

    // From here on, nothing may throw into a retry
    // The row this creates IS the delivery. A retry of this function after
    // the row exists would write the same message into the receiver's
    // transcript twice, so the only throw left in the retryable path is the
    // row creation itself — a throw there wrote nothing, and trying again is
    // safe. Everything after it is sync, catches its own failures, or is
    // caught below.
    let row: Awaited<ReturnType<MessagesService['createInboundBotMessage']>>;
    try {
      row = await this.messages.createInboundBotMessage({
        toBotId: receiver.id,
        fromBotId: sender.id,
        content: job.content,
        chainId: job.chainId,
        hopCount: job.hopCount,
        taskId: await this.taskStillOwned(job),
      });
    } catch (error) {
      context.warn('interbot.delivery.create-failed', {
        detail: error instanceof Error ? error.message : 'unknown',
      });
      throw error;
    }

    // The transcript first, the turn second. A client watching the receiving
    // bot sees the message arrive whether or not a turn can start for it —
    // and if the turn is deferred because the bot is mid-turn, the
    // message is on screen in the meantime rather than appearing only once
    // something answers it.
    this.events.emitCreated(receiver.id, { ...row, attachments: [] });

    // The sender's receipt, posted before the receiver's turn is awaited
    // because a turn is minutes of model work and "it arrived" is true the
    // moment the row and the frame are. A delivery that later fails inside
    // startTurn is still a delivery: the message is in the transcript either
    // way, which is what the receipt promises.
    await this.notice.post(sender.id, job.chainId, deliveryReceiptNotice(receiver.name));

    context.info('interbot.delivery.delivered', {
      fromBotId: sender.id,
      hopCount: job.hopCount,
      messageId: row.id,
    });

    // "The receiving bot's turn triggers as if a user had messaged
    // it." Awaited: this IS the background, and a job that resolves before
    // the run is admitted would report a delivery that has not happened yet.
    // A run's own failures close the run, so what escapes here is
    // infrastructural — and it is caught rather than thrown, because a
    // thrown failure would retry the job over a row that already exists. A delivered message whose turn never started is not lost: it
    // sits in the receiver's transcript and is in the history of the next
    // turn anyone starts there.
    try {
      await this.turns.startStored(job.userId, receiver.id, {
        id: row.id,
        content: row.content,
        chainId: job.chainId,
        hopCount: job.hopCount,
      });
    } catch (error) {
      context.error('interbot.delivery.turn-failed', {
        detail: error instanceof Error ? error.message : 'unknown',
      });
    }

    return { kind: 'delivered', messageId: row.id };
  }

  /**
   * The task the sender named, if it is still the user's. Checked here
   * as well as at send time because a job outlives the turn that queued it:
   * a task deleted in between makes this a message about no task, not a
   * delivery that fails.
   */
  private async taskStillOwned(job: BotMessageJobData): Promise<string | null> {
    if (job.taskId === undefined || job.taskId === null) return null;
    const task = await this.prisma.task.findFirst({
      where: { id: job.taskId, userId: job.userId },
      select: { id: true },
    });
    return task?.id ?? null;
  }
}
