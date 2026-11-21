import type { BotStatus, Json, Locale, ModelErrorCode, ToolApprovalAnswer } from '@crewaid/shared';
import type { AgentInstructionsInput } from '../agent-instructions.js';
import type { ToolSet } from '../tool-contract.js';
import type { PendingToolApproval, ToolApprovalHook } from '../tool-approval.js';
import type { PolicyPrompt } from '../policy/runtime.js';
import type { TurnLimitStop } from '../turn-limits.js';
import type { StallDetail } from './stall-guard.js';

/** no provider client, credential, SDK transcript or caller history crosses this seam. */
export type ExecutionBackendCapabilities = {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly approvals: boolean;
  readonly background: boolean;
};
export type ExecutionModelRef = { readonly userId: string; readonly modelRef: string };
export type ExecutionResume =
  | {
      readonly interruptId: string;
      readonly status: 'resolved';
      readonly payload: ToolApprovalAnswer;
    }
  | { readonly interruptId: string; readonly status: 'cancelled'; readonly payload?: never };
export type ExecutionPolicy = {
  readonly decide: ToolApprovalHook;
  readonly prompt: (pending: PendingToolApproval) => PolicyPrompt;
  /** Rebuilds a resumed run's plans from the parent's durable proposals. */
  readonly restore: () => Promise<void>;
};

/** The trigger is already admitted once to this owned thread. History is loaded by the backend. */
export type ExecutionRequest = {
  readonly model: ExecutionModelRef;
  readonly botId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly triggerMessageId: string;
  /**
   * The inter-bot chain this run answers, as the start admitted it.
   * The run's transcript rows carry it — the reply is in the chain at the
   * same hop, because nothing was delivered by it — and a run of a thread
   * nobody chained answers `undefined`.
   */
  readonly chain?: { readonly chainId: string | null; readonly hopCount: number };
  readonly instructions: AgentInstructionsInput;
  readonly tools: ToolSet;
  /** Server-classified read tools; action acknowledgements do not prove a stall. */
  readonly observationTools?: readonly string[];
  readonly policy: ExecutionPolicy;
  readonly resume?: readonly ExecutionResume[];
  readonly parentRunId?: string;
  /**
   * why the previous run stopped, when a ceiling stopped it
   * and this run is carrying the work on.
   *
   * A system prompt rather than a stored message, because the operator did
   * not say it, and rather than a rewrite of the trigger's text,
   * because on a TanStack thread the trigger is a row the whole chain of runs
   * shares — the instruction belongs to this run, not to what was asked.
   */
  readonly continuation?: string;
  readonly maxSteps?: number;
  /** the account's language, which a failed run's sentence is worded in. */
  readonly language?: Locale | null;
  readonly maxTurnTokens?: number;
  readonly maxTurnMs?: number;
  /**
   * tools in `tools` the model is not sent until `discovery` loads
   * them. Every one is still assessed and dispatched as any other tool once
   * it is loaded.
   */
  readonly deferredTools?: { readonly discovery: string; readonly names: readonly string[] };
};
export type ExecutionUsage = {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly reportedCalls: number;
  readonly unreportedCalls: number;
};
export type ExecutionCheckpoint = {
  readonly stepIndex: number;
  readonly workingMs: number;
  readonly finishReason: string | null;
  /** Validated canonical bodies for this iteration, without provider-only projection. */
  readonly messages: readonly Json[];
  readonly usage: ExecutionUsage;
};
export type ExecutionOutcome = {
  readonly runId: string;
  readonly status: 'completed' | 'interrupted' | 'aborted' | 'failed';
  readonly workingMs: number;
  readonly finishReason: string | null;
  readonly usage: ExecutionUsage;
  readonly stoppedBy?: TurnLimitStop;
  /**
   * The progress watch stopped this turn's tool work: the model repeated one
   * fruitless call or one failing tool past the point of progress. The run
   * still closes `completed` — the model wrote its way out — but the service
   * must not carry it on the way a ceiling stop does, and the operator is
   * told what happened.
   */
  readonly stall?: StallDetail;
  readonly error?: { readonly code: ModelErrorCode; readonly message: string };
};
export type ExecutionPorts = {
  /** Server-owned cancel intent; a delivery reader's connection does not supply this signal. */
  readonly signal?: AbortSignal;
  /** Awaited native events. The writer must verify/fence this owned run. No legacy frame mapping. */
  readonly appendEvent: (event: Json) => Promise<void>;
  /** Awaited before another model call. A rejected checkpoint prevents continuation. */
  readonly checkpoint: (checkpoint: ExecutionCheckpoint) => Promise<void>;
  /** Park execution/action admission while preserving the approval-bound browser/profile. */
  readonly releaseForApproval: () => Promise<void>;
  readonly persistUsage: (usage: ExecutionUsage) => Promise<void>;
  readonly status: (status: BotStatus) => void | Promise<void>;
};
export type ExecutionBackend = {
  readonly id: string;
  readonly capabilities: ExecutionBackendCapabilities;
  readonly execute: (request: ExecutionRequest, ports: ExecutionPorts) => Promise<ExecutionOutcome>;
};
export const EXECUTION_BACKEND = Symbol('CANONICAL_EXECUTION_BACKEND');
