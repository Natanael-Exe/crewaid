/**
 * `DockerSandboxProvider` — the v1 `HarnessV1SandboxProvider` implementation
 * for computers on a Docker host.
 *
 * This process never touches the daemon. Every verb goes to the
 * sandbox supervisor through `SupervisorEngine`, and the supervisor alone
 * holds the socket and decides what a verb may do. What stays here is the
 * lifecycle logic over the narrow `ContainerEngine` port — workspace
 * resolution, the create/resume/destroy sequence, readiness — which is what
 * lets that behaviour be tested without a daemon.
 *
 * `getPortEndpoint` is still the single way to reach a computer: the
 * supervisor reports where each port is, and nothing here builds an address.
 */

import type { ContainerEngine, ContainerLimits, WorkspaceVolume } from './container-engine.js';
import { SupervisorEngine, readSupervisorOptions } from './supervisor-engine.js';
import {
  ContainerSandboxSession,
  HARNESS_SANDBOX_SPECIFICATION_VERSION,
  HarnessError,
  HarnessSandboxAuthenticationError,
  SANDBOX_PORTS,
  SEAT_PORTS,
  SEAT_CDP_PORTS,
  SANDBOX_WORKING_DIRECTORY,
  type ContainerStatus,
  type HarnessV1CreateSessionOptions,
  type HarnessV1ResumeSessionOptions,
  type HarnessV1SandboxProvider,
  type ManagedSandboxObservation,
  type SandboxContainer,
  type SandboxHealth,
  type WorkspaceObservation,
} from '@crewaid/sandbox-core';

/**
 * PRD §5.1's fence, resized by D-063 for a machine whose bots BROWSE.
 *
 * The spec's original numbers (2 GiB, 1 CPU, 512 tasks) sized the machine like
 * the per-bot containers it replaced — but every seat desktop and every seat
 * browser draws from this ONE pool now, and a media-heavy Chrome measures ~190
 * tasks on its own. A second browser was refused at 401/512 tasks, correctly,
 * by D-061's admission. Sized for the operator's "more than six browsing
 * bots": ~110 machine tasks + ~52 per desktop + ~190 per browser ≈ 1560 at
 * six, so 2048 tasks; six browsing browsers measured land at ~3-4 GiB, so
 * 8 GiB with swap still disabled; four CPUs so six renderers do not queue on
 * one core. These are cgroup caps, not reservations — the host must actually
 * have them.
 */
export const SANDBOX_LIMITS: ContainerLimits = Object.freeze({
  memoryBytes: 8 * 1024 ** 3,
  memorySwapBytes: 8 * 1024 ** 3,
  cpus: 4.0,
  pidsLimit: 2048,
  noNewPrivileges: true,
  dropAllCapabilities: true,
  allowBrowserSandbox: true,
  shmSizeBytes: 512 * 1024 ** 2,
});

/** Reduce the desktop budget on a smaller Docker host without changing the default fence. */
export function readSandboxLimits(raw: {
  readonly cpus?: string | undefined;
  readonly memoryMiB?: string | undefined;
}): ContainerLimits {
  const cpus = readResourceLimit('SANDBOX_CPUS', raw.cpus, SANDBOX_LIMITS.cpus);
  const memoryMiB = readResourceLimit(
    'SANDBOX_MEMORY_MIB',
    raw.memoryMiB,
    SANDBOX_LIMITS.memoryBytes / 1024 ** 2,
  );
  if (cpus < 1 || cpus > SANDBOX_LIMITS.cpus) {
    throw new Error(`SANDBOX_CPUS must be >= 1 and <= ${SANDBOX_LIMITS.cpus}`);
  }
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 2048 || memoryMiB > 8192) {
    throw new Error('SANDBOX_MEMORY_MIB must be a whole number from 2048 to 8192');
  }
  const memoryBytes = memoryMiB * 1024 ** 2;
  return Object.freeze({ ...SANDBOX_LIMITS, cpus, memoryBytes, memorySwapBytes: memoryBytes });
}

