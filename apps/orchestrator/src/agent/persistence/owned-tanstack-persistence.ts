import type { Prisma } from '@prisma/client';
import { JsonSchema } from '@crewaid/shared';
import { batchRunEvents } from './batched-events.js';
import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import { fromTranscriptRow, toolResultMessageId, toTranscriptRow } from './transcript.js';
import { defineAIPersistence, type InterruptCommitEntry } from '@tanstack/ai-persistence';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TanStackExecutionPersistence } from '../execution/tanstack-execution-backend.js';
import type {
  ExecutionBackend,
  ExecutionOutcome,
  ExecutionPorts,
  ExecutionRequest,
  ExecutionResume,
} from '../execution/execution-backend.port.js';
import { PolicyProposalSchema, ResolutionSchema } from '../policy/proposal-store.js';
import { policyHash } from '../policy/policy.js';
import {
  assertOwnedToolInterruptAttachment,
  nativeToolProposalId,
} from './native-tool-interrupt.js';
import {
  assertOwnedToolInterruptCommit,
  createOwnedToolDispatchAuthorizer,
} from './owned-native-consumption.js';
import { OwnedRunBoundary, type ClosingRunStatus } from './owned-run-boundary.js';
import { createPrismaInterruptStore, InterruptStoreError } from './prisma-interrupt-store.js';
import { createPrismaMessageStore } from './prisma-message-store.js';
import {
  createRunEventLog,
  isRunEventChunk,
  RunEventLogError,
  type RunEventWakeups,
} from './run-event-log.js';
import { createPrismaRunStore, projectRunError, RunStoreError } from './prisma-run-store.js';
import {
  RUN_RECOVERY_BATCH_SIZE,
  RunOwnershipError,
  type RunLease,
  type RunLeaseService,
} from './run-lease.js';

type Budget = TanStackExecutionPersistence['budget'];

/**
 * Everything one producer may write, derived from the lease it already holds:
 * a claim or an admitted continuation. Every store joins the
 * same captured boundary, so transcript, run and native interrupt writes share
 * its fence and its closing transaction, and each mutation authority is a
 * server callback rather than anything a request carried. The budget is read
 * from the continuation chain's rows, never accepted from a caller,
 * so answering an approval cannot reset a run's ceilings.
 */
export async function openOwnedTanStackPersistence(
  prisma: PrismaService,
  lease: RunLease,
  /** The inter-bot chain the run answers; its transcript rows carry it. */
  chain?: { readonly chainId: string | null; readonly hopCount: number },
): Promise<TanStackExecutionPersistence> {
  const { budget, ancestors, parentRunId } = await readChainBudget(prisma, lease);
  const boundary = new OwnedRunBoundary(prisma, lease);
  const scope = { userId: lease.userId };
  const messages = createPrismaMessageStore(prisma, {
    userId: lease.userId,
    runId: lease.runId,
    fence: boundary.fence,
    transaction: boundary.transaction,
    ...(chain === undefined ? {} : { chain }),
  });
  const runs = createPrismaRunStore(prisma, scope, {
    transaction: boundary.transaction,
    assertWrite: boundary.assertWrite,
    projectError: projectRunError,
    // The lease already admitted this run; the library may not insert another.
    admitNew: () => Promise.reject(new RunStoreError('RUN_NOT_ADMITTED')),
  });
  const interrupts = createPrismaInterruptStore(prisma, scope, {
    transaction: boundary.transaction,
    locateProposal: (_tx, input) => Promise.resolve(nativeToolProposalId(input)),
    assertAttach: (tx, row, input) =>
      assertOwnedToolInterruptAttachment(tx, row, input, lease, boundary.fence),
    assertCommit: assertOwnedToolInterruptCommit,
  });
  // `withPersistence` commits resumed native interrupts only on `onFinish` and
  // `onChunk(interrupt)`. Because admission already consumed the private policy
  // row, any terminal close of a continuation (provider error, abort, ceiling
  // stop, or early setup failure) must also settle any remaining pending native
  // interrupts in the same closing transaction so the thread is never stranded.
  const close: typeof boundary.close = (next, operation) =>
    boundary.close(next, async () => {
      const result = await operation();
      if (parentRunId !== null) {
        await settleRemainingParentInterrupts({
          prisma,
          lease,
          parentRunId,
          next,
          boundary,
          interrupts,
        });
        await boundary.transaction((tx) => closeAnsweredParentRun(tx, lease, parentRunId, next));
      }
      return result;
    });
  return {
    persistence: defineAIPersistence({ stores: { messages, runs, interrupts } }),
    reserve: messages.reserve,
    withdraw: messages.withdraw,
    assertLive: boundary.assertLive,
    boundary: close,
    authorizeResume: createOwnedToolDispatchAuthorizer(prisma, {
      userId: lease.userId,
      botId: lease.botId,
    }),
    // The backend reports cumulative figures; the row keeps only this run's
    // share so summing a chain never counts an ancestor twice. Inside a
    // closing transaction this joins it.
    progress: ({ steps, workingMs, usage }) =>
      boundary.transaction(async (tx) => {
        await boundary.fence(tx);
        const own = (total: number, ancestors: number) => Math.max(0, total - ancestors);
        const written = await tx.agentTurn.updateMany({
          where: {
            id: lease.runId,
            botId: lease.botId,
            conversationId: lease.threadId,
            bot: { userId: lease.userId },
          },
          data: {
            stepIndex: Math.max(0, steps - ancestors.steps),
            workingMs: Math.max(0, Math.round(workingMs - ancestors.workingMs)),
            ...(usage === undefined
              ? {}
              : {
                  inputTokens: own(usage.inputTokens, ancestors.usage.inputTokens),
                  outputTokens: own(usage.outputTokens, ancestors.usage.outputTokens),
                  cachedInputTokens: own(
                    usage.cachedInputTokens,
                    ancestors.usage.cachedInputTokens,
                  ),
                  cacheCreationTokens: own(
                    usage.cacheCreationTokens,
                    ancestors.usage.cacheCreationTokens,
                  ),
                }),
          },
        });
        if (written.count !== 1) throw new RunOwnershipError('STALE_WORKER');
      }),
    budget,
  };
}

