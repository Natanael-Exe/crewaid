/**
 * The container operations a sandbox session needs, stated without naming any
 * runtime.
 *
 * `ContainerSandboxSession` builds the entire `HarnessV1NetworkSandboxSession`
 * on top of `SandboxContainer` and never learns what is underneath. Each
 * provider implements it over its own runtime: `@crewaid/sandbox-docker` over
 * dockerode (R2 keeps that to one file), and any hosted runtime over its API.
 * A provider that can answer these five calls gets the whole session — file
 * I/O framed over exec, line-ranged text reads, stream collection, the reduced
 * view — without writing any of it again.
 *
 * The practical payoff is that the session logic is unit-testable against a
 * fake container, with no daemon and no image. That matters because the parts
 * most likely to be wrong are the ones a real-runtime test is slowest and
 * least precise at exercising.
 *
 * The shapes here are deliberately small. `inspect()` returns a handful of
 * facts rather than a runtime's hundred-field blob, so an upstream API change
 * lands in one adapter method instead of everywhere a caller reached into it.
 */

/** Where a container port is reachable from the orchestrator's perspective. */
export interface ContainerPortBinding {
  readonly host: string;
  readonly port: number;
}

export interface ContainerStatus {
  readonly running: boolean;
  /** Daemon-reported network for supervisors fencing deployments on a shared host. */
  readonly network?: string;
  /** Exit code once stopped; `null` while running or never started. */
  readonly exitCode: number | null;
  /**
   * Container port → where it is published. Absent means "exposed by the image
   * but not reachable", which is a real state and not an error: a container
   * that has been stopped keeps its port list and loses its bindings.
   */
  readonly portBindings: Readonly<Record<number, ContainerPortBinding | undefined>>;
  /**
   * The durable volumes this container actually has attached.
   *
   * Reported because a container created before D-039 has none, and resuming
   * one would hand the bot a desktop whose files vanish with the container —
   * silently, and looking exactly like a working sandbox. Bind mounts are not
   * representable here for the same reason they are not representable in
   * `ContainerMount`.
   */
  readonly mounts: readonly ContainerMount[];
  /**
   * The container's own labels, which are how it says what it is for.
   *
   * Needed to tell a container that SHOULD have a workspace from one that
   * legitimately has none: a session created without an identity is ephemeral
   * by design, and refusing to resume it would be a guard firing on the case
   * it was never aimed at.
   */
  readonly labels: Readonly<Record<string, string>>;
}

export interface ContainerExecSpec {
  /** argv, already split. Nothing here builds a shell string from user input. */
  readonly command: readonly string[];
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Open stdin. Only the file-write path needs it. */
  readonly stdin?: boolean;
}

/**
 * A process running inside the container.
 *
 * `stdout`/`stderr` are already demultiplexed — Docker frames both onto one
 * connection with an 8-byte header per chunk, and a caller that receives the
 * raw stream gets binary garbage interleaved into its file reads. Demuxing
 * belongs in the adapter for the same reason the rest of Docker's shape does.
 */
export interface ContainerProcess {
  /**
   * `| undefined` is spelled out because `exactOptionalPropertyTypes` otherwise
   * reads `pid?: number` as "may be absent, but never the value undefined" —
   * which an implementation that learns the pid only after the process exits
   * cannot satisfy.
   */
  readonly pid?: number | undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Present only when the spec asked for it. */
  readonly stdin: WritableStream<Uint8Array> | null;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

export interface SandboxContainer {
  readonly id: string;
  start(): Promise<void>;
  /** Idempotent: stopping an already-stopped container is not an error. */
  stop(timeoutSeconds?: number): Promise<void>;
  /** Idempotent: removing an already-removed container is not an error. */
  remove(): Promise<void>;
  inspect(): Promise<ContainerStatus>;
  spawn(spec: ContainerExecSpec): Promise<ContainerProcess>;
}

/**
 * A durable volume attached to a container.
 *
 * There is deliberately no host-path variant. R5 and §5.1 forbid bind mounts,
 * and the cheapest way to keep that true is to make it unsayable: a caller
 * cannot ask this port for a host directory, so the rule is enforced by the
 * type rather than by remembering to check for it in review. `Binds` stays
 * empty in the adapter for the same reason it always has.
 */
export interface ContainerMount {
  /** A Docker *named volume*. The daemon owns the path; nothing here does. */
  readonly volume: string;
  /** Absolute path inside the container. */
  readonly path: string;
}
