import { SANDBOX_PORTS } from '@crewaid/sandbox-core';

import type {
  SandboxHealth,
  SandboxProvider,
  SandboxRuntimeObservation,
  SandboxSession,
  SandboxWorkspaceObservation,
} from '../src/sandbox/sandbox.provider.js';

/**
 * The provider seam, faked.
 *
 * Shared by the lifecycle and health suites because both drive the SAME row
 * through the SAME lock and a second copy would drift from this one silently.
 * It counts calls rather than simulating Docker: what the lock guarantees is
 * how many callers get past the compare-and-swap, and `createCalls` measures
 * exactly that, in milliseconds, without a daemon.
 */
/**
 * Whether a port is a CDP endpoint: the machine's own, or a seat's (D-060).
 *
 * Seat ports are allocated from `SEAT_CDP_PORT_BASE` upwards by the bridge, one
 * per seat slot. The range is mirrored rather than imported because the bridge
 * is Python and this is the orchestrator's test double — the number that has to
 * agree is the base, and it agreeing is what these suites exercise.
 */
const SEAT_CDP_PORT_BASE = 9301;
const SEAT_COUNT = 16;

function isCdpPort(port: number): boolean {
  if (port === SANDBOX_PORTS.cdp) return true;
  return port >= SEAT_CDP_PORT_BASE && port < SEAT_CDP_PORT_BASE + SEAT_COUNT;
}

export class FakeProvider implements SandboxProvider {
  readonly retiredProfiles: Array<{ computerId: string; botId: string }> = [];
  retireBotProfile = async (options: { computerId: string; botId: string }) => {
    this.retiredProfiles.push(options);
  };
  workspaceOnFirstStart = false;
  failStopWith: Error | null = null;
  provisionCalls = 0;
  failProvisionWith: Error | null = null;
  onProvision: (() => Promise<void>) | null = null;
  readonly history = new Map<string, { referenced: boolean; runtimeCreatedAt: number | null }>();
  provisionWorkspace = async ({ botId }: { botId: string }) => {
    this.provisionCalls += 1;
    this.workspaces.set(botId, {
      exists: true,
      ok: true,
      volumeName: `crewaid-workspace-${botId}`,
    });
    await this.onProvision?.();
    if (this.failProvisionWith) throw this.failProvisionWith;
  };
  inspectWorkspaceHistory = ({ botId }: { botId: string }) =>
    Promise.resolve(this.history.get(botId) ?? { referenced: false, runtimeCreatedAt: null });
  listWorkspaces = () => Promise.resolve([...this.workspaces.keys()].map((botId) => ({ botId })));
  retainWorkspace = () => Promise.resolve('retained' as const);
  destroyCalls = 0;
  failDestroyWith: Error | null = null;
  onDestroy: (() => Promise<void>) | null = null;
  readonly specificationVersion = 'harness-sandbox-v1' as const;
  readonly providerId = 'fake';

