import { memoryPersistence } from '@tanstack/ai-persistence';
import type { AIPersistence } from '@tanstack/ai-persistence';
import {
  JsonSchema,
  ToolApprovalRequestSchema,
  type ApprovalMode,
  type Json,
} from '@crewaid/shared';
import {
  TanStackExecutionBackend,
  type TanStackExecutionPersistence,
} from '../src/agent/execution/tanstack-execution-backend.js';
import type {
  ExecutionCheckpoint,
  ExecutionPorts,
  ExecutionRequest,
  ExecutionResume,
  ExecutionUsage,
} from '../src/agent/execution/execution-backend.port.js';
import {
  createPolicyRuntime,
  type PolicyRuntime,
  type PolicyState,
} from '../src/agent/policy/runtime.js';
import { policyHash } from '../src/agent/policy/policy.js';
import type {
  PolicyProposal,
  PolicyProposalStore,
  PolicyResolution,
} from '../src/agent/policy/proposal-store.js';
import { CONTAINED_BUILTIN, type ToolBehavior } from '../src/agent/tool-registry.js';
import { parseToolInput, type ToolSet } from '../src/agent/tool-contract.js';
import type { AgentInstructionsInput } from '../src/agent/agent-instructions.js';
import type { AiTelemetryCostResolver, AiTelemetrySink } from '../src/telemetry/ai-telemetry.js';
import { resolvedTextModelOf, type MockLanguageModelV4 } from './model-resolution-fake.js';

/**
 * One turn through the TanStack execution backend, with nothing behind it.
 *
 * The suites this serves used to drive `createTurnRunner` — a harness whose
 * every port was an in-memory double. The run engine's replacement,
 * `TanStackExecutionBackend`, takes its persistence as a port, so the same
 * shape exists here: a `memoryPersistence()` backend, a budget object the
 * fake `progress` keeps current (which is what a run row does between
 * continuations), and a policy runtime over in-memory proposals. Only the
 * model is scripted, by `resolvedTextModelOf`, exactly as the other suites do.
 *
 * What is deliberately NOT here: an owned-run fence (the backend calls
 * `assertLive` and `boundary`, and this answers them), a dispatch ledger, or
 * a delivery log — the suites that exercise those boot the real module
 * (MOD-AI-05/06). Everything a UNIT suite needs a turn for — what the model
 * was sent, what a tool saw, what the limits stopped, what telemetry recorded,
 * what the transcript holds — is readable off the returned fixture.
 */

export function emptyExecutionUsage(): Omit<ExecutionUsage, 'modelId'> {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    reportedCalls: 0,
    unreportedCalls: 0,
  };
}

export type ExecutionTurnOptions = {
  /**
   * The scripted model, or a factory called per resolution so a suite can
   * swap the script between runs.
   */
  readonly model: MockLanguageModelV4 | (() => MockLanguageModelV4);
  /**
   * The tool set the run is offered. Absent, a permissive policy over an
   * empty set is built: a run with no tools at all.
   */
  readonly tools?: ToolSet;
  /**
   * The run's approval policy. Absent, one is built over the behavior every
   * tool is projected with — `CONTAINED_BUILTIN` unless overridden — and the
   * mode and rules below.
   */
  readonly policy?: PolicyRuntime;
  readonly behavior?: ToolBehavior;
  readonly mode?: ApprovalMode;
  readonly rules?: ReadonlyArray<{ toolPattern: string; decision: 'allow' | 'deny' | 'ask' }>;
  readonly instructions?: AgentInstructionsInput;
  /** The clock the limits account runs on. Absent, the real one. */
  readonly now?: () => number;
  readonly telemetry?: AiTelemetrySink;
  /** Server-owned cancel intent, as the run coordinator hands it over. */
  readonly signal?: AbortSignal;
  readonly costResolver?: AiTelemetryCostResolver;
  /** What telemetry records as the model: the resolved row's upstream id. */
  readonly upstreamModelId?: string;
};

