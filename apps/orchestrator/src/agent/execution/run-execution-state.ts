import { EventType, type StreamChunk } from '@tanstack/ai';
import type { ChatWithInterruptsPersistence } from '@tanstack/ai-persistence';
import type { BotStatus, CorruptOutputKind, Locale, ProviderExplanation } from '@crewaid/shared';
import type { ResolvedTextModel } from '../../models/model-resolution.service.js';
import type { ModelErrorContext } from '../../models/normalize-error.js';
import type { NormalizedUsage } from '../../models/tanstack/usage.js';
import { failureCopy } from '../../models/failure-copy.js';
import type { createPrismaMessageStore } from '../persistence/prisma-message-store.js';
import type { ClosingRunStatus } from '../persistence/owned-run-boundary.js';
import type { TurnLimitAccount } from '../turn-limits.js';
import type { StallDetail } from './stall-guard.js';
import type { ToolResumeAuthorizer } from './tanstack-policy.js';
import type {
  ExecutionOutcome,
  ExecutionRequest,
  ExecutionUsage,
} from './execution-backend.port.js';

/** Server-only composition. No in-memory production fallback, caller history or client authority. */
export type TanStackExecutionPersistence = {
  readonly persistence: ChatWithInterruptsPersistence;
  readonly reserve: ReturnType<typeof createPrismaMessageStore>['reserve'];
  readonly withdraw: ReturnType<typeof createPrismaMessageStore>['withdraw'];
  /** Owned run/trigger/thread/bot admission and current execution fence. */
  readonly assertLive: () => Promise<void>;
  /** Database-only terminal composition; must commit before its outcome is published. */
  readonly boundary: <T>(next: ClosingRunStatus, operation: () => Promise<T>) => Promise<T>;
  readonly authorizeResume: ToolResumeAuthorizer;
  /** Durable cumulative steps and working time, joined to the current boundary. */
  readonly progress: (progress: {
    readonly steps: number;
    readonly workingMs: number;
    /** Cumulative, as `snapshotUsage` reports it; the row keeps this run's share. */
    readonly usage?: Omit<ExecutionUsage, 'modelId'>;
  }) => Promise<void>;
  readonly budget: {
    readonly steps: number;
    readonly workingMs: number;
    readonly usage: Omit<ExecutionUsage, 'modelId'>;
  };
};

/**
 * A failed run's explanation rides its terminal event in the library's
 * extension slot under our transcript namespace; the run row keeps `{ code, message }`.
 */
export function explained(explanation: ProviderExplanation | undefined): {
  metadata?: { crewaid: { explanation: ProviderExplanation } };
} {
  return explanation === undefined ? {} : { metadata: { crewaid: { explanation } } };
}

/** Mutable per-run execution state shared across checkpointing, middleware, and finalization. */
export class RunExecutionState {
  status: ExecutionOutcome['status'] = 'failed';
  finishReason: string | null = null;
  failure: ExecutionOutcome['error'];
  // Provider's own reason, carried on the terminal event separately from the run row's `{ code, message }`.
  explanation: ProviderExplanation | undefined;
  explainedBy: string | undefined;
  terminal: StreamChunk | undefined;
  workingMs = 0;
  stoppedBy: ExecutionOutcome['stoppedBy'];
  stall: StallDetail | undefined;
  /** Set when the streaming output circuit-breaker aborts a corrupt reply. */
  corruptOutput: { readonly messageId: string; readonly reason: CorruptOutputKind } | undefined;

  runtime: TanStackExecutionPersistence | undefined;
  closedStatus: ClosingRunStatus | undefined;
  boundaryFailed = false;
  boundaryError: unknown;
  deliveryFailed = false;

  usage: ExecutionUsage;
  // Set to 1 once a resumed run has charged the paused step it continues.
  carried = 0;
  readonly observedIterations = new Set<number>();
  readonly reportedIterations = new Set<number>();
  readonly checkpointed = new Set<number>();
  readonly savedBeforeTools = new Set<number>();
  readonly checkpointable = new Set<number>();
  readonly iterationStarts = new Map<number, number>();
  readonly pendingNotices: string[] = [];

