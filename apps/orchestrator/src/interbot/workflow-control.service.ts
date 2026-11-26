import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  projectPublicSpeech,
  type ListWorkflowsResponse,
  type StopWorkflowResponse,
  type WorkflowChainStatus,
  type WorkflowChainSummary,
  type WrapUpWorkflowResponse,
} from '@crewaid/shared';
import { TanStackTurns } from '../agent/tanstack-turns.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { MessagesService } from '../messages/messages.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BOT_MESSAGE_QUEUE, type BotMessageQueue } from './bot-message.queue.js';

/** Default bounded wrap-up deadline (2 minutes). */
export const DEFAULT_WRAP_UP_DEADLINE_MS = 120_000;

export type ChainGateDecision =
  | {
      readonly allowed: true;
      /**
       * Set when the hop is allowed only because it is part of a wrap-up (the
       * coordinator's closeout prompt or an owner's reply to it). Those hops
       * are bounded by the wrap-up itself, so per-chain repeat, hop, and token
       * ceilings must not drop them — a chain is often wrapped up precisely
       * because it ran into one.
       */
      readonly wrapUp?: true;
    }
  | { readonly allowed: false; readonly status: WorkflowChainStatus; readonly reason: string };

type ChainStateFields = Omit<Prisma.WorkflowChainStateUncheckedCreateInput, 'chainId' | 'userId'>;

/**
 * Chain-scoped workflow lifecycle control (`Stop workflow` vs. `Wrap up`).
 *
 * State is persisted in `WorkflowChainState` keyed by `chainId` so BullMQ
 * retries, deferred-trigger recovery, and worker restarts all enforce the same
 * stopped / wrapping-up / closed boundary without disturbing unrelated chains,
 * existing messages, or files.
 */
@Injectable()
export class WorkflowControlService implements OnModuleInit, OnModuleDestroy {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly deadlineMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(TanStackTurns) private readonly turns: TanStackTurns,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(BOT_MESSAGE_QUEUE) private readonly queue: BotMessageQueue,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {
    const raw = process.env['WORKFLOW_WRAP_UP_DEADLINE_MS'];
    const parsed = raw !== undefined && raw.trim() !== '' ? Number(raw) : Number.NaN;
    this.deadlineMs =
      Number.isFinite(parsed) && parsed >= 100 ? parsed : DEFAULT_WRAP_UP_DEADLINE_MS;
  }

