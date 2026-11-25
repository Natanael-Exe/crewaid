import type { ChatMiddlewareContext, ModelMessage } from '@tanstack/ai';
import { JsonSchema, projectPublicSpeech } from '@crewaid/shared';
import { TranscriptBodySchema } from '../persistence/transcript.js';
import type { ClosingRunStatus } from '../persistence/owned-run-boundary.js';
import type { TurnLimitAccount } from '../turn-limits.js';
import { leakedToolMarkup } from './tool-markup.js';
import type { PrivacyVault } from './privacy-vault.js';
import type { ExecutionPorts } from './execution-backend.port.js';
import type { RunExecutionState, TanStackExecutionPersistence } from './run-execution-state.js';

const CRASH_CHECKPOINT_INTERVAL_MS = 1_000;

export type CloseRunBoundary = <T>(
  next: ClosingRunStatus,
  operation: () => Promise<T>,
) => Promise<T>;

/** Tracks in-flight assistant text and throttles crash-recovery saves during streaming. */
export class CrashCheckpointTracker {
  private readonly partialText = new Map<string, ModelMessage>();
  private savedTextAt: number | undefined;

  onTextStart(messageId: string): void {
    this.savedTextAt = undefined;
    this.partialText.set(messageId, {
      id: messageId,
      role: 'assistant',
      content: '',
      createdAt: new Date(),
    });
  }

  async onTextDelta(
    messageId: string,
    delta: string,
    persistence: TanStackExecutionPersistence,
    threadId: string,
  ): Promise<void> {
    const partial = this.partialText.get(messageId);
    if (partial !== undefined && typeof partial.content === 'string') {
      this.partialText.set(messageId, {
        ...partial,
        content: partial.content + delta,
      });
    }
    // Retain the crash checkpoint using only changed replies. The first delta
    // starts the clock so initial streaming never blocks on a save.
    const textAt = Date.now();
    this.savedTextAt ??= textAt;
    if (textAt - this.savedTextAt >= CRASH_CHECKPOINT_INTERVAL_MS) {
      await persistence.assertLive();
      await persistence.persistence.stores.messages.saveThread(threadId, this.safePartialText());
      this.savedTextAt = textAt;
    }
  }

  clearPersisted(messages: readonly ModelMessage[]): void {
    for (const message of messages) {
      if (message.id !== undefined) this.partialText.delete(message.id);
    }
  }

  /** Drops an in-flight corrupted reply so terminal close never snapshots it. */
  discard(messageId: string): void {
    this.partialText.delete(messageId);
  }

  async flushForClose(persistence: TanStackExecutionPersistence, threadId: string): Promise<void> {
    if (this.partialText.size === 0) return;
    await persistence.persistence.stores.messages.saveThread(threadId, this.safePartialText());
  }

  private safePartialText(): ModelMessage[] {
    return [...this.partialText.values()].filter(
      (message) => leakedToolMarkup([message]) === undefined,
    );
  }
}

/** Runs terminal persistence transitions inside the owned boundary, flushing partial text on abort/failure. */
export function createBoundaryCloser(
  state: RunExecutionState,
  crashCheckpoint: CrashCheckpointTracker,
  threadId: string,
): CloseRunBoundary {
  return async <T>(next: ClosingRunStatus, operation: () => Promise<T>): Promise<T> => {
    if (state.runtime === undefined) throw new Error('Persistence was not opened.');
    try {
      const persistence = state.runtime;
      const result = await persistence.boundary(next, async () => {
        if (next === 'failed' || next === 'aborted') {
          await crashCheckpoint.flushForClose(persistence, threadId);
        }
        return operation();
      });
      state.closedStatus = next;
      return result;
    } catch (error) {
      state.recordBoundaryFailure(error);
      throw error;
    }
  };
}

export type RunCheckpointer = {
  readonly checkpointStep: (ctx: ChatMiddlewareContext, reason: string | null) => Promise<void>;
  readonly persistBeforeTools: (ctx: ChatMiddlewareContext) => Promise<void>;
  readonly persistCarriedResumeStep: (ctx: ChatMiddlewareContext) => Promise<void>;
};

