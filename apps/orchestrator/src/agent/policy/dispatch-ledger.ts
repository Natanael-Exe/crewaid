import { createHash } from 'node:crypto';
import type { Json } from '@crewaid/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { policyHash } from './policy.js';

/** What a dispatch is known to have done. */
export type DispatchOutcome = 'COMMITTED' | 'REFUSED' | 'UNCERTAIN';

/** The answer to "may this call run?": it may, or it already ran (or started to). */
export type DispatchReservation =
  | { readonly kind: 'reserved'; readonly id: string }
  | { readonly kind: 'existing'; readonly status: DispatchOutcome | 'DISPATCHED' };

/** D-197's ledger as the policy runtime sees it. */
export type DispatchLedger = {
  /** Insert-if-absent before the tool runs. `existing` means it must not run. */
  readonly reserve: (call: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly effect: string;
    readonly args: Json;
  }) => Promise<DispatchReservation>;
  readonly settle: (id: string, outcome: DispatchOutcome, reference?: string) => Promise<void>;
  /** A dispatch nobody settled, found again: it is not known to have happened or not. */
  readonly abandon: (toolCallId: string) => Promise<void>;
};

/**
 * The Prisma ledger for one run. A lease, when the run has one, fences the
 * reservation: a worker that lost its run cannot start an effect in it.
 */
export function createDispatchLedger(
  prisma: PrismaService,
  scope: {
    readonly userId: string;
    readonly conversationId: string;
    readonly runId: string;
  },
  lease?: { readonly workerId: string; readonly epoch: number },
): DispatchLedger {
  const owned = { conversationId: scope.conversationId, userId: scope.userId };
  return {
    async reserve(call) {
      return prisma.$transaction(async (tx) => {
        const live = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r.id FROM "AgentTurn" r JOIN "Conversation" c ON c.id = r."conversationId"
          JOIN "Bot" b ON b.id = c."botId"
          WHERE r.id = ${scope.runId} AND c.id = ${scope.conversationId}
            AND b."userId" = ${scope.userId}
            AND (${lease === undefined}
              OR (r."workerId" = ${lease?.workerId ?? ''} AND r."driverEpoch" = ${lease?.epoch ?? -1}
                AND r."leaseExpiresAt" > clock_timestamp()))
          FOR UPDATE OF r`;
        if (live.length !== 1)
          throw new Error(
            'STALE_WORKER: this run is no longer owned here; nothing was dispatched.',
          );
        const inserted = await tx.toolDispatch.createMany({
          data: {
            runId: scope.runId,
            ...owned,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            effect: call.effect,
            argsDigest: createHash('sha256').update(policyHash(call.args)).digest('hex'),
          },
          skipDuplicates: true,
        });
        const row = await tx.toolDispatch.findFirstOrThrow({
          where: { ...owned, toolCallId: call.toolCallId },
          select: { id: true, status: true },
        });
        return inserted.count === 1
          ? { kind: 'reserved' as const, id: row.id }
          : { kind: 'existing' as const, status: row.status };
      });
    },
    async settle(id, outcome, reference) {
      await prisma.toolDispatch.updateMany({
        where: { id, ...owned, status: 'DISPATCHED' },
        data: {
          status: outcome,
          settledAt: new Date(),
          ...(reference === undefined ? {} : { reference }),
        },
      });
    },
    async abandon(toolCallId) {
      await prisma.toolDispatch.updateMany({
        where: { ...owned, toolCallId, status: 'DISPATCHED' },
        data: { status: 'UNCERTAIN', settledAt: new Date() },
      });
    },
  };
}
