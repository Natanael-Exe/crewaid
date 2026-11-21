import type {
  ComputerSnapshots,
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
  ManagedSandboxObservation,
  SandboxHealth,
  WorkspaceObservation,
} from '@crewaid/sandbox-core';

export type { SandboxHealth };

/**
 * The sandbox provider as the orchestrator needs it.
 *
 * Two differences from the bare `HarnessV1SandboxProvider`, both load-bearing:
 *
 * - `resumeSession` is REQUIRED here. Upstream marks it optional because some
 * providers cannot rehydrate by id, and DECISIONS.md tells call sites to
 * use optional-call for exactly that reason. `DockerSandboxProvider` does
 * implement it, and narrowing the type at this seam is what lets the
 * lifecycle service depend on resume without an optional call that could
 * never be false in this application.
 * - `attachSession` gets a handle WITHOUT waiting for readiness. D-028 makes
 * `resumeSession` wait for the bridge, which is right for a caller that
 * wants to use the sandbox and wrong for stopping one: an UNHEALTHY
 * sandbox would have to become healthy before it could be stopped.
 * - `checkHealth` answers rather than throws. The health poll
 * needs "is it serving, and if not why" as a value it can write to a
 * column; a rejected promise would make every sandbox fault
 * indistinguishable from the daemon being unreachable.
 */
export type SandboxSession = HarnessV1NetworkSandboxSession & {
  readonly containerId: string;
  readonly screen: { readonly widthPx: number; readonly heightPx: number };
};

/** Daemon observations used to repair database/runtime disagreement. */
export type SandboxRuntimeObservation = ManagedSandboxObservation;
export type SandboxWorkspaceObservation = WorkspaceObservation;

export interface SandboxProvider extends HarnessV1SandboxProvider {
  readonly workspaceOnFirstStart?: boolean;
  readonly retireBotProfile: (options: { computerId: string; botId: string }) => Promise<void>;
  readonly provisionWorkspace: (options: { botId: string }) => Promise<void>;
  readonly inspectWorkspaceHistory: (options: { botId: string }) => Promise<{
    referenced: boolean;
    runtimeCreatedAt: number | null;
  }>;
  readonly listWorkspaces: () => Promise<readonly { botId: string }[]>;
  readonly retainWorkspace: (options: {
    botId: string;
    orphaned: boolean;
    now: number;
    retentionMs: number;
  }) => Promise<'absent' | 'in-use' | 'retained' | 'deleted'>;
  readonly createSession: (
    options?: NonNullable<Parameters<HarnessV1SandboxProvider['createSession']>[0]> & {
      requireExistingWorkspace?: boolean;
      /**
       * The profiles a computer recreated from its snapshot keeps.
       * Asked only when the provider actually recreates one.
       */
      snapshotProfiles?: () => Promise<readonly string[]>;
    },
  ) => Promise<SandboxSession>;
  readonly resumeSession: (
    options: Parameters<NonNullable<HarnessV1SandboxProvider['resumeSession']>>[0] & {
      ensureWorkspaceRetention?: boolean;
    },
  ) => Promise<SandboxSession>;
  readonly attachSession: (options: { sessionId: string }) => Promise<SandboxSession | null>;
  readonly checkHealth: (options: { sessionId: string }) => Promise<SandboxHealth>;
  /** Inventory of containers owned by this provider, including stopped containers. */
  readonly listManagedSessions: () => Promise<readonly SandboxRuntimeObservation[]>;
  /** Remove exactly one observed runtime. This operation never removes its workspace volume. */
  readonly removeManagedSession: (options: { containerId: string }) => Promise<void>;
  /** Observe the durable workspace independently from database and container state. */
  readonly inspectWorkspace: (options: { botId: string }) => Promise<SandboxWorkspaceObservation>;
  /**
   * A private `wss://` address for a port of a RUNNING computer, for a
   * viewer to reach directly, admitting new connections until `expiresAt`.
   * Optional: a provider that cannot expose a port safely has none, and its
   * screens are served by the orchestrator instead.
   */
  readonly screenAccess?: (options: {
    sessionId: string;
    port: number;
  }) => Promise<{ readonly url: string; readonly expiresAt: number }>;
  /**
   * One saved copy of each computer. Optional: a provider whose
   * computers cannot be saved whole has none, and the snapshot routes answer
   * `supported: false`.
   */
  readonly snapshots?: ComputerSnapshots;
}

/**
 * Injection token. A string token rather than the class: the orchestrator must
 * be bootable in tests without a Docker daemon, and depending on the concrete
 * `DockerSandboxProvider` would drag dockerode into every Nest test context.
 */
export const SANDBOX_PROVIDER = 'SANDBOX_PROVIDER';