  readonly language: Locale | null;

  constructor(request: ExecutionRequest) {
    this.language = request.language ?? null;
    this.usage = {
      modelId: request.model.modelRef,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      reportedCalls: 0,
      unreportedCalls: 0,
    };
  }

  attachResolvedModel(
    persistence: TanStackExecutionPersistence,
    resolved: ResolvedTextModel,
  ): void {
    this.usage = { ...persistence.budget.usage, modelId: resolved.modelId };
    this.explainedBy = resolved.included ? undefined : resolved.connectionName;
  }

  errorContext(modelId: string): ModelErrorContext {
    return this.explainedBy === undefined
      ? { modelId, language: this.language }
      : { modelId, source: this.explainedBy, language: this.language };
  }

  completedSteps(baseSteps: number): number {
    return baseSteps + this.carried + this.checkpointed.size;
  }

  snapshotUsage(baseUnreportedCalls: number): ExecutionUsage {
    return {
      ...this.usage,
      unreportedCalls:
        baseUnreportedCalls + this.observedIterations.size - this.reportedIterations.size,
    };
  }

  recordUsage(iteration: number, normalized: NormalizedUsage): void {
    if (this.reportedIterations.has(iteration)) return;
    this.reportedIterations.add(iteration);
    this.usage = {
      ...this.usage,
      inputTokens: this.usage.inputTokens + normalized.inputTokens,
      outputTokens: this.usage.outputTokens + normalized.outputTokens,
      cachedInputTokens: this.usage.cachedInputTokens + normalized.cachedInputTokens,
      cacheCreationTokens: this.usage.cacheCreationTokens + normalized.cacheCreationTokens,
      reportedCalls: this.usage.reportedCalls + 1,
    };
  }

  syncInputTokens(limits: TurnLimitAccount): void {
    limits.recordRound({ steps: 0, tokens: this.usage.inputTokens - limits.tokens() });
  }

  drainNotices(): string[] {
    return this.pendingNotices.splice(0, this.pendingNotices.length);
  }

  recordBoundaryFailure(error: unknown): void {
    this.boundaryFailed = true;
    this.boundaryError = error;
  }

  reconcilePostStream(aborted: boolean): void {
    if (this.closedStatus === 'interrupted') this.status = 'interrupted';
    else if (this.corruptOutput !== undefined) this.status = 'failed';
    else if (aborted && this.stoppedBy === undefined) this.status = 'aborted';
    else if (this.failure !== undefined) this.status = 'failed';
  }

  botStatus(): BotStatus {
    if (this.status === 'interrupted') return 'AWAITING_APPROVAL';
    if (this.status === 'failed') return 'ERROR';
    return 'IDLE';
  }

  finalizeTerminal(request: ExecutionRequest): void {
    if (this.status === 'failed') {
      const safe = this.failure ?? {
        code: 'UNKNOWN' as const,
        message: failureCopy(this.language).runIncomplete,
      };
      this.terminal = {
        type: EventType.RUN_ERROR,
        runId: request.runId,
        threadId: request.threadId,
        code: safe.code,
        message: safe.message,
        timestamp: Date.now(),
        ...explained(this.explanation),
      };
    } else if (this.status === 'aborted') {
      this.finishReason = 'interrupted';
      this.terminal = {
        type: EventType.RUN_ERROR,
        runId: request.runId,
        threadId: request.threadId,
        code: 'RUN_CANCELLED',
        message: 'The bot was stopped.',
        timestamp: Date.now(),
      };
    }
  }

  toOutcome(runId: string): ExecutionOutcome {
    return {
      runId,
      status: this.status,
      finishReason: this.finishReason,
      usage: this.usage,
      workingMs: this.workingMs,
      ...(this.stoppedBy === undefined ? {} : { stoppedBy: this.stoppedBy }),
      ...(this.stall === undefined ? {} : { stall: this.stall }),
      ...(this.status === 'failed' && this.failure !== undefined ? { error: this.failure } : {}),
    };
  }
}
