import { Prisma, type AgentTurn } from '@prisma/client';
import {
  defineRunStore,
  isRunStatus,
  type RunError,
  type RunRecord,
  type RunStore,
} from '@tanstack/ai';
import { z } from 'zod';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { fromTranscriptRow, toRunRecord } from './transcript.js';
import { RunUsageSchema } from './run-usage.js';
import { normalizeRunError } from '../../models/normalize-error.js';
import { assertRunLease, RunOwnershipError, type RunLease } from './run-lease.js';

export type RunAdmission = {
  readonly botId: string;
  readonly threadId: string;
  readonly triggerMessageId: string;
};
type CreateRun = Parameters<RunStore['createOrResume']>[0];
type RunPatch = Parameters<RunStore['update']>[1];

/** All callbacks are server authority, never hydrated from a wire request. */
export type RunStoreAuthority = {
  readonly transaction: <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  readonly admitNew: (tx: Prisma.TransactionClient, input: CreateRun) => Promise<RunAdmission>;
  readonly assertWrite: (
    tx: Prisma.TransactionClient,
    row: AgentTurn,
    patch: RunPatch,
  ) => Promise<void>;
  /** Production supplies its D-006 normalizer; library RunError prose is not trusted. */
  readonly projectError: (error: RunError) => RunError;
};
export class RunStoreError extends Error {
  constructor(
    readonly code: 'RUN_NOT_ADMITTED' | 'RUN_CONFLICT' | 'SUBAGENTS_UNSUPPORTED' | 'INVALID_RUN',
  ) {
    super(code);
    this.name = 'RunStoreError';
  }
}
const errorSchema = z.object({ message: z.string(), code: z.string().optional() }).strict();
const epochSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);
const integerSchema = z.number().int().nonnegative().max(2_147_483_647);

export function projectRunError(error: RunError): RunError {
  const { code, message } = normalizeRunError(error);
  return { code, message };
}

/** A valid lease for one run cannot be reused as authority for another owned row. */
export async function assertLeasedRunWrite(
  tx: Prisma.TransactionClient,
  row: AgentTurn,
  patch: RunPatch,
  lease: RunLease,
): Promise<void> {
  if (
    row.id !== lease.runId ||
    row.botId !== lease.botId ||
    row.conversationId !== lease.threadId ||
    (Object.hasOwn(patch, 'driverEpoch') && patch.driverEpoch !== lease.epoch) ||
    (Object.hasOwn(patch, 'cancelRequested') && patch.cancelRequested !== true)
  )
    throw new RunOwnershipError('STALE_WORKER');
  await assertRunLease(tx, lease);
}

