import type { AgentTurn, Prisma, RunInterrupt } from '@prisma/client';
import { validateInterruptResumeBatch } from '@tanstack/ai';
import { ToolApprovalAnswerSchema } from '@crewaid/shared';
import { z } from 'zod';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ExecutionResume } from '../execution/execution-backend.port.js';
import { readBoundToolInterrupt, type BoundToolInterruptRead } from './native-tool-interrupt.js';
import { toInterruptRecord } from './transcript.js';
import { InterruptStoreError, type CreateInterrupt } from './prisma-interrupt-store.js';
import { RunOwnershipError, type RunScope } from './run-lease.js';

type ResumeScope = RunScope & { readonly parentRunId: string };
export type OwnedResumeScope = ResumeScope;
const resumeSchema = z.array(
  z.discriminatedUnion('status', [
    z
      .object({
        interruptId: z.string().min(1),
        status: z.literal('resolved'),
        payload: ToolApprovalAnswerSchema,
      })
      .strict(),
    z.object({ interruptId: z.string().min(1), status: z.literal('cancelled') }).strict(),
  ]),
);

/** A validated read snapshot. Admission must reread under its own locks; this is not a capability. */
export interface OwnedResumeBatch {
  readonly run: AgentTurn;
  readonly pending: ReadonlyArray<
    { readonly row: RunInterrupt; readonly record: CreateInterrupt } & BoundToolInterruptRead
  >;
  readonly resume: ExecutionResume[];
  readonly fingerprint: string;
  readonly canonicalResolutions: string;
}

export async function readOwnedToolResumeBatch(
  prisma: PrismaService,
  scope: ResumeScope,
  resume: readonly ExecutionResume[],
): Promise<OwnedResumeBatch> {
  return prisma.$transaction((tx) => validateOwnedToolResumeBatch(tx, scope, resume));
}

/** Database/local-schema work only; reusable inside the future atomic admission transaction. */
export async function validateOwnedToolResumeBatch(
  tx: Prisma.TransactionClient,
  scope: ResumeScope,
  resume: readonly ExecutionResume[],
): Promise<OwnedResumeBatch> {
  const bots = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Bot" WHERE id = ${scope.botId} AND "userId" = ${scope.userId} FOR UPDATE`;
  const threads = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM "Conversation" c JOIN "Bot" b ON b.id = c."botId"
    WHERE c.id = ${scope.threadId} AND b.id = ${scope.botId}
      AND b."userId" = ${scope.userId} FOR UPDATE OF c`;
  if (bots.length !== 1 || threads.length !== 1) throw new RunOwnershipError('RUN_NOT_OWNED');
  const runs = await tx.$queryRaw<AgentTurn[]>`
    SELECT r.* FROM "AgentTurn" r JOIN "Bot" b ON b.id = r."botId"
    WHERE r.id = ${scope.parentRunId} AND b.id = ${scope.botId} AND b."userId" = ${scope.userId}
      AND r."conversationId" = ${scope.threadId} FOR UPDATE OF r`;
  const run = runs[0];
  if (run === undefined) throw new RunOwnershipError('RUN_NOT_OWNED');
  if (
    run.status !== 'interrupted' ||
    run.activeKey !== null ||
    run.workerId !== null ||
    run.leaseExpiresAt !== null ||
    run.cancelRequested === true
  )
    throw invalid();
  const rows = await tx.$queryRaw<RunInterrupt[]>`
    SELECT i.* FROM "RunInterrupt" i JOIN "AgentTurn" r ON r.id = i."runId"
    JOIN "Bot" b ON b.id = r."botId"
    WHERE i."conversationId" = ${scope.threadId} AND i."userId" = ${scope.userId}
      AND b.id = ${scope.botId} AND b."userId" = ${scope.userId}
      AND r."conversationId" = ${scope.threadId}
      AND i."nativeInterruptId" IS NOT NULL AND i."nativeStatus" = 'pending'
    ORDER BY i."nativeRequestedAt", i.sequence FOR UPDATE OF i`;
  if (rows.length === 0 || rows.some((row) => row.runId !== run.id || row.status !== 'pending'))
    throw invalid();
  const parsed = resumeSchema.safeParse(resume);
  if (!parsed.success) throw invalid();
  const pending = rows.map((row) => {
    const record = toInterruptRecord(row);
    if (!record.ok) throw invalid();
    const bound = readBoundToolInterrupt(row, record.value, { ...scope, runId: run.id });
    return { row, record: record.value, ...bound };
  });
  const validated = await validateInterruptResumeBatch({
    threadId: scope.threadId,
    interruptedRunId: run.id,
    generation: 0,
    pending: pending.map((item) => ({
      interruptId: item.record.interruptId,
      payload: item.record.payload,
      binding: item.binding,
      genericRequest: item.nativeRequest,
    })),
    resume: parsed.data,
    tools: [],
  });
  if (
    validated.errors.length !== 0 ||
    validated.fingerprint === undefined ||
    validated.canonicalResolutions === undefined ||
    validated.resolutions === undefined
  )
    throw invalid();
  return {
    run,
    pending,
    resume: parsed.data,
    fingerprint: validated.fingerprint,
    canonicalResolutions: validated.canonicalResolutions,
  };
}
function invalid(): InterruptStoreError {
  return new InterruptStoreError('INVALID_INTERRUPT_BATCH');
}
