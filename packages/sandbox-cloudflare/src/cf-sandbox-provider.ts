/**
 * Customer computers on Cloudflare Containers.
 *
 * Satisfies the orchestrator's `SandboxProvider` contract over the control
 * Worker in `infra/cloudflare/control-worker`, which owns one Durable Object
 * and one container per computer:
 *
 * - The runtime and the workspace are apart, as under Docker. A container's
 * disk starts from the image every time; the workspace is a tar of
 * /home/bot in R2 that the Worker restores on start and saves on stop.
 * So `stop` and orphan cleanup really stop the container — nothing runs
 * or bills until the next start — and only retention's `deleted` outcome
 * removes the saved workspace. Open tabs and running programs do not
 * survive a stop; files and saved logins do (measured 2026-09-30).
 * - Filesystem snapshots are not used. Cloudflare stores each one in the
 * account's image registry (50 GB per account), each holds the whole
 * workspace, a snapshot restores only onto the image it was taken from,
 * and it expires 30 days after its last restore. A tar in R2 survives
 * image releases and never expires.
 * - The workspace record, its first-start time and its orphan clock live in
 * the computer's Durable Object, outside the container, so workspace
 * history and retention never start a machine to answer.
 * - Ports reach the orchestrator as loopback listeners (`PortTunnels`) over
 * the Worker's WebSocket tunnel, and commands and file I/O go through the
 * machine's own bridge (`/exec`) over that tunnel, as on DigitalOcean.
 * - The orchestrator's idle stop decides when a computer stops. Any open
 * tunnel keeps a Cloudflare container awake past its own inactivity
 * timeout, so the Worker stops a computer itself when the orchestrator
 * has been silent for 15 minutes; `checkHealth`, which the health sweep
 * calls every few seconds per running computer, is what it hears.
 */

import {
  ContainerSandboxSession,
  HARNESS_SANDBOX_SPECIFICATION_VERSION,
  HarnessError,
  HarnessSandboxAuthenticationError,
  PortTunnels,
  SANDBOX_PORTS,
  SEAT_CDP_PORTS,
  SEAT_PORTS,
  bridgeExec,
  type ContainerExecSpec,
  type ContainerPortBinding,
  type ContainerProcess,
  type ContainerStatus,
  type HarnessV1CreateSessionOptions,
  type HarnessV1ResumeSessionOptions,
  type HarnessV1SandboxProvider,
  type ManagedSandboxObservation,
  type SandboxContainer,
  type SandboxHealth,
  type WorkspaceObservation,
} from '@crewaid/sandbox-core';

import {
  CloudflareControl,
  CloudflareControlError,
  type ComputerStatus,
  type RetentionOutcome,
} from './cf-control.js';

/** Every port a machine serves; each gets a loopback listener while it runs. */
const MACHINE_PORTS: readonly number[] = [
  SANDBOX_PORTS.rfb,
  SANDBOX_PORTS.cdp,
  SANDBOX_PORTS.bridge,
  ...SEAT_PORTS,
  ...SEAT_CDP_PORTS,
];

/** The image's screen. Every start is the image, so there is nothing to renegotiate. */
const SCREEN = Object.freeze({ widthPx: 1280, heightPx: 800 });

/** How long a status answer is reused. `getPortEndpoint` inspects on every call. */
const STATUS_TTL_MS = 1_000;

export interface CloudflareSandboxProviderOptions {
  /** The control Worker's origin (`SANDBOX_CF_CONTROL_URL`). Ignored when `control` is given. */
  readonly controlUrl?: string;
  /** Seam for tests; defaults to a client that reads the secret from the environment. */
  readonly control?: CloudflareControl;
  /**
   * How long a start has to become usable. A start from a cached image took
   * about five seconds in the trial and the first start of a new image
   * seventeen; the rest is room for a large workspace restore.
   */
  readonly readyTimeoutMs?: number;
  /** Seam for tests: resolves true when the bridge at `baseUrl` is healthy. */
  readonly bridgeProbe?: (baseUrl: string) => Promise<boolean>;
}