/** Include a reclaimed run's own spend; subtract only ancestors when writing its share. */
async function readChainBudget(
  prisma: PrismaService,
  lease: RunLease,
): Promise<{
  readonly budget: Budget;
  readonly ancestors: Budget;
  readonly parentRunId: string | null;
}> {
  const budget = {
    steps: 0,
    workingMs: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      reportedCalls: 0,
      unreportedCalls: 0,
    },
  };
  const seen = new Set<string>();
  let current:
    | {
        readonly steps: number;
        readonly workingMs: number;
        readonly usage: Budget['usage'];
        readonly parentRunId: string | null;
      }
    | undefined;
  let next: string | null = lease.runId;
  while (next !== null) {
    if (seen.has(next)) throw new RunOwnershipError('RUN_CONFLICT');
    seen.add(next);
    const run: {
      id: string;
      resumesRunId: string | null;
      stepIndex: number;
      workingMs: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheCreationTokens: number;
    } | null = await prisma.agentTurn.findFirst({
      where: {
        id: next,
        botId: lease.botId,
        conversationId: lease.threadId,
        bot: { userId: lease.userId },
      },
      select: {
        id: true,
        resumesRunId: true,
        stepIndex: true,
        workingMs: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheCreationTokens: true,
      },
    });
    if (run === null) throw new RunOwnershipError('RUN_NOT_OWNED');
    if (run.id !== lease.runId) {
      budget.steps += run.stepIndex;
      budget.workingMs += run.workingMs;
      budget.usage.inputTokens += run.inputTokens;
      budget.usage.outputTokens += run.outputTokens;
      budget.usage.cachedInputTokens += run.cachedInputTokens;
      budget.usage.cacheCreationTokens += run.cacheCreationTokens;
    } else {
      current = {
        steps: run.stepIndex,
        workingMs: run.workingMs,
        parentRunId: run.resumesRunId,
        usage: {
          ...budget.usage,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          cachedInputTokens: run.cachedInputTokens,
          cacheCreationTokens: run.cacheCreationTokens,
        },
      };
    }
    next = run.resumesRunId;
  }
  if (current === undefined) throw new RunOwnershipError('RUN_NOT_OWNED');
  return {
    ancestors: budget,
    parentRunId: current.parentRunId,
    budget: {
      steps: budget.steps + current.steps,
      workingMs: budget.workingMs + current.workingMs,
      usage: {
        ...budget.usage,
        inputTokens: budget.usage.inputTokens + current.usage.inputTokens,
        outputTokens: budget.usage.outputTokens + current.usage.outputTokens,
        cachedInputTokens: budget.usage.cachedInputTokens + current.usage.cachedInputTokens,
        cacheCreationTokens: budget.usage.cacheCreationTokens + current.usage.cacheCreationTokens,
      },
    },
  };
}

