/**
 * Customer computers on Instabox (instabox.sh) sandboxes.
 *
 * Satisfies the orchestrator's `SandboxProvider` contract with one Firecracker
 * microVM per computer running the unmodified Crewaid desktop container image
 * inside Instabox's preinstalled Docker daemon:
 *
 * - A computer is ONE Instabox VM named `crewaid-<id>` and tagged with
 *   metadata `crewaid=computer`, created from the stock `agent-browser`
 *   template with `vault: false` (so the operator's personal Instabox Vault
 *   never enters customer VMs).
 * - Inside the VM, the desktop runs as the hardened container `crewaid-sandbox`
 *   on an isolated Docker bridge (`crewaid-net` / `crewaid0`, `172.28.0.0/24`),
 *   with `BROWSER_SANDBOX_SECCOMP` (Chrome sandbox enabled), `--cap-drop=ALL`,
 *   `no-new-privileges:true`, cgroup memory/PID limits reserving 1.5 GiB for VM
 *   services, and a persistent systemd firewall (`INPUT` drop from `crewaid0` +
 *   `DOCKER-USER` D-155 TCP 80/443-only egress fence).
 * - Persistent user state lives in `/data/crewaid-home`, bind-mounted over
 *   `/home/bot` on Instabox's persistent `/data` block volume. Because the VM
 *   IS the workspace, `stop`, `remove` and orphan cleanup PAUSE (suspend RAM +
 *   disk), and only retention's `deleted` outcome deletes the VM.
 * - Container ports are published on VM loopback shifted by `+10000` (so they
 *   never collide with Instabox's on-demand `Xvnc :1` on port 5901) and reach
 *   the orchestrator over one multiplexed `ssh2` tunnel per running computer.
 *   No port is published to the internet.
 * - Workspace history (`crewaid-first-start`, `crewaid-orphaned-at`) lives in
 *   Instabox VM metadata, so reconciliation and retention never wake a paused
 *   computer.
 */

import {
  ContainerSandboxSession,
  HARNESS_SANDBOX_SPECIFICATION_VERSION,
  HarnessError,
  HarnessSandboxAuthenticationError,
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
  InstaboxApiError,
  SdkInstaboxApi,
  type InstaboxApi,
  type InstaboxMachine,
  type InstaboxMachineState,
  type InstaboxTunnel,
} from './instabox-client.js';
import {
  assertValidBotProfileId,
  assertValidImageRef,
  ensureContainer,
  installHostSetup,
  retireContainerBotProfile,
} from './instabox-container-script.js';
import {
  COMPUTER_LABEL,
  COMPUTER_NAME_PREFIX,
  CONTAINER_MEMORY_RESERVE_MIB,
  DEFAULT_INSTABOX_TEMPLATE,
  FIRST_START_LABEL,
  IMAGE_ID_LABEL,
  IMAGE_LABEL,
  ORPHANED_AT_LABEL,
  hostPortFor,
  sandboxNameFor,
} from './instabox-labels.js';
export * from './instabox-labels.js';

/** Every container port a computer serves; forwarded over the VM's offset loopback ports. */
const CONTAINER_PORTS: readonly number[] = [
  SANDBOX_PORTS.rfb,
  SANDBOX_PORTS.cdp,
  SANDBOX_PORTS.bridge,
  ...SEAT_PORTS,
  ...SEAT_CDP_PORTS,
];

/** The sandbox image's entrypoint draws this fixed screen (R8). */
const SCREEN = Object.freeze({ widthPx: 1280, heightPx: 800 });

/** How long a VM's state is cached between `inspect()` calls. */
const STATUS_TTL_MS = 1_000;

/** Instabox states that settle on their own; waiting on one ends in a stable state. */
const TRANSITIONAL: ReadonlySet<InstaboxMachineState> = new Set([
  'creating',
  'starting',
  'resuming',
  'suspending',
  'stopping',
]);