export type ExecutionTurn = {
  readonly threadId: string;
  /** The id the NEXT run gets; `run-0` is the first. */
  readonly nextRunId: () => string;
  readonly lastRunId: () => string;
  /** The canonical transcript the run saved, as the persistence store holds it. */
  readonly persistence: AIPersistence;
  /** The run budget, kept current by `progress` — a run row in miniature. */
  readonly budget: { steps: number; workingMs: number; usage: Omit<ExecutionUsage, 'modelId'> };
  readonly closedStatuses: ClosingStatus[];
  readonly progressCalls: Array<{
    readonly steps: number;
    readonly workingMs: number;
    readonly usage?: Omit<ExecutionUsage, 'modelId'>;
  }>;
  /** Everything `appendEvent` received, in delivery order. */
  readonly events: Json[];
  readonly checkpoints: ExecutionCheckpoint[];
  readonly statuses: string[];
  readonly usagePersisted: ExecutionUsage[];
  /**
   * Run one execution. `maxSteps`/`maxTurnTokens`/`maxTurnMs` go on the
   * request, exactly as a caller supplies them; the boot environment still
   * governs any axis the request leaves unset.
   */
  execute(
    options?: Partial<
      Pick<
        ExecutionRequest,
        'maxSteps' | 'maxTurnTokens' | 'maxTurnMs' | 'tools' | 'resume' | 'parentRunId'
      >
    >,
  ): Promise<ExecutionOutcomeOf>;
  /**
   * Resolve every pending approval interrupt the way an operator's answer
   * arrives — as a RESUME of the interrupted run — and run it.
   */
  resumeApproved(): Promise<ExecutionOutcomeOf>;
  readonly policy: PolicyRuntime;
  /**
   * How many durable proposals the run's decisions created. One per
   * `user-approval` — the counter an "it asked the operator N times" case
   * reads instead of spying on a port.
   */
  askedProposals: () => number;
  /** Pending approval interrupts, as the persistence store holds them. */
  pendingApprovals: () => Promise<number>;
};

export type ClosingStatus = 'completed' | 'failed' | 'aborted' | 'interrupted';
type ExecutionOutcomeOf = Awaited<ReturnType<TanStackExecutionBackend['execute']>>;