/**
 * One server producer: the persistence its lease grants, a heartbeat that
 * keeps the lease while it works, an abort the moment the lease is lost, so a
 * worker that another has replaced stops instead of racing it, and the run's
 * delivery log, written before the caller's own delivery sees an event
 * and closed only after its durable run settles.
 */
export async function executeOwned(input: {
  readonly prisma: PrismaService;
  readonly leases: RunLeaseService;
  readonly wakeups: RunEventWakeups;
  readonly lease: RunLease;
  readonly backend: (persistence: TanStackExecutionPersistence) => ExecutionBackend;
  readonly request: ExecutionRequest;
  readonly ports: ExecutionPorts;
}): Promise<ExecutionOutcome> {
  const { lease, request, ports } = input;
  if (
    request.runId !== lease.runId ||
    request.botId !== lease.botId ||
    request.threadId !== lease.threadId ||
    request.model.userId !== lease.userId
  )
    throw new RunOwnershipError('RUN_NOT_OWNED');
  const persistence = await openOwnedTanStackPersistence(input.prisma, lease, request.chain);
  const controller = new AbortController();
  const forward = () => controller.abort(ports.signal?.reason);
  ports.signal?.addEventListener('abort', forward, { once: true });
  if (ports.signal?.aborted) forward();
  const heartbeat = input.leases.heartbeat(lease, (error) => controller.abort(error));
  const log = createRunEventLog(
    input.prisma,
    { userId: lease.userId, botId: lease.botId, threadId: lease.threadId, runId: lease.runId },
    { wakeups: input.wakeups, writer: lease },
  );
  const events = batchRunEvents(
    async (batch) => {
      await log.append(batch);
      for (const event of batch)
        await ports.appendEvent(JsonSchema.parse(JSON.parse(JSON.stringify(event))));
    },
    (error) => controller.abort(error),
  );
  const bufferedPersistence = {
    ...persistence,
    boundary: async <T>(
      next: Parameters<typeof persistence.boundary>[0],
      operation: () => Promise<T>,
    ) => {
      await events.flush();
      return persistence.boundary(next, operation);
    },
  };
  try {
    const outcome = await input.backend(bufferedPersistence).execute(request, {
      ...ports,
      signal: controller.signal,
      appendEvent: async (event) => {
        if (!isRunEventChunk(event)) throw new RunEventLogError('INVALID_EVENT');
        await events.append(event);
      },
    });
    await events.flush();
    return outcome;
  } catch (error) {
    // A failed buffer must not prevent the database from releasing the busy
    // fence. Wait for any in-flight write before the independent owned close.
    await events.flush().catch(() => undefined);
    const next = ports.signal?.aborted ? 'aborted' : 'failed';
    const safe = projectRunError({ code: 'UNKNOWN', message: 'Execution could not finish.' });
    let settled = false;
    try {
      await persistence.boundary(next, () =>
        persistence.persistence.stores.runs.update(lease.runId, {
          status: next,
          finishedAt: Date.now(),
          ...(next === 'failed' ? { error: safe } : {}),
        }),
      );
      settled = true;
      // Use the durable log directly: the downstream delivery callback may
      // itself be what failed. No raw transport/database detail is published.
      const replay = await log.snapshot();
      const terminal: StreamChunk = {
        type: EventType.RUN_ERROR,
        runId: lease.runId,
        threadId: lease.threadId,
        timestamp: Date.now(),
        code: next === 'aborted' ? 'RUN_CANCELLED' : (safe.code ?? 'UNKNOWN'),
        message: next === 'aborted' ? 'The bot was stopped.' : safe.message,
      };
      await log.append([
        ...(replay.length === 0
          ? [
              {
                type: EventType.RUN_STARTED,
                runId: lease.runId,
                threadId: lease.threadId,
                timestamp: Date.now(),
              } as StreamChunk,
            ]
          : []),
        terminal,
      ]);
    } catch {
      // Already terminal, replaced, canceled, or unavailable: the captured
      // boundary decides authority. Cleanup releases only this exact owner.
    }
    if (settled)
      await Promise.resolve()
        .then(() => ports.status(next === 'aborted' ? 'IDLE' : 'ERROR'))
        .catch(() => undefined);
    throw error;
  } finally {
    await events.flush().catch(() => undefined);
    await heartbeat.stop();
    // If settlement could not commit, recovery must retain a writable log.
    // Closing it while status is running creates an endless recovery loop.
    const abandoned = await input.leases.release(lease).catch(() => true);
    if (!abandoned) await log.close().catch(() => undefined);
    ports.signal?.removeEventListener('abort', forward);
  }
}