export class CloudflareSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = HARNESS_SANDBOX_SPECIFICATION_VERSION;
  readonly providerId = 'crewaid-cloudflare';

  readonly #control: CloudflareControl;
  readonly #readyTimeoutMs: number;
  readonly #bridgeProbe: (baseUrl: string) => Promise<boolean>;
  /** One container object per computer, so its tunnels are shared. */
  readonly #containers = new Map<string, CloudflareContainer>();

  constructor(options: CloudflareSandboxProviderOptions) {
    if (options.control === undefined && options.controlUrl === undefined) {
      throw new Error('The Cloudflare sandbox provider needs the control Worker URL');
    }
    this.#control = options.control ?? new CloudflareControl({ url: options.controlUrl ?? '' });
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
    this.#bridgeProbe = options.bridgeProbe ?? probeBridgeOverHttp;
  }

  // sessions

  createSession = async (
    options?: HarnessV1CreateSessionOptions & { requireExistingWorkspace?: boolean },
  ): Promise<ContainerSandboxSession> =>
    this.#mapped(async () => {
      options?.abortSignal?.throwIfAborted();
      const sessionId = options?.sessionId ?? crypto.randomUUID();
      // The Worker keys a computer's runtime and workspace by one id. The
      // orchestrator passes the same string for both; if they ever diverge
      // this refuses rather than filing files under a name nothing looks for.
      if (options?.identity !== undefined && options.identity !== sessionId) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: the Cloudflare provider keys a computer's runtime and ` +
            `workspace by one id, but was asked for identity ${options.identity}.`,
        });
      }
      const status = await this.#control.status(sessionId);
      if (status.running) {
        throw new HarnessError({
          message: `sandbox ${sessionId} is already running. Use resumeSession() to reattach.`,
        });
      }
      if (!status.exists) {
        if (options?.requireExistingWorkspace === true) {
          throw new HarnessError({
            message:
              `sandbox ${sessionId}: its workspace is missing, and storage is not recreated ` +
              'automatically (D-031).',
          });
        }
        await this.#control.provision(sessionId);
      }
      const container = this.#containerFor(sessionId);
      try {
        await container.start();
        const session = this.#sessionOver(sessionId, container);
        await this.#awaitUsable(session, sessionId, options?.abortSignal);
        if (options?.onFirstCreate !== undefined) {
          await options.onFirstCreate(session.restricted(), {
            ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          });
        }
        return session;
      } catch (error) {
        // Stopping saves the workspace, so a failed start loses nothing.
        await container.stop().catch(() => undefined);
        throw error;
      }
    });

  resumeSession = async (
    options: HarnessV1ResumeSessionOptions,
  ): Promise<ContainerSandboxSession> =>
    this.#mapped(async () => {
      const { sessionId } = options;
      const status = await this.#control.status(sessionId);
      if (!status.exists) {
        throw new HarnessError({
          message: `sandbox ${sessionId}: no Cloudflare computer has that id`,
        });
      }
      const container = this.#containerFor(sessionId);
      await container.start();
      const session = this.#sessionOver(sessionId, container);
      await this.#awaitUsable(session, sessionId, options.abortSignal);
      return session;
    });

  /** A handle without starting or waiting — for stop, destroy and inspect. */
  attachSession = async (options: { sessionId: string }): Promise<ContainerSandboxSession | null> =>
    this.#mapped(async () => {
      const status = await this.#control.status(options.sessionId);
      if (!status.exists) return null;
      return this.#sessionOver(options.sessionId, this.#containerFor(options.sessionId));
    });

  /** Total, like Docker's: every machine-level fault is an answer, only an API failure throws. */
  checkHealth = async (options: { sessionId: string }): Promise<SandboxHealth> =>
    this.#mapped(async () => {
      const status = await this.#control.status(options.sessionId);
      if (!status.exists) return unwell(`no Cloudflare computer has id ${options.sessionId}`);
      if (!status.running)
        return unwell(`computer ${options.sessionId} is stopped${exitDetail(status)}`);
      const bridge = await this.#containerFor(options.sessionId).endpoint(SANDBOX_PORTS.bridge);
      if (!(await this.#bridgeProbe(`http://${bridge.host}:${bridge.port}`))) {
        return unwell(`the agent-bridge in computer ${options.sessionId} did not report healthy`);
      }
      return { ok: true };
    });

  // inventory and reconciliation

  /** Running computers. A stopped one has no runtime to observe: its workspace is a saved tar. */
  listManagedSessions = async (): Promise<readonly ManagedSandboxObservation[]> =>
    this.#mapped(async () =>
      (await this.#control.list())
        .filter((computer) => computer.running)
        .map((computer) => ({
          containerId: computer.id,
          sessionId: computer.id,
          botId: computer.id,
          running: true,
          workspace: { ok: true, volumeName: computer.id },
        })),
    );

  /** Orphan cleanup: stop the runtime. Stopping saves the workspace; nothing is deleted. */
  removeManagedSession = async (options: { containerId: string }): Promise<void> =>
    this.#mapped(async () => {
      const status = await this.#control.status(options.containerId);
      if (!status.exists) return;
      await this.#containerFor(options.containerId).stop();
    });

  // workspaces

  /** Records the workspace. Nothing starts: the first start restores an empty one. */
  provisionWorkspace = async (options: { botId: string }): Promise<void> =>
    this.#mapped(async () => {
      await this.#control.provision(options.botId);
    });

  inspectWorkspace = async (options: { botId: string }): Promise<WorkspaceObservation> =>
    this.#mapped(async () => {
      const status = await this.#control.status(options.botId);
      return status.exists
        ? { exists: true, ok: true, volumeName: options.botId }
        : { exists: false };
    });

  /** Answered from the Worker's record, so it never starts a machine. */
  inspectWorkspaceHistory = async (options: {
    botId: string;
  }): Promise<{ referenced: boolean; runtimeCreatedAt: number | null }> =>
    this.#mapped(async () => {
      const status = await this.#control.status(options.botId);
      if (!status.exists) throw new Error('Workspace is missing; refusing to recreate storage');
      const runtimeCreatedAt = status.runtimeCreatedAt ?? null;
      // A running computer is the runtime referencing this workspace.
      return { referenced: status.running && runtimeCreatedAt !== null, runtimeCreatedAt };
    });

  listWorkspaces = async (): Promise<readonly { botId: string }[]> =>
    this.#mapped(async () =>
      (await this.#control.list()).map((computer) => ({ botId: computer.id })),
    );

  /** The orphan clock is in the Worker, so retention never starts a machine either. */
  retainWorkspace = async (options: {
    botId: string;
    orphaned: boolean;
    now: number;
    retentionMs: number;
  }): Promise<RetentionOutcome> =>
    this.#mapped(async () => {
      const outcome = await this.#control.retain(options.botId, {
        orphaned: options.orphaned,
        now: options.now,
        retentionMs: options.retentionMs,
      });
      if (outcome === 'deleted' || outcome === 'absent') {
        await this.#containers.get(options.botId)?.close();
        this.#containers.delete(options.botId);
      }
      return outcome;
    });

  /**
   * Write a bot's profile tombstone. A running computer writes it now; a
   * stopped one has only a saved tar, so the Worker writes it on the next
   * start, after the restore and before the desktop opens any profile.
   */
  retireBotProfile = async (options: { computerId: string; botId: string }): Promise<void> =>
    this.#mapped(async () => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.botId) || options.botId === 'Default') {
        throw new Error('Invalid bot profile');
      }
      await this.#control.retireProfile(options.computerId, options.botId);
    });

  // plumbing

  #containerFor(computerId: string): CloudflareContainer {
    let container = this.#containers.get(computerId);
    if (container === undefined) {
      container = new CloudflareContainer(this.#control, computerId);
      this.#containers.set(computerId, container);
    }
    return container;
  }

  #sessionOver(sessionId: string, container: CloudflareContainer): ContainerSandboxSession {
    return new ContainerSandboxSession({
      sessionId,
      container,
      containerId: container.id,
      screen: SCREEN,
    });
  }

  /**
   * Wait for the bridge. There is no launcher to run, unlike DigitalOcean:
   * the desktop's entrypoint is the container's first process, so a desktop
   * that dies ends the container, and that is reported instead of waited on.
   */
  async #awaitUsable(
    session: ContainerSandboxSession,
    sessionId: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    const { url } = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    let lastStatusAt = Date.now();
    for (;;) {
      abortSignal?.throwIfAborted();
      if (await this.#bridgeProbe(url)) return;
      if (Date.now() - lastStatusAt >= 2_000) {
        lastStatusAt = Date.now();
        const status = await this.#control.status(sessionId);
        if (!status.running) {
          throw new HarnessError({
            message: `sandbox ${sessionId}: the computer stopped while starting${exitDetail(status)}`,
          });
        }
      }
      if (Date.now() > deadline) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: the agent-bridge did not report healthy within ` +
            `${this.#readyTimeoutMs}ms`,
        });
      }
      await delay(250);
    }
  }

  async #mapped<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (HarnessError.isInstance(error)) throw error;
      if (error instanceof CloudflareControlError && error.status === 401) {
        throw new HarnessSandboxAuthenticationError({
          message:
            'The Cloudflare control Worker refused the control secret. Check that the ' +
            'orchestrator’s secret matches the Worker’s CONTROL_SECRET.',
          sandboxProviderId: this.providerId,
          cause: error,
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new HarnessError({ message: `cloudflare: ${detail}`, cause: error });
    }
  }
}

