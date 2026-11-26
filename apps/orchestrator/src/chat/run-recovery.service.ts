import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { ToolApprovalHub } from '../agent/policy/approval-hub.js';
import { CodingRunStoreService } from '../agent/coding/coding-run-store.service.js';
import { TURN_BOT_SELECT } from '../agent/turn-assembly.js';
import {
  cancelPendingToolResults,
  readAdmittedResume,
  recoverExpiredRuns,
} from '../agent/persistence/owned-tanstack-persistence.js';
import {
  RUN_HEARTBEAT_MS,
  RunLeaseService,
  type RunLease,
} from '../agent/persistence/run-lease.js';
import { OwnedRunBoundary } from '../agent/persistence/owned-run-boundary.js';
import { closeCancelledRunLog } from '../agent/persistence/run-event-log.js';
import { RunEventWakeupsService } from './run-event-wakeups.service.js';
import type { RunStarter, StatusWriter } from './chat-run.types.js';

export type RecoveryHooks = {
  readonly start: RunStarter;
  readonly writeStatus: StatusWriter;
};

/**
 * Reclaims expired run leases after crashes or quick restarts, either
 * re-dispatching the leased run or closing canceled/closed-log rows cleanly.
 */
@Injectable()
export class RunRecoveryService implements OnModuleDestroy {
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;
  private recoverySweep: Promise<void> | undefined;
  private readonly leases: RunLeaseService;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(RunEventWakeupsService) private readonly wakeups: RunEventWakeupsService,
    @Inject(ToolApprovalHub) private readonly approvalHub: ToolApprovalHub,
    @Optional() @Inject(CodingRunStoreService) private readonly codingRuns?: CodingRunStoreService,
  ) {
    this.leases = new RunLeaseService(prisma);
  }

  /**
   * Start periodic recovery after boot. A quick restart can precede lease
   * expiry, so the boot pass alone cannot release every abandoned fence.
   */
  async startRecovery(hooks: RecoveryHooks): Promise<void> {
    await this.recoverAbandonedRuns(hooks);
    if (this.recoveryTimer !== undefined) return;
    this.recoveryTimer = setInterval(() => {
      void this.recoverAbandonedRuns(hooks).catch((error: unknown) => {
        this.logger.warn('turn.recovery.failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
    }, RUN_HEARTBEAT_MS);
    this.recoveryTimer.unref();
  }

  /** Stop the periodic timer and wait for any in-flight sweep to finish. */
  async stop(): Promise<void> {
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.recoverySweep;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Coalesce overlapping recovery passes onto a single in-flight promise. */
  recoverAbandonedRuns(hooks: RecoveryHooks): Promise<void> {
    this.recoverySweep ??= this.sweepAbandonedRuns(hooks).finally(() => {
      this.recoverySweep = undefined;
    });
    return this.recoverySweep;
  }

  /** Rebuild owned input; the producer fences checkpoints and effect replay. */
  private async sweepAbandonedRuns(hooks: RecoveryHooks): Promise<void> {
    const result = await recoverExpiredRuns({
      leases: this.leases,
      resume: async (lease) => {
        await this.codingRuns
          ?.reconcileAbandonedForRun(lease.userId, lease.botId, lease.runId)
          .catch(() => undefined);
        const run = await this.prisma.agentTurn.findFirstOrThrow({
          where: {
            id: lease.runId,
            botId: lease.botId,
            conversationId: lease.threadId,
            bot: { userId: lease.userId },
          },
          select: {
            triggerMessageId: true,
            cancelRequested: true,
            resumesRunId: true,
            eventsClosedAt: true,
          },
        });
        if (run.cancelRequested === true) {
          await this.settleCanceledRecovery(lease, run.resumesRunId);
          return;
        }
        if (run.eventsClosedAt !== null) {
          // A closed log cannot accept another producer; settle once rather
          // than reclaiming the broken row every lease TTL.
          await this.leases.finish(lease, 'failed');
          await this.approvalHub.finishRun(lease.userId, lease.runId);
          await hooks.writeStatus(lease.botId, 'ERROR');
          this.logger.warn('turn.recovery.closed-log', { runId: lease.runId });
          return;
        }
        const admitted = await readAdmittedResume(this.prisma, lease);
        const bot = await this.prisma.bot.findFirstOrThrow({
          where: { id: lease.botId, userId: lease.userId },
          select: TURN_BOT_SELECT,
        });
        const trigger = await this.prisma.message.findFirstOrThrow({
          where: {
            id: run.triggerMessageId,
            conversationId: lease.threadId,
            conversation: { bot: { id: lease.botId, userId: lease.userId } },
          },
          select: { id: true, content: true, chainId: true, hopCount: true },
        });
        // Detached as at ordinary admission so the producer owns its heartbeat,
        // closing transaction, delivery log, and sidebar status.
        void hooks.start(lease, bot, {
          triggerMessageId: trigger.id,
          triggerContent: trigger.content,
          chainId: trigger.chainId,
          hopCount: trigger.hopCount,
          ...(admitted === null
            ? {}
            : { parentRunId: admitted.parentRunId, resume: admitted.batch }),
        });
        this.logger.info('turn.recovery.started', {
          runId: lease.runId,
          admittedBatch: admitted !== null,
        });
      },
    });
    if (result.recovered > 0 || result.failed > 0)
      this.logger.info('turn.recovery.swept', {
        recovered: result.recovered,
        failed: result.failed,
      });
  }

  /** A dead worker cannot acknowledge Stop; recovery closes it without dispatch. */
  private async settleCanceledRecovery(lease: RunLease, parentRunId: string | null): Promise<void> {
    const boundary = new OwnedRunBoundary(this.prisma, lease);
    await boundary.close('aborted', () =>
      boundary.transaction(async (tx) => {
        await boundary.fence(tx);
        await cancelPendingToolResults(this.prisma, lease, parentRunId, boundary);
        await tx.runInterrupt.updateMany({
          where: {
            runId: { in: parentRunId === null ? [lease.runId] : [lease.runId, parentRunId] },
            userId: lease.userId,
            conversationId: lease.threadId,
            OR: [{ status: 'pending' }, { nativeStatus: 'pending' }],
          },
          data: {
            status: 'cancelled',
            nativeStatus: 'cancelled',
            resolvedAt: new Date(),
            nativeResolvedAt: new Date(),
          },
        });
        await tx.agentTurn.updateMany({
          where: { id: lease.runId, botId: lease.botId, bot: { userId: lease.userId } },
          data: { status: 'aborted' },
        });
        // close holds the bot lock until its active key is released, so a new
        // producer cannot race this status repair.
        await tx.bot.updateMany({
          where: { id: lease.botId, userId: lease.userId },
          data: { status: 'IDLE' },
        });
      }),
    );
    await closeCancelledRunLog(this.prisma, lease, this.wakeups);
    this.events.emitBotStatus(lease.botId, 'IDLE');
  }
}