/**
 * A continuation's resume input, rebuilt from its rows. A worker that reclaims
 * an expired continuation has no request body to replay; admission staged the
 * operator's decisions on the private proposals, and those are the only
 * source. Null when the run resumes nothing.
 */
export async function readAdmittedResume(
  prisma: PrismaService,
  lease: RunLease,
): Promise<{ readonly parentRunId: string; readonly batch: ExecutionResume[] } | null> {
  const run = await prisma.agentTurn.findFirst({
    where: {
      id: lease.runId,
      botId: lease.botId,
      conversationId: lease.threadId,
      bot: { userId: lease.userId },
    },
    select: { resumesRunId: true },
  });
  if (run === null) throw new RunOwnershipError('RUN_NOT_OWNED');
  if (run.resumesRunId === null) return null;
  const rows = await prisma.runInterrupt.findMany({
    where: {
      runId: run.resumesRunId,
      userId: lease.userId,
      conversationId: lease.threadId,
      nativeInterruptId: { not: null },
      nativeStatus: 'pending',
      run: { botId: lease.botId, bot: { userId: lease.userId } },
    },
    orderBy: [{ nativeRequestedAt: 'asc' }, { sequence: 'asc' }],
  });
  const batch = rows.map((row): ExecutionResume => {
    const interruptId = row.nativeInterruptId;
    if (interruptId === null) throw new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
    if (row.status === 'cancelled') return { interruptId, status: 'cancelled' };
    const proposal = PolicyProposalSchema.safeParse(row.payload);
    const staged = ResolutionSchema.safeParse(row.response);
    if (row.status !== 'resolved' || !proposal.success || !staged.success)
      throw new InterruptStoreError('INTERRUPT_NOT_ADMITTED');
    const edited =
      staged.data.approved && policyHash(staged.data.args) !== policyHash(proposal.data.args);
    return {
      interruptId,
      status: 'resolved',
      payload: {
        approved: staged.data.approved,
        ...(staged.data.reason === undefined ? {} : { reason: staged.data.reason }),
        ...(edited ? { editedArgs: staged.data.args } : {}),
      },
    };
  });
  return { parentRunId: run.resumesRunId, batch };
}

/**
 * Scoped recovery: claims only runs whose lease has expired and hands each new
 * lease to `resume`. A healthy owner is never a candidate and a renewed one
 * joins instead of being claimed, so recovery never interrupts live work, and
 * a claim grants no replay — the restored plans' dispatch markers decide what
 * may still run. One run's failure does not stop the sweep.
 */
export async function recoverExpiredRuns(input: {
  readonly leases: RunLeaseService;
  readonly resume: (lease: RunLease) => Promise<void>;
  readonly maxBatches?: number;
}): Promise<{ readonly recovered: number; readonly failed: number }> {
  let recovered = 0;
  let failed = 0;
  for (let batch = 0; batch < (input.maxBatches ?? 10); batch++) {
    const candidates = await input.leases.expiredCandidates();
    for (const candidate of candidates) {
      try {
        const claim = await input.leases.claim(candidate, { recoverCancellation: true });
        if (claim.kind !== 'claimed') continue;
        recovered++;
        await input.resume(claim.lease);
      } catch {
        failed++;
      }
    }
    // A claimed candidate holds a fresh lease, so the next batch is new work.
    if (candidates.length < RUN_RECOVERY_BATCH_SIZE) break;
  }
  return { recovered, failed };
}

const UNANSWERED_TOOL_MESSAGE: Record<Exclude<ClosingRunStatus, 'interrupted'>, string> = {
  aborted:
    'RUN_CANCELLED: the run was stopped and this call was not repeated. If it had already started, check its outcome before trying again.',
  failed:
    'RUN_FAILED: the resumed run ended before this call completed. If it had already started, check its outcome before trying again.',
  completed:
    'RUN_LIMIT_REACHED: this call did not run because the turn reached its step or time limit.',
};

/**
 * Commits any parent native interrupts that were staged at admission but left
 * pending when the continuation closed without reaching `withPersistence`'s
 * success boundary (e.g. provider timeout, abort, or budget stop before `chat()`),
 * and closes any still-unanswered parent tool calls so later turns remain valid.
 */