  onModuleInit(): void {
    void this.armPendingDeadlines().catch((error: unknown) => {
      this.logger.warn('workflow.deadlines.recovery_failed', {
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Lists active and wrapping-up chains relevant to this bot (or its group). */
  async listWorkflows(userId: string, botId: string): Promise<ListWorkflowsResponse> {
    const bot = await this.findOwnedBot(userId, botId);
    const scopeBotIds = await this.scopeBotIds(userId, bot);
    const chains = await this.discoverActiveChains(userId, scopeBotIds, bot.groupId);
    return { chains };
  }

  /**
   * Hard stop for one chain: marks it `STOPPED` durably, cancels only runs
   * belonging to that chain across participating bots, and blocks queued
   * deliveries, retries, and deferred wakeups for that chain.
   */
  async stopWorkflow(
    userId: string,
    botId: string,
    requestedChainId?: string,
  ): Promise<StopWorkflowResponse> {
    const bot = await this.findOwnedBot(userId, botId);
    const chainId = await this.resolveTargetChainId(userId, bot, requestedChainId, true);

    this.clearTimer(chainId);
    const stopFields = {
      status: 'STOPPED' as const,
      closeoutPublished: true,
      stoppedAt: new Date(),
    };
    const stopped = await this.prisma.workflowChainState.updateMany({
      where: { chainId, userId },
      data: stopFields,
    });
    if (
      stopped.count === 0 &&
      !(await this.createChainState(userId, chainId, {
        rootBotId: bot.id,
        groupId: bot.groupId,
        ...stopFields,
      }))
    ) {
      // Lost a race with this account's own concurrent create, or the id is
      // held by a row another account wrote. Only the first is ours to stop.
      const retried = await this.prisma.workflowChainState.updateMany({
        where: { chainId, userId },
        data: stopFields,
      });
      if (retried.count === 0) throw new NotFoundException('No active workflow found for this bot.');
    }

    const { cancelledRuns, stoppedBotIds } = await this.cancelChainRuns(userId, chainId);
    const notice = await this.messages.createSystemMessage({
      botId: bot.id,
      content:
        'Workflow stopped. Active runs in this workflow were cancelled and queued handoffs will not start new turns. Existing messages and files remain available.',
    });
    this.events.emitCreated(bot.id, { ...notice, attachments: [] });

    this.logger.info('workflow.stopped', {
      userId,
      botId: bot.id,
      chainId,
      cancelledRuns,
      stoppedBotIds,
    });
    return {
      chainId,
      status: 'STOPPED',
      stoppedBotIds,
      cancelledRuns,
    };
  }

  /**
   * Graceful closeout for one chain: acknowledges the user immediately, pauses
   * new delegation hops, sends exactly one closeout prompt per active owner,
   * and publishes one consolidated closeout when all owners respond or after
   * the 2-minute deadline.
   */
  async wrapUpWorkflow(
    userId: string,
    botId: string,
    requestedChainId?: string,
  ): Promise<WrapUpWorkflowResponse> {
    const bot = await this.findOwnedBot(userId, botId);
    const chainId = await this.resolveTargetChainId(userId, bot, requestedChainId, false);

    // Find every participating peer bot in this chain (excluding the coordinator itself).
    const participants = await this.chainParticipants(userId, chainId);
    const ownerBots = participants.filter((participant) => participant.id !== bot.id);
    const expectedOwners = ownerBots.map((owner) => owner.id);
    const deadline = expectedOwners.length === 0 ? null : new Date(Date.now() + this.deadlineMs);

    // Claim the ACTIVE -> WRAPPING_UP transition before saying anything. A
    // chain the user already stopped, closed, or is wrapping up must not be
    // revived: that would wake every past participant, and the fixed
    // per-owner deliveryKey would swallow a second round of prompts anyway.
    const wrapFields = {
      rootBotId: bot.id,
      groupId: bot.groupId,
      status: expectedOwners.length === 0 ? ('CLOSED' as const) : ('WRAPPING_UP' as const),
      expectedOwners,
      respondedOwners: [],
      closeoutPublished: false,
      deadlineAt: deadline,
      closedAt: expectedOwners.length === 0 ? new Date() : null,
    };
    const claimed = await this.prisma.workflowChainState.updateMany({
      where: { chainId, userId, status: 'ACTIVE' },
      data: wrapFields,
    });
    if (claimed.count === 0 && !(await this.createChainState(userId, chainId, wrapFields))) {
      const current = await this.prisma.workflowChainState.findFirst({
        where: { chainId, userId },
        select: { status: true },
      });
      if (current === null) throw new NotFoundException('No active workflow found for this bot.');
      throw new ConflictException({
        code: 'WORKFLOW_NOT_ACTIVE',
        status: current.status,
        message: 'This workflow is no longer active, so it cannot be wrapped up.',
      });
    }

    const ackText =
      expectedOwners.length === 0
        ? 'Wrapping up this workflow now. No other teammates are active on it — publishing closeout.'
        : `Wrapping up this workflow now. New delegation is paused; waiting on final deliverables and blockers from ${ownerBots.map((owner) => owner.name).join(', ')} (up to ${Math.max(1, Math.round(this.deadlineMs / 60_000))} min).`;

    const ackRow = await this.messages.createSystemMessage({
      botId: bot.id,
      content: ackText,
    });
    this.events.emitCreated(bot.id, { ...ackRow, attachments: [] });

    if (expectedOwners.length === 0) {
      await this.finalizeWrapUp(userId, chainId, 'all-responded');
      return {
        chainId,
        status: 'CLOSED',
        expectedOwners: [],
        deadlineAt: null,
        acknowledgedMessageId: ackRow.id,
      };
    }

    // Send exactly ONE bounded closeout prompt to each active owner.
    const prompt =
      `Workflow wrap-up requested by the user. New delegation is paused — do not message other teammates. ` +
      `Reply once to ${bot.name} with: (1) finished deliverables and artifact names/IDs, (2) any open blockers or unfinished items.`;
    for (const owner of ownerBots) {
      try {
        await this.queue.enqueue({
          userId,
          fromBotId: bot.id,
          toBotId: owner.id,
          toBotName: owner.name,
          content: prompt,
          chainId,
          hopCount: 1,
          expectReply: true,
          deliveryKey: `wrapup:${chainId}:${owner.id}`,
          wrapUpKind: 'request',
        });
      } catch (error) {
        this.logger.warn('workflow.wrapup.enqueue_failed', {
          chainId,
          ownerBotId: owner.id,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.scheduleDeadline(userId, chainId, this.deadlineMs);
    this.logger.info('workflow.wrapup.started', {
      userId,
      botId: bot.id,
      chainId,
      expectedOwners,
      deadlineAt: deadline?.toISOString() ?? null,
    });

    return {
      chainId,
      status: 'WRAPPING_UP',
      expectedOwners,
      deadlineAt: deadline?.toISOString() ?? null,
      acknowledgedMessageId: ackRow.id,
    };
  }

  /**
   * Gate checked by `send_message` before enqueuing a hop.
   * Stops new delegation on `STOPPED`, `CLOSED`, or `WRAPPING_UP` chains,
   * while permitting an expected wrap-up owner to reply once back to the root.
   */
  async canSend(
    userId: string,
    chainId: string,
    fromBotId: string,
    toBotId: string,
  ): Promise<ChainGateDecision> {
    const state = await this.prisma.workflowChainState.findFirst({
      where: { chainId, userId },
      select: { status: true, rootBotId: true, expectedOwners: true },
    });
    if (state === null || state.status === 'ACTIVE') return { allowed: true };
    if (state.status === 'STOPPED') {
      return {
        allowed: false,
        status: 'STOPPED',
        reason:
          'This workflow was stopped by the user, so nothing was sent. Do not delegate further work on this chain.',
      };
    }
    if (state.status === 'CLOSED') {
      return {
        allowed: false,
        status: 'CLOSED',
        reason: 'This workflow is already closed, so nothing was sent.',
      };
    }
    // WRAPPING_UP: only expected owners replying back to rootBotId are allowed.
    if (toBotId === state.rootBotId && state.expectedOwners.includes(fromBotId)) {
      return { allowed: true, wrapUp: true };
    }
    return {
      allowed: false,
      status: 'WRAPPING_UP',
      reason:
        'This workflow is wrapping up, so new delegation is paused. Return your finished deliverables and blockers directly.',
    };
  }

  /**
   * Gate checked by `BotMessageDeliveryService` before writing/triggering a job.
   * Survives BullMQ retries and worker restarts because it reads durable state.
   */
  async canDeliver(
    userId: string,
    chainId: string,
    fromBotId: string,
    toBotId: string,
    wrapUpKind?: 'request',
  ): Promise<ChainGateDecision> {
    const state = await this.prisma.workflowChainState.findFirst({
      where: { chainId, userId },
      select: { status: true, rootBotId: true, expectedOwners: true },
    });
    if (state === null || state.status === 'ACTIVE') return { allowed: true };
    if (state.status === 'STOPPED' || state.status === 'CLOSED') {
      return {
        allowed: false,
        status: state.status,
        reason: `chain-${state.status.toLowerCase()}`,
      };
    }
    // WRAPPING_UP: permit the coordinator's single closeout request OR an expected owner's reply back to root.
    if (
      wrapUpKind === 'request' &&
      fromBotId === state.rootBotId &&
      state.expectedOwners.includes(toBotId)
    ) {
      return { allowed: true, wrapUp: true };
    }
    if (toBotId === state.rootBotId && state.expectedOwners.includes(fromBotId)) {
      return { allowed: true, wrapUp: true };
    }
    return {
      allowed: false,
      status: 'WRAPPING_UP',
      reason: 'chain-wrapping-up',
    };
  }

  /**
   * Records an owner's wrap-up reply back to the coordinator; once every
   * expected owner has replied, publishes the closeout immediately.
   */
  async recordOwnerResponse(
    userId: string,
    chainId: string,
    ownerBotId: string,
  ): Promise<void> {
    const state = await this.prisma.workflowChainState.findFirst({
      where: { chainId, userId, status: 'WRAPPING_UP' },
      select: {
        chainId: true,
        expectedOwners: true,
        respondedOwners: true,
        closeoutPublished: true,
      },
    });
    if (state === null || state.closeoutPublished) return;
    if (!state.expectedOwners.includes(ownerBotId)) return;

    const nextResponded = state.respondedOwners.includes(ownerBotId)
      ? state.respondedOwners
      : [...state.respondedOwners, ownerBotId];

    await this.prisma.workflowChainState.updateMany({
      where: { chainId, userId, status: 'WRAPPING_UP' },
      data: { respondedOwners: nextResponded },
    });

    const allResponded = state.expectedOwners.every((id) => nextResponded.includes(id));
    if (allResponded) {
      await this.finalizeWrapUp(userId, chainId, 'all-responded');
    }
  }

  /**
   * Publishes the consolidated closeout at most once (when all owners respond
   * or when the 2-minute deadline fires), explicitly naming missing owners and
   * outstanding work, then marks the chain `CLOSED`.
   */
  async finalizeWrapUp(
    userId: string,
    chainId: string,
    reason: 'all-responded' | 'deadline',
  ): Promise<boolean> {
    this.clearTimer(chainId);
    const claimed = await this.prisma.workflowChainState.updateMany({
      where: {
        chainId,
        userId,
        closeoutPublished: false,
        status: { in: ['WRAPPING_UP', 'CLOSED'] },
      },
      data: {
        status: 'CLOSED',
        closeoutPublished: true,
        closedAt: new Date(),
      },
    });
    if (claimed.count === 0) return false;

    const state = await this.prisma.workflowChainState.findFirst({
      where: { chainId, userId },
      select: {
        rootBotId: true,
        expectedOwners: true,
        respondedOwners: true,
      },
    });
    if (state === null) return false;

    // Cancel any lingering runs still spinning in this chain after deadline.
    if (reason === 'deadline') {
      await this.cancelChainRuns(userId, chainId);
    }

    const ownerIds = state.expectedOwners;
    const ownerRows =
      ownerIds.length === 0
        ? []
        : await this.prisma.bot.findMany({
            where: { userId, id: { in: ownerIds } },
            select: { id: true, name: true },
          });
    const nameById = new Map(ownerRows.map((row) => [row.id, row.name]));
    const respondedSet = new Set(state.respondedOwners);
    const missingIds = ownerIds.filter((id) => !respondedSet.has(id));

    // Fetch latest closeout replies sent to rootBotId during this chain.
    const replies =
      state.respondedOwners.length === 0
        ? []
        : await this.prisma.message.findMany({
            where: {
              chainId,
              author: 'BOT',
              fromBotId: { in: state.respondedOwners },
              conversation: { botId: state.rootBotId, bot: { userId } },
            },
            orderBy: { sequence: 'desc' },
            select: { fromBotId: true, content: true },
          });
    const latestReplyByOwner = new Map<string, string>();
    for (const row of replies) {
      if (row.fromBotId !== null && !latestReplyByOwner.has(row.fromBotId)) {
        const clean = projectPublicSpeech(row.content).replace(/\s+/g, ' ').trim();
        latestReplyByOwner.set(row.fromBotId, clean.slice(0, 260));
      }
    }

    const lines: string[] = [];
    if (ownerIds.length === 0) {
      lines.push('Workflow closed. No other teammates had active work on this chain.');
    } else if (missingIds.length === 0) {
      lines.push(
        `Workflow closed — all ${ownerIds.length} teammates reported in.`,
      );
    } else {
      const missingNames = missingIds.map((id) => nameById.get(id) ?? id).join(', ');
      lines.push(
        `Workflow closed after the wrap-up deadline. Missing responses from: ${missingNames}. Any remaining work from those teammates is unfinished and was halted.`,
      );
    }

    for (const ownerId of state.respondedOwners) {
      const name = nameById.get(ownerId) ?? ownerId;
      const summary = latestReplyByOwner.get(ownerId);
      lines.push(`- ${name}: ${summary && summary !== '' ? summary : 'Reported complete.'}`);
    }
    for (const ownerId of missingIds) {
      const name = nameById.get(ownerId) ?? ownerId;
      lines.push(`- ${name}: No response before deadline (unfinished / halted).`);
    }

    const row = await this.messages.createSystemMessage({
      botId: state.rootBotId,
      content: lines.join('\n'),
    });
    this.events.emitCreated(state.rootBotId, { ...row, attachments: [] });
    this.logger.info('workflow.wrapup.closed', {
      userId,
      chainId,
      reason,
      responded: state.respondedOwners.length,
      missing: missingIds.length,
    });
    return true;
  }

  private scheduleDeadline(userId: string, chainId: string, delayMs: number): void {
    this.clearTimer(chainId);
    const timer = setTimeout(() => {
      this.timers.delete(chainId);
      void this.finalizeWrapUp(userId, chainId, 'deadline').catch((error: unknown) => {
        this.logger.warn('workflow.wrapup.deadline_failed', {
          chainId,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    }, Math.max(0, delayMs));
    timer.unref();
    this.timers.set(chainId, timer);
  }

  private clearTimer(chainId: string): void {
    const existing = this.timers.get(chainId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(chainId);
    }
  }

  private async armPendingDeadlines(): Promise<void> {
    const pending = await this.prisma.workflowChainState.findMany({
      where: { status: 'WRAPPING_UP', closeoutPublished: false },
      select: { chainId: true, userId: true, deadlineAt: true },
    });
    const now = Date.now();
    for (const row of pending) {
      const remaining = row.deadlineAt === null ? 0 : row.deadlineAt.getTime() - now;
      this.scheduleDeadline(row.userId, row.chainId, remaining);
    }
  }

  private async cancelChainRuns(
    userId: string,
    chainId: string,
  ): Promise<{ cancelledRuns: number; stoppedBotIds: string[] }> {
    const messages = await this.prisma.message.findMany({
      where: {
        OR: [{ id: chainId }, { chainId }],
        conversation: { bot: { userId } },
      },
      select: { id: true },
    });
    const triggerIds = messages.map((row) => row.id);
    if (triggerIds.length === 0) return { cancelledRuns: 0, stoppedBotIds: [] };

    const liveRuns = await this.prisma.agentTurn.findMany({
      where: {
        bot: { userId },
        triggerMessageId: { in: triggerIds },
        status: { in: ['running', 'interrupted'] },
      },
      select: { id: true, botId: true },
    });
    const stoppedBots = new Set<string>();
    for (const run of liveRuns) {
      this.turns.cancelRun(userId, run.botId, run.id);
      stoppedBots.add(run.botId);
    }
    return { cancelledRuns: liveRuns.length, stoppedBotIds: [...stoppedBots] };
  }

  private async chainParticipants(
    userId: string,
    chainId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const messages = await this.prisma.message.findMany({
      where: {
        OR: [{ id: chainId }, { chainId }],
        conversation: { bot: { userId } },
      },
      select: {
        fromBotId: true,
        conversation: { select: { botId: true } },
      },
    });
    const botIds = new Set<string>();
    for (const row of messages) {
      botIds.add(row.conversation.botId);
      if (row.fromBotId !== null) botIds.add(row.fromBotId);
    }
    if (botIds.size === 0) return [];
    return this.prisma.bot.findMany({
      where: { userId, id: { in: [...botIds] } },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private async resolveTargetChainId(
    userId: string,
    bot: { id: string; groupId: string | null },
    requestedChainId: string | undefined,
    allowInactiveFallback: boolean,
  ): Promise<string> {
    const scopeBotIds = await this.scopeBotIds(userId, bot);
    if (requestedChainId !== undefined) {
      // The id arrives in a request body, so it proves nothing by itself:
      // only a chain with a message in this account and in this bot's scope
      // may be stopped or wrapped up from here.
      await this.assertChainInScope(userId, scopeBotIds, requestedChainId);
      return requestedChainId;
    }
    const active = await this.discoverActiveChains(userId, scopeBotIds, bot.groupId);
    if (active.length > 1) {
      throw new ConflictException({
        code: 'WORKFLOW_AMBIGUOUS',
        message: 'Multiple workflows are active. Choose which workflow to close.',
        chains: active,
      });
    }
    if (active.length === 1) {
      return active[0]!.chainId;
    }
    // Fallback to the latest chain involving this bot (or its active run's trigger).
    const latestRun = await this.prisma.agentTurn.findFirst({
      where: { botId: bot.id, bot: { userId }, status: { in: ['running', 'interrupted'] } },
      orderBy: { sequence: 'desc' },
      select: { triggerMessageId: true },
    });
    if (latestRun !== null) {
      const trigger = await this.prisma.message.findFirst({
        where: { id: latestRun.triggerMessageId, conversation: { bot: { userId } } },
        select: { id: true, chainId: true },
      });
      if (trigger !== null) return trigger.chainId ?? trigger.id;
    }
    // Nothing is live. Stopping the most recent chain anyway is harmless, but
    // wrapping up a finished one would prompt every bot that ever took part.
    if (!allowInactiveFallback) {
      throw new NotFoundException('No active workflow found for this bot.');
    }
    const latestChainMsg = await this.prisma.message.findFirst({
      where: {
        chainId: { not: null },
        conversation: { botId: bot.id, bot: { userId } },
      },
      orderBy: { sequence: 'desc' },
      select: { chainId: true },
    });
    if (latestChainMsg?.chainId !== null && latestChainMsg?.chainId !== undefined) {
      return latestChainMsg.chainId;
    }
    const latestTrigger = await this.prisma.message.findFirst({
      where: {
        author: 'USER',
        conversation: { botId: bot.id, bot: { userId } },
      },
      orderBy: { sequence: 'desc' },
      select: { id: true },
    });
    if (latestTrigger !== null) return latestTrigger.id;
    throw new NotFoundException('No active workflow found for this bot.');
  }

  private async assertChainInScope(
    userId: string,
    scopeBotIds: readonly string[],
    chainId: string,
  ): Promise<void> {
    const inScope = { in: [...scopeBotIds] };
    const hit = await this.prisma.message.findFirst({
      where: {
        conversation: { bot: { userId } },
        OR: [
          { id: chainId, conversation: { botId: inScope } },
          { chainId, conversation: { botId: inScope } },
          { chainId, fromBotId: inScope },
        ],
      },
      select: { id: true },
    });
    if (hit === null) throw new NotFoundException('No active workflow found for this bot.');
  }

  /**
   * Creates this account's state row for a chain. False when the id already
   * has a row — written concurrently by this account, or by another one —
   * so callers never fall back to writing a row they do not own.
   */
  private async createChainState(
    userId: string,
    chainId: string,
    fields: ChainStateFields,
  ): Promise<boolean> {
    try {
      await this.prisma.workflowChainState.create({ data: { ...fields, chainId, userId } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  private async discoverActiveChains(
    userId: string,
    scopeBotIds: readonly string[],
    groupId: string | null,
  ): Promise<WorkflowChainSummary[]> {
    const liveRuns = await this.prisma.agentTurn.findMany({
      where: {
        botId: { in: [...scopeBotIds] },
        bot: { userId },
        status: { in: ['running', 'interrupted'] },
      },
      select: { botId: true, triggerMessageId: true, startedAt: true },
    });
    const triggerIds = [...new Set(liveRuns.map((run) => run.triggerMessageId))];
    const triggerRows =
      triggerIds.length === 0
        ? []
        : await this.prisma.message.findMany({
            where: { id: { in: triggerIds }, conversation: { bot: { userId } } },
            select: {
              id: true,
              chainId: true,
              createdAt: true,
              conversation: { select: { botId: true } },
            },
          });
    const triggerById = new Map(triggerRows.map((row) => [row.id, row]));

    // Discover persisted ACTIVE / WRAPPING_UP states in this scope.
    const persisted = await this.prisma.workflowChainState.findMany({
      where: {
        userId,
        status: { in: ['ACTIVE', 'WRAPPING_UP'] },
        ...(groupId !== null ? { OR: [{ groupId }, { rootBotId: { in: [...scopeBotIds] } }] } : { rootBotId: { in: [...scopeBotIds] } }),
      },
      orderBy: { updatedAt: 'desc' },
    });

    const chainMap = new Map<
      string,
      {
        status: WorkflowChainStatus;
        rootBotId: string;
        groupId: string | null;
        participantBotIds: Set<string>;
        activeBotIds: Set<string>;
        expectedOwners: string[];
        respondedOwners: string[];
        deadlineAt: string | null;
        startedAt: Date;
      }
    >();

    for (const row of persisted) {
      chainMap.set(row.chainId, {
        status: row.status,
        rootBotId: row.rootBotId,
        groupId: row.groupId,
        participantBotIds: new Set([row.rootBotId, ...row.expectedOwners]),
        activeBotIds: new Set(),
        expectedOwners: [...row.expectedOwners],
        respondedOwners: [...row.respondedOwners],
        deadlineAt: row.deadlineAt?.toISOString() ?? null,
        startedAt: row.createdAt,
      });
    }

    const candidateChainIds = new Set<string>(chainMap.keys());
    for (const run of liveRuns) {
      const trigger = triggerById.get(run.triggerMessageId);
      if (trigger === undefined) continue;
      const chainId = trigger.chainId ?? trigger.id;
      candidateChainIds.add(chainId);
      const existing = chainMap.get(chainId);
      if (existing === undefined) {
        chainMap.set(chainId, {
          status: 'ACTIVE',
          rootBotId: trigger.conversation.botId,
          groupId,
          participantBotIds: new Set([trigger.conversation.botId, run.botId]),
          activeBotIds: new Set([run.botId]),
          expectedOwners: [],
          respondedOwners: [],
          deadlineAt: null,
          startedAt: trigger.createdAt,
        });
      } else {
        existing.participantBotIds.add(run.botId);
        existing.activeBotIds.add(run.botId);
      }
    }

    if (candidateChainIds.size === 0) return [];

    // Exclude chains already persisted as STOPPED or CLOSED.
    const halted = await this.prisma.workflowChainState.findMany({
      where: {
        userId,
        chainId: { in: [...candidateChainIds] },
        status: { in: ['STOPPED', 'CLOSED'] },
      },
      select: { chainId: true },
    });
    const haltedIds = new Set(halted.map((row) => row.chainId));

    // Enrich participants for each candidate chain so multi-bot chains are recognized
    // even when only one bot is mid-run at this exact millisecond.
    const chainMessages = await this.prisma.message.findMany({
      where: {
        chainId: { in: [...candidateChainIds].filter((id) => !haltedIds.has(id)) },
        conversation: { bot: { userId } },
      },
      select: {
        chainId: true,
        fromBotId: true,
        conversation: { select: { botId: true } },
      },
    });
    for (const msg of chainMessages) {
      if (msg.chainId === null) continue;
      const entry = chainMap.get(msg.chainId);
      if (entry === undefined) continue;
      entry.participantBotIds.add(msg.conversation.botId);
      if (msg.fromBotId !== null) entry.participantBotIds.add(msg.fromBotId);
    }

    const result: WorkflowChainSummary[] = [];
    for (const [chainId, entry] of chainMap) {
      if (haltedIds.has(chainId)) continue;
      // Include WRAPPING_UP chains always, or ACTIVE chains that involve >1 bot (or are live).
      if (entry.status !== 'WRAPPING_UP' && entry.participantBotIds.size < 2) continue;
      result.push({
        chainId,
        status: entry.status,
        rootBotId: entry.rootBotId,
        groupId: entry.groupId,
        participantBotIds: [...entry.participantBotIds],
        activeBotIds: [...entry.activeBotIds],
        expectedOwners: entry.expectedOwners,
        respondedOwners: entry.respondedOwners,
        deadlineAt: entry.deadlineAt,
        startedAt: entry.startedAt.toISOString(),
      });
    }
    return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private async scopeBotIds(
    userId: string,
    bot: { id: string; groupId: string | null },
  ): Promise<string[]> {
    if (bot.groupId === null) return [bot.id];
    const members = await this.prisma.bot.findMany({
      where: { userId, groupId: bot.groupId },
      select: { id: true },
    });
    return members.length > 0 ? members.map((row) => row.id) : [bot.id];
  }

  private async findOwnedBot(
    userId: string,
    botId: string,
  ): Promise<{ id: string; name: string; groupId: string | null }> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: { id: true, name: true, groupId: true },
    });
    if (bot === null) throw new NotFoundException('Bot not found');
    return bot;
  }
}
