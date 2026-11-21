import { chat, EventType, RUN_CANCEL_REASON, type StreamChunk } from '@tanstack/ai';
import { JsonSchema } from '@crewaid/shared';
import type { StructuredLogger } from '../../logging/structured-logger.js';
import type { ResolvedTextModel } from '../../models/model-resolution.service.js';
import {
  httpStatusOf,
  normalizeModelError,
  normalizeRunError,
} from '../../models/normalize-error.js';
import type { AiTelemetryCostResolver, AiTelemetrySink } from '../../telemetry/ai-telemetry.js';
import { historyBudget } from '../../models/context-budget.js';
import { createTurnLimitAccount } from '../turn-limits.js';
import {
  readContextTrimTokens,
  readMaxSteps,
  readMaxTurnMs,
  readMaxTurnTokens,
} from '../agent-loop.config.js';
import {
  executionSystemPrompts,
  providerContext,
  type ClaimedAttachmentLoader,
  type TeammateNameLoader,
} from './provider-context.js';
import { tanstackTools } from './tanstack-tools.js';
import { deferredTools } from './deferred-tools.js';
import { providerCompaction } from './context-compaction.js';
import { publicEventWriter } from './ag-ui-events.js';
import { tanstackPolicy } from './tanstack-policy.js';
import { toolApproval } from './tool-approval-interrupt.js';
import type {
  ExecutionBackend,
  ExecutionOutcome,
  ExecutionPorts,
  ExecutionRequest,
} from './execution-backend.port.js';
import {
  explained,
  RunExecutionState,
  type TanStackExecutionPersistence,
} from './run-execution-state.js';
import {
  CrashCheckpointTracker,
  createBoundaryCloser,
  createRunCheckpointer,
  type CloseRunBoundary,
} from './run-checkpoint.js';
import {
  buildLifecycleMiddleware,
  buildPersistenceCommitMiddleware,
  buildStallCloseMiddleware,
} from './run-lifecycle-middleware.js';

export type { TanStackExecutionPersistence } from './run-execution-state.js';

export type TanStackExecutionDeps = {
  readonly resolveModel: (model: ExecutionRequest['model']) => Promise<ResolvedTextModel>;
  readonly openPersistence: (request: ExecutionRequest) => Promise<TanStackExecutionPersistence>;
  readonly loadAttachments: ClaimedAttachmentLoader;
  /** Current name of each user row's sending bot, for inter-bot attribution. */
  readonly loadSenders?: TeammateNameLoader;
  readonly logger: Pick<StructuredLogger, 'warn'> & Partial<Pick<StructuredLogger, 'info'>>;
  readonly now?: () => number;
  /** One privacy-safe `ai.model-call` record per model call. */
  readonly telemetry?: AiTelemetrySink;
  readonly costResolver?: AiTelemetryCostResolver;
};

/** One library invocation, with its own iteration, typed interrupts, and canonical persistence. */
export class TanStackExecutionBackend implements ExecutionBackend {
  readonly id = 'tanstack-ai';
  readonly capabilities = { streaming: true, tools: true, approvals: true, background: true };

  constructor(private readonly deps: TanStackExecutionDeps) {}