export interface InstaboxSandboxProviderOptions {
  /** Seam for tests; defaults to the official SDK reading the configured API key. */
  readonly api?: InstaboxApi;
  /** The Crewaid desktop OCI image pulled inside each VM (`SANDBOX_INSTABOX_IMAGE`). */
  readonly image: string;
  /** Stock Instabox base template (`SANDBOX_INSTABOX_TEMPLATE`); defaults to `agent-browser`. */
  readonly template?: string;
  /** Paid-tier vCPU override (`SANDBOX_INSTABOX_VCPU`); omit on Free tier. */
  readonly vcpus?: number;
  /** Paid-tier RAM override in MiB (`SANDBOX_INSTABOX_MEMORY_MIB`); omit on Free tier. */
  readonly memoryMiB?: number;
  /** Optional Instabox API origin override (`INSTABOX_API_URL`). */
  readonly apiUrl?: string;
  /** How long a start has to become usable, including image pull and desktop boot. */
  readonly readyTimeoutMs?: number;
  /** How long to wait for the bridge before re-ensuring the container. */
  readonly relaunchMs?: number;
  /** Seam for tests: resolves true when the bridge at `baseUrl` is healthy. */
  readonly bridgeProbe?: (baseUrl: string) => Promise<boolean>;
  /** Where non-fatal lifecycle warnings (e.g. skipped image upgrade on low disk) are written. */
  readonly log?: (message: string) => void;
}

export class InstaboxSandboxProvider implements HarnessV1SandboxProvider {
  readonly workspaceOnFirstStart = true;
  readonly specificationVersion = HARNESS_SANDBOX_SPECIFICATION_VERSION;
  readonly providerId = 'crewaid-instabox';

  readonly #api: InstaboxApi;
  readonly #image: string;
  readonly #template: string;
  readonly #vcpus: number | undefined;
  readonly #memoryMiB: number | undefined;
  readonly #readyTimeoutMs: number;
  readonly #relaunchMs: number;
  readonly #bridgeProbe: (baseUrl: string) => Promise<boolean>;
  readonly #log: (message: string) => void;
  /** One container object per Instabox machine, so its SSH tunnel is shared. */
  readonly #containers = new Map<string, InstaboxContainer>();
  /** Computer ID → Instabox machine ID, learned from creates and lists. */
  readonly #machineIds = new Map<string, string>();

  constructor(options: InstaboxSandboxProviderOptions) {
    this.#image = assertValidImageRef(options.image);
    this.#template =
      (options.template ?? DEFAULT_INSTABOX_TEMPLATE).trim() || DEFAULT_INSTABOX_TEMPLATE;
    this.#vcpus = options.vcpus;
    this.#memoryMiB = options.memoryMiB;
    this.#api =
      options.api ??
      new SdkInstaboxApi(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {});
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
    this.#relaunchMs = options.relaunchMs ?? 20_000;
    this.#bridgeProbe = options.bridgeProbe ?? probeBridgeOverHttp;
    this.#log = options.log ?? ((message) => console.warn(message));
  }

  // sessions

