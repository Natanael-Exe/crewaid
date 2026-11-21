import { EventType, type ChatMiddleware } from '@tanstack/ai';
import { withPersistence } from '@tanstack/ai-persistence';
import type { StructuredLogger } from '../../logging/structured-logger.js';
import type { ResolvedTextModel } from '../../models/model-resolution.service.js';
import { httpStatusOf, normalizeModelError } from '../../models/normalize-error.js';
import { normalizeUsage, type NormalizedUsage } from '../../models/tanstack/usage.js';
import { failureCopy } from '../../models/failure-copy.js';
import {
  productionCostEstimate,
  projectUsageForEvent,
  safeCostEstimate,
  type AiTelemetryCostResolver,
  type AiTelemetryEvent,
  type AiTelemetrySink,
} from '../../telemetry/ai-telemetry.js';
import { wrapUpCopy, wrapUpDue, type TurnLimitAccount } from '../turn-limits.js';
import { leakedToolMarkup } from './tool-markup.js';
import {
  scanForStall,
  stallBlockCopy,
  stallToolFailureBlockCopy,
  stallWarnCopy,
} from './stall-guard.js';
import type { ExecutionPorts, ExecutionRequest } from './execution-backend.port.js';
import type { RunExecutionState, TanStackExecutionPersistence } from './run-execution-state.js';
import type { CloseRunBoundary, RunCheckpointer } from './run-checkpoint.js';

type ModelCallRecorder = {
  readonly markStart: (iteration: number) => void;
  readonly record: (
    iteration: number,
    outcome: AiTelemetryEvent['outcome'],
    reported: NormalizedUsage | null,
    errorCode?: string,
  ) => void;
  readonly recordOpen: (outcome: AiTelemetryEvent['outcome'], errorCode?: string) => void;
};

function createModelCallRecorder(input: {
  readonly request: Pick<ExecutionRequest, 'botId' | 'threadId' | 'runId'>;
  readonly resolved: Pick<ResolvedTextModel, 'kind' | 'upstreamModelId'>;
  readonly telemetry: AiTelemetrySink | undefined;
  readonly costResolver: AiTelemetryCostResolver | undefined;
  readonly now: () => number;
}): ModelCallRecorder {
  const { request, resolved, telemetry, now } = input;
  const costResolver = input.costResolver ?? productionCostEstimate;
  const callStarts = new Map<number, number>();
  const callsRecorded = new Set<number>();

  const record: ModelCallRecorder['record'] = (iteration, outcome, reported, errorCode) => {
    const started = callStarts.get(iteration);
    if (telemetry === undefined || started === undefined || callsRecorded.has(iteration)) return;
    callsRecorded.add(iteration);
    try {
      const usage = {
        inputTokens: reported?.inputTokens,
        outputTokens: reported?.outputTokens,
        totalTokens: reported === null ? undefined : reported.inputTokens + reported.outputTokens,
        cacheReadTokens: reported?.cachedInputTokens,
        cacheWriteTokens: reported?.cacheCreationTokens,
        usageUnknown: reported === null,
      };
      const event: AiTelemetryEvent = {
        schemaVersion: 1,
        event: 'ai.model-call',
        outcome,
        provider: resolved.kind,
        model: resolved.upstreamModelId,
        ...projectUsageForEvent(usage),
        latencyMs: Math.max(0, now() - started),
        estimatedCostUsd: safeCostEstimate(
          costResolver,
          resolved.kind,
          resolved.upstreamModelId,
          usage,
        ),
        botId: request.botId,
        conversationId: request.threadId,
        runId: request.runId,
        ...(errorCode === undefined ? {} : { errorCode }),
      };
      // Observational: never awaited and never allowed to fail the run.
      void Promise.resolve(telemetry.record(event)).catch(() => undefined);
    } catch {
      // A malformed telemetry record must not affect run execution.
    }
  };

  return {
    markStart: (iteration) => {
      callStarts.set(iteration, now());
    },
    record,
    recordOpen: (outcome, errorCode) => {
      for (const iteration of callStarts.keys()) record(iteration, outcome, null, errorCode);
    },
  };
}

/** First-win hooks that refuse tools on the closing call after a stall block. */
export function buildStallCloseMiddleware(state: RunExecutionState): ChatMiddleware {
  return {
    name: 'crewaid-stall-close',
    onConfig: () => (state.stall === undefined ? undefined : { tools: [] }),
    onBeforeToolCall: () =>
      state.stall === undefined
        ? undefined
        : { type: 'skip', result: 'STALL_STOPPED: no action was dispatched.' },
  };
}

