/**
 * Customer computers on DigitalOcean Harness Runtime.
 *
 * Satisfies the orchestrator's `SandboxProvider` contract the way
 * `DockerSandboxProvider` does, over a different kind of host:
 *
 * - A computer is ONE DigitalOcean session, named `crewaid-<id>` (sessions
 * carry no labels, and names are unique per team). Every session is
 * created from one shared environment, by id, so creating a computer
 * leaves no saved environment behind.
 * - The session's disk IS the workspace. Docker can remove a container and
 * keep its volume; here removing the session deletes the files. So every
 * path that removes a runtime under Docker — `stop`, `destroy`, orphan
 * cleanup — PAUSES here, and only retention's `deleted` outcome removes
 * a session. A pause keeps memory and processes, so a browser that was
 * logged in is still logged in when the machine resumes.
 * - Ports reach the orchestrator as loopback listeners (`PortTunnels`), and
 * commands and file I/O go through the machine's own bridge (`/exec`)
 * over that tunnel. DigitalOcean's exec — one request and response, as
 * root, no stdin or stream — is kept for what must work while the bridge
 * is down: starting the desktop and the workspace markers.
 * - The orchestrator's idle stop (`SANDBOX_IDLE_STOP_MS`) decides when a
 * computer pauses. DigitalOcean's own idle timer ignores tunnel traffic —
 * it paused a machine while a viewer watched — and `keep_warm` cannot be
 * used to turn it off, because a warm session refuses to pause at all
 * (409). So the environment keeps a long `idle_timeout` as a backstop for
 * an orchestrator that is down, and `checkHealth`, which the health sweep
 * calls for every running computer, sends a trivial exec — which DOES
 * reset the timer (measured 2026-09-30) — at most every
 * `KEEP_ALIVE_MS`.
 */

import { createHash } from 'node:crypto';

import {
  ContainerSandboxSession,
  HARNESS_SANDBOX_SPECIFICATION_VERSION,
  HarnessError,
  HarnessSandboxAuthenticationError,
  PortTunnels,
  RUNTIME_MARKER_PROGRAM,
  SANDBOX_PORTS,
  SEAT_CDP_PORTS,
  SEAT_PORTS,
  WORKSPACE_MARKER_PROGRAM,
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
  DigitalOceanApi,
  DigitalOceanApiError,
  type ExecResult,
  type HarnessSession,
} from './do-api.js';

/** The session-name prefix that marks a session as one of this provider's computers. */
export const COMPUTER_NAME_PREFIX = 'crewaid-';

/** Every port a machine serves; each gets a loopback listener while it runs. */
const MACHINE_PORTS: readonly number[] = [
  SANDBOX_PORTS.rfb,
  SANDBOX_PORTS.cdp,
  SANDBOX_PORTS.bridge,
  ...SEAT_PORTS,
  ...SEAT_CDP_PORTS,
];

/**
 * The desktop is started during the template build and frozen into the
 * snapshot every session resumes from, so the screen is the image's and a
 * per-session setting could not change it (spec `env` never reaches the
 * frozen process).
 */
const SCREEN = Object.freeze({ widthPx: 1280, heightPx: 800 });

/** How long `getSession` answers are reused. `getPortEndpoint` inspects on every call. */
const STATUS_TTL_MS = 1_000;

/**
 * DigitalOcean pauses a session after this long without exec or input. Long
 * enough that the orchestrator's own idle stop (30 minutes by default) always
 * decides first; short enough that a machine an unreachable orchestrator
 * stopped watching does not run for a day.
 */
export const IDLE_BACKSTOP = '1h';

/** How often a running, healthy computer is told it is still in use. Well inside the backstop. */
export const KEEP_ALIVE_MS = 10 * 60_000;

/** DigitalOcean's limit on an environment's name. */
const ENVIRONMENT_NAME_MAX = 64;