async function settleRemainingParentInterrupts(input: {
  readonly prisma: PrismaService;
  readonly lease: RunLease;
  readonly parentRunId: string;
  readonly next: ClosingRunStatus;
  readonly boundary: OwnedRunBoundary;
  readonly interrupts: ReturnType<typeof createPrismaInterruptStore>;
}): Promise<void> {
  const { prisma, lease, parentRunId, next, boundary, interrupts } = input;
  const remaining = await boundary.transaction((tx) =>
    tx.runInterrupt.findMany({
      where: {
        runId: parentRunId,
        userId: lease.userId,
        conversationId: lease.threadId,
        nativeInterruptId: { not: null },
        nativeStatus: 'pending',
        run: { botId: lease.botId, bot: { userId: lease.userId } },
      },
      orderBy: [{ nativeRequestedAt: 'asc' }, { sequence: 'asc' }],
    }),
  );
  if (remaining.length === 0) return;

  const entries: InterruptCommitEntry[] = [];
  for (const row of remaining) {
    const interruptId = row.nativeInterruptId;
    if (interruptId === null) continue;
    if (row.status === 'cancelled') {
      entries.push({ interruptId, status: 'cancelled' });
      continue;
    }
    const proposal = PolicyProposalSchema.safeParse(row.payload);
    const staged = ResolutionSchema.safeParse(row.response);
    if (row.status !== 'resolved' || !proposal.success || !staged.success) continue;
    const edited =
      staged.data.approved && policyHash(staged.data.args) !== policyHash(proposal.data.args);
    entries.push({
      interruptId,
      status: 'resolved',
      response: {
        approved: staged.data.approved,
        ...(staged.data.reason === undefined ? {} : { reason: staged.data.reason }),
        ...(edited ? { editedArgs: staged.data.args } : {}),
      },
    });
  }
  if (entries.length > 0) {
    await interrupts.commitBatch?.(entries);
  }
  if (next !== 'interrupted') {
    await settleUnansweredToolResults(prisma, lease, parentRunId, boundary, next);
  }
}

/** Answer canceled pending calls so a later instruction cannot redispatch them. */
export async function cancelPendingToolResults(
  prisma: PrismaService,
  lease: RunLease,
  parentRunId: string | null,
  boundary: OwnedRunBoundary,
): Promise<void> {
  await settleUnansweredToolResults(prisma, lease, parentRunId, boundary, 'aborted');
}

async function settleUnansweredToolResults(
  prisma: PrismaService,
  lease: RunLease,
  parentRunId: string | null,
  boundary: OwnedRunBoundary,
  reason: Exclude<ClosingRunStatus, 'interrupted'>,
): Promise<void> {
  const store = createPrismaMessageStore(prisma, {
    userId: lease.userId,
    runId: lease.runId,
    fence: boundary.fence,
    transaction: boundary.transaction,
  });
  const history = await store.loadThread(lease.threadId);
  const answeredIds = new Set(
    history.filter((message) => message.role === 'tool').map((message) => message.id),
  );
  const answeredCallIds = new Set(
    history
      .filter((message) => message.role === 'tool' && typeof message.toolCallId === 'string')
      .map((message) => message.toolCallId),
  );
  const origins = new Set(parentRunId === null ? [lease.runId] : [lease.runId, parentRunId]);
  const pending = history.flatMap((message) => {
    // The message store already validates the transcript; the run tag is
    // opaque library metadata until its object shape has been checked.
    const tagged: unknown = message.metadata?.['tanstack'];
    const run: unknown =
      typeof tagged === 'object' && tagged !== null && 'run' in tagged ? tagged.run : undefined;
    const runId: unknown =
      typeof run === 'object' && run !== null && 'id' in run ? run.id : undefined;
    if (message.role !== 'assistant' || typeof runId !== 'string' || !origins.has(runId)) return [];
    return (message.toolCalls ?? []).filter(
      (call) =>
        !answeredCallIds.has(call.id) &&
        !answeredIds.has(toolResultMessageId(lease.threadId, runId, call.id)),
    );
  });
  if (pending.length === 0) return;
  await store.saveThread(lease.threadId, [
    ...history,
    ...pending.map((call): ModelMessage => ({
      role: 'tool',
      toolCallId: call.id,
      content: UNANSWERED_TOOL_MESSAGE[reason],
    })),
  ]);
}

