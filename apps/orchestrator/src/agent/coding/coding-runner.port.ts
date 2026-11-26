import type { Locale } from '@crewaid/shared';
import type { ToolSandboxSession } from '@crewaid/sandbox-core';

/**
 * SDK-independent coding runner port (D-241).
 *
 * No TanStack AI, Prisma, or provider credential types cross this seam, so the
 * built-in orchestrator sub-loop (Step 3) and future ACP runners (Steps 5–6)
 * share one contract, one `code_task` tool, and one progress/reporting surface.
 */

export type CodingRunnerKind = 'builtin';

export type CodingTaskStatus =
  | 'completed'
  | 'incomplete'
  | 'limit_reached'
  | 'stalled'
  | 'cancelled'
  | 'failed';

export type CodingTestStatus = 'passed' | 'failed' | 'not_run';

export interface CodingTestReport {
  readonly status: CodingTestStatus;
  readonly command?: string;
  readonly detail?: string;
}

export interface CodingCommandRecord {
  readonly command: string;
  readonly exitCode: number | null;
}

export interface CodingBlockedAction {
  readonly toolName: string;
  readonly detail: string;
  readonly reason: string;
}

export interface CodingTaskUsage {
  /** Recorded `provider:upstreamModelId` billing key for `/usage` pricing. */
  readonly modelKey: string;
  readonly modelLabel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly calls: number;
  readonly estimatedCostUsd: number | null;
}

export interface CodingTask {
  readonly goal: string;
  /** Workspace-validated absolute directory inside `/home/bot`. */
  readonly cwd: string;
  readonly context?: string;
  readonly verifyCommand?: string;
}

export type CodingProgressEvent =
  | {
      readonly kind: 'started';
      readonly sessionId: string;
      readonly runnerId: string;
      readonly modelLabel: string;
      readonly maxSteps: number;
      readonly cwd: string;
    }
  | {
      readonly kind: 'step';
      readonly sessionId: string;
      readonly runnerId: string;
      readonly modelLabel: string;
      readonly step: number;
      readonly maxSteps: number;
      readonly toolName: string;
      /** English, for logs and older clients; the desktop builds its own label from `toolName` and `target`. */
      readonly action: string;
      /** What the step acts on, already shortened (a file's basename, a pattern, a command). */
      readonly target?: string;
      readonly file?: string;
      readonly filesChangedCount: number;
    }
  | {
      readonly kind: 'finished';
      readonly sessionId: string;
      readonly runnerId: string;
      readonly modelLabel: string;
      readonly status: CodingTaskStatus;
      readonly steps: number;
      readonly maxSteps: number;
      readonly durationMs: number;
      readonly filesChangedCount: number;
    };

export interface CodingInvocation {
  readonly sessionId: string;
  readonly userId: string;
  readonly botId: string;
  readonly groupId: string | null;
  readonly parentRunId: string | undefined;
  /** Bot's configured primary model ref (`Bot.modelId`), used when no coding model override is set. */
  readonly parentModelRef: string;
  /** A coding-model override. No setting provides one yet, so this is null and the bot's model is used. */
  readonly codingModelRef: string | null;
  readonly maxSteps: number;
  readonly maxDurationMs: number;
  readonly maxTokens: number;
  readonly language: Locale | null;
  readonly session: () => Promise<ToolSandboxSession>;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (event: CodingProgressEvent) => void;
}

export interface CodingResult {
  readonly status: CodingTaskStatus;
  readonly runnerKind: CodingRunnerKind;
  readonly runnerId: string;
  readonly sessionId: string;
  readonly summary: string;
  readonly filesChanged: readonly string[];
  readonly tests: CodingTestReport;
  readonly commandsRun: readonly CodingCommandRecord[];
  readonly blockedActions: readonly CodingBlockedAction[];
  readonly steps: number;
  readonly durationMs: number;
  readonly usage?: CodingTaskUsage;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface CodingRunner {
  readonly id: string;
  readonly kind: CodingRunnerKind;
  run(task: CodingTask, invocation: CodingInvocation): Promise<CodingResult>;
}

export const CODING_RUNNER = Symbol('CODING_RUNNER');