  createCalls = 0;
  resumeCalls = 0;
  attachCalls = 0;
  stopCalls = 0;
  /**
   * Stops per session id. The global counter above is fine for a suite that
   * drives one bot, and useless for anything that runs a sweep: a sweep walks
   * every sandbox row in a database other suites left theirs in, so a global
   * count reports the leftovers rather than the test. Same reason
   * `healthCallsFor` exists.
   */
  readonly stopCallsBySession = new Map<string, number>();
  stopDelayMs = 0;
  existing = false;
  /**
   * When set, `getPortEndpoint` answers it for any CDP port — the endpoint the
   * attach resolves (D-012). `null` keeps the default loopback address, which
   * nothing listens on; a suite driving the CDP layer points this at its own
   * stand-in Chrome, or at a dead address to force the degradation (M4-BE-07)
   * without deciding it by accident.
   *
   * "Any" rather than 9222 since D-060: a seat is a browser of its own on its
   * own port, so the turn's browser and M4's capture both dial the SEAT's
   * `cdpPort` and the machine's holds only the launch window. A fake that
   * answered 9222 alone would hand those callers a dead address and fail as a
   * missing navigation three layers away from the cause.
   */
  cdpUrl: string | null = null;
  /** Simulates a real create being slow enough for others to pile up behind it. */
  createDelayMs = 0;
  failCreateWith: Error | null = null;
  failResumeWith: Error | null = null;
  attachReturnsNull = false;
  /**
   * The host port this fake's session advertises for the agent bridge.
   *
   * Settable because a suite that actually BINDS it cannot use a fixed number:
   * 32768-32770 below are the first three ports of Linux's default ephemeral
   * range (`ip_local_port_range` is `32768 60999` on the ubuntu-latest
   * runner), so by the time a late suite calls `listen(32770)` the kernel has
   * likely handed that port to an outbound socket — a Postgres or Redis
   * connection from one of the ~90 suites before it — and the bind fails with
   * EADDRINUSE. macOS starts its ephemeral range at 49152, which is why this
   * only ever fails in CI.
   *
   * Suites that merely ASSERT the number (sandbox-lifecycle, reconciliation)
   * read it as data and keep the default. A suite that binds listens on port
   * 0, lets the kernel pick, and assigns the result here.
   */
  bridgePort = 32770;
  readonly runtimes: SandboxRuntimeObservation[] = [];
  readonly removedContainerIds: string[] = [];
  readonly workspaces = new Map<string, SandboxWorkspaceObservation>();

  // ── health (M2-BE-05) ──
  //
  // Keyed by session, not global, because the sweep walks EVERY bot's sandbox
  // and a shared database carries rows from every other suite that ran. A
  // global call counter measures those too, so it reports whatever the
  // database happens to be holding rather than what this test did.

  /** Probe count per session id. `healthCallsFor(id)` reads it. */
  readonly healthCalls = new Map<string, number>();
  /** Answer for a specific session. Unset sessions get `defaultHealth`. */
  readonly healthBySession = new Map<string, SandboxHealth>();
  /** What every sandbox this test did not name answers — i.e. other suites' rows. */
  defaultHealth: SandboxHealth = { ok: true };
  /** Sessions whose probe REJECTS: the daemon-unreachable case, not a sick sandbox. */
  readonly failHealthFor = new Set<string>();
  /** Runs inside `checkHealth` for one session, so a test can move the row mid-probe. */
  readonly onHealthProbe = new Map<string, () => Promise<void>>();

  checkHealth = async (options: { sessionId: string }): Promise<SandboxHealth> => {
    const { sessionId } = options;
    this.healthCalls.set(sessionId, (this.healthCalls.get(sessionId) ?? 0) + 1);
    await this.onHealthProbe.get(sessionId)?.();
    if (this.failHealthFor.has(sessionId)) {
      throw new Error(`connect ENOENT /var/run/docker.sock (${sessionId})`);
    }
    return this.healthBySession.get(sessionId) ?? this.defaultHealth;
  };

  healthCallsFor(sessionId: string): number {
    return this.healthCalls.get(sessionId) ?? 0;
  }

  stopCallsFor(sessionId: string): number {
    return this.stopCallsBySession.get(sessionId) ?? 0;
  }

  createSession = async (options?: { sessionId?: string }) => {
    this.createCalls += 1;
    if (this.createDelayMs > 0) await new Promise((r) => setTimeout(r, this.createDelayMs));
    if (this.failCreateWith !== null) throw this.failCreateWith;
    this.existing = true;
    return this.session(options?.sessionId ?? 'minted');
  };

  resumeSession = async (options: { sessionId: string }) => {
    this.resumeCalls += 1;
    if (this.failResumeWith !== null) throw this.failResumeWith;
    return this.session(options.sessionId);
  };

