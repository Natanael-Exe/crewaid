import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, type Attachment, type Message } from '@prisma/client';
import {
  ChatForwardedPropsSchema,
  ToolApprovalAnswerSchema,
  type BotStatus,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { TURN_BOT_SELECT, type TurnBot } from '../agent/turn-assembly.js';
import { TanStackTurns, type StoredTrigger } from '../agent/tanstack-turns.js';
import {
  InvalidChatRequestError,
  parseChatRequest,
  type ChatRequestParams,
} from '../agent/execution/chat-request.js';
import type { ExecutionResume } from '../agent/execution/execution-backend.port.js';
import { admitOwnedToolResumeBatch } from '../agent/persistence/owned-resume-admission.js';
import {
  RunLeaseService,
  RunOwnershipError,
  type RunLease,
} from '../agent/persistence/run-lease.js';
import { toTranscriptRow } from '../agent/persistence/transcript.js';
import { InterruptStoreError } from '../agent/persistence/prisma-interrupt-store.js';
import { RunEventLogError } from '../agent/persistence/run-event-log.js';
import type { AdmittedTurn, ProducedTrigger } from './chat-run.types.js';
import { RunProducerService } from './run-producer.service.js';
import { RunRecoveryService, type RecoveryHooks } from './run-recovery.service.js';
import { RunSettlementService } from './run-settlement.service.js';

export type { AdmittedTurn } from './chat-run.types.js';

/** Id shape a client may propose: 1-64 URL-safe characters. */
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

type ParsedBody = ChatRequestParams;

function isEmptyState(state: unknown): boolean {
  if (state === undefined || state === null) return true;
  return typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length === 0;
}

/**
 * Admits HTTP and background chat turns, claims per-bot run leases, tracks
 * in-flight producers for immediate Stop cancellation, and delegates execution,
 * post-run settlement, and expired-lease recovery.
 */
@Injectable()
export class ChatSendService implements OnModuleInit, OnModuleDestroy {
  private readonly leases: RunLeaseService;
  /**
   * Active runs produced by this worker, keyed by botId (at most one active
   * run per bot). Aborting here reaches the model immediately without a DB
   * round trip; durable `cancelRequested` fences other workers at heartbeat.
   */
  private readonly producing = new Map<
    string,
    {
      readonly userId: string;
      readonly runId: string;
      readonly controller: AbortController;
      /** Resolves once this producer has put its run down. */
      settled: Promise<void>;
    }
  >();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(TanStackTurns) private readonly turns: TanStackTurns,
    @Inject(RunProducerService) private readonly producer: RunProducerService,
    @Inject(RunSettlementService) private readonly settlement: RunSettlementService,
    @Inject(RunRecoveryService) private readonly recovery: RunRecoveryService,
  ) {
    this.leases = new RunLeaseService(prisma);
  }

  /** Register after imports initialize so background callers can reach this producer. */
  onModuleInit(): void {
    this.turns.use(this);
  }

  async onModuleDestroy(): Promise<void> {
    await this.recovery.stop();
  }

  /** Parsed through the execution seam so the wire contract stays single-sourced. */
  async parse(body: unknown): Promise<ParsedBody> {
    try {
      return await parseChatRequest(body);
    } catch (error) {
      if (error instanceof InvalidChatRequestError)
        throw new BadRequestException({ code: 'INVALID_RUN_AGENT_INPUT' });
      throw error;
    }
  }

  /**
   * Checks whether `admit` would refuse a new message with `THREAD_AWAITING_APPROVAL`
   * before callers pay to download or transcribe media.
   */
  async awaitingApproval(userId: string, botId: string, threadId: string): Promise<boolean> {
    return (await this.liveState(userId, botId, threadId)).pendingInterrupts > 0;
  }

  async admit(userId: string, botId: string, params: ParsedBody): Promise<AdmittedTurn> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: TURN_BOT_SELECT,
    });
    if (bot?.conversation == null) throw new NotFoundException();
    const threadId = bot.conversation.id;
    if (params.threadId !== threadId) throw new NotFoundException();
    if (!CLIENT_ID.test(params.runId)) throw new BadRequestException({ code: 'INVALID_RUN_ID' });

    const forwarded = ChatForwardedPropsSchema.safeParse(params.forwardedProps);
    if (!forwarded.success) throw new BadRequestException({ code: 'FORWARDED_PROPS_NOT_ALLOWED' });
    // Refuse client-declared tools and context explicitly rather than silently ignoring them.
    if (params.tools.length > 0 || params.aguiContext.length > 0)
      throw new BadRequestException({ code: 'CLIENT_TOOLS_NOT_ACCEPTED' });
    // Stock clients always send `state: {}`; reject only non-empty client state.
    if (!isEmptyState(params.state))
      throw new BadRequestException({ code: 'CLIENT_STATE_NOT_ACCEPTED' });

    const resume = this.resumeBatch(params);
    const incoming = params.messages.filter((message) => 'role' in message && 'id' in message);
    const storedIds = await this.storedIds(
      threadId,
      incoming.flatMap((message) => (typeof message.id === 'string' ? [message.id] : [])),
    );
    // Drop already-stored ids so client history cannot rewrite or truncate the server thread.
    const fresh = incoming.filter(
      (message) => typeof message.id === 'string' && !storedIds.has(message.id),
    );
    if (fresh.some((message) => message.role !== 'user'))
      throw new BadRequestException({ code: 'ONLY_USER_MESSAGES_ACCEPTED' });
    if (fresh.length > 1) throw new BadRequestException({ code: 'ONE_TRIGGER_PER_RUN' });
    const trigger = fresh[0];
    if (trigger === undefined && resume === undefined)
      throw new BadRequestException({ code: 'NOTHING_TO_RUN' });
    if (trigger !== undefined && resume !== undefined)
      throw new BadRequestException({ code: 'ANSWER_OR_ASK_NOT_BOTH' });

    if (resume !== undefined) return this.resumeRun(userId, bot, threadId, params, resume);

    const id = String(trigger?.id ?? '');
    if (!CLIENT_ID.test(id)) throw new BadRequestException({ code: 'INVALID_MESSAGE_ID' });
    // This route admits text content only; attachments travel via `attachmentIds`.
    const body: unknown = trigger === undefined ? '' : Reflect.get(trigger, 'content');
    if (typeof body !== 'string') throw new BadRequestException({ code: 'TEXT_CONTENT_ONLY' });
    const content = body;
    const attachmentIds = forwarded.data.attachmentIds ?? [];
    if (content.trim() === '' && attachmentIds.length === 0)
      throw new BadRequestException({ code: 'EMPTY_MESSAGE' });

    const live = await this.liveState(userId, botId, threadId);
    if (live.pendingInterrupts > 0)
      throw new ConflictException({ code: 'THREAD_AWAITING_APPROVAL' });
    // Store mid-run messages so the settling run answers them instead of refusing.
    await this.storeTrigger({ userId, botId, threadId, id, content, attachmentIds });
    if (live.runningRunId !== null) return { kind: 'deferred' };

    const claimed = await this.claim(userId, botId, threadId, params.runId, id);
    if (claimed.kind === 'joined') return { kind: 'joined', runId: params.runId };
    void this.start(claimed.lease, bot, {
      triggerMessageId: id,
      triggerContent: content,
      chainId: null,
      hopCount: 0,
    });
    return { kind: 'started', runId: claimed.lease.runId };
  }

  /**
   * Starts a run for an already-stored background trigger and resolves once it
   * settles, or immediately if a live run/approval leaves the trigger deferred.
   */
  async startStored(userId: string, botId: string, trigger: StoredTrigger): Promise<void> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: TURN_BOT_SELECT,
    });
    if (bot?.conversation == null) return;
    await (
      await this.runStored(userId, bot, bot.conversation.id, trigger)
    )?.settled;
  }

  /**
   * Immediately aborts an in-process run for this bot and asynchronously marks
   * durable cancel intent and clears parked interrupts.
   */
  cancel(userId: string, botId: string): boolean {
    const live = this.producing.get(botId);
    const stopped = live !== undefined && live.userId === userId;
    if (stopped) live.controller.abort();
    void this.recordCancel(userId, botId, stopped ? live : undefined).catch((error: unknown) => {
      this.logger.warn('chat.cancel.failed', {
        botId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
    return stopped;
  }

  async startRecovery(): Promise<void> {
    await this.recovery.startRecovery(this.recoveryHooks());
  }

  recoverAbandonedRuns(): Promise<void> {
    return this.recovery.recoverAbandonedRuns(this.recoveryHooks());
  }

  /** Claims and starts a stored trigger, returning null if deferred to another run. */
  private async runStored(
    userId: string,
    bot: TurnBot,
    threadId: string,
    trigger: StoredTrigger & { readonly continuation?: string },
  ): Promise<{ readonly settled: Promise<void> } | null> {
    const logger = this.logger.child({
      botId: bot.id,
      conversationId: threadId,
      chainId: trigger.chainId,
    });
    const live = await this.liveState(userId, bot.id, threadId);
    if (live.runningRunId !== null || live.pendingInterrupts > 0) {
      logger.info('turn.deferred', { activeTurnId: live.runningRunId });
      return null;
    }
    let claimed;
    try {
      claimed = await this.claim(userId, bot.id, threadId, ChatSendService.nextRunId(), trigger.id);
    } catch (error) {
      // Lost race between check and claim: leave stored for the winning run to answer.
      if (error instanceof RunOwnershipError || error instanceof ConflictException) {
        logger.info('turn.deferred.contended', {
          detail: error instanceof RunOwnershipError ? error.code : 'conflict',
        });
        return null;
      }
      throw error;
    }
    if (claimed.kind === 'joined') return null;
    const settled = this.start(claimed.lease, bot, {
      triggerMessageId: trigger.id,
      triggerContent: trigger.content,
      chainId: trigger.chainId,
      hopCount: trigger.hopCount,
      ...(trigger.continuation === undefined ? {} : { continuation: trigger.continuation }),
    });
    return { settled };
  }

  private async recordCancel(
    userId: string,
    botId: string,
    aborted: { readonly runId: string; readonly settled: Promise<void> } | undefined,
  ): Promise<void> {
    await this.prisma.agentTurn.updateMany({
      where: { botId, status: 'running', bot: { userId } },
      data: { cancelRequested: true },
    });
    if (aborted !== undefined) {
      await aborted.settled.catch(() => undefined);
      // An abort before the first model call can leave this run `running` with no
      // producer left to close it; scope strictly to the aborted run id.
      await this.prisma.agentTurn.updateMany({
        where: { id: aborted.runId, botId, status: 'running', bot: { userId } },
        data: {
          status: 'aborted',
          endedAt: new Date(),
          activeKey: null,
          workerId: null,
          leaseExpiresAt: null,
        },
      });
    }
    // Cancel pending interrupts on aborted or parked runs that no longer have a producer.
    const settled = await this.prisma.agentTurn.findMany({
      where: {
        botId,
        status: { in: ['interrupted', 'aborted'] },
        bot: { userId },
      },
      select: { id: true },
    });
    if (settled.length === 0) return;
    const ids = settled.map((run) => run.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.runInterrupt.updateMany({
        where: { runId: { in: ids }, userId, status: 'pending' },
        data: { status: 'cancelled', resolvedAt: new Date() },
      });
      await tx.agentTurn.updateMany({
        where: { id: { in: ids }, botId, status: 'interrupted', bot: { userId } },
        data: {
          status: 'aborted',
          endedAt: new Date(),
          activeKey: null,
          workerId: null,
          leaseExpiresAt: null,
        },
      });
    });
    await this.writeStatus(botId, 'IDLE');
  }

  /** Returns which candidate message ids are already stored on this thread. */
  private async storedIds(threadId: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.message.findMany({
      where: { conversationId: threadId, id: { in: [...ids] } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  private async liveState(
    userId: string,
    botId: string,
    threadId: string,
  ): Promise<{ readonly runningRunId: string | null; readonly pendingInterrupts: number }> {
    const running = await this.prisma.agentTurn.findFirst({
      where: { botId, conversationId: threadId, status: 'running', bot: { userId } },
      select: { id: true },
    });
    const pendingInterrupts = await this.prisma.runInterrupt.count({
      where: {
        conversationId: threadId,
        userId,
        status: 'pending',
        run: { botId, bot: { userId } },
      },
    });
    return { runningRunId: running?.id ?? null, pendingInterrupts };
  }

  /**
   * Persists the user message and claims its attachments in one transaction
   * before any run exists, then announces it so other open clients see it.
   */
  private async storeTrigger(input: {
    readonly userId: string;
    readonly botId: string;
    readonly threadId: string;
    readonly id: string;
    readonly content: string;
    readonly attachmentIds: readonly string[];
  }): Promise<void> {
    const row = toTranscriptRow(
      { id: input.id, role: 'user', content: input.content },
      { threadBotId: input.botId, runId: null },
    );
    if (!row.ok) throw new BadRequestException({ code: 'INVALID_MESSAGE' });
    let stored: Message & { attachments: Attachment[] };
    try {
      stored = await this.prisma.$transaction(async (tx) => {
        let claimed: Attachment[] = [];
        if (input.attachmentIds.length > 0) {
          // Only unclaimed uploads owned by this user may be attached.
          claimed = await tx.attachment.findMany({
            where: {
              id: { in: [...input.attachmentIds] },
              messageId: null,
              deliverable: null,
              ownerId: input.userId,
            },
          });
          if (claimed.length !== input.attachmentIds.length) throw new NotFoundException();
        }
        const message = await tx.message.create({
          data: { conversationId: input.threadId, ...row.value },
        });
        if (input.attachmentIds.length > 0) {
          await tx.attachment.updateMany({
            where: {
              id: { in: [...input.attachmentIds] },
              ownerId: input.userId,
              messageId: null,
              deliverable: null,
            },
            data: { messageId: input.id },
          });
        }
        return {
          ...message,
          attachments: claimed.map((attachment) => ({ ...attachment, messageId: message.id })),
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        // Keep cross-thread id collisions opaque.
        throw new ConflictException({ code: 'MESSAGE_ID_TAKEN' });
      throw error;
    }
    this.events.emitCreated(input.botId, stored);
  }

  private async claim(
    userId: string,
    botId: string,
    threadId: string,
    runId: string,
    triggerMessageId: string,
  ) {
    try {
      return await this.leases.claim({ userId, botId, threadId, runId, triggerMessageId });
    } catch (error) {
      throw this.ownershipFailure(error);
    }
  }

  private ownershipFailure(error: unknown): unknown {
    if (!(error instanceof RunOwnershipError)) return error;
    switch (error.code) {
      case 'RUN_BUSY':
        return new ConflictException({ code: 'RUN_BUSY' });
      case 'RUN_CONFLICT':
        return new ConflictException({ code: 'RUN_CONFLICT' });
      case 'RUN_NOT_OWNED':
        return new NotFoundException();
      default:
        return new ConflictException({ code: 'STALE_WORKER' });
    }
  }

  /** Validates client approval answers into the shape expected by resume admission. */
  private resumeBatch(params: ParsedBody): readonly ExecutionResume[] | undefined {
    if (params.resume === undefined || params.resume.length === 0) return undefined;
    return params.resume.map((entry): ExecutionResume => {
      if (entry.status === 'cancelled')
        return { interruptId: entry.interruptId, status: 'cancelled' };
      const payload = ToolApprovalAnswerSchema.safeParse(entry.payload);
      if (!payload.success) throw new BadRequestException({ code: 'INVALID_RESUME_PAYLOAD' });
      return { interruptId: entry.interruptId, status: 'resolved', payload: payload.data };
    });
  }

  private async resumeRun(
    userId: string,
    bot: TurnBot,
    threadId: string,
    params: ParsedBody,
    resume: readonly ExecutionResume[],
  ): Promise<AdmittedTurn> {
    const parentRunId = params.parentRunId;
    if (parentRunId === undefined) throw new BadRequestException({ code: 'RESUME_NEEDS_PARENT' });
    let admitted;
    try {
      admitted = await admitOwnedToolResumeBatch(
        this.prisma,
        { userId, botId: bot.id, threadId, parentRunId },
        resume,
        { runId: params.runId },
      );
    } catch (error) {
      if (error instanceof InterruptStoreError)
        throw new ConflictException({ code: 'INTERRUPT_NOT_PENDING' });
      throw this.ownershipFailure(error);
    }
    // Preserve chain hop position from the trigger row so approvals do not reset hop budgets.
    const chain = await this.chainOf(threadId, admitted.batch.run.triggerMessageId);
    void this.start(admitted.lease, bot, {
      triggerMessageId: admitted.batch.run.triggerMessageId,
      triggerContent: '',
      ...chain,
      parentRunId,
      resume: admitted.batch.resume,
    });
    return { kind: 'started', runId: admitted.lease.runId };
  }

  /** Starts a detached producer registered for immediate in-process cancellation. */
  private start(lease: RunLease, bot: TurnBot, trigger: ProducedTrigger): Promise<void> {
    this.events.emitRunStarted(bot.id, lease.threadId, lease.runId);
    const logger = this.logger.child({
      botId: bot.id,
      conversationId: lease.threadId,
      runId: lease.runId,
    });
    // Register before assembly starts so a Stop arriving mid-setup reaches this signal.
    const controller = new AbortController();
    const entry = {
      userId: lease.userId,
      runId: lease.runId,
      controller,
      settled: Promise.resolve(),
    };
    this.producing.set(bot.id, entry);
    entry.settled = this.produce(lease, bot, trigger, controller, logger)
      .catch((error: unknown) => {
        logger.error('chat.producer.failed', {
          errorName: error instanceof Error ? error.name : typeof error,
          ...(error instanceof RunEventLogError ||
          error instanceof RunOwnershipError ||
          error instanceof Prisma.PrismaClientKnownRequestError
            ? { errorCode: error.code }
            : {}),
        });
      })
      .finally(() => {
        const held = this.producing.get(bot.id);
        if (held?.runId === lease.runId) this.producing.delete(bot.id);
      });
    return entry.settled;
  }

  private async produce(
    lease: RunLease,
    bot: TurnBot,
    trigger: ProducedTrigger,
    controller: AbortController,
    logger: StructuredLogger,
  ): Promise<void> {
    const outcome = await this.producer.execute(lease, bot, trigger, controller, logger, {
      writeStatus: (botId, status) => this.writeStatus(botId, status),
      postSystemMessage: (botId, content) => this.settlement.postSystemMessage(botId, content),
    });
    // Clear the producing entry before settlement so a handoff starts cleanly as a new run.
    const mine = this.producing.get(bot.id);
    if (mine?.runId === lease.runId) this.producing.delete(bot.id);
    await this.settlement.settle(
      lease,
      bot,
      trigger,
      outcome,
      logger,
      (userId, nextBot, threadId, nextTrigger) =>
        this.runStored(userId, nextBot, threadId, nextTrigger),
    );
  }

  /** Reads the trigger row's chain position for resumed runs. */
  private async chainOf(
    threadId: string,
    messageId: string,
  ): Promise<{ readonly chainId: string | null; readonly hopCount: number }> {
    const row = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId: threadId },
      select: { chainId: true, hopCount: true },
    });
    return { chainId: row?.chainId ?? null, hopCount: row?.hopCount ?? 0 };
  }

  private async writeStatus(botId: string, status: BotStatus): Promise<void> {
    try {
      await this.prisma.bot.update({ where: { id: botId }, data: { status } });
      this.events.emitBotStatus(botId, status);
    } catch (error) {
      // Status updates are notifications and must not fail the run.
      this.logger.warn('bot.status.write.failed', {
        botId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private recoveryHooks(): RecoveryHooks {
    return {
      start: (lease, bot, trigger) => this.start(lease, bot, trigger),
      writeStatus: (botId, status) => this.writeStatus(botId, status),
    };
  }

  /** Generates a run id for callers starting deferred or background turns. */
  static nextRunId(): string {
    return randomUUID();
  }
}