/** Durable library records; insertion never grants producer ownership. */
export function createPrismaRunStore(
  prisma: PrismaService,
  scope: { readonly userId: string },
  authority: RunStoreAuthority,
) {
  const owned = { bot: { userId: scope.userId } };
  return defineRunStore({
    createOrResume(input: CreateRun) {
      return authority.transaction(async (tx) => {
        const existing = await tx.agentTurn.findFirst({ where: { id: input.runId, ...owned } });
        // First insertion is immutable even when a later input names another thread.
        if (existing !== null) return toRunRecord(existing);
        if (
          input.parentRunId !== undefined ||
          input.subagentRunId !== undefined ||
          input.name !== undefined
        )
          throw new RunStoreError('SUBAGENTS_UNSUPPORTED');
        if (
          !input.runId ||
          !input.threadId ||
          (input.status !== undefined && !isRunStatus(input.status))
        )
          throw new RunStoreError('INVALID_RUN');
        const startedAt = new Date(epochSchema.parse(input.startedAt));
        const admission = await authority.admitNew(tx, input);
        if (admission.threadId !== input.threadId) throw new RunStoreError('RUN_NOT_ADMITTED');
        const bots = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Bot" WHERE id = ${admission.botId} AND "userId" = ${scope.userId} FOR UPDATE`;
        if (bots.length !== 1) throw new RunStoreError('RUN_NOT_ADMITTED');
        await lockThread(tx, scope.userId, admission);
        const trigger = await tx.message.findFirst({
          where: {
            id: admission.triggerMessageId,
            conversationId: admission.threadId,
            conversation: { botId: admission.botId, bot: { userId: scope.userId } },
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
        const body = trigger === null ? undefined : fromTranscriptRow(trigger, admission.botId);
        if (!body?.ok || body.value?.role !== 'user') throw new RunStoreError('RUN_NOT_ADMITTED');
        await tx.agentTurn.createMany({
          data: [
            {
              id: input.runId,
              botId: admission.botId,
              conversationId: admission.threadId,
              triggerMessageId: admission.triggerMessageId,
              startedAt,
              status: input.status ?? 'running',
            },
          ],
          skipDuplicates: true,
        });
        const row = await tx.agentTurn.findFirst({ where: { id: input.runId, ...owned } });
        if (row === null) throw new RunStoreError('RUN_CONFLICT');
        return toRunRecord(row);
      });
    },
    update(runId: string, patch: RunPatch) {
      return authority.transaction(async (tx) => {
        const target = await tx.agentTurn.findFirst({
          where: { id: runId, ...owned },
          select: { botId: true, conversationId: true },
        });
        // Unknown includes foreign records; never an insertion.
        if (target === null) return;
        await lockThread(tx, scope.userId, {
          botId: target.botId,
          threadId: target.conversationId,
        });
        const rows = await tx.$queryRaw<AgentTurn[]>`
          SELECT r.* FROM "AgentTurn" r JOIN "Bot" b ON b.id = r."botId"
          WHERE r.id = ${runId} AND r."conversationId" = ${target.conversationId}
            AND b.id = ${target.botId} AND b."userId" = ${scope.userId} FOR UPDATE OF r`;
        const row = rows[0];
        if (row === undefined) return;
        await authority.assertWrite(tx, row, patch);
        const data = patchData(patch, authority.projectError, row.status);
        await tx.agentTurn.updateMany({ where: { id: runId, ...owned }, data });
      });
    },
    async get(runId: string): Promise<RunRecord | null> {
      const row = await prisma.agentTurn.findFirst({ where: { id: runId, ...owned } });
      return row === null ? null : toRunRecord(row);
    },
    async findActiveRun(threadId: string): Promise<RunRecord | null> {
      const row = await prisma.agentTurn.findFirst({
        where: { conversationId: threadId, status: 'running', ...owned },
        orderBy: [{ startedAt: 'desc' }, { sequence: 'desc' }],
      });
      return row === null ? null : toRunRecord(row);
    },
    async listByThread(threadId: string): Promise<RunRecord[]> {
      const rows = await prisma.agentTurn.findMany({
        where: { conversationId: threadId, ...owned },
        orderBy: [{ startedAt: 'asc' }, { sequence: 'asc' }],
      });
      return rows.map(toRunRecord);
    },
    async listReclaimable({ now, ttlMs }: { now: number; ttlMs: number }): Promise<RunRecord[]> {
      const cutoff = new Date(epochSchema.parse(now) - epochSchema.parse(ttlMs));
      const rows = await prisma.agentTurn.findMany({
        where: { status: 'running', detachedSince: { lte: cutoff }, ...owned },
        orderBy: [{ startedAt: 'asc' }, { sequence: 'asc' }],
      });
      return rows.map(toRunRecord);
    },
  });
}

async function lockThread(
  tx: Prisma.TransactionClient,
  userId: string,
  admission: Pick<RunAdmission, 'botId' | 'threadId'>,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM "Conversation" c JOIN "Bot" b ON b.id = c."botId"
    WHERE c.id = ${admission.threadId} AND b.id = ${admission.botId}
      AND b."userId" = ${userId} FOR UPDATE OF c`;
  if (rows.length !== 1) throw new RunStoreError('RUN_NOT_ADMITTED');
}

function patchData(
  patch: RunPatch,
  projectError: RunStoreAuthority['projectError'],
  currentStatus: RunRecord['status'],
): Prisma.AgentTurnUpdateManyMutationInput {
  if ((patch.status ?? currentStatus) === 'interrupted' && patch.finishedAt !== undefined)
    throw new RunStoreError('INVALID_RUN');
  const data: Prisma.AgentTurnUpdateManyMutationInput = {};
  if (patch.status !== undefined) {
    if (!isRunStatus(patch.status)) throw new RunStoreError('INVALID_RUN');
    data.status = patch.status;
    if (patch.status !== 'running') data.activeKey = null;
    if (patch.status === 'interrupted') data.endedAt = null;
  }
  if (Object.hasOwn(patch, 'finishedAt'))
    data.endedAt =
      patch.finishedAt === undefined ? null : new Date(epochSchema.parse(patch.finishedAt));
  if (Object.hasOwn(patch, 'error')) {
    const error =
      patch.error === undefined ? undefined : errorSchema.parse(projectError(patch.error));
    data.errorCode = error?.code ?? null;
    data.errorMessage = error?.message ?? null;
  }
  if (Object.hasOwn(patch, 'usage')) {
    const usage = patch.usage === undefined ? undefined : RunUsageSchema.parse(patch.usage);
    data.usage = usage ?? Prisma.DbNull;
    data.inputTokens = usage?.promptTokens ?? 0;
    data.outputTokens = usage?.completionTokens ?? 0;
    data.cachedInputTokens = usage?.promptTokensDetails?.['cachedTokens'] ?? 0;
    data.cacheCreationTokens = usage?.promptTokensDetails?.['cacheWriteTokens'] ?? 0;
  }
  if (Object.hasOwn(patch, 'sandboxKey'))
    data.sandboxKey = patch.sandboxKey === undefined ? null : z.string().parse(patch.sandboxKey);
  if (Object.hasOwn(patch, 'detachedSince'))
    data.detachedSince =
      patch.detachedSince === undefined ? null : new Date(epochSchema.parse(patch.detachedSince));
  if (Object.hasOwn(patch, 'cancelRequested'))
    data.cancelRequested =
      patch.cancelRequested === undefined ? null : z.boolean().parse(patch.cancelRequested);
  if (Object.hasOwn(patch, 'driverEpoch'))
    data.driverEpoch =
      patch.driverEpoch === undefined ? null : integerSchema.parse(patch.driverEpoch);
  return data;
}