  createSession = async (
    options?: HarnessV1CreateSessionOptions & {
      requireExistingWorkspace?: boolean;
      snapshotProfiles?: () => Promise<readonly string[]>;
    },
  ): Promise<ContainerSandboxSession> =>
    this.#mapped(async () => {
      options?.abortSignal?.throwIfAborted();
      const sessionId = options?.sessionId ?? crypto.randomUUID();
      if (options?.identity !== undefined && options.identity !== sessionId) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: the Instabox provider keys a computer's runtime and ` +
            `workspace by one name, but was asked for identity ${options.identity}.`,
        });
      }
      const existing = await this.#api.findByName(sandboxNameFor(sessionId));
      if (existing !== null) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId} already exists as Instabox sandbox ${existing.id}. ` +
            'Use resumeSession() to reattach.',
        });
      }
      if (options?.requireExistingWorkspace === true) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: its workspace is missing. On Instabox the workspace is ` +
            'the sandbox, and none exists; storage is not recreated automatically (D-031).',
        });
      }

      const initialMetadata: Record<string, string> = {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [ORPHANED_AT_LABEL]: 'none',
        [FIRST_START_LABEL]: String(Date.now()),
        [IMAGE_LABEL]: this.#image,
      };
      const created = await this.#api.create({
        name: sandboxNameFor(sessionId),
        template: this.#template,
        metadata: initialMetadata,
        // Disable Instabox's own idle pause on paid plans so the orchestrator
        // controls idle shutdown; the SDK client falls back to the 30-minute
        // fixed idle window on Free-tier orgs automatically.
        autoSuspendMs: 0,
        ...(this.#vcpus !== undefined ? { vcpus: this.#vcpus } : {}),
        ...(this.#memoryMiB !== undefined ? { memoryMiB: this.#memoryMiB } : {}),
      });
      this.#machineIds.set(sessionId, created.id);
      const container = this.#containerFor(created.id);
      try {
        await installHostSetup(this.#api, created.id, options?.abortSignal);
        const ensured = await ensureContainer(this.#api, created.id, {
          image: this.#image,
          containerMemoryMiB: containerMemoryFor(created, this.#memoryMiB),
          ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
        });
        await this.#api.setMetadata(created.id, {
          ...created.metadata,
          ...initialMetadata,
          [IMAGE_ID_LABEL]: ensured.imageId,
        });

        const session = this.#sessionOver(sessionId, container);
        await this.#awaitUsable(session, created, sessionId, options?.abortSignal);
        if (options?.onFirstCreate !== undefined) {
          await options.onFirstCreate(session.restricted(), {
            ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          });
        }
        return session;
      } catch (error) {
        // Nothing escaped to the caller, and a fresh VM holds no user files yet.
        await container.close();
        this.#forgetMachine(created.id);
        if (!options?.abortSignal?.aborted) {
          await this.#api.delete(created.id).catch(() => undefined);
        }
        throw error;
      }
    });

  resumeSession = async (
    options: HarnessV1ResumeSessionOptions & { ensureWorkspaceRetention?: boolean },
  ): Promise<ContainerSandboxSession> =>
    this.#mapped(async () => {
      const { sessionId } = options;
      const found = await this.#findComputer(sessionId);
      if (found === null) {
        throw new HarnessError({
          message: `sandbox ${sessionId}: no Instabox sandbox is named ${sandboxNameFor(sessionId)}`,
        });
      }

      const metadata: Record<string, string> = {
        ...found.metadata,
        [ORPHANED_AT_LABEL]: 'none',
      };
      if (parseTime(found.metadata[FIRST_START_LABEL]) === null) {
        metadata[FIRST_START_LABEL] = String(Date.now());
      }
      if (!sameMetadata(metadata, found.metadata)) {
        await this.#api.setMetadata(found.id, metadata);
      }

      const wasNotRunning = found.state !== 'running';
      const wasColdStopped = found.state === 'stopped';
      const imageChanged = found.metadata[IMAGE_LABEL] !== this.#image;

      options.abortSignal?.throwIfAborted();
      const container = this.#containerFor(found.id);
      try {
        await container.start();
        const live = (await this.#api.get(found.id)) ?? found;

        // Never recreate the container underneath an already-running computer:
        // a bot may be mid-task on it. On cold boot or when the configured
        // image ref changed while paused/stopped, reconcile host setup and container.
        if (wasNotRunning && (wasColdStopped || imageChanged)) {
          await installHostSetup(this.#api, live.id, options.abortSignal);
          const ensured = await ensureContainer(this.#api, live.id, {
            image: this.#image,
            containerMemoryMiB: containerMemoryFor(live, this.#memoryMiB),
            forcePull: imageChanged,
            ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          });
          if (ensured.skippedUpgradeForDiskSpace) {
            this.#log(
              `computer ${sessionId} stays on its current image: less than 2 GiB free on / inside Instabox VM ${live.id}`,
            );
          } else {
            const updated: Record<string, string> = {
              ...metadata,
              [IMAGE_LABEL]: this.#image,
              [IMAGE_ID_LABEL]: ensured.imageId,
            };
            if (!sameMetadata(updated, metadata)) {
              await this.#api.setMetadata(live.id, updated);
            }
          }
        }

        const session = this.#sessionOver(sessionId, container);
        await this.#awaitUsable(session, live, sessionId, options.abortSignal);
        return session;
      } catch (error) {
        if (wasNotRunning && !options.abortSignal?.aborted) {
          try {
            await container.stop();
          } catch (cleanup: unknown) {
            const detail = cleanup instanceof Error ? cleanup.message : String(cleanup);
            this.#log(`sandbox ${sessionId}: could not pause after a failed wake: ${detail}`);
          }
        }
        throw error;
      }
    });

  /** A handle without starting or waiting — for stop, destroy and inspect. */
  attachSession = async (options: { sessionId: string }): Promise<ContainerSandboxSession | null> =>
    this.#mapped(async () => {
      const found = await this.#findComputer(options.sessionId);
      if (found === null) return null;
      return this.#sessionOver(options.sessionId, this.#containerFor(found.id));
    });

  /** Total, like Docker and Runtime: every VM-level fault is an answer; only API failures throw. */
  checkHealth = async (options: { sessionId: string }): Promise<SandboxHealth> =>
    this.#mapped(async () => {
      const found = await this.#findComputer(options.sessionId);
      if (found === null) {
        return unwell(`no Instabox sandbox is named ${sandboxNameFor(options.sessionId)}`);
      }
      if (found.state !== 'running') {
        const cooldown =
          found.cooldownUntil !== null ? ` (cooldown until ${found.cooldownUntil})` : '';
        return unwell(`sandbox ${found.id} is ${found.state}${cooldown}`);
      }
      const bridge = await this.#containerFor(found.id).endpoint(SANDBOX_PORTS.bridge);
      if (!(await this.#bridgeProbe(`http://${bridge.host}:${bridge.port}`))) {
        return unwell(`the agent-bridge in sandbox ${found.id} did not report healthy`);
      }
      return { ok: true };
    });

  // inventory and reconciliation

  listManagedSessions = async (): Promise<readonly ManagedSandboxObservation[]> =>
    this.#mapped(async () =>
      (await this.#computers()).map(({ computerId, machine }) => ({
        containerId: machine.id,
        sessionId: computerId,
        botId: computerId,
        running: machine.state === 'running',
        workspace: { ok: true, volumeName: machine.id },
      })),
    );

  /**
   * Orphan cleanup PAUSES. On Instabox the VM's `/data` volume IS the workspace,
   * so deleting the VM here would destroy customer files on a path whose
   * contract is to preserve workspace storage.
   */
  removeManagedSession = async (options: { containerId: string }): Promise<void> =>
    this.#mapped(async () => {
      const machine = await this.#api.get(options.containerId);
      if (machine === null) return;
      if (!isComputer(machine)) {
        throw new HarnessError({
          message: `Instabox sandbox ${options.containerId} is not a Crewaid computer`,
        });
      }
      await this.#containerFor(machine.id).stop();
    });

  // workspaces

  /** Creates the computer's Instabox VM, configures host isolation, and pauses it. */
  provisionWorkspace = async (options: { botId: string }): Promise<void> =>
    this.#mapped(async () => {
      if ((await this.#findComputer(options.botId)) !== null) return;
      const created = await this.#api.create({
        name: sandboxNameFor(options.botId),
        template: this.#template,
        metadata: {
          [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
          [ORPHANED_AT_LABEL]: 'none',
          [IMAGE_LABEL]: this.#image,
        },
        autoSuspendMs: 0,
        ...(this.#vcpus !== undefined ? { vcpus: this.#vcpus } : {}),
        ...(this.#memoryMiB !== undefined ? { memoryMiB: this.#memoryMiB } : {}),
      });
      try {
        await installHostSetup(this.#api, created.id);
        await this.#api.pause(created.id);
      } catch (error) {
        await this.#api.delete(created.id).catch(() => undefined);
        throw error;
      }
    });

  inspectWorkspace = async (options: { botId: string }): Promise<WorkspaceObservation> =>
    this.#mapped(async () => {
      const found = await this.#findComputer(options.botId);
      return found === null ? { exists: false } : { exists: true, ok: true, volumeName: found.id };
    });

  /** Read from VM metadata only — never wakes a paused computer. */
  inspectWorkspaceHistory = async (options: {
    botId: string;
  }): Promise<{ referenced: boolean; runtimeCreatedAt: number | null }> =>
    this.#mapped(async () => {
      const found = await this.#findComputer(options.botId);
      if (found === null) throw new Error('Workspace is missing; refusing to recreate storage');
      const runtimeCreatedAt = parseTime(found.metadata[FIRST_START_LABEL]);
      return {
        referenced: found.state === 'running' && runtimeCreatedAt !== null,
        runtimeCreatedAt,
      };
    });

  listWorkspaces = async (): Promise<readonly { botId: string }[]> =>
    this.#mapped(async () =>
      (await this.#computers()).map(({ computerId }) => ({ botId: computerId })),
    );

  /**
   * Retention sweep answered purely from VM metadata: the orphan clock lives in
   * `crewaid-orphaned-at`, so retention never wakes a paused or stopped machine.
   */
  retainWorkspace = async (options: {
    botId: string;
    orphaned: boolean;
    now: number;
    retentionMs: number;
  }): Promise<'absent' | 'in-use' | 'retained' | 'deleted'> =>
    this.#mapped(async () => {
      const found = await this.#findComputer(options.botId);
      if (found === null) return 'absent';

      const first = parseTime(found.metadata[ORPHANED_AT_LABEL]);
      if (!options.orphaned) {
        if (first !== null) {
          await this.#api.setMetadata(found.id, {
            ...found.metadata,
            [ORPHANED_AT_LABEL]: 'none',
          });
        }
        return 'retained';
      }
      if (found.state === 'running') return 'in-use';
      if (first === null) {
        await this.#api.setMetadata(found.id, {
          ...found.metadata,
          [ORPHANED_AT_LABEL]: String(options.now),
        });
        return options.retentionMs <= 0 ? this.#deleteOrphan(found.id) : 'retained';
      }
      if (options.now - first < options.retentionMs) return 'retained';
      return this.#deleteOrphan(found.id);
    });

  /**
   * Writes a bot's Chrome profile tombstone under `/data/crewaid-home`. If the
   * VM is paused or stopped, wakes it briefly to run `profiles.py retire`, then
   * restores its prior power state in `finally`.
   */
  retireBotProfile = async (options: { computerId: string; botId: string }): Promise<void> =>
    this.#mapped(async () => {
      const safeBotId = assertValidBotProfileId(options.botId);
      const found = await this.#findComputer(options.computerId);
      if (found === null) throw new Error('Workspace is missing; cannot retire profile');

      const priorState = found.state;
      const container = this.#containerFor(found.id);
      if (priorState !== 'running') {
        await container.start();
      }
      try {
        await retireContainerBotProfile(
          this.#api,
          found.id,
          safeBotId,
          found.metadata[IMAGE_LABEL] ?? this.#image,
        );
      } finally {
        if (priorState === 'suspended') {
          await container.stop().catch(() => undefined);
        } else if (priorState === 'stopped') {
          await container.close().catch(() => undefined);
          await this.#api.stop(found.id).catch(() => undefined);
        }
      }
    });

  // plumbing

  #containerFor(machineId: string): InstaboxContainer {
    let container = this.#containers.get(machineId);
    if (container === undefined) {
      container = new InstaboxContainer(this.#api, machineId);
      this.#containers.set(machineId, container);
    }
    return container;
  }

  #sessionOver(sessionId: string, container: InstaboxContainer): ContainerSandboxSession {
    return new ContainerSandboxSession({
      sessionId,
      container,
      containerId: container.id,
      screen: SCREEN,
    });
  }

  /**
   * The computer's VM, read by ID once its ID is known. Health checks run every
   * few seconds for every running computer, and finding a VM by name means
   * listing the account page by page, which at a hundred computers runs into
   * Instabox's API rate limits. A VM's ID never changes, so only a miss (first
   * sight in this process, or the VM gone) lists, and only Crewaid's computers.
   */
  async #findComputer(computerId: string): Promise<InstaboxMachine | null> {
    const name = sandboxNameFor(computerId);
    const knownId = this.#machineIds.get(computerId);
    if (knownId !== undefined) {
      const machine = await this.#api.get(knownId);
      if (machine !== null && machine.name === name && isComputer(machine)) return machine;
      this.#machineIds.delete(computerId);
    }
    const listed = await this.#api.list({ [COMPUTER_LABEL.key]: COMPUTER_LABEL.value });
    const found = listed.find((machine) => machine.name === name && isComputer(machine)) ?? null;
    if (found !== null) this.#machineIds.set(computerId, found.id);
    return found;
  }

  async #computers(): Promise<{ computerId: string; machine: InstaboxMachine }[]> {
    const listed = await this.#api.list({ [COMPUTER_LABEL.key]: COMPUTER_LABEL.value });
    const computers = listed.filter(isComputer).map((machine) => ({
      computerId: machine.name.slice(COMPUTER_NAME_PREFIX.length),
      machine,
    }));
    for (const { computerId, machine } of computers) this.#machineIds.set(computerId, machine.id);
    return computers;
  }

  #forgetMachine(machineId: string): void {
    this.#containers.delete(machineId);
    for (const [computerId, knownId] of this.#machineIds) {
      if (knownId === machineId) this.#machineIds.delete(computerId);
    }
  }

  async #deleteOrphan(machineId: string): Promise<'absent' | 'in-use' | 'deleted'> {
    // Recheck immediately before delete: a computer started since the sweep's
    // first read is in use, whatever its metadata clock says.
    const current = await this.#api.get(machineId);
    if (current === null) return 'absent';
    if (current.state === 'running') return 'in-use';
    await this.#containerFor(machineId).close();
    this.#forgetMachine(machineId);
    await this.#api.delete(machineId);
    return 'deleted';
  }

  /**
   * Waits for `agent-bridge` over the SSH tunnel. After a normal suspend→resume
   * the container is already up so the first probe answers immediately. If the
   * container died before pause or failed to auto-restart after a cold stop,
   * re-ensuring the host setup + container every `relaunchMs` recovers it.
   */
  async #awaitUsable(
    session: ContainerSandboxSession,
    machine: InstaboxMachine,
    sessionId: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    let lastRelaunch = Date.now();
    for (;;) {
      abortSignal?.throwIfAborted();
      try {
        const { url } = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
        if (await this.#bridgeProbe(url)) return;
      } catch {
        // Tunnel or container not yet ready; retry until deadline.
      }

      if (Date.now() - lastRelaunch >= this.#relaunchMs) {
        lastRelaunch = Date.now();
        await installHostSetup(this.#api, machine.id, abortSignal);
        await ensureContainer(this.#api, machine.id, {
          image: this.#image,
          containerMemoryMiB: containerMemoryFor(machine, this.#memoryMiB),
          ...(abortSignal !== undefined ? { abortSignal } : {}),
        });
      }

      if (Date.now() > deadline) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: the agent-bridge in Instabox VM ${machine.id} did not report ` +
            `healthy within ${this.#readyTimeoutMs}ms.`,
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
      if (error instanceof InstaboxApiError) {
        if (error.unauthorized) {
          throw new HarnessSandboxAuthenticationError({
            message:
              'Instabox refused the API key. Check that it is set and has ' +
              'machines:read, machines:write and machines:delete scopes.',
            sandboxProviderId: this.providerId,
            cause: error,
          });
        }
        if (error.code === 'machine_cooldown') {
          throw new HarnessError({
            message: `instabox: this sandbox hit its Free-plan continuous run limit and is cooling down (${error.message}).`,
            cause: error,
          });
        }
        if (error.quotaExceeded || error.status === 429 || error.status === 402) {
          throw new HarnessError({
            message: `instabox: plan or rate limit reached (${error.code}): ${error.message}`,
            cause: error,
          });
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new HarnessError({ message: `instabox: ${detail}`, cause: error });
    }
  }
}

/**
 * One Instabox VM as the narrow `SandboxContainer` port.
 *
 * `stop()` and `remove()` both suspend the VM (preserving RAM and `/data`) and
 * close the SSH tunnel BEFORE suspending so no open SSH session keeps the VM
 * awake. All handles from `createSession`, `resumeSession`, and `attachSession`
 * share this single object and its multiplexed SSH connection; if the SSH
 * connection drops unexpectedly or nears token expiry, the next `endpoint()`
 * transparently opens a fresh tunnel.
 */
class InstaboxContainer implements SandboxContainer {
  readonly id: string;
  readonly #api: InstaboxApi;
  #tunnel: Promise<InstaboxTunnel> | null = null;
  #forwards = new Map<number, Promise<ContainerPortBinding>>();
  #status: { value: InstaboxMachine | null; at: number } | null = null;
  #lifecycle: Promise<void> = Promise.resolve();

  constructor(api: InstaboxApi, machineId: string) {
    this.#api = api;
    this.id = machineId;
  }

  start(): Promise<void> {
    return this.#withLifecycle(async () => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const machine = await this.#machine(true);
        if (machine === null) throw new Error(`sandbox ${this.id} no longer exists`);
        if (machine.state === 'running') return;
        if (Date.now() > deadline) {
          throw new Error(`sandbox ${this.id} did not start; it is still ${machine.state}`);
        }
        if (machine.state === 'suspended' || machine.state === 'stopped') {
          await this.#api.resume(this.id);
        } else if (TRANSITIONAL.has(machine.state)) {
          await delay(250);
        } else {
          throw new Error(`sandbox ${this.id} is ${machine.state}`);
        }
      }
    });
  }

  stop(): Promise<void> {
    return this.#withLifecycle(async () => {
      // Close SSH before pausing so the open tunnel does not count as activity
      // or linger across suspension.
      await this.close();
      const machine = await this.#machine(true);
      if (
        machine?.state === 'running' ||
        machine?.state === 'creating' ||
        machine?.state === 'starting' ||
        machine?.state === 'resuming'
      ) {
        await this.#api.pause(this.id);
      }
      const deadline = Date.now() + 120_000;
      for (;;) {
        const current = await this.#machine(true);
        if (
          current === null ||
          current.state === 'suspended' ||
          current.state === 'stopped' ||
          current.state === 'deleted'
        ) {
          break;
        }
        if (Date.now() >= deadline || !TRANSITIONAL.has(current.state)) {
          throw new Error(`sandbox ${this.id} did not pause; it is ${current.state}`);
        }
        await delay(250);
      }
      this.#status = null;
    });
  }

  /** Pauses, never deletes: this VM's `/data` volume is the computer's workspace. */
  async remove(): Promise<void> {
    await this.stop();
  }

  async inspect(): Promise<ContainerStatus> {
    const machine = await this.#machine(false);
    const running = machine?.state === 'running';
    return {
      running,
      exitCode: null,
      portBindings: running ? await this.#allBindings() : {},
      mounts: [],
      labels: machine === null ? {} : { name: machine.name },
    };
  }

  async spawn(spec: ContainerExecSpec): Promise<ContainerProcess> {
    return bridgeExec(await this.endpoint(SANDBOX_PORTS.bridge), spec);
  }

  /** A loopback listener reaching `containerPort` inside `crewaid-sandbox` via the VM's offset port. */
  endpoint(containerPort: number): Promise<ContainerPortBinding> {
    let forward = this.#forwards.get(containerPort);
    if (forward === undefined) {
      const targetHostPort = hostPortFor(containerPort);
      const opened = this.#openTunnel().then((tunnel) => tunnel.forward(targetHostPort));
      forward = opened;
      this.#forwards.set(containerPort, opened);
      // A failed forward must not stay cached forever.
      opened.catch(() => {
        if (this.#forwards.get(containerPort) === opened) {
          this.#forwards.delete(containerPort);
        }
      });
    }
    return forward;
  }

  async close(): Promise<void> {
    const tunnel = this.#tunnel;
    this.#tunnel = null;
    this.#forwards = new Map();
    if (tunnel !== null) {
      await (await tunnel.catch(() => null))?.close();
    }
  }

  #openTunnel(): Promise<InstaboxTunnel> {
    if (this.#tunnel === null) {
      const opened = this.#api.openTunnel(this.id);
      this.#tunnel = opened;
      opened.then(
        (tunnel) => {
          // If the SSH connection drops or closes pre-expiry, clear cached
          // listeners so the next request transparently reconnects.
          void tunnel.closed.then(() => {
            if (this.#tunnel === opened) {
              this.#tunnel = null;
              this.#forwards = new Map();
            }
          });
        },
        () => {
          if (this.#tunnel === opened) {
            this.#tunnel = null;
            this.#forwards = new Map();
          }
        },
      );
    }
    return this.#tunnel;
  }

  #withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#lifecycle.then(operation);
    this.#lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #allBindings(): Promise<Readonly<Record<number, ContainerPortBinding>>> {
    const entries = await Promise.all(
      CONTAINER_PORTS.map(async (port) => [port, await this.endpoint(port)] as const),
    );
    return Object.fromEntries(entries);
  }

  async #machine(fresh: boolean): Promise<InstaboxMachine | null> {
    if (!fresh && this.#status !== null && Date.now() - this.#status.at < STATUS_TTL_MS) {
      return this.#status.value;
    }
    const value = await this.#api.get(this.id);
    this.#status = { value, at: Date.now() };
    return value;
  }
}

function containerMemoryFor(machine: InstaboxMachine, configuredMemoryMiB?: number): number {
  const vmMemoryMiB = machine.memoryMiB > 0 ? machine.memoryMiB : (configuredMemoryMiB ?? 8192);
  return Math.max(512, vmMemoryMiB - CONTAINER_MEMORY_RESERVE_MIB);
}

function isComputer(machine: InstaboxMachine): boolean {
  return (
    machine.name.startsWith(COMPUTER_NAME_PREFIX) &&
    machine.metadata[COMPUTER_LABEL.key] === COMPUTER_LABEL.value
  );
}

function parseTime(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,16}$/.test(value)) return null;
  return Number(value);
}

function sameMetadata(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function unwell(reason: string): SandboxHealth {
  return { ok: false, reason };
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