/**
 * One Cloudflare computer as the narrow container port.
 *
 * `stop` and `remove` both stop the container through the Worker, which saves
 * the workspace first — `remove` keeps the workspace, as Docker's does. Both
 * close the tunnels first: an open tunnel keeps a container awake.
 */
class CloudflareContainer implements SandboxContainer {
  readonly id: string;
  readonly #control: CloudflareControl;
  #tunnels: PortTunnels | null = null;
  #bindings: Readonly<Record<number, ContainerPortBinding>> | null = null;
  #status: { value: ComputerStatus; at: number } | null = null;

  constructor(control: CloudflareControl, computerId: string) {
    this.#control = control;
    this.id = computerId;
  }

  async start(): Promise<void> {
    const status = await this.#control.start(this.id);
    this.#status = { value: status, at: Date.now() };
    if (!status.running) {
      throw new Error(`computer ${this.id} did not start${exitDetail(status)}`);
    }
  }

  async stop(): Promise<void> {
    await this.close();
    this.#status = { value: await this.#control.stop(this.id), at: Date.now() };
  }

  async remove(): Promise<void> {
    await this.stop();
  }

  async inspect(): Promise<ContainerStatus> {
    const status = await this.#current();
    return {
      running: status.running,
      exitCode: status.running ? null : (status.exit?.code ?? null),
      portBindings: status.running ? await this.#allBindings() : {},
      mounts: [],
      labels: {},
    };
  }