  async execute(request: ExecutionRequest, ports: ExecutionPorts): Promise<ExecutionOutcome> {
    const controller = new AbortController();
    const cancel = () => controller.abort(RUN_CANCEL_REASON);
    ports.signal?.addEventListener('abort', cancel, { once: true });
    if (ports.signal?.aborted) cancel();

    const state = new RunExecutionState(request);
    const crashCheckpoint = new CrashCheckpointTracker();
    const close = createBoundaryCloser(state, crashCheckpoint, request.threadId);
    const append = createEventAppender(ports, state);

    await append({
      type: EventType.RUN_STARTED,
      runId: request.runId,
      threadId: request.threadId,
      timestamp: Date.now(),
    });

    try {
      if (controller.signal.aborted) {
        // An already-cancelled request resolves no provider and opens no persistence;
        // the caller settles the run row because this producer never held the thread.
        state.status = 'aborted';
      } else {
        await this.runPersisted(request, ports, state, crashCheckpoint, close, append, controller);
      }
    } catch (error) {
      await this.handleExecutionError(error, request, state, close, controller);
      if (state.deliveryFailed) throw error;
    } finally {
      ports.signal?.removeEventListener('abort', cancel);
    }

    try {
      await ports.persistUsage(state.usage);
    } catch (error) {
      this.deps.logger.warn('turn.usage.persist.failed', {
        runId: request.runId,
        botId: request.botId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    await ports.status(state.botStatus());
    state.finalizeTerminal(request);
    if (state.terminal !== undefined) await append(state.terminal);
    return state.toOutcome(request.runId);
  }

  private async runPersisted(
    request: ExecutionRequest,
    ports: ExecutionPorts,
    state: RunExecutionState,
    crashCheckpoint: CrashCheckpointTracker,
    close: CloseRunBoundary,
    append: (event: StreamChunk) => Promise<void>,
    controller: AbortController,
  ): Promise<void> {
    const persistence = await this.deps.openPersistence(request);
    state.runtime = persistence;
    await persistence.assertLive();

    const resolved = await this.deps.resolveModel(request.model);
    state.attachResolvedModel(persistence, resolved);

    const historyTokens = historyBudget(
      resolved.contextWindow,
      readContextTrimTokens(process.env['AGENT_CONTEXT_TRIM_TOKENS']),
    );
    const maxStepsLimit = readMaxSteps(
      request.maxSteps === undefined ? process.env['AGENT_MAX_STEPS'] : String(request.maxSteps),
    );
    const limits = createTurnLimitAccount(
      {
        maxSteps: maxStepsLimit,
        maxTurnTokens: readMaxTurnTokens(
          request.maxTurnTokens === undefined
            ? process.env['AGENT_MAX_TURN_TOKENS']
            : String(request.maxTurnTokens),
        ),
        maxTurnMs: readMaxTurnMs(
          request.maxTurnMs === undefined
            ? process.env['AGENT_MAX_TURN_MS']
            : String(request.maxTurnMs),
        ),
      },
      this.deps.now,
      {
        steps: persistence.budget.steps,
        tokens: state.usage.inputTokens,
        elapsedMs: persistence.budget.workingMs,
      },
    );
    limits.resume();

    const checkpointer = createRunCheckpointer({
      state,
      persistence,
      limits,
      crashCheckpoint,
      ports,
      threadId: request.threadId,
    });
    const lifecycle = buildLifecycleMiddleware({
      request,
      ports,
      persistence,
      resolved,
      state,
      limits,
      maxStepsLimit,
      checkpointer,
      controller,
      logger: this.deps.logger,
      now: this.deps.now ?? (() => Date.now()),
      telemetry: this.deps.telemetry,
      costResolver: this.deps.costResolver,
    });
    const persistenceCommit = buildPersistenceCommitMiddleware({
      request,
      persistence,
      state,
      limits,
      checkpointer,
      close,
    });

    try {
      if (limits.check() !== undefined) {
        // Close an already-admitted resumed run whose cumulative budget is exhausted.
        await close('completed', () =>
          persistence.persistence.stores.runs.update(request.runId, {
            status: 'completed',
            finishedAt: Date.now(),
          }),
        );
        state.status = 'completed';
        state.terminal = {
          type: EventType.RUN_FINISHED,
          runId: request.runId,
          threadId: request.threadId,
          timestamp: Date.now(),
          outcome: { type: 'success' },
        };
      } else {
        const runTools = tanstackTools(request.tools);
        for await (const chunk of chat({
          adapter: resolved.adapter,
          // Default library debug logging prints unredacted provider transport objects.
          debug: false,
          threadId: request.threadId,
          runId: request.runId,
          messages: [],
          systemPrompts: executionSystemPrompts(request, resolved.kind),
          tools: runTools,
          interrupts: [toolApproval],
          ...(request.resume === undefined ? {} : { resume: [...request.resume] }),
          ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
          abortController: controller,
          // Natural model finish ends the loop; middleware enforces cumulative ceilings.
          agentLoopStrategy: ({ lastTurnToolCallCount }) => lastTurnToolCallCount > 0,
          middleware: [
            persistenceCommit,
            // Must precede policy so closing-call tools are refused before approval or transform.
            buildStallCloseMiddleware(state),
            tanstackPolicy({
              botId: request.botId,
              tools: request.tools,
              policy: request.policy,
              authorizeResume: persistence.authorizeResume,
            }),
            lifecycle,
            providerContext(
              request,
              resolved.capabilities.vision,
              this.deps.loadAttachments,
              this.deps.loadSenders,
              () => state.drainNotices(),
            ),
            // Runs after providerContext so compaction bounds only the provider copy.
            providerCompaction({
              maxTokens: historyTokens,
              onCompact: (info) =>
                this.deps.logger.info?.('turn.context.compacted', {
                  runId: request.runId,
                  botId: request.botId,
                  ...info,
                }),
            }),
            // Runs last so it inspects the history loaded by the middleware above.
            ...(request.deferredTools === undefined
              ? []
              : [
                  deferredTools({
                    tools: runTools,
                    discovery: request.deferredTools.discovery,
                    names: new Set(request.deferredTools.names),
                    enabled: () => state.stall === undefined,
                  }),
                ]),
          ],
        })) {
          await consumeStreamChunk(
            chunk,
            request,
            resolved,
            persistence,
            state,
            crashCheckpoint,
            append,
          );
        }
      }
      // The engine isolates terminal hook errors; rethrow any rejected boundary transaction.
      if (state.boundaryFailed) throw state.boundaryError;
    } finally {
      limits.suspend();
      state.workingMs = limits.elapsedMs();
      state.stoppedBy = limits.stopped();
      state.syncInputTokens(limits);
      state.usage = state.snapshotUsage(persistence.budget.usage.unreportedCalls);
    }

    state.reconcilePostStream(controller.signal.aborted);
    // The library ends its stream on abort without firing a terminal hook; close the run
    // explicitly so the active-run fence does not stay locked until lease recovery.
    if (state.status === 'aborted' && state.closedStatus === undefined) {
      await close('aborted', () =>
        persistence.persistence.stores.runs.update(request.runId, {
          status: 'aborted',
          finishedAt: Date.now(),
        }),
      );
    }
  }

  private async handleExecutionError(
    error: unknown,
    request: ExecutionRequest,
    state: RunExecutionState,
    close: CloseRunBoundary,
    controller: AbortController,
  ): Promise<void> {
    if (controller.signal.aborted && !state.boundaryFailed) {
      state.status = 'aborted';
    } else {
      state.status = 'failed';
      const normalized = normalizeModelError(error, state.errorContext(state.usage.modelId));
      state.failure = { code: normalized.code, message: normalized.message };
      state.explanation = normalized.explanation;
      this.deps.logger.warn('turn.execution.error', {
        runId: request.runId,
        botId: request.botId,
        stage: state.boundaryFailed
          ? 'persistence'
          : state.deliveryFailed
            ? 'delivery'
            : 'execution',
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: normalized.code,
        httpStatus: httpStatusOf(error),
      });
    }
    if (state.runtime !== undefined && state.closedStatus === undefined) {
      const persistence = state.runtime;
      const next = state.status === 'aborted' ? 'aborted' : 'failed';
      try {
        await close(next, () =>
          persistence.persistence.stores.runs.update(request.runId, {
            status: next,
            finishedAt: Date.now(),
            ...(state.failure === undefined ? {} : { error: state.failure }),
          }),
        );
      } catch (closingError) {
        this.deps.logger.warn('turn.persistence.close.failed', {
          runId: request.runId,
          botId: request.botId,
          errorName: closingError instanceof Error ? closingError.name : typeof closingError,
        });
        // Terminal events must not precede durable state; surface close failures to the caller.
        throw closingError;
      }
    }
  }
}

function createEventAppender(ports: ExecutionPorts, state: RunExecutionState) {
  // Delivery append failures cannot be converted into a successful execution or swallowed.
  return publicEventWriter(async (event: StreamChunk) => {
    try {
      const encoded = JSON.stringify(event, (key, value: unknown) =>
        key === 'rawEvent' ? undefined : value,
      );
      await ports.appendEvent(JsonSchema.parse(JSON.parse(encoded)));
    } catch (error) {
      state.deliveryFailed = true;
      throw error;
    }
  });
}

async function consumeStreamChunk(
  chunk: StreamChunk,
  request: ExecutionRequest,
  resolved: ResolvedTextModel,
  persistence: TanStackExecutionPersistence,
  state: RunExecutionState,
  crashCheckpoint: CrashCheckpointTracker,
  append: (event: StreamChunk) => Promise<void>,
): Promise<void> {
  if (chunk.type === EventType.TEXT_MESSAGE_START) {
    crashCheckpoint.onTextStart(chunk.messageId);
  }
  if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
    await crashCheckpoint.onTextDelta(chunk.messageId, chunk.delta, persistence, request.threadId);
  }
  if (chunk.type === EventType.RUN_STARTED) return;
  if (chunk.type === EventType.RUN_ERROR) {
    const normalized = normalizeRunError(chunk, state.errorContext(resolved.modelId));
    state.failure = { code: normalized.code, message: normalized.message };
    state.explanation = normalized.explanation;
    state.status = 'failed';
    state.terminal = {
      type: EventType.RUN_ERROR,
      runId: request.runId,
      threadId: request.threadId,
      timestamp: chunk.timestamp ?? Date.now(),
      code: normalized.code,
      message: normalized.message,
      ...explained(state.explanation),
    };
  } else if (chunk.type === EventType.RUN_FINISHED) {
    state.finishReason =
      chunk.finishReason ?? chunk.metadata?.tanstack?.finishReason ?? state.finishReason;
    state.terminal = chunk;
  } else if (chunk.type !== EventType.RAW) {
    // Transport diagnostics and raw vendor payloads never become transcript content.
    await append(chunk);
  }
}