export function createRunCheckpointer(input: {
  readonly state: RunExecutionState;
  readonly persistence: TanStackExecutionPersistence;
  readonly limits: TurnLimitAccount;
  readonly crashCheckpoint: CrashCheckpointTracker;
  readonly ports: Pick<ExecutionPorts, 'checkpoint'>;
  readonly threadId: string;
  readonly vault?: PrivacyVault;
}): RunCheckpointer {
  const { state, persistence, limits, crashCheckpoint, ports, threadId, vault } = input;

  return {
    async checkpointStep(ctx, reason) {
      if (state.checkpointed.has(ctx.iteration) || !state.checkpointable.has(ctx.iteration)) return;
      // A pause closes the run and releases the lease before the engine asks
      // whether to continue; the closing transaction already flushed it.
      if (state.closedStatus !== undefined) return;
      await persistence.assertLive();
      // Full canonical results land before the next provider request; saveThread never deletes rows.
      await persistence.persistence.stores.messages.saveThread(threadId, [...ctx.messages]);
      const usageSnapshot = state.snapshotUsage(persistence.budget.usage.unreportedCalls);
      const completed = state.completedSteps(persistence.budget.steps);
      // Persist token usage step by step so chained budgets see spend while this run is active.
      await persistence.progress({
        steps: completed + 1,
        workingMs: limits.elapsedMs(),
        usage: usageSnapshot,
      });
      const start = state.iterationStarts.get(ctx.iteration) ?? ctx.messages.length;
      const stepSlice = ctx.messages.slice(start);
      const resolvedSlice = (vault === undefined ? stepSlice : vault.resolveMessages(stepSlice)).map(
        (message) => {
          if (message.role !== 'assistant' || message.content === null) return message;
          if (typeof message.content === 'string') {
            const cleaned = projectPublicSpeech(message.content);
            return cleaned === message.content ? message : { ...message, content: cleaned };
          }
          let changed = false;
          const nextParts = message.content.map((part) => {
            if (part.type !== 'text' || typeof part.content !== 'string') return part;
            const cleaned = projectPublicSpeech(part.content);
            if (cleaned === part.content) return part;
            changed = true;
            return { ...part, content: cleaned };
          });
          return changed ? { ...message, content: nextParts } : message;
        },
      );
      const bodies = resolvedSlice.map(({ id: _id, createdAt: _date, ...body }) =>
        JsonSchema.parse(TranscriptBodySchema.parse(body)),
      );
      await ports.checkpoint({
        stepIndex: completed,
        workingMs: limits.elapsedMs(),
        messages: bodies,
        finishReason: reason,
        usage: usageSnapshot,
      });
      crashCheckpoint.clearPersisted(ctx.messages);
      state.checkpointed.add(ctx.iteration);
      limits.recordRound({ steps: 1, tokens: state.usage.inputTokens - limits.tokens() });
    },

    async persistBeforeTools(ctx) {
      if (ctx.phase !== 'beforeTools' || state.closedStatus !== undefined) return;
      if (state.savedBeforeTools.has(ctx.iteration)) return;
      state.savedBeforeTools.add(ctx.iteration);
      // Persist calls before dispatch so recovery after a crash mid-tool answers
      // from the dispatch ledger instead of re-asking the model.
      await persistence.assertLive();
      await persistence.persistence.stores.messages.saveThread(threadId, [...ctx.messages]);
      crashCheckpoint.clearPersisted(ctx.messages);
      // Persist spend before tools run so downstream work spawned by a tool sees current usage.
      await persistence.progress({
        steps: state.completedSteps(persistence.budget.steps),
        workingMs: limits.elapsedMs(),
        usage: state.snapshotUsage(persistence.budget.usage.unreportedCalls),
      });
    },

    async persistCarriedResumeStep(ctx) {
      // A paused step never reaches its checkpoint; the resumed run charges it
      // before checking ceilings for the next model call.
      state.carried = 1;
      state.iterationStarts.set(0, ctx.messages.length);
      await persistence.persistence.stores.messages.saveThread(threadId, [...ctx.messages]);
      await persistence.progress({
        steps: persistence.budget.steps + state.carried,
        workingMs: limits.elapsedMs(),
        usage: state.snapshotUsage(persistence.budget.usage.unreportedCalls),
      });
      limits.recordRound({ steps: 1, tokens: 0 });
    },
  };
}
