import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, AgentTurn } from '@prisma/client';
import type { RunStore } from '@tanstack/ai';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  assertRunLease,
  assertAbortRunLease,
  RunOwnershipError,
  type RunLease,
} from './run-lease.js';
import { assertLeasedRunWrite } from './prisma-run-store.js';

export type ClosingRunStatus = 'completed' | 'interrupted' | 'failed' | 'aborted';
type RunPatch = Parameters<RunStore['update']>[1];
type Context = {
  readonly tx: Prisma.TransactionClient;
  readonly next: ClosingRunStatus;
  open: boolean;
  pending: number;
  failed: boolean;
  failure?: unknown;
};

/** A private, short database boundary for one captured producer. Never wraps external work. */
export class OwnedRunBoundary {
  private readonly storage = new AsyncLocalStorage<Context>();
  private readonly lease: RunLease;

  constructor(
    private readonly prisma: PrismaService,
    lease: RunLease,
  ) {
    this.lease = Object.freeze({ ...lease });
  }

  /** Store operations join a closing transaction; ordinary checkpoints use their own transaction. */
  readonly transaction = async <T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> => {
    const context = this.storage.getStore();
    if (context === undefined) return this.prisma.$transaction(operation);
    this.requireOpen(context);
    context.pending++;
    try {
      return await operation(context.tx);
    } catch (error) {
      context.failed = true;
      context.failure ??= error;
      throw error;
    } finally {
      context.pending--;
    }
  };

  readonly fence = async (tx: Prisma.TransactionClient): Promise<void> => {
    const context = this.storage.getStore();
    if (context === undefined) return assertRunLease(tx, this.lease);
    this.requireOpen(context, tx);
    await this.assertCapturedWrite(tx, context.next);
  };

  readonly assertLive = (): Promise<void> => this.transaction(this.fence);

  readonly assertWrite = async (
    tx: Prisma.TransactionClient,
    row: AgentTurn,
    patch: RunPatch,
  ): Promise<void> => {
    const context = this.storage.getStore();
    if (context === undefined) {
      // A producer cannot close through an independent store transaction.
      if (patch.status !== undefined && patch.status !== 'running') throw stale();
      return assertLeasedRunWrite(tx, row, patch, this.lease);
    }
    this.requireOpen(context, tx);
    if (
      row.id !== this.lease.runId ||
      row.botId !== this.lease.botId ||
      row.conversationId !== this.lease.threadId ||
      (patch.status !== undefined && patch.status !== context.next) ||
      (Object.hasOwn(patch, 'driverEpoch') && patch.driverEpoch !== this.lease.epoch) ||
      (Object.hasOwn(patch, 'cancelRequested') && patch.cancelRequested !== true)
    )
      throw stale();
    await this.assertCapturedWrite(tx, context.next);
  };

  readonly close = async <T>(next: ClosingRunStatus, operation: () => Promise<T>): Promise<T> => {
    if (this.storage.getStore() !== undefined) throw stale();
    const lease = this.lease;
    return this.prisma.$transaction(async (tx) => {
      // Match producer claim ordering so another thread cannot race active-key release.
      const bots = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Bot" WHERE id = ${lease.botId} AND "userId" = ${lease.userId} FOR UPDATE`;
      const threads = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM "Conversation" c JOIN "Bot" b ON b.id = c."botId"
        WHERE c.id = ${lease.threadId} AND b.id = ${lease.botId}
          AND b."userId" = ${lease.userId} FOR UPDATE OF c`;
      if (bots.length !== 1 || threads.length !== 1) throw stale();
      if (next === 'aborted') await assertAbortRunLease(tx, lease);
      else await assertRunLease(tx, lease);
      const context: Context = { tx, next, open: true, pending: 0, failed: false };
      const result = await this.storage.run(context, async () => {
        try {
          return await operation();
        } finally {
          // Inherited timers/promises must not retain authority after this callback.
          context.open = false;
        }
      });
      if (context.failed) throw context.failure;
      if (context.pending !== 0) throw stale();
      const changed = await tx.$executeRaw`
        UPDATE "AgentTurn" r SET "activeKey" = NULL, "workerId" = NULL,
          "leaseExpiresAt" = NULL, "detachedSince" = NULL,
          "endedAt" = CASE WHEN ${next} = 'interrupted' THEN NULL
            ELSE COALESCE(r."endedAt", clock_timestamp()) END
        FROM "Bot" b, "Conversation" c
        WHERE r.id = ${lease.runId} AND r."botId" = ${lease.botId}
          AND b.id = r."botId" AND b."userId" = ${lease.userId}
          AND c.id = r."conversationId" AND c.id = ${lease.threadId}
          AND c."botId" = b.id
          AND r.status::text = ${next} AND r."workerId" = ${lease.workerId}
          AND r."driverEpoch" = ${lease.epoch} AND r."leaseExpiresAt" > clock_timestamp()
          AND (${next === 'aborted'} OR r."cancelRequested" IS NOT TRUE)`;
      if (changed !== 1) throw stale();
      return result;
    });
  };

  private requireOpen(context: Context, tx?: Prisma.TransactionClient): void {
    if (!context.open || (tx !== undefined && tx !== context.tx)) throw stale();
  }

  private async assertCapturedWrite(
    tx: Prisma.TransactionClient,
    next: ClosingRunStatus,
  ): Promise<void> {
    const lease = this.lease;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT r.id FROM "AgentTurn" r JOIN "Bot" b ON b.id = r."botId"
      JOIN "Conversation" c ON c.id = r."conversationId" AND c."botId" = b.id
      WHERE r.id = ${lease.runId} AND b.id = ${lease.botId} AND b."userId" = ${lease.userId}
        AND c.id = ${lease.threadId}
        AND ((r.status::text = 'running' AND r."activeKey" = ${lease.botId})
          OR (r.status::text = ${next} AND r."activeKey" IS NULL))
        AND r."workerId" = ${lease.workerId} AND r."driverEpoch" = ${lease.epoch}
        AND r."leaseExpiresAt" > clock_timestamp()
        AND (${next === 'aborted'} OR r."cancelRequested" IS NOT TRUE)
      FOR UPDATE OF r`;
    if (rows.length !== 1) throw stale();
  }
}

function stale(): RunOwnershipError {
  return new RunOwnershipError('STALE_WORKER');
}
