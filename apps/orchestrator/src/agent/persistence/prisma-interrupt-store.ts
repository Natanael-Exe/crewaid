import { Prisma, type RunInterrupt } from '@prisma/client';
import {
  defineInterruptStore,
  type InterruptStore,
  type InterruptCommitEntry,
} from '@tanstack/ai-persistence';
import { JsonSchema } from '@crewaid/shared';
import { z } from 'zod';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { toInterruptRecord } from './transcript.js';

export type CreateInterrupt = Parameters<InterruptStore['create']>[0];
/** These callbacks are server capabilities, never fields accepted from a request. */
export type InterruptStoreAuthority = {
  readonly transaction: <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  readonly locateProposal: (
    tx: Prisma.TransactionClient,
    input: CreateInterrupt,
  ) => Promise<string>;
  readonly assertAttach: (
    tx: Prisma.TransactionClient,
    row: RunInterrupt,
    input: CreateInterrupt,
  ) => Promise<void>;
  readonly assertCommit: (
    tx: Prisma.TransactionClient,
    row: RunInterrupt,
    entry: InterruptCommitEntry,
  ) => Promise<void>;
};
export class InterruptStoreError extends Error {
  constructor(
    readonly code:
      | 'INTERRUPT_NOT_ADMITTED'
      | 'INTERRUPT_CONFLICT'
      | 'INVALID_INTERRUPT'
      | 'INVALID_INTERRUPT_BATCH',
  ) {
    super(code);
    this.name = 'InterruptStoreError';
  }
}
const payloadSchema = z.record(z.string(), JsonSchema);
const timestampSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);
const entrySchema = z.discriminatedUnion('status', [
  z
    .object({
      interruptId: z.string().min(1),
      status: z.literal('resolved'),
      response: JsonSchema.optional(),
    })
    .strict(),
  z.object({ interruptId: z.string().min(1), status: z.literal('cancelled') }).strict(),
]);