/**
 * Answers any still-open tool calls on already-settled (parked/failed/aborted)
 * runs inside the caller's transaction, without requiring a live run lease, so
 * a later user message cannot re-enter `beforeTools` for a cancelled or failed call.
 */
/** The status a parked parent takes once its continuation closes. */
export function parentStatusAfter(next: ClosingRunStatus): 'completed' | 'failed' | 'aborted' {
  // A continuation that parks on a new approval has taken the conversation
  // over: the parent's own part (the answered approvals) is done.
  return next === 'interrupted' ? 'completed' : next;
}

/**
 * Closes a parent run parked on approvals once its continuation closes.
 *
 * Admission answers the parent's approvals but leaves it `interrupted`, and
 * nothing moved it on afterwards. Every live-run check counts `interrupted`
 * as working, so a bot stayed "busy" after any approval: deleting a message
 * was refused and there was no run left to Stop. A parent with an approval
 * still pending stays parked, since only an answer may move it.
 */
export async function closeAnsweredParentRun(
  tx: Prisma.TransactionClient,
  scope: { readonly userId: string; readonly botId: string; readonly threadId: string },
  parentRunId: string,
  next: ClosingRunStatus,
): Promise<boolean> {
  const closed = await tx.agentTurn.updateMany({
    where: {
      id: parentRunId,
      botId: scope.botId,
      conversationId: scope.threadId,
      status: 'interrupted',
      bot: { userId: scope.userId },
      interrupts: { none: { OR: [{ status: 'pending' }, { nativeStatus: 'pending' }] } },
    },
    data: { status: parentStatusAfter(next), endedAt: new Date() },
  });
  return closed.count === 1;
}

export async function settleUnansweredToolResultsTx(
  tx: Prisma.TransactionClient,
  scope: { readonly userId: string; readonly botId: string; readonly threadId: string },
  runIds: readonly string[],
  resultRunId: string,
  reason: Exclude<ClosingRunStatus, 'interrupted'>,
): Promise<void> {
  if (runIds.length === 0) return;
  const owned = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM "Conversation" c JOIN "Bot" b ON b.id = c."botId"
    WHERE c.id = ${scope.threadId} AND b.id = ${scope.botId} AND b."userId" = ${scope.userId}
    FOR UPDATE OF c`;
  if (owned.length !== 1) return;
  const assistantRows = await tx.message.findMany({
    where: {
      conversationId: scope.threadId,
      runId: { in: [...runIds] },
      author: 'BOT',
      conversation: { bot: { id: scope.botId, userId: scope.userId } },
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
  const toolCalls: Array<{ readonly id: string }> = [];
  for (const row of assistantRows) {
    if (row.parts === null) continue;
    const parsed = fromTranscriptRow(row, scope.botId);
    if (!parsed.ok || parsed.value?.role !== 'assistant') continue;
    for (const call of parsed.value.toolCalls ?? []) {
      toolCalls.push({ id: call.id });
    }
  }
  if (toolCalls.length === 0) return;
  const toolRows = await tx.message.findMany({
    where: {
      conversationId: scope.threadId,
      author: 'TOOL',
      conversation: { bot: { id: scope.botId, userId: scope.userId } },
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
  const existingById = new Map(toolRows.map((row) => [row.id, row]));
  const answeredCallIds = new Set<string>();
  for (const row of toolRows) {
    if (row.parts === null) continue;
    const parsed = fromTranscriptRow(row, scope.botId);
    if (parsed.ok && parsed.value?.role === 'tool' && typeof parsed.value.toolCallId === 'string') {
      answeredCallIds.add(parsed.value.toolCallId);
    }
  }
  for (const call of toolCalls) {
    if (answeredCallIds.has(call.id)) continue;
    const id = toolResultMessageId(scope.threadId, resultRunId, call.id);
    const written = toTranscriptRow(
      {
        id,
        role: 'tool',
        toolCallId: call.id,
        content: UNANSWERED_TOOL_MESSAGE[reason],
      },
      { threadBotId: scope.botId, runId: resultRunId },
    );
    if (!written.ok) continue;
    const existing = existingById.get(id);
    if (existing === undefined) {
      await tx.message.create({
        data: { conversationId: scope.threadId, ...written.value },
      });
    } else if (existing.parts === null) {
      await tx.message.updateMany({
        where: {
          id,
          conversationId: scope.threadId,
          conversation: { bot: { id: scope.botId, userId: scope.userId } },
        },
        data: { parts: written.value.parts, content: written.value.content },
      });
    }
    answeredCallIds.add(call.id);
  }
}