export function buildLifecycleMiddleware(input: {
  readonly request: ExecutionRequest;
  readonly ports: Pick<ExecutionPorts, 'status' | 'releaseForApproval'>;
  readonly persistence: TanStackExecutionPersistence;
  readonly resolved: ResolvedTextModel;
  readonly state: RunExecutionState;
  readonly limits: TurnLimitAccount;
  readonly maxStepsLimit: number;
  readonly checkpointer: RunCheckpointer;
  readonly controller: AbortController;
  readonly logger: Pick<StructuredLogger, 'warn'> & Partial<Pick<StructuredLogger, 'info'>>;
  readonly now: () => number;
  readonly telemetry: AiTelemetrySink | undefined;
  readonly costResolver: AiTelemetryCostResolver | undefined;
}): ChatMiddleware {
  const {
    request,
    ports,
    persistence,
    resolved,
    state,
    limits,
    maxStepsLimit,
    checkpointer,
    controller,
    logger,
  } = input;
  const callRecorder = createModelCallRecorder({
    request,
    resolved,
    telemetry: input.telemetry,
    costResolver: input.costResolver,
    now: input.now,
  });
  const stallWarned = new Set<string>();
  let stallClosing = false;
  let wrapUpSent = false;

  return {
    name: 'crewaid-execution-lifecycle',
    async onStart() {
      await ports.status('THINKING');
    },
    async onConfig(ctx) {
      if (ctx.phase !== 'beforeModel') return;
      await persistence.assertLive();
      if (request.resume !== undefined && ctx.iteration === 0 && state.carried === 0) {
        await checkpointer.persistCarriedResumeStep(ctx);
      }
      const stepsDone = state.completedSteps(persistence.budget.steps);
      if (!wrapUpSent && wrapUpDue(stepsDone, maxStepsLimit)) {
        wrapUpSent = true;
        state.pendingNotices.push(wrapUpCopy(stepsDone, maxStepsLimit));
      }
      if (limits.check() !== undefined) {
        controller.abort('Execution budget exhausted.');
        ctx.abort('Execution budget exhausted.');
      } else {
        state.observedIterations.add(ctx.iteration);
        callRecorder.markStart(ctx.iteration);
      }
    },
    onIteration(ctx, info) {
      // The engine updates ctx.iteration after this hook; info names the new iteration.
      state.iterationStarts.set(info.iteration, ctx.messages.length);
      state.checkpointable.add(info.iteration);
    },
    onUsage(ctx, reported) {
      const normalized = normalizeUsage(resolved.kind, reported);
      callRecorder.record(ctx.iteration, 'success', normalized);
      if (normalized === null) return;
      state.recordUsage(ctx.iteration, normalized);
    },
    async onInterruptBoundary(ctx) {
      await checkpointer.persistBeforeTools(ctx);
      return undefined;
    },
    async onBeforeToolCall() {
      await persistence.assertLive();
      await ports.status('ACTING');
    },
    async onToolPhaseComplete() {
      await ports.status('THINKING');
    },
    async onShouldContinue(ctx, loopState) {
      // A call that reported no usage is still a call: recorded as unknown, never zero.
      callRecorder.record(ctx.iteration, 'success', null);
      await checkpointer.checkpointStep(ctx, loopState.finishReason);
      // A natural closing answer has no next step to refuse, so ceilings only gate
      // tool-calling steps (and resumed steps, whose finishReason is null).
      if (loopState.finishReason != null && loopState.finishReason !== 'tool_calls') return true;
      const found = scanForStall(
        ctx.messages,
        undefined,
        request.observationTools === undefined ? undefined : new Set(request.observationTools),
      );
      if (found.worst === 'block' && state.stall === undefined) {
        state.stall = { repeats: found.repeats, why: found.why, tool: found.tool };
        state.pendingNotices.push(
          found.why === 'same-result'
            ? stallBlockCopy(found.repeats)
            : stallToolFailureBlockCopy(found.tool, found.repeats),
        );
        logger.warn('turn.stall.blocked', {
          runId: request.runId,
          botId: request.botId,
          tool: found.tool,
          repeats: found.repeats,
          why: found.why,
        });
      } else if (found.worst === 'warn') {
        const warned = `${found.tool}:${String(found.repeats)}`;
        if (!stallWarned.has(warned)) {
          stallWarned.add(warned);
          state.pendingNotices.push(stallWarnCopy(found.repeats));
          logger.info?.('turn.stall.warned', {
            runId: request.runId,
            botId: request.botId,
            tool: found.tool,
            repeats: found.repeats,
          });
        }
      }
      if (
        state.stall !== undefined &&
        (loopState.finishReason === null || loopState.finishReason === 'tool_calls')
      ) {
        // The single closing call already ran and the model tried tools anyway: end the loop.
        if (stallClosing) return false;
        stallClosing = true;
      }
      return limits.check() === undefined;
    },
    async onChunk(_ctx, chunk) {
      if (chunk.type === EventType.TEXT_MESSAGE_START) {
        await persistence.reserve(request.threadId, { role: 'assistant', id: chunk.messageId });
      }
      if (chunk.type === EventType.TOOL_CALL_START) {
        if (chunk.parentMessageId !== undefined) {
          await persistence.reserve(request.threadId, {
            role: 'assistant',
            id: chunk.parentMessageId,
          });
        }
        await persistence.reserve(request.threadId, { role: 'tool', toolCallId: chunk.toolCallId });
      }
      if (chunk.type === EventType.RUN_FINISHED && chunk.outcome?.type === 'interrupt') {
        state.status = 'interrupted';
        limits.suspend();
        state.syncInputTokens(limits);
        await ports.releaseForApproval();
        await ports.status('AWAITING_APPROVAL');
      }
    },
    onFinish(_ctx, info) {
      callRecorder.recordOpen('success');
      if (state.status === 'interrupted') return;
      state.finishReason = info.finishReason;
      state.status = 'completed';
    },
    onAbort() {
      callRecorder.recordOpen('interrupted');
      if (state.status === 'interrupted') return;
      state.status = limits.stopped() === undefined ? 'aborted' : 'completed';
    },
    onError(_ctx, info) {
      state.status = 'failed';
      const normalized = normalizeModelError(info.error, state.errorContext(resolved.modelId));
      state.failure = { code: normalized.code, message: normalized.message };
      state.explanation = normalized.explanation;
      logger.warn('turn.execution.error', {
        runId: request.runId,
        botId: request.botId,
        errorName: info.error instanceof Error ? info.error.name : typeof info.error,
        errorCode: normalized.code,
        httpStatus: httpStatusOf(info.error),
      });
      callRecorder.recordOpen('error', normalized.code);
    },
  };
}

