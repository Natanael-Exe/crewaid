import { randomUUID } from 'node:crypto';
import { Prisma, type AgentTurn } from '@prisma/client';
import { fromTranscriptRow } from './transcript.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

export const RUN_LEASE_MS = 30_000;
export const RUN_HEARTBEAT_MS = 10_000;
export const RUN_RECOVERY_BATCH_SIZE = 100;

export type RunScope = {
  readonly userId: string;
  readonly botId: string;
  readonly threadId: string;
};
/** Server-owned capability; never reconstructed from a client request. */
export type RunLease = RunScope & {
  readonly runId: string;
  readonly workerId: string;
  readonly epoch: number;
};
export class RunOwnershipError extends Error {
  constructor(readonly code: 'RUN_NOT_OWNED' | 'RUN_BUSY' | 'RUN_CONFLICT' | 'STALE_WORKER') {
    super(code);
    this.name = 'RunOwnershipError';
  }
}
export type RunClaim =
  | { readonly kind: 'joined'; readonly run: AgentTurn }
  | { readonly kind: 'claimed'; readonly lease: RunLease; readonly recovered: boolean };

/**
 * Scoped producer ownership, separate from library record creation and resume
 * admission. A lease cannot grant permission to repeat an external action.
 */
export class RunLeaseService {
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  constructor(
    private readonly prisma: PrismaService,
    timing: { leaseMs?: number; heartbeatMs?: number } = {},
  ) {
    this.leaseMs = timing.leaseMs ?? RUN_LEASE_MS;
    this.heartbeatMs = timing.heartbeatMs ?? RUN_HEARTBEAT_MS;
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      !Number.isSafeInteger(this.heartbeatMs) ||
      this.heartbeatMs <= 0 ||
      this.leaseMs <= this.heartbeatMs ||
      this.leaseMs > 2_147_483_647
    )
      throw new Error('Invalid execution lease timing.');
  }

  async claim(
    input: RunScope & { readonly runId: string; readonly triggerMessageId: string },
    options: { readonly recoverCancellation?: boolean } = {},
  ): Promise<RunClaim> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Fixed bot -> conversation -> run lock order. Two threads of one bot
        // cannot each acquire the unique active key while inspecting old work.
        const bots = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Bot" WHERE id = ${input.botId} AND "userId" = ${input.userId}
          FOR UPDATE`;
        if (bots.length !== 1) throw new RunOwnershipError('RUN_NOT_OWNED');
        await lockThread(tx, input);
        const active = await tx.agentTurn.findFirst({
          where: { activeKey: input.botId, botId: input.botId, bot: { userId: input.userId } },
          select: { id: true },
        });
        if (active !== null && active.id !== input.runId) throw new RunOwnershipError('RUN_BUSY');
        let run = await lockRun(tx, input, input.runId);
        if (run === null) {
          const pending = await tx.runInterrupt.count({
            where: {
              conversationId: input.threadId,
              userId: input.userId,
              status: 'pending',
              run: { botId: input.botId, bot: { userId: input.userId } },
            },
          });
          if (pending > 0) throw new RunOwnershipError('RUN_BUSY');
          const trigger = await tx.message.findFirst({
            where: {
              id: input.triggerMessageId,
              conversationId: input.threadId,
              conversation: { bot: { userId: input.userId, id: input.botId } },
            },
            select: {
              id: true,
              author: true,
              fromBotId: true,
              runId: true,
              parts: true,
              createdAt: true,
            },
          });
          const body = trigger === null ? undefined : fromTranscriptRow(trigger, input.botId);
          if (!body?.ok || body.value?.role !== 'user')
            throw new RunOwnershipError('RUN_NOT_OWNED');
          await tx.agentTurn.createMany({
            data: [
              {
                id: input.runId,
                botId: input.botId,
                conversationId: input.threadId,
                triggerMessageId: input.triggerMessageId,
              },
            ],
            skipDuplicates: true,
          });
          run = await lockRun(tx, input, input.runId);
          // A global ID collision remains opaque; no foreign record is returned.
          if (run === null) throw new RunOwnershipError('RUN_CONFLICT');
        }
        if (run.triggerMessageId !== input.triggerMessageId)
          throw new RunOwnershipError('RUN_CONFLICT');
        if (
          run.status !== 'running' ||
          (run.cancelRequested === true && options.recoverCancellation !== true)
        )
          return { kind: 'joined', run };
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        if (clock === undefined) throw new Error('PostgreSQL clock unavailable.');
        if (run.workerId !== null && run.leaseExpiresAt !== null && run.leaseExpiresAt > clock.now)
          return { kind: 'joined', run };
        // A canceled live owner acknowledges its own Stop. Once its lease
        // expires, recovery must own that acknowledgement or the bot stays busy.
        if (run.cancelRequested === true && run.workerId === null) return { kind: 'joined', run };
        if ((run.workerId === null) !== (run.leaseExpiresAt === null))
          throw new RunOwnershipError('STALE_WORKER');
        // A legacy producer has no execution lease and cannot be reclaimed.
        if (run.workerId === null && run.activeKey !== null)
          throw new RunOwnershipError('RUN_BUSY');
        const epoch = (run.driverEpoch ?? 0) + 1;
        if (!Number.isSafeInteger(epoch) || epoch <= 0 || epoch > 2_147_483_647)
          throw new RunOwnershipError('STALE_WORKER');
        const workerId = randomUUID();
        const claimed = await tx.agentTurn.updateMany({
          where: {
            id: input.runId,
            botId: input.botId,
            conversationId: input.threadId,
            status: 'running',
            bot: { userId: input.userId },
          },
          data: {
            activeKey: input.botId,
            driverEpoch: epoch,
            workerId,
            leaseExpiresAt: new Date(clock.now.getTime() + this.leaseMs),
          },
        });
        if (claimed.count !== 1) throw new RunOwnershipError('STALE_WORKER');
        return {
          kind: 'claimed',
          lease: Object.freeze({
            userId: input.userId,
            botId: input.botId,
            threadId: input.threadId,
            runId: input.runId,
            workerId,
            epoch,
          }),
          recovered: run.workerId !== null,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new RunOwnershipError('RUN_BUSY');
      throw error;
    }
  }

  /** Both the predicate and the new expiry use the database clock. */
  async renew(lease: RunLease): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "AgentTurn" r SET "leaseExpiresAt" = clock_timestamp() + ${this.leaseMs} * interval '1 millisecond'
      FROM "Bot" b, "Conversation" c
      WHERE r.id = ${lease.runId} AND r."botId" = b.id AND b.id = ${lease.botId}
        AND b."userId" = ${lease.userId} AND c.id = r."conversationId" AND c.id = ${lease.threadId}
        AND c."botId" = b.id AND r.status::text = 'running'
        AND r."cancelRequested" IS NOT TRUE
        AND r."activeKey" = ${lease.botId} AND r."workerId" = ${lease.workerId}
        AND r."driverEpoch" = ${lease.epoch} AND r."leaseExpiresAt" > clock_timestamp()`;
    return count === 1;
  }

  async assertLive(lease: RunLease): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockThread(tx, lease);
      await assertRunLease(tx, lease);
    });
  }

  /** Server lifecycle discovery only. Each candidate still needs claim and recovery admission. */
  async expiredCandidates(
    limit = RUN_RECOVERY_BATCH_SIZE,
  ): Promise<Array<RunScope & { readonly runId: string; readonly triggerMessageId: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUN_RECOVERY_BATCH_SIZE)
      throw new Error('Invalid execution recovery batch size.');
    return this.prisma.$queryRaw`
      SELECT b."userId", b.id AS "botId", c.id AS "threadId",
        r.id AS "runId", r."triggerMessageId"
      FROM "AgentTurn" r JOIN "Bot" b ON b.id = r."botId"
      JOIN "Conversation" c ON c.id = r."conversationId" AND c."botId" = b.id
      WHERE r.status::text = 'running'
        AND r."workerId" IS NOT NULL AND r."leaseExpiresAt" <= clock_timestamp()
      ORDER BY r."leaseExpiresAt", r.id LIMIT ${limit}`;
  }

  /** An abandoned producer becomes reclaimable; it has not completed. */
  async release(lease: RunLease): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "AgentTurn" r SET "leaseExpiresAt" = clock_timestamp() - interval '1 millisecond'
      FROM "Bot" b
      WHERE r.id = ${lease.runId} AND r."botId" = ${lease.botId} AND r."conversationId" = ${lease.threadId}
        AND b.id = r."botId" AND b."userId" = ${lease.userId} AND r.status::text = 'running'
        AND r."workerId" = ${lease.workerId} AND r."driverEpoch" = ${lease.epoch}`;
    return count === 1;
  }

  async finish(
    lease: RunLease,
    next: 'completed' | 'failed' | 'aborted' | 'interrupted',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockThread(tx, lease);
      // Cancellation revokes dispatch immediately, but the current producer
      // must still be able to acknowledge it with an owned abort.
      await assertRunLeaseState(tx, lease, next === 'aborted');
      const changed = await tx.agentTurn.updateMany({
        where: {
          id: lease.runId,
          botId: lease.botId,
          conversationId: lease.threadId,
          workerId: lease.workerId,
          driverEpoch: lease.epoch,
          bot: { userId: lease.userId },
        },
        data: {
          status: next,
          activeKey: null,
          workerId: null,
          leaseExpiresAt: null,
          ...(next === 'interrupted' ? {} : { endedAt: new Date() }),
        },
      });
      if (changed.count !== 1) throw new RunOwnershipError('STALE_WORKER');
    });
  }

  /** Stop is awaited so no pending renewal can revive the released owner. */
  heartbeat(
    lease: RunLease,
    onLost: (error: RunOwnershipError) => void,
  ): { stop: () => Promise<void> } {
    let closed = false;
    let pending: Promise<void> | undefined;
    const lost = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      onLost(new RunOwnershipError('STALE_WORKER'));
    };
    const timer = setInterval(() => {
      if (closed || pending !== undefined) return;
      pending = this.renew(lease)
        .then((ok) => {
          if (!ok) lost();
        }, lost)
        .finally(() => {
          pending = undefined;
        });
    }, this.heartbeatMs);
    timer.unref();
    return {
      stop: async () => {
        closed = true;
        clearInterval(timer);
        await pending;
      },
    };
  }
}

/** Call inside the same transaction as every leased store write. */
export async function assertRunLease(tx: Prisma.TransactionClient, lease: RunLease): Promise<void> {
  await assertRunLeaseState(tx, lease, false);
}

/** Acknowledging cancellation is permitted only while flushing the captured producer's abort. */
export async function assertAbortRunLease(
  tx: Prisma.TransactionClient,
  lease: RunLease,
): Promise<void> {
  await assertRunLeaseState(tx, lease, true);
}

async function assertRunLeaseState(
  tx: Prisma.TransactionClient,
  lease: RunLease,
  allowCanceled: boolean,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT r.id FROM "AgentTurn" r
    JOIN "Bot" b ON b.id = r."botId"
    JOIN "Conversation" c ON c.id = r."conversationId" AND c."botId" = b.id
    WHERE r.id = ${lease.runId} AND b.id = ${lease.botId} AND b."userId" = ${lease.userId}
      AND c.id = ${lease.threadId}
      AND r.status::text = 'running' AND r."activeKey" = ${lease.botId}
      AND (${allowCanceled} OR r."cancelRequested" IS NOT TRUE)
      AND r."workerId" = ${lease.workerId} AND r."driverEpoch" = ${lease.epoch}
      AND r."leaseExpiresAt" > clock_timestamp()
    FOR UPDATE OF r`;
  if (rows.length !== 1) throw new RunOwnershipError('STALE_WORKER');
}

async function lockThread(tx: Prisma.TransactionClient, scope: RunScope): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM "Conversation" c
    JOIN "Bot" b ON b.id = c."botId"
    WHERE c.id = ${scope.threadId} AND b.id = ${scope.botId} AND b."userId" = ${scope.userId}
    FOR UPDATE OF c`;
  if (rows.length !== 1) throw new RunOwnershipError('RUN_NOT_OWNED');
}

async function lockRun(
  tx: Prisma.TransactionClient,
  scope: RunScope,
  runId: string,
): Promise<AgentTurn | null> {
  // Renewal updates the run too. Lock before reading expiry so a renewal
  // cannot land between an old snapshot and an otherwise healthy takeover.
  const rows = await tx.$queryRaw<AgentTurn[]>`
    SELECT r.* FROM "AgentTurn" r JOIN "Bot" b ON b.id = r."botId"
    WHERE r.id = ${runId} AND b.id = ${scope.botId} AND b."userId" = ${scope.userId}
      AND r."conversationId" = ${scope.threadId} FOR UPDATE OF r`;
  return rows[0] ?? null;
}