  attachSession = async (options: { sessionId: string }) => {
    this.attachCalls += 1;
    return this.attachReturnsNull || !this.existing ? null : this.session(options.sessionId);
  };

  listManagedSessions = (): Promise<readonly SandboxRuntimeObservation[]> =>
    Promise.resolve(this.runtimes.map((runtime) => ({ ...runtime })));

  removeManagedSession = (options: { containerId: string }): Promise<void> => {
    this.removedContainerIds.push(options.containerId);
    const index = this.runtimes.findIndex((runtime) => runtime.containerId === options.containerId);
    if (index >= 0) this.runtimes.splice(index, 1);
    return Promise.resolve();
  };

  inspectWorkspace = (options: { botId: string }): Promise<SandboxWorkspaceObservation> =>
    Promise.resolve(this.workspaces.get(options.botId) ?? { exists: false });

  private session(id: string): SandboxSession {
    const ports: Record<number, number> = {
      5900: 32768,
      9222: 32769,
      [SANDBOX_PORTS.bridge]: this.bridgePort,
    };
    const unsupported = () => {
      throw new Error('not exercised by the lifecycle tests');
    };
    return {
      id,
      containerId: `container-${id}`,
      screen: { widthPx: 1024, heightPx: 768 },
      defaultWorkingDirectory: '/home/bot',
      ports: [5900, 9222, 7070],
      getPortEndpoint: (o: { port: number }) =>
        Promise.resolve(
          isCdpPort(o.port) && this.cdpUrl !== null
            ? { url: this.cdpUrl }
            : { url: `http://127.0.0.1:${ports[o.port] ?? 0}` },
        ),
      getPortUrl: (o: { port: number }) =>
        Promise.resolve(`http://127.0.0.1:${ports[o.port] ?? 0}`),
      stop: async () => {
        this.stopCalls += 1;
        if (this.failStopWith) throw this.failStopWith;
        this.stopCallsBySession.set(id, (this.stopCallsBySession.get(id) ?? 0) + 1);
        if (this.stopDelayMs) await new Promise((r) => setTimeout(r, this.stopDelayMs));
        return Promise.resolve();
      },
      destroy: async () => {
        this.destroyCalls += 1;
        await this.onDestroy?.();
        if (this.failDestroyWith !== null) throw this.failDestroyWith;
        this.existing = false;
      },
      restricted: unsupported,
      description: 'fake',
      readFile: unsupported,
      readBinaryFile: unsupported,
      readTextFile: unsupported,
      writeFile: unsupported,
      writeBinaryFile: unsupported,
      writeTextFile: unsupported,
      spawn: unsupported,
      run: unsupported,
    } as unknown as SandboxSession;
  }

  /**
   * Back to a fresh sandbox with nothing created. Centralised because a field
   * added above and forgotten in one suite's `beforeEach` leaks state between
   * tests as an order-dependent failure — the worst kind to read.
   */
  reset(): void {
    this.workspaceOnFirstStart = false;
    this.failStopWith = null;
    this.provisionCalls = 0;
    this.failProvisionWith = null;
    this.onProvision = null;
    this.history.clear();
    this.destroyCalls = 0;
    this.failDestroyWith = null;
    this.onDestroy = null;
    this.createCalls = 0;
    this.resumeCalls = 0;
    this.attachCalls = 0;
    this.stopCalls = 0;
    this.stopCallsBySession.clear();
    this.healthCalls.clear();
    this.healthBySession.clear();
    this.failHealthFor.clear();
    this.onHealthProbe.clear();
    this.defaultHealth = { ok: true };
    this.stopDelayMs = 0;
    this.createDelayMs = 0;
    this.existing = false;
    this.cdpUrl = null;
    this.failCreateWith = null;
    this.failResumeWith = null;
    this.attachReturnsNull = false;
    this.runtimes.length = 0;
    this.removedContainerIds.length = 0;
    // Reset runtime counters without erasing durable storage created by bot CRUD.
  }
}