export function executionTurn(options: ExecutionTurnOptions): ExecutionTurn {
  const threadId = 'thread_under_test';
  const persistence = memoryPersistence();
  const budget = { steps: 0, workingMs: 0, usage: emptyExecutionUsage() };
  const latest = { steps: 0, workingMs: 0, usage: emptyExecutionUsage() };
  const closedStatuses: ClosingStatus[] = [];
  const progressCalls: Array<{
    steps: number;
    workingMs: number;
    usage?: Omit<ExecutionUsage, 'modelId'>;
  }> = [];
  const events: Json[] = [];
  const checkpoints: ExecutionCheckpoint[] = [];
  const statuses: string[] = [];
  const usagePersisted: ExecutionUsage[] = [];

  const proposals = new Map<string, PolicyProposal>();
  const resolutions = new Map<string, PolicyResolution>();
  const state: PolicyState = {
    snapshot: {
      mode: options.mode ?? 'FULL',
      rules: [...(options.rules ?? [])],
      grantRevision: policyHash(['permission']),
      grantValid: true,
      seat: null,
      resourceRevision: null,
    },
  };
  const store: PolicyProposalStore = {
    assertLive: async () => true,
    staged: async () => [],
    rebind: async () => false,
    claimDispatch: async () => true,
    create: async (proposal) => {
      const id = `proposal-${proposals.size}`;
      proposals.set(id, proposal);
      return id;
    },
    read: async (id) => (resolutions.has(id) ? null : (proposals.get(id) ?? null)),
    resolve: async (id, resolution) => {
      if (!proposals.has(id) || resolutions.has(id)) return false;
      resolutions.set(id, resolution);
      return true;
    },
    cancel: async (id) => {
      proposals.delete(id);
    },
    recordOutcome: async () => undefined,
    memory: async () =>
      [...resolutions].flatMap(([id, result]) => {
        const proposal = proposals.get(id);
        return result.approved && proposal
          ? [{ binding: result.binding, mode: proposal.mode, authority: proposal.authority }]
          : [];
      }),
    openIdentityWindow: async () => undefined,
  };
  const policy =
    options.policy ??
    createPolicyRuntime({
      project: (name, args) => ({ name, args, behavior: options.behavior ?? CONTAINED_BUILTIN }),
      read: async () => state,
      store,
    });

  let runCounter = 0;
  let lastRunId = '';
  const nextRunId = () => `run-${runCounter++}`;

  /**
   * The owned resume authorizer, over the fixture's own proposals: it answers
   * the runtime the way `executeOwned`'s does and binds the dispatch to the
   * original call's arguments. In-memory, so a unit suite needs no rows.
   */
  const authorizeResume = async (input: {
    readonly resolutions: ReadonlyArray<{
      readonly request: { readonly key: string; readonly payload: unknown };
      readonly status: 'resolved' | 'cancelled';
      readonly response?: unknown;
    }>;
  }) => {
    const tools = currentTools();
    const answered = [];
    for (const resolution of input.resolutions) {
      const payload = ToolApprovalRequestSchema.parse(resolution.request.payload);
      const answer = await policy.answer(
        resolution.request.key,
        resolution.status === 'resolved'
          ? (resolution.response as { approved: boolean })
          : { approved: false, reason: 'Cancelled' },
      );
      if (!answer?.approved) {
        answered.push({
          toolCallId: payload.toolCallId,
          approved: false as const,
          reason: answer?.reason ?? 'Declined',
        });
        continue;
      }
      const definition = tools[payload.definitionName];
      if (definition === undefined) throw new Error('Missing owned definition');
      answered.push({
        toolCallId: payload.toolCallId,
        approved: true as const,
        dispatchArgs: JsonSchema.parse(await parseToolInput(definition.inputSchema, payload.args)),
      });
    }
    return answered;
  };

  let requestedTools: ToolSet | undefined;
  const currentTools = () => requestedTools ?? options.tools ?? {};

  const backend = new TanStackExecutionBackend({
    logger: { warn: () => undefined },
    resolveModel: async () => ({
      ...resolvedTextModelOf(typeof options.model === 'function' ? options.model() : options.model),
      ...(options.upstreamModelId === undefined
        ? {}
        : { upstreamModelId: options.upstreamModelId }),
    }),
    openPersistence: async (request): Promise<TanStackExecutionPersistence> => {
      // What earlier runs spent, fixed for this run as a run row's sum is:
      // `progress` reports cumulative totals, which the NEXT run starts from.
      budget.steps = latest.steps;
      budget.workingMs = latest.workingMs;
      budget.usage = { ...latest.usage };
      await persistence.stores.runs.createOrResume({
        runId: request.runId,
        threadId,
        startedAt: Date.now(),
      });
      return {
        persistence,
        reserve: async () => undefined,
        withdraw: async () => undefined,
        assertLive: async () => undefined,
        boundary: async (next, operation) => {
          closedStatuses.push(next);
          return operation();
        },
        authorizeResume: authorizeResume as never,
        progress: async (progress) => {
          latest.steps = progress.steps;
          latest.workingMs = progress.workingMs;
          if (progress.usage !== undefined) latest.usage = { ...progress.usage };
          progressCalls.push(progress);
        },
        budget,
      };
    },
    loadAttachments: async () => new Map(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    ...(options.costResolver === undefined ? {} : { costResolver: options.costResolver }),
  });

  const ports = (): ExecutionPorts => ({
    appendEvent: async (event) => {
      events.push(event);
    },
    checkpoint: async (step) => {
      checkpoints.push(step);
    },
    releaseForApproval: async () => undefined,
    persistUsage: async (usage) => {
      usagePersisted.push(usage);
    },
    status: (status) => {
      statuses.push(status);
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const request = (
    overrides: Partial<
      Pick<
        ExecutionRequest,
        'maxSteps' | 'maxTurnTokens' | 'maxTurnMs' | 'tools' | 'resume' | 'parentRunId'
      >
    > = {},
  ): ExecutionRequest => {
    requestedTools = overrides.tools ?? options.tools ?? {};
    const runId = nextRunId();
    lastRunId = runId;
    return {
      model: { userId: 'user_under_test', modelRef: 'mock-model' },
      botId: 'bot_under_test',
      threadId,
      runId,
      triggerMessageId: 'trigger-1',
      instructions: options.instructions ?? { identity: { name: 'Quill', role: 'Tester' } },
      tools: requestedTools,
      policy,
      ...overrides,
    };
  };

  // The ceilings a run was given, so the run answering its interrupt has the
  // same ones: in production both read the same configuration.
  let limitOverrides: Partial<Pick<ExecutionRequest, 'maxSteps' | 'maxTurnTokens' | 'maxTurnMs'>> =
    {};

  const seedTrigger = async () => {
    const existing = await persistence.stores.messages.loadThread(threadId);
    if (existing.length === 0) {
      await persistence.stores.messages.saveThread(threadId, [
        { id: 'trigger-1', role: 'user', content: 'go' },
      ]);
    }
  };

  return {
    threadId,
    nextRunId,
    lastRunId: () => lastRunId,
    persistence,
    budget: latest,
    closedStatuses,
    progressCalls,
    events,
    checkpoints,
    statuses,
    usagePersisted,
    policy,
    askedProposals: () => proposals.size,
    pendingApprovals: async () =>
      (await persistence.stores.interrupts.listPending(threadId)).length,
    async execute(overrides = {}) {
      await seedTrigger();
      limitOverrides = {
        ...(overrides.maxSteps === undefined ? {} : { maxSteps: overrides.maxSteps }),
        ...(overrides.maxTurnTokens === undefined
          ? {}
          : { maxTurnTokens: overrides.maxTurnTokens }),
        ...(overrides.maxTurnMs === undefined ? {} : { maxTurnMs: overrides.maxTurnMs }),
      };
      return backend.execute(request(overrides), ports());
    },
    async resumeApproved() {
      await seedTrigger();
      const pending = await persistence.stores.interrupts.listPending(threadId);
      if (pending.length === 0) throw new Error('The run left no approval to answer.');
      const resume: ExecutionResume[] = pending.map((record) => ({
        interruptId: record.interruptId,
        status: 'resolved' as const,
        payload: { approved: true },
      }));
      return backend.execute(
        request({ ...limitOverrides, resume, parentRunId: lastRunId }),
        ports(),
      );
    },
  };
}