function readResourceLimit(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

/**
 * Container ownership is a label, never the image name or creation order.
 * M2-QA-02 counts "this bot's containers" while other tests are creating their
 * own from the same image, and `docker ps` filtered by image would count theirs.
 */
export const SANDBOX_LABELS = {
  sessionId: 'crewaid.sessionId',
  managedBy: 'crewaid.managedBy',
  /**
   * The bot a workspace volume belongs to (D-039 §2).
   *
   * Deliberately NOT the session id, even though the two carry the same string
   * today. The workspace belongs to the bot and has to survive any change of
   * session; keying it on the session would make a future divergence quietly
   * strand every bot's files under a name nothing looks for.
   */
  botId: 'crewaid.botId',
} as const;

/** Marks the container as belonging to a bot rather than being ephemeral. */
export const SANDBOX_IDENTITY_LABEL = 'crewaid.identity';

export const SANDBOX_MANAGED_BY = 'crewaid-orchestrator';

/**
 * The bot's durable workspace (D-039). One named volume, mounted at `$HOME`.
 *
 * A named volume rather than a bind mount because R5 and §5.1 forbid host
 * paths and D-031 permits storage only where the provider owns it — the daemon
 * owns this path and nothing in the orchestrator can name a host directory.
 */
export function workspaceVolumeNameFor(botId: string): string {
  return `crewaid-workspace-${botId}`;
}

export interface DockerSandboxProviderOptions {
  /** `SANDBOX_IMAGE`. */
  readonly image?: string;
  /** `SANDBOX_NETWORK` — the §7.3 bridge. */
  readonly network?: string;
  readonly screen?: { readonly widthPx: number; readonly heightPx: number };
  /**
   * Seam for tests. Defaults to the sandbox supervisor named by
   * `SANDBOX_SUPERVISOR_URL` (D-200); how a computer's ports are published is
   * the supervisor's configuration, not this process's.
   */
  readonly engine?: ContainerEngine;
  /**
   * How long a sandbox has to become usable — container running, ports
   * published, and the bridge answering. §7.4 budgets 20 s for a cold start
   * and the §5 image boots in about 5.
   */
  readonly readyTimeoutMs?: number;
  /**
   * Seam for tests: resolves true when the agent-bridge answers `/health` at
   * the given base URL. Defaults to a real request.
   */
  readonly bridgeProbe?: (baseUrl: string) => Promise<boolean>;
}

export class DockerSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = HARNESS_SANDBOX_SPECIFICATION_VERSION;
  readonly providerId = 'crewaid-docker';

  /** Seeds home through Docker copy-up in an isolated helper, with no desktop or ports. */
  provisionWorkspace = async (options: { botId: string }): Promise<void> => {
    await withMappedDockerErrors(this.providerId, async () => {
      await this.#resolveWorkspace(options.botId);
    });
  };

  /** Persist a tombstone even when the desktop is stopped. */
  retireBotProfile = async (options: { computerId: string; botId: string }): Promise<void> => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.botId) || options.botId === 'Default') {
      throw new Error('Invalid bot profile');
    }
    const name = workspaceVolumeNameFor(options.computerId);
    const volume = await this.#engine.findVolume(name);
    if (volume === null) throw new Error('Workspace is missing; cannot retire profile');
    this.#assertWorkspaceOwnership(volume, options.computerId);
    await this.#engine.retireBotProfile(name, this.#image, options.botId);
  };

  /** Only an unreferenced workspace can be classified without entering its runtime. */
  inspectWorkspaceHistory = async (options: {
    botId: string;
  }): Promise<{
    referenced: boolean;
    runtimeCreatedAt: number | null;
  }> =>
    withMappedDockerErrors(this.providerId, async () => {
      const name = workspaceVolumeNameFor(options.botId);
      const volume = await this.#engine.findVolume(name);
      if (volume === null) throw new Error('Workspace is missing; refusing to recreate storage');
      this.#assertWorkspaceOwnership(volume, options.botId);
      if ((await this.#engine.listByVolume(name)).length > 0)
        return { referenced: true, runtimeCreatedAt: null };
      const runtimeCreatedAt = await this.#engine.workspaceMarker(
        name,
        this.#image,
        Date.now(),
        false,
        'read',
      );
      return { referenced: false, runtimeCreatedAt };
    });

  listWorkspaces = async (): Promise<readonly { botId: string }[]> => {
    const volumes = await this.#engine.listWorkspaceVolumes();
    return volumes.flatMap((volume) => {
      const botId = volume.labels[SANDBOX_LABELS.botId];
      if (
        !botId ||
        volume.name !== workspaceVolumeNameFor(botId) ||
        volume.labels[SANDBOX_LABELS.managedBy] !== SANDBOX_MANAGED_BY
      )
        return [];
      return [{ botId }];
    });
  };

  /** Only the retention service calls this; orphan-runtime cleanup never does. */
  retainWorkspace = async (options: {
    botId: string;
    orphaned: boolean;
    now: number;
    retentionMs: number;
  }): Promise<'absent' | 'in-use' | 'retained' | 'deleted'> => {
    const name = workspaceVolumeNameFor(options.botId);
    const volume = await this.#engine.findVolume(name);
    if (volume === null) return 'absent';
    this.#assertWorkspaceOwnership(volume, options.botId);
    // Even stopped or unmanaged containers protect a volume from reclamation.
    if (options.orphaned && (await this.#engine.listByVolume(name)).length > 0) return 'in-use';
    const first = await this.#engine.workspaceMarker(
      name,
      this.#image,
      options.now,
      !options.orphaned,
    );
    if (!options.orphaned || first === null || options.now - first < options.retentionMs)
      return 'retained';
    // Recheck identity and references after the helper exits. Never force removal.
    const current = await this.#engine.findVolume(name);
    if (current === null) return 'absent';
    this.#assertWorkspaceOwnership(current, options.botId);
    if ((await this.#engine.listByVolume(name)).length > 0) return 'in-use';
    await this.#engine.removeWorkspaceVolume(name);
    return 'deleted';
  };

  readonly #engine: ContainerEngine;
  readonly #image: string;
  readonly #network: string;
  readonly #limits: ContainerLimits;
  readonly #screen: { readonly widthPx: number; readonly heightPx: number };
  readonly #readyTimeoutMs: number;
  readonly #bridgeProbe: (baseUrl: string) => Promise<boolean>;

  constructor(options: DockerSandboxProviderOptions = {}) {
    this.#image = options.image ?? process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
    this.#network = options.network ?? process.env['SANDBOX_NETWORK'] ?? 'agent-net';
    this.#limits = readSandboxLimits({
      cpus: process.env['SANDBOX_CPUS'],
      memoryMiB: process.env['SANDBOX_MEMORY_MIB'],
    });
    this.#screen = options.screen ?? {
      widthPx: readPositiveInt(process.env['SANDBOX_WIDTH_PX'], 1280),
      heightPx: readPositiveInt(process.env['SANDBOX_HEIGHT_PX'], 800),
    };
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
    this.#bridgeProbe = options.bridgeProbe ?? probeBridgeOverHttp;
    // Read boot-critical settings now; no request is made until a verb runs.
    this.#engine = options.engine ?? new SupervisorEngine(readSupervisorOptions(process.env));
  }

  createSession = async (
    options?: HarnessV1CreateSessionOptions & { requireExistingWorkspace?: boolean },
  ): Promise<ContainerSandboxSession> => {
    const sessionId = options?.sessionId ?? `crewaid-${crypto.randomUUID()}`;

    return withMappedDockerErrors(this.providerId, async () => {
      options?.abortSignal?.throwIfAborted();
      await this.#engine.ensureNetwork(this.#network);

      const existing = await this.#engine.findByLabel(SANDBOX_LABELS.sessionId, sessionId);
      if (existing !== null) {
        // Deliberately not "return the one that is already there". A second
        // create for a live session is a bug in the caller's lifecycle, and
        // quietly succeeding hides it until two callers believe they own the
        // same desktop. Reattaching is what resumeSession is for.
        throw new HarnessError({
          message:
            `sandbox ${sessionId} already exists as container ${existing.id}. ` +
            'Use resumeSession() to reattach, or destroy() it first.',
        });
      }

      // Resolved BEFORE the container is created: a container that came up
      // without its workspace would be a working-looking desktop with none of
      // the bot's history, and the operator's first sign of it would be missing
      // files. Failing here costs a start; failing later costs the illusion.
      const workspace = await this.#resolveWorkspace(
        options?.identity,
        options?.requireExistingWorkspace,
      );

      const container = await this.#engine.create({
        image: this.#image,
        screen: this.#screen,
        name: containerNameFor(sessionId),
        network: this.#network,
        // D-046 / M5-BE-23: the seat ports travel with the machine's own,
        // because a container publishes its ports at creation and `setPorts`
        // is not implemented — a seat opened later has nowhere to be reached
        // unless its port was published before any seat existed.
        publishPorts: [
          SANDBOX_PORTS.rfb,
          SANDBOX_PORTS.cdp,
          SANDBOX_PORTS.bridge,
          ...SEAT_PORTS,
          ...SEAT_CDP_PORTS,
        ],
        labels: {
          [SANDBOX_LABELS.sessionId]: sessionId,
          [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
          ...(options?.identity !== undefined
            ? { [SANDBOX_IDENTITY_LABEL]: options.identity }
            : {}),
        },
        limits: this.#limits,
        mounts:
          workspace === null ? [] : [{ volume: workspace.name, path: SANDBOX_WORKING_DIRECTORY }],
      });

      try {
        if (workspace !== null) {
          await this.#engine.workspaceMarker(
            workspace.name,
            this.#image,
            Date.now(),
            false,
            'write',
          );
        }
        await container.start();

        const session = new ContainerSandboxSession({
          sessionId,
          container,
          containerId: container.id,
          screen: this.#screen,
        });
        await this.#awaitUsable(session, container, sessionId, options?.abortSignal);

        // No snapshot support here, so upstream's guidance applies directly:
        // providers without it run the hook immediately after a fresh create. It
        // gets the reduced view, never the network session (R4).
        if (options?.onFirstCreate !== undefined) {
          await options.onFirstCreate(session.restricted(), {
            ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          });
        }

        return session;
      } catch (error) {
        // No session escaped to the caller, so it has no handle to clean up.
        await container.remove().catch(() => undefined);
        throw error;
      }
    });
  };

  /**
   * Reattach WITHOUT starting anything or waiting for readiness. Resolves null
   * when no container carries the id.
   *
   * Not part of the harness interface, and deliberately separate from
   * `resumeSession`. D-028 makes resume wait for the bridge, which is right for
   * a caller that wants to use the sandbox and wrong for every lifecycle
   * operation that does not: stopping an UNHEALTHY sandbox would have to wait
   * for it to become healthy first, which is a deadlock dressed as a timeout.
   * Stop, destroy and inspect need a handle, not a running desktop.
   */
  attachSession = async (options: {
    sessionId: string;
  }): Promise<ContainerSandboxSession | null> => {
    return withMappedDockerErrors(this.providerId, async () => {
      const container = await this.#engine.findByLabel(SANDBOX_LABELS.sessionId, options.sessionId);
      if (container === null) return null;

      return new ContainerSandboxSession({
        sessionId: options.sessionId,
        container,
        containerId: container.id,
        screen: this.#screen,
      });
    });
  };

  /**
   * Inventory every runtime we own, including stopped and malformed ones.
   *
   * The database is intentionally absent from this answer. Reconciliation is
   * the comparison between two independent sources; teaching the provider
   * about stored rows would collapse them into one and make disagreement
   * impossible to detect.
   */
  listManagedSessions = async (): Promise<readonly ManagedSandboxObservation[]> => {
    return withMappedDockerErrors(this.providerId, async () => {
      const containers = await this.#engine.listByLabel(
        SANDBOX_LABELS.managedBy,
        SANDBOX_MANAGED_BY,
      );
      const observations: ManagedSandboxObservation[] = [];

      for (const container of containers) {
        let status: ContainerStatus;
        try {
          status = await container.inspect();
        } catch (error: unknown) {
          // A container removed between list and inspect is already reconciled.
          if ((error as { statusCode?: number } | null)?.statusCode === 404) continue;
          throw error;
        }

        const sessionId = status.labels[SANDBOX_LABELS.sessionId] ?? null;
        const botId = status.labels[SANDBOX_IDENTITY_LABEL] ?? null;
        observations.push({
          containerId: container.id,
          sessionId,
          botId,
          running: status.running,
          workspace: botId === null ? null : await this.#workspaceForContainer(botId, status),
        });
      }

      return observations;
    });
  };

  /** Remove a runtime orphan while making volume deletion unrepresentable. */
  removeManagedSession = async (options: { containerId: string }): Promise<void> => {
    return withMappedDockerErrors(this.providerId, async () => {
      const container = await this.#engine.findById(options.containerId);
      if (container === null) return;
      const status = await container.inspect();
      if (status.labels[SANDBOX_LABELS.managedBy] !== SANDBOX_MANAGED_BY) {
        throw new HarnessError({
          message: `container ${options.containerId} is not managed by ${SANDBOX_MANAGED_BY}`,
        });
      }
      await container.stop();
      await container.remove();
    });
  };

  inspectWorkspace = async (options: { botId: string }): Promise<WorkspaceObservation> => {
    return withMappedDockerErrors(this.providerId, async () => {
      const workspace = await this.#engine.findVolume(workspaceVolumeNameFor(options.botId));
      if (workspace === null) return { exists: false };
      try {
        this.#assertWorkspaceOwnership(workspace, options.botId);
        return { exists: true, ok: true, volumeName: workspace.name };
      } catch (error: unknown) {
        return { exists: true, ok: false, reason: describe(error) };
      }
    });
  };

  /**
   * Is this sandbox still serving? (M2-BE-05.)
   *
   * Total by design: every sandbox-level fault is an ANSWER, not an exception,
   * because the caller is a health poll whose whole job is to turn "no" into a
   * state. Only a failure to reach the daemon at all throws, and that is the
   * one case a poller must not read as "this sandbox is sick" — a hiccup
   * talking to Docker would otherwise flip every bot to UNHEALTHY at once.
   *
   * Three conditions, in the order that a failure actually stops the desktop:
   * the container exists, it is running, and the bridge answers. Checking the
   * bridge alone would report a killed container as merely unreachable and lose
   * the exit code, which is the part that says why.
   *
   * A container that is gone entirely is unhealthy, deliberately not stopped.
   * D-031 requires a missing runtime to surface as a recoverable error rather
   * than as a clean state that a later start would silently paper over with an
   * empty desktop.
   */
  checkHealth = async (options: { sessionId: string }): Promise<SandboxHealth> => {
    const { sessionId } = options;

    return withMappedDockerErrors(this.providerId, async () => {
      const container = await this.#engine.findByLabel(SANDBOX_LABELS.sessionId, sessionId);
      if (container === null) {
        return unwell(`no container carries ${SANDBOX_LABELS.sessionId}=${sessionId}`);
      }

      let status;
      try {
        status = await container.inspect();
      } catch (error: unknown) {
        if ((error as { statusCode?: number } | null)?.statusCode !== 404) throw error;
        return unwell(`container ${container.id} no longer exists`);
      }
      if (!status.running) {
        const code = status.exitCode === null ? 'no exit code' : `exit ${status.exitCode}`;
        return unwell(`container ${container.id} is not running (${code})`);
      }

      const session = new ContainerSandboxSession({
        sessionId,
        container,
        containerId: container.id,
        screen: this.#screen,
      });

      let url: string;
      try {
        ({ url } = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge }));
      } catch (error: unknown) {
        // Only the session's missing-binding error is evidence of bad health.
        // getPortEndpoint also inspects Docker; daemon failures must reject.
        if ((error as { statusCode?: number } | null)?.statusCode === 404) {
          return unwell(`container ${container.id} no longer exists`);
        }
        if (!HarnessError.isInstance(error)) throw error;
        // Running, but Docker publishes no bridge binding: reachable by nothing.
        return unwell(`container ${container.id} publishes no port ${SANDBOX_PORTS.bridge}`);
      }

      return (await this.#bridgeProbe(url))
        ? { ok: true }
        : unwell(`the agent-bridge at ${url} did not report healthy`);
    });
  };

  resumeSession = async (
    options: HarnessV1ResumeSessionOptions,
  ): Promise<ContainerSandboxSession> => {
    const { sessionId } = options;

    return withMappedDockerErrors(this.providerId, async () => {
      const container = await this.#engine.findByLabel(SANDBOX_LABELS.sessionId, sessionId);
      if (container === null) {
        // Throwing rather than falling back on the caller's behalf: the caller
        // is the one that knows whether a missing container means "create a
        // fresh one" or "something removed a desktop we thought we owned".
        throw new HarnessError({
          message: `sandbox ${sessionId}: no container carries ${SANDBOX_LABELS.sessionId}=${sessionId}`,
        });
      }

      // A resume across an orchestrator restart finds the container still
      // running and must not restart it — M2-QA-03 asserts the desktop is
      // unchanged, and a restart would silently pass "same container id" while
      // losing every window the bot had open.
      const status = await container.inspect();

      // D-039 §4: a container that belongs to a BOT but has no workspace
      // mounted is inconsistent, and resuming it would hand that bot a desktop
      // whose files die with the container — indistinguishable, until the day
      // it matters, from a durable one. Every container created before D-039 is
      // in that state. Refusing is the "recoverable error until recovery is
      // selected" D-031 requires; replacement is the recovery, and it keeps
      // whatever workspace already exists for that bot.
      //
      // Keyed on the identity label rather than on the mount alone, because a
      // session created WITHOUT an identity is ephemeral on purpose and has no
      // workspace to lose. For a bot session, both the exact volume name and
      // its daemon-owned labels are checked before a stopped container starts.
      const owner = status.labels[SANDBOX_IDENTITY_LABEL];
      if (owner !== undefined) {
        const expectedName = workspaceVolumeNameFor(owner);
        const workspaceMount = status.mounts.find(
          (mount) => mount.path === SANDBOX_WORKING_DIRECTORY,
        );
        if (workspaceMount === undefined) {
          throw new HarnessError({
            message:
              `sandbox ${sessionId}: container ${container.id} belongs to ${owner} but has no ` +
              `workspace mounted at ${SANDBOX_WORKING_DIRECTORY}. It predates the durable-workspace ` +
              'contract (D-039) and must be replaced rather than resumed; replacement preserves ' +
              'the saved workspace.',
          });
        }
        if (workspaceMount.volume !== expectedName) {
          throw new HarnessError({
            message:
              `sandbox ${sessionId}: container ${container.id} mounts workspace volume ` +
              `${workspaceMount.volume} at ${SANDBOX_WORKING_DIRECTORY}, expected ${expectedName}. ` +
              "Refusing to resume with another bot's files.",
          });
        }

        const workspace = await this.#engine.findVolume(expectedName);
        if (workspace === null) {
          throw new HarnessError({
            message:
              `sandbox ${sessionId}: container ${container.id} names workspace volume ` +
              `${expectedName}, but the daemon cannot inspect it. Refusing to resume.`,
          });
        }
        this.#assertWorkspaceOwnership(workspace, owner);
        await this.#assertNoOtherRunningWriter(expectedName, container.id);
        if (!status.running) {
          await this.#engine.workspaceMarker(expectedName, this.#image, Date.now(), true);
        }
      }

      if (!status.running) await container.start();

      const session = new ContainerSandboxSession({
        sessionId,
        container,
        containerId: container.id,
        screen: this.#screen,
      });
      await this.#awaitUsable(session, container, sessionId, options.abortSignal);

      return session;
    });
  };

  /**
   * Provisioning may create storage; ordinary orchestrator runtime creation
   * requires the storage that was provisioned earlier. That flag is checked
   * against the daemon here, not just before admission, so a volume lost in
   * between cannot silently become an empty replacement. Existing volumes
   * are always revalidated and their contents are never reset.
   *
   * `undefined` owner means an ephemeral desktop with no durable storage. That
   * exists for tests and one-off sessions, and it is deliberately explicit:
   * defaulting to the session id would silently create a workspace under a
   * name nothing would ever look for again.
   */
  async #resolveWorkspace(
    owner: string | undefined,
    requireExisting = false,
  ): Promise<WorkspaceVolume | null> {
    if (owner === undefined) return null;

    const name = workspaceVolumeNameFor(owner);
    const existing = await this.#engine.findVolume(name);
    if (existing === null && requireExisting)
      throw new Error('Workspace is missing; refusing to recreate storage');
    const workspace =
      existing ??
      (await this.#engine.createVolume({
        name,
        labels: {
          [SANDBOX_LABELS.botId]: owner,
          [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
        },
      }));

    // Validate both branches. Docker volume creation is idempotent, so another
    // actor can create this name after our lookup but before our create call.
    // In that race the daemon returns the already-existing volume with ITS
    // labels; treating the create path as trusted would bypass the ownership
    // check at exactly the point where it matters most.
    this.#assertWorkspaceOwnership(workspace, owner);
    await this.#assertNoOtherRunningWriter(workspace.name);
    await this.#engine.workspaceMarker(workspace.name, this.#image, Date.now(), true);
    return workspace;
  }

  async #workspaceForContainer(
    botId: string,
    status: ContainerStatus,
  ): Promise<ManagedSandboxObservation['workspace']> {
    const expectedName = workspaceVolumeNameFor(botId);
    const mount = status.mounts.find((candidate) => candidate.path === SANDBOX_WORKING_DIRECTORY);
    if (mount === undefined) {
      return {
        ok: false,
        reason: `bot runtime has no workspace mounted at ${SANDBOX_WORKING_DIRECTORY}`,
      };
    }
    if (mount.volume !== expectedName) {
      return {
        ok: false,
        reason: `runtime mounts ${mount.volume}, expected ${expectedName}`,
      };
    }

    const workspace = await this.#engine.findVolume(expectedName);
    if (workspace === null) {
      return { ok: false, reason: `workspace volume ${expectedName} is absent` };
    }
    try {
      this.#assertWorkspaceOwnership(workspace, botId);
      return { ok: true, volumeName: workspace.name };
    } catch (error: unknown) {
      return { ok: false, reason: describe(error) };
    }
  }

  /**
   * A database row cannot fence a container created before persistence.
   * Checking daemon mounts closes that crash window before create or resume.
   */
  async #assertNoOtherRunningWriter(volumeName: string, exceptContainerId?: string): Promise<void> {
    // Deliberately not filtered by our ownership label. A foreign or malformed
    // container is still a writer, and the mount is the fact that can corrupt
    // the workspace if we start a second one.
    const containers = await this.#engine.listByVolume(volumeName);
    for (const container of containers) {
      if (container.id === exceptContainerId) continue;
      let status: ContainerStatus;
      try {
        status = await container.inspect();
      } catch (error: unknown) {
        if ((error as { statusCode?: number } | null)?.statusCode === 404) continue;
        throw error;
      }
      if (
        status.running &&
        status.mounts.some(
          (mount) => mount.path === SANDBOX_WORKING_DIRECTORY && mount.volume === volumeName,
        )
      ) {
        throw new HarnessError({
          message:
            `workspace volume ${volumeName} is already mounted by running container ` +
            `${container.id}. Refusing a second writable runtime.`,
        });
      }
    }
  }

  #assertWorkspaceOwnership(workspace: WorkspaceVolume, owner: string): void {
    const expectedName = workspaceVolumeNameFor(owner);
    // D-039 §2. The label is the ONLY authoritative record of who owns a
    // workspace, so it is checked rather than inferred from the name matching.
    // Attaching one bot's files to another bot's desktop is the worst failure
    // available in this design: it is silent, and it leaks between bots.
    const ownerLabel = workspace.labels[SANDBOX_LABELS.botId];
    const managedBy = workspace.labels[SANDBOX_LABELS.managedBy];
    if (
      workspace.name !== expectedName ||
      ownerLabel !== owner ||
      managedBy !== SANDBOX_MANAGED_BY
    ) {
      throw new HarnessError({
        message:
          `workspace volume ${workspace.name} is not owned by ${owner} ` +
          `(expected name ${expectedName}, ${SANDBOX_LABELS.botId}=${ownerLabel ?? 'unset'}, ` +
          `${SANDBOX_LABELS.managedBy}=${managedBy ?? 'unset'}). Refusing to attach it.`,
      });
    }
  }

  /**
   * Return only once the sandbox can actually serve, which is two conditions,
   * not one.
   *
   * Docker publishes a port mapping the instant the container starts, so
   * waiting on the mapping alone returns a session roughly two seconds before
   * anything is listening behind it — the ports resolve, and every one of them
   * refuses the connection. That is worse than a slow start: it hands the
   * caller a session that looks healthy and fails on first use, and it misses
   * §5's acceptance criterion, which asks for a RUNNING sandbox *with a healthy
   * bridge*. The entrypoint already blocks on the same `/health` before it
   * declares the desktop up; this is the outside of that same gate.
   *
   * Health polling for the rest of the sandbox's life is M2-BE-05. This is only
   * the boot edge.
   */
  async #awaitUsable(
    session: ContainerSandboxSession,
    container: SandboxContainer,
    sessionId: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    await this.#awaitPublishedPorts(container, sessionId, deadline, abortSignal);

    const { url } = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    for (;;) {
      abortSignal?.throwIfAborted();
      if (await this.#bridgeProbe(url)) return;

      // A container that died while we were waiting explains itself far better
      // than "the bridge never answered" does.
      const status = await container.inspect();
      if (!status.running) throw exitedDuringStart(sessionId, container.id, status);
      if (Date.now() > deadline) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: the agent-bridge at ${url} did not report healthy within ` +
            `${this.#readyTimeoutMs}ms. The container is still running, so read its log — the ` +
            'entrypoint names the component it was waiting on.',
        });
      }
      await delay(250);
    }
  }

  async #awaitPublishedPorts(
    container: SandboxContainer,
    sessionId: string,
    deadline: number,
    abortSignal?: AbortSignal,
  ): Promise<ContainerStatus> {
    let status = await container.inspect();

    while (!isFullyPublished(status)) {
      abortSignal?.throwIfAborted();
      if (!status.running) throw exitedDuringStart(sessionId, container.id, status);
      if (Date.now() > deadline) {
        throw new HarnessError({
          message: `sandbox ${sessionId}: ports were not published within ${this.#readyTimeoutMs}ms`,
        });
      }
      await delay(100);
      status = await container.inspect();
    }

    return status;
  }
}