/**
 * A seat resolver for a machine that is a fake (D-046 / M5-BE-23).
 *
 * A bot's §4.3 stream is its own SEAT, and resolving one is an HTTP call into
 * the machine's agent-bridge. Every suite that opens a screen upstream over a
 * fake provider therefore needs this, the same way it already needs a fake
 * `RFB_UPSTREAM_FACTORY` — without it the upstream resolves a port nothing is
 * listening on, and the failure arrives as an `ECONNREFUSED` from a fetch
 * nobody in the test asked for. It lives here, beside `FakeProvider`, because
 * a fake machine that cannot answer for its seats is only half a fake.
 *
 * It answers with the MACHINE's own RFB port, which is the one a fake provider
 * serves: a seat's own port exists only inside a real container, and
 * `seat-docker.integration.test.ts` is where that is measured. These suites
 * test the multiplexer, the tee, the correlator and idle stop, none of which
 * care which port the picture came from.
 *
 * Declared as the members `ScreenService` actually calls rather than cast
 * through `unknown`: a method added to `SeatService` that the screen path
 * starts using should fail here at compile time, not at the first suite that
 * happens to reach it.
 */
export class FakeSeatService implements Pick<
  SeatService,
  | 'ensureSeat'
  | 'ensureBrowser'
  | 'seatFor'
  | 'assertCurrentBrowser'
  | 'releaseSeat'
  | 'prepareHuman'
  | 'publishScreenKey'
> {
  readonly ensured: Array<{ sessionId: string; botId: string }> = [];
  private readonly liveSeats = new Map<string, Seat>();
  async seatFor(sessionId: string, botId: string): Promise<Seat | null> {
    return this.liveSeats.get(`${sessionId}:${botId}`) ?? null;
  }

  async ensureSeat(
    sessionId: string,
    botId: string,
    geometry: { widthPx: number; heightPx: number },
  ): Promise<Seat> {
    this.ensured.push({ sessionId, botId });
    // D-060: a seat is a display with its own browser. `cdpPort` is what the
    // turn's browser dials, so a fake that omitted it would send every browser
    // tool to port 0 and fail as a missing navigation rather than as a seat.
    const seat = {
      seatId: `seat-${botId}`,
      browserGeneration: 1,
      profile: botId,
      identityRevision: 0,
      botId,
      display: ':10',
      rfbPort: SANDBOX_PORTS.rfb,
      cdpPort: SEAT_CDP_PORT_BASE,
      // D-061: a fake seat whose browser is already up, because the suites that
      // use this are exercising the tools rather than the lazy start.
      browserReady: true,
      widthPx: geometry.widthPx,
      heightPx: geometry.heightPx,
    };
    this.liveSeats.set(`${sessionId}:${botId}`, seat);
    return seat;
  }

  async ensureBrowser(sessionId: string, botId: string): Promise<Seat> {
    return this.ensureSeat(sessionId, botId, { widthPx: 1280, heightPx: 800 });
  }

  async assertCurrentBrowser(_sessionId: string, botId: string, opened: Seat): Promise<void> {
    if (
      opened.botId !== botId ||
      opened.seatId !== `seat-${botId}` ||
      opened.identityRevision !== 0
    ) {
      throw new Error('STALE_REFERENCE: fixture seat changed');
    }
  }

  async prepareHuman(): Promise<Awaited<ReturnType<SeatService['prepareHuman']>>> {
    return { renew: async () => undefined, release: async () => undefined };
  }

  async releaseSeat(): Promise<boolean> {
    return false;
  }

  /** D-223: every key published, as the machine's bridge would have been told. */
  readonly publishedKeys: Array<{ sessionId: string; publicKey: string; session: string }> = [];

  async publishScreenKey(
    sessionId: string,
    key: { readonly publicKey: string; readonly session: string },
  ): Promise<boolean> {
    this.publishedKeys.push({ sessionId, ...key });
    return true;
  }
}
