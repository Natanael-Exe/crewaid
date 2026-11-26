/**
 * Public, SDK-independent types for `@crewaid/acp-core` (D-241 Steps 5–6).
 *
 * Neither the local connector CLI (Step 5) nor the orchestrator's sandbox
 * runner (Step 6) imports `@agentclientprotocol/sdk` directly; everything
 * crosses this contract so upstream protocol churn stays inside one package.
 */

export type AcpHarnessId = 'claude-code' | 'codex' | 'opencode' | 'antigravity' | 'custom';

/**
 * How much of the harness's work leaves the machine executing it.
 *
 * - `summary` (default): forwards step counters, tool categories, basenames,
 *   relative file paths changed, command labels/outcomes, and the harness's
 *   own final summary. Raw file contents, diffs, and command output are
 *   dropped before returning or emitting progress.
 * - `full`: additionally includes size-bounded transcript and diff excerpts.
 */
export type AcpReportMode = 'summary' | 'full';

export type AcpSessionStatus = 'completed' | 'incomplete' | 'cancelled' | 'failed';

export type AcpPermissionOptionKind =
  'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: AcpPermissionOptionKind;
}

export interface AcpPermissionRequest {
  readonly acpSessionId: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly toolKind: string;
  /** Paths referenced by the tool call, already relativized to `cwd` when inside it. */
  readonly locations: readonly string[];
  readonly options: readonly AcpPermissionOption[];
}

export type AcpPermissionDecision =
  { readonly outcome: 'selected'; readonly optionId: string } | { readonly outcome: 'cancelled' };

export type AcpProgressUpdate =
  | {
      readonly kind: 'started';
      readonly acpSessionId: string;
      readonly harness: string;
      readonly agentName?: string;
      readonly cwd: string;
    }
  | {
      readonly kind: 'step';
      readonly acpSessionId: string;
      readonly step: number;
      readonly toolKind: string;
      readonly toolName: string;
      readonly title: string;
      readonly target?: string;
      readonly file?: string;
      readonly filesChangedCount: number;
    }
  | {
      readonly kind: 'waiting_local_permission';
      readonly acpSessionId: string;
      readonly toolCallId: string;
      readonly title: string;
      readonly toolKind: string;
    }
  | {
      readonly kind: 'resumed';
      readonly acpSessionId: string;
      readonly toolCallId: string;
      readonly outcome: 'selected' | 'cancelled';
    }
  | {
      readonly kind: 'finished';
      readonly acpSessionId: string;
      readonly status: AcpSessionStatus;
      readonly steps: number;
      readonly durationMs: number;
      readonly filesChangedCount: number;
    };

export interface AcpCommandRecord {
  readonly command: string;
  readonly status: 'completed' | 'failed' | 'unknown';
}

export interface AcpRunOutput {
  readonly status: AcpSessionStatus;
  readonly stopReason?: string;
  readonly acpSessionId: string | null;
  readonly agentName?: string;
  readonly reportMode: AcpReportMode;
  /** The harness's own final text summary of what it did (bounded). */
  readonly summary: string;
  readonly filesChanged: readonly string[];
  readonly commandsRun: readonly AcpCommandRecord[];
  readonly steps: number;
  readonly durationMs: number;
  /** Present only when `reportMode === 'full'` and non-empty. */
  readonly transcriptExcerpt?: string;
  /** Present only when `reportMode === 'full'` and non-empty. */
  readonly diffExcerpt?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * Raw NDJSON byte transport for an ACP agent.
 *
 * Step 5 constructs this over a local `child_process.spawn` stdin/stdout pair;
 * Step 6 constructs it over a sandbox `bridgeExec` stdin/stdout pair.
 */
export interface AcpByteTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly close?: () => void | Promise<void>;
}

export interface AcpRunInput {
  /** Absolute workspace directory handed to ACP `session/new`. */
  readonly cwd: string;
  readonly prompt: string;
  readonly harnessId?: AcpHarnessId | undefined;
  readonly reportMode?: AcpReportMode | undefined;
  readonly transport: AcpByteTransport;
  readonly abortSignal?: AbortSignal | undefined;
  /** How long to wait after sending `session/cancel` before closing the transport. */
  readonly cancelGraceMs?: number | undefined;
  readonly clientInfo?: { readonly name: string; readonly version: string } | undefined;
  readonly onProgress?: ((event: AcpProgressUpdate) => void) | undefined;
  /**
   * Handles ACP `session/request_permission`.
   *
   * When omitted (or if the callback throws or aborts), `@crewaid/acp-core`
   * fails closed with `{ outcome: 'cancelled' }`.
   */
  readonly onPermissionRequest?:
    | ((request: AcpPermissionRequest, signal: AbortSignal) => Promise<AcpPermissionDecision>)
    | undefined;
}