export interface DigitalOceanSandboxProviderOptions {
  /** Seam for tests; defaults to a client that reads the token from the environment. */
  readonly api?: DigitalOceanApi;
  /** The custom template built from the sandbox image (`SANDBOX_DO_TEMPLATE`). */
  readonly template: string;
  /** Machine size slug (`SANDBOX_DO_SIZE`). */
  readonly size?: string;
  /** Base adapter the template was rebased onto (`SANDBOX_DO_BASE_ADAPTER`). */
  readonly baseAdapter?: string;
  /**
   * How long a start has to become usable. A resume takes about a second and
   * a new session about five; the rest is room for the desktop launcher.
   */
  readonly readyTimeoutMs?: number;
  /** Seam for tests: resolves true when the bridge at `baseUrl` is healthy. */
  readonly bridgeProbe?: (baseUrl: string) => Promise<boolean>;
  /** How long to wait for the desktop after launching it before launching again. */
  readonly relaunchMs?: number;
}

/** `crewaid-<id>`, the only name a computer's session ever has. */
export function sessionNameFor(computerId: string): string {
  return `${COMPUTER_NAME_PREFIX}${computerId}`;
}

export class DigitalOceanSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = HARNESS_SANDBOX_SPECIFICATION_VERSION;
  readonly providerId = 'crewaid-digitalocean';

  readonly #api: DigitalOceanApi;
  readonly #template: string;
  readonly #size: string;
  readonly #baseAdapter: string;
  readonly #readyTimeoutMs: number;
  readonly #bridgeProbe: (baseUrl: string) => Promise<boolean>;
  readonly #relaunchMs: number;
  /** One container object per DigitalOcean session, so its tunnels are shared. */
  readonly #containers = new Map<string, DigitalOceanContainer>();
  /**
   * When each orphaned computer was first seen orphaned, once read from the
   * marker inside its workspace. Cached so a retention sweep — once a minute,
   * per computer — does not wake a paused machine to ask again.
   */
  readonly #orphanedSince = new Map<string, number>();
  /** When each session last had a keep-alive exec. */
  readonly #keptAlive = new Map<string, number>();
  /** Sessions whose runtime marker read "none", until a start here writes one. */
  readonly #neverStarted = new Set<string>();
  #environmentId: Promise<string> | null = null;

  constructor(options: DigitalOceanSandboxProviderOptions) {
    this.#api = options.api ?? new DigitalOceanApi();
    this.#template = options.template;
    this.#size = options.size ?? 'mars-4vcpu-8gb';
    this.#baseAdapter = options.baseAdapter ?? 'opencode';
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
    this.#bridgeProbe = options.bridgeProbe ?? probeBridgeOverHttp;
    this.#relaunchMs = options.relaunchMs ?? 20_000;
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  createSession = async (
    options?: HarnessV1CreateSessionOptions & { requireExistingWorkspace?: boolean },
  ): Promise<ContainerSandboxSession> =>
    this.#mapped(async () => {
      options?.abortSignal?.throwIfAborted();
      const sessionId = options?.sessionId ?? crypto.randomUUID();
      // One resource is both runtime and workspace here, so it can only be
      // keyed one way. The orchestrator passes the same string for both today
      // (sandbox.service.ts says why); if they ever diverge this refuses
      // rather than filing a computer's files under a name nothing looks for.
      if (options?.identity !== undefined && options.identity !== sessionId) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: the DigitalOcean provider keys a computer's runtime and ` +
            `workspace by one name, but was asked for identity ${options.identity}.`,
        });
      }
      const existing = await this.#api.findSessionByName(sessionNameFor(sessionId));
      if (existing !== null) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId} already exists as session ${existing.session_id}. ` +
            'Use resumeSession() to reattach.',
        });
      }
      if (options?.requireExistingWorkspace === true) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: its workspace is missing. On DigitalOcean the workspace is ` +
            'the session, and none exists; storage is not recreated automatically (D-031).',
        });
      }

      const created = await this.#api.createSession(
        sessionNameFor(sessionId),
        await this.#environment(),
      );
      const container = this.#containerFor(created.session_id);
      try {
        await container.start();
        await this.#writeRuntimeMarker(created.session_id);
        const session = this.#sessionOver(sessionId, container);
        await this.#awaitUsable(session, container, sessionId, options?.abortSignal);
        if (options?.onFirstCreate !== undefined) {
          await options.onFirstCreate(session.restricted(), {
            ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          });
        }
        return session;
      } catch (error) {
        // Nothing escaped to the caller, and a fresh session holds no files yet.
        await container.close();
        await this.#api.destroy(created.session_id).catch(() => undefined);
        throw error;
      }
    });

  resumeSession = async (
    options: HarnessV1ResumeSessionOptions,
  ): Promise<ContainerSandboxSession> =>
    this.#mapped(async () => {
      const { sessionId } = options;
      const found = await this.#api.findSessionByName(sessionNameFor(sessionId));
      if (found === null) {
        throw new HarnessError({
          message: `sandbox ${sessionId}: no DigitalOcean session is named ${sessionNameFor(sessionId)}`,
        });
      }
      const container = this.#containerFor(found.session_id);
      await container.start();
      // Provisioning created this session, so a computer's first start comes
      // through here rather than createSession. The marker is write-once, so
      // every later resume keeps the first start's time.
      this.#neverStarted.delete(found.session_id);
      await this.#writeRuntimeMarker(found.session_id);
      // A resumed computer is not an orphan: forget any retention clock.
      this.#orphanedSince.delete(sessionId);
      await this.#workspaceMarker(found.session_id, 'clear');
      const session = this.#sessionOver(sessionId, container);
      await this.#awaitUsable(session, container, sessionId, options.abortSignal);
      return session;
    });

  /** A handle without starting or waiting — for stop, destroy and inspect. */
  attachSession = async (options: { sessionId: string }): Promise<ContainerSandboxSession | null> =>
    this.#mapped(async () => {
      const found = await this.#api.findSessionByName(sessionNameFor(options.sessionId));
      if (found === null) return null;
      return this.#sessionOver(options.sessionId, this.#containerFor(found.session_id));
    });

  /** Total, like Docker's: every machine-level fault is an answer, only an API failure throws. */
  checkHealth = async (options: { sessionId: string }): Promise<SandboxHealth> =>
    this.#mapped(async () => {
      const found = await this.#api.findSessionByName(sessionNameFor(options.sessionId));
      if (found === null) {
        return unwell(`no DigitalOcean session is named ${sessionNameFor(options.sessionId)}`);
      }
      if (found.status !== 'SESSION_STATUS_READY') {
        const reason = found.pause_reason ? `, ${found.pause_reason}` : '';
        return unwell(`session ${found.session_id} is ${statusWord(found.status)}${reason}`);
      }
      const bridge = await this.#containerFor(found.session_id).endpoint(SANDBOX_PORTS.bridge);
      const url = `http://${bridge.host}:${bridge.port}`;
      if (!(await this.#bridgeProbe(url))) {
        return unwell(`the agent-bridge in session ${found.session_id} did not report healthy`);
      }
      await this.#keepAlive(found.session_id);
      return { ok: true };
    });

  // ── inventory and reconciliation ───────────────────────────────────────────

  listManagedSessions = async (): Promise<readonly ManagedSandboxObservation[]> =>
    this.#mapped(async () =>
      (await this.#computers()).map(({ computerId, session }) => ({
        containerId: session.session_id,
        sessionId: computerId,
        botId: computerId,
        running: session.status === 'SESSION_STATUS_READY',
        workspace: { ok: true, volumeName: session.session_id },
      })),
    );

  /**
   * Orphan cleanup PAUSES. Under Docker this removes a container and keeps
   * its volume; here the session is the volume, so removing it would delete
   * a computer's files on a path whose whole promise is that it never does.
   */
  removeManagedSession = async (options: { containerId: string }): Promise<void> =>
    this.#mapped(async () => {
      const session = await this.#api.getSession(options.containerId);
      if (session === null) return;
      if (!session.name?.startsWith(COMPUTER_NAME_PREFIX)) {
        throw new HarnessError({
          message: `session ${options.containerId} is not a Crewaid computer`,
        });
      }
      await this.#containerFor(session.session_id).stop();
    });

  // ── workspaces ─────────────────────────────────────────────────────────────

  /** Creates the computer's session and pauses it: the workspace exists, nothing runs. */
  provisionWorkspace = async (options: { botId: string }): Promise<void> =>
    this.#mapped(async () => {
      const name = sessionNameFor(options.botId);
      if ((await this.#api.findSessionByName(name)) !== null) return;
      const created = await this.#api.createSession(name, await this.#environment());
      await this.#awaitStatus(created.session_id, 'SESSION_STATUS_READY');
      await this.#api.pause(created.session_id);
    });

  inspectWorkspace = async (options: { botId: string }): Promise<WorkspaceObservation> =>
    this.#mapped(async () => {
      const found = await this.#api.findSessionByName(sessionNameFor(options.botId));
      return found === null
        ? { exists: false }
        : { exists: true, ok: true, volumeName: found.session_id };
    });

  /**
   * Has this workspace ever run under the orchestrator? Read from the runtime
   * marker a start writes inside it, through DigitalOcean's exec — which wakes
   * a paused session, so a paused one is paused again after the read.
   *
   * The workspace sweep asks this every minute about each computer that has
   * never started. A "never" is remembered, because only a start through this
   * provider can change it and that start forgets it; so the answer costs one
   * brief wake per computer per process, not one a minute.
   */
  inspectWorkspaceHistory = async (options: {
    botId: string;
  }): Promise<{ referenced: boolean; runtimeCreatedAt: number | null }> =>
    this.#mapped(async () => {
      const found = await this.#api.findSessionByName(sessionNameFor(options.botId));
      if (found === null) throw new Error('Workspace is missing; refusing to recreate storage');
      if (this.#neverStarted.has(found.session_id)) {
        return { referenced: false, runtimeCreatedAt: null };
      }
      const wasPaused = found.status === 'SESSION_STATUS_PAUSED';
      let result: ExecResult;
      try {
        result = await this.#api.exec(found.session_id, [
          'python3',
          '-I',
          '-c',
          RUNTIME_MARKER_PROGRAM,
          String(Date.now()),
          'read',
        ]);
      } finally {
        if (wasPaused) await this.#api.pause(found.session_id);
      }
      const match = /crewaid-runtime:(none|\d+)/.exec(result.stdout);
      if (result.exitCode !== 0 || match === null) {
        throw new Error('Workspace runtime marker is unsafe or inaccessible');
      }
      if (match[1] === 'none') {
        this.#neverStarted.add(found.session_id);
        return { referenced: false, runtimeCreatedAt: null };
      }
      // A running session is the runtime referencing this workspace.
      return {
        referenced: found.status === 'SESSION_STATUS_READY',
        runtimeCreatedAt: Number(match[1]),
      };
    });

  listWorkspaces = async (): Promise<readonly { botId: string }[]> =>
    this.#mapped(async () =>
      (await this.#computers()).map(({ computerId }) => ({ botId: computerId })),
    );

  /**
   * The retention sweep's question, answered without waking a machine in the
   * common case. An in-use computer is `retained` from the API alone. An
   * orphan's first-seen time lives in a marker inside its workspace (D-039),
   * written once through DigitalOcean's exec and then cached here; only a
   * process restart asks the machine again.
   */
  retainWorkspace = async (options: {
    botId: string;
    orphaned: boolean;
    now: number;
    retentionMs: number;
  }): Promise<'absent' | 'in-use' | 'retained' | 'deleted'> =>
    this.#mapped(async () => {
      const found = await this.#api.findSessionByName(sessionNameFor(options.botId));
      if (found === null) {
        this.#orphanedSince.delete(options.botId);
        return 'absent';
      }
      if (!options.orphaned) {
        // A computer restored after being orphaned must lose its old clock.
        if (this.#orphanedSince.delete(options.botId)) {
          await this.#workspaceMarker(found.session_id, 'clear');
        }
        return 'retained';
      }
      if (found.status === 'SESSION_STATUS_READY') return 'in-use';

      let first = this.#orphanedSince.get(options.botId);
      if (first === undefined) {
        first = await this.#workspaceMarker(found.session_id, 'mark', options.now);
        // Reading the marker woke it; an orphan has no reason to stay awake.
        await this.#api.pause(found.session_id).catch(() => undefined);
        this.#orphanedSince.set(options.botId, first);
      }
      if (options.now - first < options.retentionMs) return 'retained';

      const current = await this.#api.getSession(found.session_id);
      if (current === null) return 'absent';
      if (current.status === 'SESSION_STATUS_READY') return 'in-use';
      await this.#containerFor(found.session_id).close();
      this.#containers.delete(found.session_id);
      await this.#api.destroy(found.session_id);
      this.#orphanedSince.delete(options.botId);
      return 'deleted';
    });

  /** Write a bot's profile tombstone as `bot`, while the desktop may be down. */
  retireBotProfile = async (options: { computerId: string; botId: string }): Promise<void> =>
    this.#mapped(async () => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.botId) || options.botId === 'Default') {
        throw new Error('Invalid bot profile');
      }
      const found = await this.#api.findSessionByName(sessionNameFor(options.computerId));
      if (found === null) throw new Error('Workspace is missing; cannot retire profile');
      const result = await this.#api.exec(
        found.session_id,
        [
          'setpriv',
          '--reuid=bot',
          '--regid=bot',
          '--init-groups',
          'python3',
          '/opt/agent-bridge/profiles.py',
          'retire',
          options.botId,
        ],
        { timeoutSeconds: 10 },
      );
      if (result.exitCode !== 0) throw new Error('Could not persist profile retirement');
    });

  // ── plumbing ───────────────────────────────────────────────────────────────

  #containerFor(sessionId: string): DigitalOceanContainer {
    let container = this.#containers.get(sessionId);
    if (container === undefined) {
      container = new DigitalOceanContainer(this.#api, sessionId);
      this.#containers.set(sessionId, container);
    }
    return container;
  }

  #sessionOver(sessionId: string, container: DigitalOceanContainer): ContainerSandboxSession {
    return new ContainerSandboxSession({
      sessionId,
      container,
      containerId: container.id,
      screen: SCREEN,
    });
  }

  /** Every live session that is one of this provider's computers. */
  async #computers(): Promise<{ computerId: string; session: HarnessSession }[]> {
    return (await this.#api.listSessions()).flatMap((session) => {
      const name = session.name ?? '';
      if (!name.startsWith(COMPUTER_NAME_PREFIX)) return [];
      const computerId = name.slice(COMPUTER_NAME_PREFIX.length);
      return computerId === '' ? [] : [{ computerId, session }];
    });
  }

  /** The shared environment's id, created once per template, size and adapter. */
  #environment(): Promise<string> {
    if (this.#environmentId === null) {
      // Environments are immutable, so every setting that shapes one is in its
      // name. Past the name limit a plain cut would drop the settings at the
      // end, and two sizes would share one environment; a hash of the whole
      // name keeps them apart.
      const full = `crewaid-${this.#template}-${this.#size}-${this.#baseAdapter}-idle${IDLE_BACKSTOP}`;
      const name =
        full.length <= ENVIRONMENT_NAME_MAX
          ? full
          : `${full.slice(0, ENVIRONMENT_NAME_MAX - 17)}-${createHash('sha256').update(full).digest('hex').slice(0, 16)}`;
      const manifest = [
        `name: ${name}`,
        `agent: ${this.#baseAdapter}`,
        `template: ${this.#template}`,
        `size: ${this.#size}`,
        `idle_timeout: ${IDLE_BACKSTOP}`,
        '',
      ].join('\n');
      this.#environmentId = this.#api.ensureEnvironment(name, manifest);
      // A failed lookup must be retried on the next call, not cached forever.
      this.#environmentId.catch(() => {
        this.#environmentId = null;
      });
    }
    return this.#environmentId;
  }

  /**
   * Reset DigitalOcean's idle timer for a computer the orchestrator is
   * using. Best effort: a failed keep-alive is retried on the next sweep, and
   * must not turn a healthy machine's health answer into a failure.
   */
  async #keepAlive(doSessionId: string): Promise<void> {
    const last = this.#keptAlive.get(doSessionId);
    if (last !== undefined && Date.now() - last < KEEP_ALIVE_MS) return;
    try {
      await this.#api.exec(doSessionId, ['true'], { timeoutSeconds: 10 });
      this.#keptAlive.set(doSessionId, Date.now());
    } catch {
      // Next sweep tries again; the backstop is an hour away.
    }
  }

  async #writeRuntimeMarker(doSessionId: string): Promise<void> {
    const result = await this.#api.exec(doSessionId, [
      'python3',
      '-I',
      '-c',
      RUNTIME_MARKER_PROGRAM,
      String(Date.now()),
      'write',
    ]);
    if (result.exitCode !== 0)
      throw new Error('Workspace runtime marker is unsafe or inaccessible');
  }

  /**
   * The orphan clock inside the workspace. `mark` returns when the computer
   * was first seen orphaned (setting it now if unset); `clear` resets it.
   */
  async #workspaceMarker(doSessionId: string, mode: 'mark', now: number): Promise<number>;
  async #workspaceMarker(doSessionId: string, mode: 'clear'): Promise<null>;
  async #workspaceMarker(
    doSessionId: string,
    mode: 'mark' | 'clear',
    now = Date.now(),
  ): Promise<number | null> {
    const result = await this.#api.exec(doSessionId, [
      'python3',
      '-I',
      '-c',
      WORKSPACE_MARKER_PROGRAM,
      String(now),
      mode === 'clear' ? 'clear' : 'mark',
    ]);
    if (result.exitCode !== 0) throw new Error('Workspace marker is unsafe or inaccessible');
    if (mode === 'clear') return null;
    const match = /crewaid-retention:(\d+)/.exec(result.stdout);
    if (match === null) throw new Error('Workspace marker returned no timestamp');
    return Number(match[1]);
  }

  async #awaitStatus(doSessionId: string, wanted: HarnessSession['status']): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    for (;;) {
      const session = await this.#api.getSession(doSessionId);
      if (session?.status === wanted) return;
      if (session === null || session.status === 'SESSION_STATUS_FAILED') {
        throw new HarnessError({
          message: `session ${doSessionId} ${session === null ? 'disappeared' : 'failed'} while starting`,
        });
      }
      if (Date.now() > deadline) {
        throw new HarnessError({
          message: `session ${doSessionId} did not reach ${statusWord(wanted)} within ${this.#readyTimeoutMs}ms`,
        });
      }
      await delay(500);
    }
  }

  /**
   * Wait for the bridge. When it does not answer, the desktop may simply not
   * be running — nothing on this host restarts it — so the launcher runs once
   * through DigitalOcean's exec, and the wait continues against the same
   * deadline.
   */
  async #awaitUsable(
    session: ContainerSandboxSession,
    container: DigitalOceanContainer,
    sessionId: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    const { url } = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    let lastLaunch = Number.NEGATIVE_INFINITY;
    for (;;) {
      abortSignal?.throwIfAborted();
      if (await this.#bridgeProbe(url)) return;
      // Again, not once: the launcher is idempotent, and a live crash test
      // saw one start in five stay down after a single launch. Retrying turns
      // that into a delay rather than a failed start.
      if (Date.now() - lastLaunch >= this.#relaunchMs) {
        lastLaunch = Date.now();
        const result = await this.#api.exec(container.id, ['/usr/local/bin/crewaid-desktop-up'], {
          timeoutSeconds: 15,
        });
        if (result.exitCode !== 0) {
          throw new HarnessError({
            message:
              `sandbox ${sessionId}: the desktop launcher failed (exit ${result.exitCode}): ` +
              result.stderr.trim().slice(0, 300),
          });
        }
      }
      if (Date.now() > deadline) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: the agent-bridge did not report healthy within ` +
            `${this.#readyTimeoutMs}ms. /tmp/crewaid-entrypoint.log inside the machine names ` +
            'the component the entrypoint was waiting on.',
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
      if (error instanceof DigitalOceanApiError && (error.status === 401 || error.status === 403)) {
        throw new HarnessSandboxAuthenticationError({
          message:
            'DigitalOcean refused the access token. Check that it is set and that it can ' +
            'manage Harness Runtime sessions and templates.',
          sandboxProviderId: this.providerId,
          cause: error,
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new HarnessError({ message: `digitalocean: ${detail}`, cause: error });
    }
  }
}

/**
 * One DigitalOcean session as the narrow container port.
 *
 * `stop` and `remove` both pause — see the provider's header for why neither
 * may delete — and both close the tunnels, because a stream opened to a paused
 * session resumes it, and a listener left open would wake a machine nobody
 * asked to wake.
 */
class DigitalOceanContainer implements SandboxContainer {
  readonly id: string;
  readonly #api: DigitalOceanApi;
  #tunnels: PortTunnels | null = null;
  #bindings: Readonly<Record<number, ContainerPortBinding>> | null = null;
  #status: { value: HarnessSession | null; at: number } | null = null;

  constructor(api: DigitalOceanApi, sessionId: string) {
    this.#api = api;
    this.id = sessionId;
  }

  async start(): Promise<void> {
    const session = await this.#session(true);
    if (session === null) throw new Error(`session ${this.id} no longer exists`);
    if (session.status === 'SESSION_STATUS_PAUSED') await this.#api.resume(this.id);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const current = await this.#session(true);
      if (current?.status === 'SESSION_STATUS_READY') return;
      if (current === null || current.status === 'SESSION_STATUS_FAILED') {
        throw new Error(`session ${this.id} ${current === null ? 'disappeared' : 'failed'}`);
      }
      if (Date.now() > deadline) throw new Error(`session ${this.id} did not become ready`);
      await delay(250);
    }
  }

  async stop(): Promise<void> {
    await this.close();
    const session = await this.#session(true);
    if (session?.status === 'SESSION_STATUS_READY') await this.#api.pause(this.id);
    this.#status = null;
  }

  /** Pauses, never deletes: this session is the computer's workspace. */
  async remove(): Promise<void> {
    await this.stop();
  }

  async inspect(): Promise<ContainerStatus> {
    const session = await this.#session(false);
    const running = session?.status === 'SESSION_STATUS_READY';
    return {
      running,
      exitCode: null,
      portBindings: running ? await this.#allBindings() : {},
      mounts: [],
      labels: session?.name === undefined ? {} : { name: session.name },
    };
  }

  async spawn(spec: ContainerExecSpec): Promise<ContainerProcess> {
    return bridgeExec(await this.endpoint(SANDBOX_PORTS.bridge), spec);
  }

  endpoint(port: number): Promise<ContainerPortBinding> {
    this.#tunnels ??= new PortTunnels((remote) => this.#api.openPortForward(this.id, remote));
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

  async #session(fresh: boolean): Promise<HarnessSession | null> {
    if (!fresh && this.#status !== null && Date.now() - this.#status.at < STATUS_TTL_MS) {
      return this.#status.value;
    }
    const value = await this.#api.getSession(this.id);
    this.#status = { value, at: Date.now() };
    return value;
  }
}

function unwell(reason: string): SandboxHealth {
  return { ok: false, reason };
}

function statusWord(status: HarnessSession['status']): string {
  return status.replace('SESSION_STATUS_', '').toLowerCase();
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