  async spawn(spec: ContainerExecSpec): Promise<ContainerProcess> {
    return bridgeExec(await this.endpoint(SANDBOX_PORTS.bridge), spec);
  }

  endpoint(port: number): Promise<ContainerPortBinding> {
    this.#tunnels ??= new PortTunnels((remote) => this.#control.openTunnel(this.id, remote));
    return this.#tunnels.endpoint(port);
  }

  async close(): Promise<void> {
    const tunnels = this.#tunnels;
    this.#tunnels = null;
    this.#bindings = null;
    await tunnels?.close();
  }

  async #allBindings(): Promise<Readonly<Record<number, ContainerPortBinding>>> {
    if (this.#bindings === null) {
      const entries = await Promise.all(
        MACHINE_PORTS.map(async (port) => [port, await this.endpoint(port)] as const),
      );
      this.#bindings = Object.fromEntries(entries);
    }
    return this.#bindings;
  }

  async #current(): Promise<ComputerStatus> {
    if (this.#status !== null && Date.now() - this.#status.at < STATUS_TTL_MS)
      return this.#status.value;
    const value = await this.#control.status(this.id);
    this.#status = { value, at: Date.now() };
    return value;
  }
}

function unwell(reason: string): SandboxHealth {
  return { ok: false, reason };
}

function exitDetail(status: ComputerStatus): string {
  const exit = status.exit;
  if (exit === null || exit === undefined) return '';
  return exit.error !== undefined
    ? `: it exited (code ${exit.code ?? 'unknown'}: ${exit.error})`
    : `: it exited with code ${exit.code ?? 'unknown'}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeBridgeOverHttp(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}
