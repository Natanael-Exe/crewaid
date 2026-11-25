import { chat, EventType, RUN_CANCEL_REASON, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import {
  createModelControlTagFilter,
  JsonSchema,
  stripModelControlTags,
  type StreamTextFilter,
} from '@crewaid/shared';
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
import { PrivacyVault, type StreamTokenRehydrator } from './privacy-vault.js';
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
    const rawPersistence = await this.deps.openPersistence(request);
    const vault =
      process.env['AGENT_PRIVACY_VAULT'] === 'false' ? undefined : new PrivacyVault();
    // Proxy saveThread once so canonical persistence (including TanStack's own
    // withPersistence hooks) always strips leaked model control tags and
    // resolves vault tokens before sealing at rest, without losing prototype
    // methods or bound `this` on class-backed stores.
    const persistence: TanStackExecutionPersistence = {
      ...rawPersistence,
      persistence: {
        ...rawPersistence.persistence,
        stores: {
          ...rawPersistence.persistence.stores,
          messages: wrapMessageStore(rawPersistence.persistence.stores.messages, vault),
        },
      },
    };
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
      ...(vault === undefined ? {} : { vault }),
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
        const streamRehydrators = createStreamRehydratorRegistry(vault);
        for await (const chunk of chat({
          adapter: resolved.adapter,
          // Default library debug logging prints unredacted provider transport objects.
          debug: false,
          threadId: request.threadId,
          runId: request.runId,
          messages: [],
          systemPrompts: executionSystemPrompts(request, resolved.kind, vault),
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
              ...(vault === undefined ? {} : { vault }),
            }),
            lifecycle,
            providerContext(
              request,
              resolved.capabilities.vision,
              this.deps.loadAttachments,
              this.deps.loadSenders,
              () => state.drainNotices(),
              vault,
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
            vault,
            streamRehydrators,
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

function sanitizeAssistantControlTags(messages: readonly ModelMessage[]): ModelMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || message.content === null) return message;
    if (typeof message.content === 'string') {
      const cleaned = stripModelControlTags(message.content);
      if (cleaned === message.content) return message;
      changed = true;
      return { ...message, content: cleaned };
    }
    let partsChanged = false;
    const nextParts = message.content.map((part) => {
      if (part.type !== 'text' || typeof part.content !== 'string') return part;
      const cleaned = stripModelControlTags(part.content);
      if (cleaned === part.content) return part;
      partsChanged = true;
      return { ...part, content: cleaned };
    });
    if (!partsChanged) return message;
    changed = true;
    return { ...message, content: nextParts };
  });
  return changed ? next : [...messages];
}

