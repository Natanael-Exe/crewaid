/**
 * What a provider reports about its own runtimes and workspaces.
 *
 * These are the answers the orchestrator's health poll, reconciliation and
 * retention sweeps act on, so they are provider-neutral: a Docker
 * provider fills them from the daemon, a hosted one from its API. The field
 * names still say `containerId` and `volumeName` because Docker was the first
 * runtime; for another provider they are its runtime id and its durable
 * workspace's name.
 */

/**
 * The answer `checkHealth` gives. `reason` is written to `Sandbox.lastError`
 * and read by an operator, so it names the component and the evidence rather
 * than restating "unhealthy".
 */
export type SandboxHealth = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** A provider-owned runtime as observed directly from the provider. */
export interface ManagedSandboxObservation {
  readonly containerId: string;
  readonly sessionId: string | null;
  readonly botId: string | null;
  readonly running: boolean;
  readonly workspace:
    | { readonly ok: true; readonly volumeName: string }
    | { readonly ok: false; readonly reason: string }
    | null;
}

export type WorkspaceObservation =
  | { readonly exists: false }
  | { readonly exists: true; readonly ok: true; readonly volumeName: string }
  | { readonly exists: true; readonly ok: false; readonly reason: string };

/**
 * A computer's one snapshot, as its provider reports it. Times are
 * Unix milliseconds. `saving`/`restoring` say what the provider can see in
 * flight; `lastError` is a capture that failed and was not replaced.
 */
export interface ComputerSnapshotObservation {
  readonly snapshot: {
    readonly takenAt: number;
    readonly sizeBytes: number | null;
    readonly expiresAt: number | null;
  } | null;
  readonly saving: boolean;
  readonly restoring: boolean;
  readonly lastError: string | null;
}

/**
 * The optional snapshot capability of a provider whose computers can be saved
 * whole and brought back. A provider without it has no member at all.
 */
export interface ComputerSnapshots {
  /** Never wakes a computer. Finishes an interrupted replacement first. */
  inspect(options: { computerId: string }): Promise<ComputerSnapshotObservation>;
  /** Replaces the computer's snapshot. A paused computer stays paused. */
  take(options: { computerId: string; abortSignal?: AbortSignal }): Promise<void>;
  /**
   * Replaces the computer's machine with its snapshot. The new machine stays
   * paused unless the caller is putting it back into service immediately.
   * Every browser profile not in `keepProfiles` is retired on the restored
   * machine before it becomes the computer.
   */
  restore(options: {
    computerId: string;
    keepProfiles: readonly string[];
    leaveRunning?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<void>;
}