function exitedDuringStart(
  sessionId: string,
  containerId: string,
  status: ContainerStatus,
): HarnessError {
  return new HarnessError({
    message:
      `sandbox ${sessionId}: container ${containerId} exited during start ` +
      `(exit ${status.exitCode ?? 'unknown'}). The entrypoint exits non-zero when any ` +
      'supervised process dies — read the container log for which one.',
  });
}

function unwell(reason: string): SandboxHealth {
  return { ok: false, reason };
}

/**
 * The default bridge probe. Every failure mode here — refused, reset, timed
 * out, 503 from a bridge whose checks are failing — is "not ready yet", so
 * this answers a boolean rather than throwing and letting the caller
 * distinguish a connection error from a slow boot.
 */
async function probeBridgeOverHttp(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isFullyPublished(status: ContainerStatus): boolean {
  return (
    status.running &&
    [SANDBOX_PORTS.rfb, SANDBOX_PORTS.cdp, SANDBOX_PORTS.bridge].every(
      (port) => status.portBindings[port] !== undefined,
    )
  );
}

export function containerNameFor(sessionId: string): string {
  // Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*, and the harness places no
  // constraint on sessionId, so anything else becomes '-' rather than a create
  // failure three layers from the sessionId that caused it. The label is the
  // lookup key; the name is for humans reading `docker ps`.
  return `crewaid-sandbox-${sessionId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

/**
 * Docker refusing on credentials and Docker being down are different problems
 * with different fixes, and the harness has a distinct error for the first so
 * a framework integration can tell a misconfiguration from an outage.
 */
async function withMappedDockerErrors<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (HarnessError.isInstance(error)) throw error;

    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new HarnessSandboxAuthenticationError({
        message:
          'the Docker daemon refused this process. Check the socket permissions, ' +
          'or DOCKER_HOST and its credentials.',
        sandboxProviderId: providerId,
        cause: error,
      });
    }
    throw new HarnessError({ message: describe(error), cause: error });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `docker: ${error.message}`;
  return `docker: ${String(error)}`;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
