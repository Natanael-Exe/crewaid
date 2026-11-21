/**
 * The Docker engine operations `DockerSandboxProvider` needs, stated without
 * naming dockerode.
 *
 * R2 allows exactly one file in the monorepo to import `dockerode`, and
 * CLAUDE.md is explicit about the consequence: "if you need container behaviour
 * elsewhere, widen this class's interface — do not widen the allowlist." This
 * is that interface. `docker-sandbox-provider.ts` implements it over dockerode.
 *
 * The per-container half — `SandboxContainer` and the shapes it returns — is
 * shared with every other provider and lives in `@crewaid/sandbox-core`. What
 * stays here is Docker's own: named volumes, the bridge network, create-time
 * limits and label lookups.
 */

import type { ContainerMount, SandboxContainer } from '@crewaid/sandbox-core';

export interface ContainerCreateSpec {
  readonly image: string;
  readonly screen: { readonly widthPx: number; readonly heightPx: number };
  readonly name: string;
  readonly network: string;
  /** Container ports to publish. The engine chooses free host ports. */
  readonly publishPorts: readonly number[];
  readonly labels: Readonly<Record<string, string>>;
  /** §5.1, applied at creation. Never defaulted by the adapter. */
  readonly limits: ContainerLimits;
  /** Durable storage. Empty means an ephemeral desktop. */
  readonly mounts: readonly ContainerMount[];
}

/**
 * A bot's durable workspace, as the engine reports it.
 *
 * The labels are the load-bearing part: they are the ONLY authoritative record
 * of which bot a workspace belongs to. Nothing stores the volume
 * name in Postgres, precisely so that a stored copy cannot disagree with the
 * daemon about who owns a desktop's files.
 */
export interface WorkspaceVolume {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * PRD §5.1 verbatim. Stated as required fields rather than optional ones with
 * defaults: a sandbox that silently came up without a memory cap or with
 * capabilities intact would look identical to a correct one from the outside,
 * and the negative test that would catch it runs much later than the
 * mistake.
 */
export interface ContainerLimits {
  readonly memoryBytes: number;
  readonly memorySwapBytes: number;
  readonly cpus: number;
  readonly pidsLimit: number;
  readonly noNewPrivileges: boolean;
  readonly dropAllCapabilities: boolean;
  /**
   * Docker's default seccomp profile plus what Chrome's own sandbox needs to
   * create its namespaces. Grants no capability.
   */
  readonly allowBrowserSandbox: boolean;
  readonly shmSizeBytes: number;
}

export interface ContainerEngine {
  listWorkspaceVolumes(): Promise<readonly WorkspaceVolume[]>;
  /** Queue deletion without touching a loaded Chrome profile. */
  retireBotProfile(volumeName: string, image: string, botId: string): Promise<void>;
  /** Marker lives inside the named volume; no host path or application entrypoint. */
  workspaceMarker(
    name: string,
    image: string,
    now: number,
    clear: boolean,
    history?: 'read' | 'write',
  ): Promise<number | null>;
  /** Non-forced removal: Docker must refuse a volume referenced by any container. */
  removeWorkspaceVolume(name: string): Promise<void>;
  /** Create the sandbox bridge if it is not already there. Idempotent. */
  ensureNetwork(name: string): Promise<void>;
  create(spec: ContainerCreateSpec): Promise<SandboxContainer>;
  /** The durable lookup for resume. `null` when nothing matches. */
  findByLabel(label: string, value: string): Promise<SandboxContainer | null>;
  /** Every matching container, including stopped ones. Used only for reconciliation. */
  listByLabel(label: string, value: string): Promise<readonly SandboxContainer[]>;
  /** Every container mounting a named volume, including unmanaged containers. */
  listByVolume(volumeName: string): Promise<readonly SandboxContainer[]>;
  /** Exact-id lookup for removing one observed orphan without trusting its labels again. */
  findById(id: string): Promise<SandboxContainer | null>;
  /** One workspace volume by exact name. `null` when it does not exist. */
  findVolume(name: string): Promise<WorkspaceVolume | null>;
  /**
   * Create a workspace volume. Labels are set at creation because Docker has no
   * way to add them afterwards — which is also why D-039 keeps the retention
   * deadline inside the volume rather than in a label.
   */
  createVolume(spec: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  }): Promise<WorkspaceVolume>;
}