function wrapMessageStore(
  store: TanStackExecutionPersistence['persistence']['stores']['messages'],
  vault: PrivacyVault | undefined,
): TanStackExecutionPersistence['persistence']['stores']['messages'] {
  return new Proxy(store, {
    get(target, prop, receiver): unknown {
      if (prop === 'saveThread') {
        return (tid: string, messages: Parameters<typeof target.saveThread>[1]) => {
          const resolved = vault === undefined ? messages : vault.resolveMessages(messages);
          return target.saveThread(tid, sanitizeAssistantControlTags(resolved));
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: readonly unknown[]) => unknown;
      return (...args: readonly unknown[]): unknown => Reflect.apply(fn, target, args);
    },
  });
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

interface StreamRehydratorRegistry {
  readonly text: (messageId: string) => StreamTokenRehydrator | undefined;
  readonly flushText: (messageId: string) => string;
  readonly controlFilter: (messageId: string) => StreamTextFilter;
  readonly flushControlFilter: (messageId: string) => string;
  readonly reasoning: (messageId: string) => StreamTokenRehydrator | undefined;
  readonly flushReasoning: (messageId: string) => string;
  readonly toolArgs: (toolCallId: string) => StreamTokenRehydrator | undefined;
  readonly flushToolArgs: (toolCallId: string) => string;
}

function createStreamRehydratorRegistry(
  vault: PrivacyVault | undefined,
): StreamRehydratorRegistry {
  const maskSecrets = process.env['AGENT_PRIVACY_MASK_SECRETS'] === 'true';
  const textStreams = new Map<string, StreamTokenRehydrator>();
  const controlFilters = new Map<string, StreamTextFilter>();
  const reasoningStreams = new Map<string, StreamTokenRehydrator>();
  const toolArgStreams = new Map<string, StreamTokenRehydrator>();

  const getOrCreate = (
    map: Map<string, StreamTokenRehydrator>,
    id: string,
    jsonStringEscape = false,
  ): StreamTokenRehydrator | undefined => {
    if (vault === undefined) return undefined;
    let instance = map.get(id);
    if (instance === undefined) {
      instance = vault.createStreamRehydrator({
        ...(jsonStringEscape ? { jsonStringEscape: true } : {}),
        ...(maskSecrets && !jsonStringEscape ? { maskSecrets: true } : {}),
      });
      map.set(id, instance);
    }
    return instance;
  };

  const flushAndDelete = (map: Map<string, StreamTokenRehydrator>, id: string): string => {
    const instance = map.get(id);
    if (instance === undefined) return '';
    map.delete(id);
    return instance.flush();
  };

  return {
    text: (id) => getOrCreate(textStreams, id),
    flushText: (id) => flushAndDelete(textStreams, id),
    controlFilter: (id) => {
      let filter = controlFilters.get(id);
      if (filter === undefined) {
        filter = createModelControlTagFilter();
        controlFilters.set(id, filter);
      }
      return filter;
    },
    flushControlFilter: (id) => {
      const filter = controlFilters.get(id);
      if (filter === undefined) return '';
      controlFilters.delete(id);
      return filter.flush();
    },
    reasoning: (id) => getOrCreate(reasoningStreams, id),
    flushReasoning: (id) => flushAndDelete(reasoningStreams, id),
    toolArgs: (id) => getOrCreate(toolArgStreams, id, true),
    flushToolArgs: (id) => flushAndDelete(toolArgStreams, id),
  };
}

async function consumeStreamChunk(
  chunk: StreamChunk,
  request: ExecutionRequest,
  resolved: ResolvedTextModel,
  persistence: TanStackExecutionPersistence,
  state: RunExecutionState,
  crashCheckpoint: CrashCheckpointTracker,
  append: (event: StreamChunk) => Promise<void>,
  vault: PrivacyVault | undefined,
  rehydrators: StreamRehydratorRegistry,
): Promise<void> {
  if (chunk.type === EventType.TEXT_MESSAGE_START) {
    crashCheckpoint.onTextStart(chunk.messageId);
  }
  if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
    const stream = rehydrators.text(chunk.messageId);
    const rehydrated = stream === undefined ? chunk.delta : stream.push(chunk.delta);
    const delta = rehydrated === '' ? '' : rehydrators.controlFilter(chunk.messageId).push(rehydrated);
    if (delta === '') return;
    await crashCheckpoint.onTextDelta(chunk.messageId, delta, persistence, request.threadId);
    await append(delta === chunk.delta ? chunk : { ...chunk, delta });
    return;
  }
  if (chunk.type === EventType.TEXT_MESSAGE_END) {
    const rehydratedTail = rehydrators.flushText(chunk.messageId);
    const filter = rehydrators.controlFilter(chunk.messageId);
    const pushed = rehydratedTail === '' ? '' : filter.push(rehydratedTail);
    const tail = pushed + rehydrators.flushControlFilter(chunk.messageId);
    if (tail !== '') {
      await crashCheckpoint.onTextDelta(chunk.messageId, tail, persistence, request.threadId);
      await append({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: chunk.messageId,
        delta: tail,
        ...(chunk.timestamp === undefined ? {} : { timestamp: chunk.timestamp }),
      });
    }
  }
  if (chunk.type === EventType.REASONING_MESSAGE_CONTENT) {
    const stream = rehydrators.reasoning(chunk.messageId);
    const delta = stream === undefined ? chunk.delta : stream.push(chunk.delta);
    if (delta === '') return;
    await append(delta === chunk.delta ? chunk : { ...chunk, delta });
    return;
  }
  if (chunk.type === EventType.REASONING_MESSAGE_END) {
    const tail = rehydrators.flushReasoning(chunk.messageId);
    if (tail !== '') {
      await append({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: chunk.messageId,
        delta: tail,
        ...(chunk.timestamp === undefined ? {} : { timestamp: chunk.timestamp }),
      });
    }
  }
  if (chunk.type === EventType.TOOL_CALL_ARGS) {
    const stream = rehydrators.toolArgs(chunk.toolCallId);
    const delta = stream === undefined ? chunk.delta : stream.push(chunk.delta);
    if (delta === '') return;
    await append(delta === chunk.delta ? chunk : { ...chunk, delta });
    return;
  }
  if (chunk.type === EventType.TOOL_CALL_END) {
    const tail = rehydrators.flushToolArgs(chunk.toolCallId);
    if (tail !== '') {
      await append({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: chunk.toolCallId,
        delta: tail,
        ...(chunk.timestamp === undefined ? {} : { timestamp: chunk.timestamp }),
      });
    }
    if (vault !== undefined && vault.size > 0 && chunk.input !== undefined) {
      await append({ ...chunk, input: vault.resolveValue(chunk.input) });
      return;
    }
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