/** Native storage is a facet of an existing policy proposal, never a second approval ledger. */
export function createPrismaInterruptStore(
  prisma: PrismaService,
  scope: { readonly userId: string },
  authority: InterruptStoreAuthority,
) {
  const owned = {
    userId: scope.userId,
    conversation: { bot: { userId: scope.userId } },
    run: { bot: { userId: scope.userId } },
  };
  const native = { ...owned, nativeInterruptId: { not: null } };
  const orderBy = [{ nativeRequestedAt: 'asc' as const }, { sequence: 'asc' as const }];

  async function lockRows(
    tx: Prisma.TransactionClient,
    targets: RunInterrupt[],
  ): Promise<RunInterrupt[]> {
    for (const threadId of [...new Set(targets.map((row) => row.conversationId))].sort()) {
      const threads = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM "Conversation" c JOIN "Bot" b ON b.id = c."botId"
        WHERE c.id = ${threadId} AND b."userId" = ${scope.userId} FOR UPDATE OF c`;
      if (threads.length !== 1) throw new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
    }
    // Follow thread -> run -> proposal order; callbacks must not acquire an earlier lock.
    for (const runId of [...new Set(targets.map((row) => row.runId))].sort()) {
      const runs = await tx.$queryRaw<Array<{ id: string; conversationId: string }>>`
        SELECT r.id, r."conversationId" FROM "AgentTurn" r
        JOIN "Bot" b ON b.id = r."botId"
        JOIN "Conversation" c ON c.id = r."conversationId" AND c."botId" = b.id
        WHERE r.id = ${runId} AND b."userId" = ${scope.userId} FOR UPDATE OF r`;
      if (
        runs.length !== 1 ||
        targets.some((row) => row.runId === runId && row.conversationId !== runs[0]?.conversationId)
      )
        throw new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
    }
    const result: RunInterrupt[] = [];
    for (const target of [...targets].sort((a, b) => a.id.localeCompare(b.id))) {
      const rows = await tx.$queryRaw<RunInterrupt[]>`
        SELECT i.* FROM "RunInterrupt" i
        JOIN "AgentTurn" r ON r.id = i."runId" AND r."conversationId" = i."conversationId"
        JOIN "Bot" b ON b.id = r."botId"
        JOIN "Conversation" c ON c.id = i."conversationId" AND c."botId" = b.id
        WHERE i.id = ${target.id} AND i."userId" = ${scope.userId}
          AND b."userId" = ${scope.userId} FOR UPDATE OF i`;
      const row = rows[0];
      if (row === undefined) throw new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
      result.push(row);
    }
    return result;
  }

  function record(row: RunInterrupt) {
    const result = toInterruptRecord(row);
    if (!result.ok) throw new InterruptStoreError('INVALID_INTERRUPT');
    return result.value;
  }
  async function terminal(
    entries: ReadonlyArray<InterruptCommitEntry>,
    strict: boolean,
  ): Promise<void> {
    if (entries.length === 0) return;
    if (new Set(entries.map((entry) => entry.interruptId)).size !== entries.length)
      throw new InterruptStoreError('INVALID_INTERRUPT_BATCH');
    await authority.transaction(async (tx) => {
      const targets = await tx.runInterrupt.findMany({
        where: { ...native, nativeInterruptId: { in: entries.map((entry) => entry.interruptId) } },
      });
      if (targets.length !== entries.length) {
        if (!strict) return;
        throw new InterruptStoreError('INVALID_INTERRUPT_BATCH');
      }
      const rows = await lockRows(tx, targets);
      if (rows.some((row) => row.nativeStatus !== 'pending')) {
        if (!strict) return;
        throw new InterruptStoreError('INVALID_INTERRUPT_BATCH');
      }
      const writes = entries.map((entry) => {
        const row = rows.find((item) => item.nativeInterruptId === entry.interruptId);
        if (row === undefined) throw new InterruptStoreError('INVALID_INTERRUPT_BATCH');
        record(row);
        return { row, entry: entrySchema.parse(entry) };
      });
      for (const { row, entry } of writes) await authority.assertCommit(tx, row, entry);
      for (const { row, entry } of writes) {
        const response =
          entry.status === 'resolved' && entry.response !== undefined
            ? { value: entry.response }
            : Prisma.DbNull;
        const changed = await tx.runInterrupt.updateMany({
          where: {
            ...native,
            id: row.id,
            nativeInterruptId: entry.interruptId,
            nativeStatus: 'pending',
          },
          data: {
            nativeStatus: entry.status,
            nativeResolvedAt: new Date(),
            nativeResponse: response,
          },
        });
        if (changed.count !== 1) throw new InterruptStoreError('INVALID_INTERRUPT_BATCH');
      }
    });
  }

  return defineInterruptStore({
    async create(input: CreateInterrupt) {
      try {
        await authority.transaction(async (tx) => {
          const existing = await tx.runInterrupt.findFirst({
            where: { ...native, nativeInterruptId: input.interruptId },
          });
          if (existing !== null) return;
          if (!input.interruptId || !input.runId || !input.threadId)
            throw new InterruptStoreError('INVALID_INTERRUPT');
          const proposalId = await authority.locateProposal(tx, input);
          const target = await tx.runInterrupt.findFirst({
            where: { ...owned, id: proposalId, runId: input.runId, conversationId: input.threadId },
          });
          if (target === null) throw new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
          const [row] = await lockRows(tx, [target]);
          if (row?.nativeInterruptId === input.interruptId) return;
          if (row === undefined || row.nativeInterruptId !== null || row.status !== 'pending')
            throw new InterruptStoreError('INTERRUPT_CONFLICT');
          const payload = payloadSchema.parse(input.payload);
          const requestedAt = new Date(timestampSchema.parse(input.requestedAt));
          const response =
            input.response === undefined
              ? Prisma.DbNull
              : { value: JsonSchema.parse(input.response) };
          await authority.assertAttach(tx, row, input);
          const changed = await tx.runInterrupt.updateMany({
            where: { ...owned, id: row.id, status: 'pending', nativeInterruptId: null },
            data: {
              nativeInterruptId: input.interruptId,
              nativePayload: payload,
              nativeResponse: response,
              nativeStatus: 'pending',
              nativeRequestedAt: requestedAt,
            },
          });
          if (changed.count !== 1) throw new InterruptStoreError('INTERRUPT_CONFLICT');
        });
      } catch (error) {
        // Global collisions disclose neither the foreign proposal nor its owner.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw new InterruptStoreError('INTERRUPT_CONFLICT');
        throw error;
      }
    },
    resolve: (interruptId: string, response?: unknown) =>
      terminal(
        [{ interruptId, status: 'resolved', ...(response === undefined ? {} : { response }) }],
        false,
      ),
    cancel: (interruptId: string) => terminal([{ interruptId, status: 'cancelled' }], false),
    commitBatch: (entries: ReadonlyArray<InterruptCommitEntry>) => terminal(entries, true),
    async get(interruptId: string) {
      const row = await prisma.runInterrupt.findFirst({
        where: { ...native, nativeInterruptId: interruptId },
      });
      return row === null ? null : record(row);
    },
    async list(threadId: string) {
      return (
        await prisma.runInterrupt.findMany({
          where: { ...native, conversationId: threadId },
          orderBy,
        })
      ).map(record);
    },
    async listPending(threadId: string) {
      return (
        await prisma.runInterrupt.findMany({
          where: { ...native, conversationId: threadId, nativeStatus: 'pending' },
          orderBy,
        })
      ).map(record);
    },
    async listByRun(runId: string) {
      return (await prisma.runInterrupt.findMany({ where: { ...native, runId }, orderBy })).map(
        record,
      );
    },
    async listPendingByRun(runId: string) {
      return (
        await prisma.runInterrupt.findMany({
          where: { ...native, runId, nativeStatus: 'pending' },
          orderBy,
        })
      ).map(record);
    },
  });
}