/**
 * Wraps persistence terminal hooks inside the owned close boundary so checkpoint
 * validation and terminal commits succeed or fail together in one hook.
 */
export function buildPersistenceCommitMiddleware(input: {
  readonly request: Pick<ExecutionRequest, 'runId' | 'threadId'>;
  readonly persistence: TanStackExecutionPersistence;
  readonly state: RunExecutionState;
  readonly limits: TurnLimitAccount;
  readonly checkpointer: RunCheckpointer;
  readonly close: CloseRunBoundary;
}): ChatMiddleware {
  const { request, persistence, state, limits, checkpointer, close } = input;
  const persistenceMiddleware = withPersistence(persistence.persistence, {
    snapshotStreaming: false,
  });

  return {
    ...persistenceMiddleware,
    async onChunk(ctx, chunk) {
      if (chunk.type === EventType.RUN_FINISHED && chunk.outcome?.type === 'interrupt') {
        await close('interrupted', async () => {
          await persistenceMiddleware.onChunk?.(ctx, chunk);
          // A pause never reaches a checkpoint; persist its working time so continuations account for it.
          await persistence.progress({
            steps: state.completedSteps(persistence.budget.steps),
            workingMs: limits.elapsedMs(),
          });
        });
      } else {
        await persistenceMiddleware.onChunk?.(ctx, chunk);
      }
    },
    async onFinish(ctx, info) {
      if (state.closedStatus === 'interrupted') return;
      // Withdraw replies that leak raw tool-call markup as text and fail the run instead of completing.
      const leaked = leakedToolMarkup(ctx.messages);
      if (leaked !== undefined) {
        const error = {
          code: 'PROVIDER_UNAVAILABLE' as const,
          message: failureCopy(state.language).garbledReply,
        };
        state.failure = error;
        await close('failed', async () => {
          await persistence.persistence.stores.messages.saveThread(
            request.threadId,
            ctx.messages.flatMap((message) =>
              message !== leaked
                ? [message]
                : leaked.id === undefined
                  ? [{ ...message, content: '' }]
                  : [],
            ),
          );
          if (leaked.id !== undefined) {
            await persistence.withdraw(request.threadId, leaked.id);
          }
          await persistence.progress({
            steps: state.completedSteps(persistence.budget.steps) + 1,
            workingMs: limits.elapsedMs(),
          });
          await persistence.persistence.stores.runs.update(request.runId, {
            status: 'failed',
            finishedAt: Date.now(),
            error,
          });
        });
        return;
      }
      await close('completed', async () => {
        await checkpointer.checkpointStep(ctx, info.finishReason);
        await persistenceMiddleware.onFinish?.(ctx, info);
      });
    },
    async onError(ctx, info) {
      if (state.closedStatus !== undefined) return;
      await close('failed', async () => persistenceMiddleware.onError?.(ctx, info));
    },
    async onAbort(ctx, info) {
      // Once parked, cancel settles the run separately; a released producer cannot reclaim it.
      if (state.closedStatus !== undefined) return;
      if (limits.stopped() !== undefined) {
        await close('completed', async () => {
          await checkpointer.checkpointStep(ctx, state.finishReason);
          await persistenceMiddleware.onFinish?.(ctx, {
            finishReason: state.finishReason,
            duration: info.duration,
            content: '',
          });
        });
      } else {
        await close('aborted', async () => persistenceMiddleware.onAbort?.(ctx, info));
      }
    },
  };
}
