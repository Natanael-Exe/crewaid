import { describe, expect, it } from 'vitest';

import {
  HarnessSandboxAuthenticationError,
  SANDBOX_PORTS,
  SANDBOX_WORKING_DIRECTORY,
  SEAT_PORTS,
  SEAT_CDP_PORTS,
  SEAT_PORT_BASE,
  SEAT_PORT_COUNT,
  type ContainerProcess,
  type ContainerStatus,
  type SandboxContainer,
} from '@crewaid/sandbox-core';

import type { ContainerCreateSpec, ContainerEngine, WorkspaceVolume } from './container-engine.js';
import {
  DockerSandboxProvider,
  SANDBOX_IDENTITY_LABEL,
  SANDBOX_LABELS,
  SANDBOX_LIMITS,
  SANDBOX_MANAGED_BY,
  containerNameFor,
  readSandboxLimits,
  workspaceVolumeNameFor,
} from './docker-sandbox-provider.js';

/**
 * Every container in these fixtures carries a workspace, because every
 * container the provider creates does (D-039). A fixture without one is a
 * pre-D-039 container, and `resumeSession` is required to refuse it — so the
 * absence has to be written deliberately rather than inherited by default.
 */
const WORKSPACE_MOUNT = [
  { volume: workspaceVolumeNameFor('bot-1'), path: SANDBOX_WORKING_DIRECTORY },
] as const;

describe('sandbox resource limits', () => {
  it('keeps the default budget and disables swap for a smaller host', () => {
    expect(readSandboxLimits({})).toEqual(SANDBOX_LIMITS);
    expect(readSandboxLimits({ cpus: '2', memoryMiB: '5120' })).toMatchObject({
      cpus: 2,
      memoryBytes: 5 * 1024 ** 3,
      memorySwapBytes: 5 * 1024 ** 3,
      pidsLimit: 2048,
      dropAllCapabilities: true,
    });
  });

  it('refuses an invalid or oversized host budget', () => {
    expect(() => readSandboxLimits({ cpus: '5' })).toThrow('SANDBOX_CPUS');
    expect(() => readSandboxLimits({ cpus: '0.5' })).toThrow('SANDBOX_CPUS');
    expect(() => readSandboxLimits({ cpus: 'NaN' })).toThrow('SANDBOX_CPUS');
    expect(() => readSandboxLimits({ memoryMiB: '1024' })).toThrow('SANDBOX_MEMORY_MIB');
    expect(() => readSandboxLimits({ memoryMiB: '5120.5' })).toThrow('SANDBOX_MEMORY_MIB');
  });
});

const PUBLISHED: ContainerStatus = {
  running: true,
  exitCode: null,
  portBindings: {
    [SANDBOX_PORTS.rfb]: { host: '127.0.0.1', port: 32768 },
    [SANDBOX_PORTS.cdp]: { host: '127.0.0.1', port: 32769 },
    [SANDBOX_PORTS.bridge]: { host: '127.0.0.1', port: 32770 },
  },
  mounts: WORKSPACE_MOUNT,
  labels: {},
};

class FakeContainer implements SandboxContainer {
  readonly lifecycle: string[] = [];
  constructor(
    readonly id: string,
    private status: ContainerStatus = PUBLISHED,
  ) {}
  // Synchronous fakes, written as such — see sandbox-session.test.ts.
  start = (): Promise<void> => this.note('start');
  stop = (): Promise<void> => this.note('stop');
  remove = (): Promise<void> => this.note('remove');
  inspect = (): Promise<ContainerStatus> => Promise.resolve(this.status);
  spawn = (): Promise<ContainerProcess> =>
    Promise.reject(new Error('the provider tests never exec'));

  private note(event: string): Promise<void> {
    this.lifecycle.push(event);
    return Promise.resolve();
  }
  setStatus(status: ContainerStatus): void {
    this.status = status;
  }
}

class FakeEngine implements ContainerEngine {
  readonly retiredProfiles: Array<{ name: string; botId: string }> = [];
  retireBotProfile = (name: string, _image: string, botId: string) => {
    this.retiredProfiles.push({ name, botId });
    return Promise.resolve();
  };
  readonly history = new Map<string, number>();
  readonly markers = new Map<string, number>();
  listWorkspaceVolumes = () => Promise.resolve([...this.volumes.values()]);
  workspaceMarker = (
    name: string,
    _image: string,
    now: number,
    clear: boolean,
    history?: 'read' | 'write',
  ) => {
    if (history !== undefined) {
      if (history === 'write' && !this.history.has(name)) this.history.set(name, now);
      return Promise.resolve(this.history.get(name) ?? null);
    }
    if (clear) {
      this.markers.delete(name);
      return Promise.resolve(null);
    }
    const first = this.markers.get(name) ?? now;
    this.markers.set(name, first);
    return Promise.resolve(first);
  };
  removeWorkspaceVolume = (name: string) => {
    this.volumes.delete(name);
    return Promise.resolve();
  };
  readonly networks: string[] = [];
  readonly created: ContainerCreateSpec[] = [];
  /** Workspace volumes the daemon would report, keyed by name. */
  readonly volumes = new Map<string, WorkspaceVolume>();
  readonly volumesCreated: string[] = [];
  existing: SandboxContainer | null = null;
  readonly managed: SandboxContainer[] = [];
  nextContainer: FakeContainer = new FakeContainer('container-new');
  /** Typed as an Error so the fake throws what a real failure would. */
  createError: (Error & { code?: string }) | null = null;

  ensureNetwork = (name: string): Promise<void> => {
    this.networks.push(name);
    return Promise.resolve();
  };

  create = (spec: ContainerCreateSpec): Promise<SandboxContainer> => {
    if (this.createError !== null) return Promise.reject(this.createError);
    this.created.push(spec);
    return Promise.resolve(this.nextContainer);
  };

  findByLabel = (): Promise<SandboxContainer | null> => Promise.resolve(this.existing);

  listByLabel = (): Promise<readonly SandboxContainer[]> => Promise.resolve(this.managed);

  listByVolume = (): Promise<readonly SandboxContainer[]> => Promise.resolve(this.managed);

  findById = (id: string): Promise<SandboxContainer | null> =>
    Promise.resolve(
      this.managed.find((container) => container.id === id) ??
        (this.existing?.id === id ? this.existing : null),
    );

  findVolume = (name: string): Promise<WorkspaceVolume | null> =>
    Promise.resolve(this.volumes.get(name) ?? null);

  createVolume = (spec: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  }): Promise<WorkspaceVolume> => {
    this.volumesCreated.push(spec.name);
    const volume: WorkspaceVolume = { name: spec.name, labels: { ...spec.labels } };
    this.volumes.set(spec.name, volume);
    return Promise.resolve(volume);
  };

  /** A workspace that already exists, as a replacement-from-saved-workspace would find. */
  seedWorkspace(botId: string, labels?: Record<string, string>): WorkspaceVolume {
    const volume: WorkspaceVolume = {
      name: workspaceVolumeNameFor(botId),
      labels: labels ?? {
        [SANDBOX_LABELS.botId]: botId,
        [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
      },
    };
    this.volumes.set(volume.name, volume);
    return volume;
  }
}

function providerOver(
  engine: ContainerEngine,
  bridgeProbe: (baseUrl: string) => Promise<boolean> = () => Promise.resolve(true),
): DockerSandboxProvider {
  return new DockerSandboxProvider({
    engine,
    image: 'crewaid/sandbox:test',
    network: 'agent-net',
    screen: { widthPx: 1280, heightPx: 800 },
    readyTimeoutMs: 200,
    bridgeProbe,
  });
}

describe('the provider contract', () => {
  it('retains orphaned workspaces for the full grace period across provider restarts', async () => {
    const engine = new FakeEngine();
    const workspace = engine.seedWorkspace('retention-bot');
    const options = { botId: 'retention-bot', orphaned: true, now: 1_000_000, retentionMs: 1000 };
    expect(await providerOver(engine).retainWorkspace(options)).toBe('retained');
    expect(await providerOver(engine).retainWorkspace({ ...options, now: options.now + 999 })).toBe(
      'retained',
    );
    expect(engine.volumes.has(workspace.name)).toBe(true);
    expect(
      await providerOver(engine).retainWorkspace({ ...options, now: options.now + 1000 }),
    ).toBe('deleted');
    expect(await providerOver(engine).retainWorkspace(options)).toBe('absent');
  });

  it('clears the orphan clock for a restored bot and starts a fresh grace period', async () => {
    const engine = new FakeEngine();
    engine.seedWorkspace('restored-bot');
    const provider = providerOver(engine);
    const options = { botId: 'restored-bot', orphaned: true, now: 1000, retentionMs: 100 };
    await provider.retainWorkspace(options);
    await provider.retainWorkspace({ ...options, orphaned: false, now: 1200 });
    expect(await provider.retainWorkspace({ ...options, now: 1300 })).toBe('retained');
    expect(engine.markers.get(workspaceVolumeNameFor(options.botId))).toBe(1300);
  });

  it('never reaps a referenced volume or one with mismatched ownership labels', async () => {
    const engine = new FakeEngine();
    engine.seedWorkspace('protected');
    engine.managed.push(new FakeContainer('stopped-reference'));
    const options = { botId: 'protected', orphaned: true, now: 1000, retentionMs: 1 };
    expect(await providerOver(engine).retainWorkspace(options)).toBe('in-use');
    engine.managed.length = 0;
    engine.seedWorkspace('protected', { [SANDBOX_LABELS.botId]: 'another-bot' });
    await expect(providerOver(engine).retainWorkspace(options)).rejects.toThrow();
    expect(await providerOver(engine).listWorkspaces()).toEqual([]);
  });
  it('declares the harness-sandbox-v1 specification', () => {
    const provider = providerOver(new FakeEngine());
    expect(provider.specificationVersion).toBe('harness-sandbox-v1');
    expect(provider.providerId).toBe('crewaid-docker');
  });

  it('omits setNetworkPolicy and setPorts, so callers must use optional-call', async () => {
    // Both need capabilities §5.1 drops. Implementing them as no-ops would let
    // a caller believe §7.3's egress policy had been applied when the real
    // mechanism is iptables on agent-net (M2-BE-09).
    const session = await providerOver(new FakeEngine()).createSession({ sessionId: 's1' });
    expect(session).not.toHaveProperty('setNetworkPolicy');
    expect(session).not.toHaveProperty('setPorts');
  });
});

describe('createSession', () => {
  it('queues profile retirement only in the owning computer workspace', async () => {
    const engine = new FakeEngine();
    const provider = providerOver(engine);
    await provider.provisionWorkspace({ botId: 'computer-1' });
    await provider.retireBotProfile({ computerId: 'computer-1', botId: 'bot-a' });
    expect(engine.retiredProfiles).toEqual([
      { name: workspaceVolumeNameFor('computer-1'), botId: 'bot-a' },
    ]);
    await expect(
      provider.retireBotProfile({ computerId: 'missing', botId: 'bot-a' }),
    ).rejects.toThrow();
    await expect(
      provider.retireBotProfile({ computerId: 'computer-1', botId: '../escape' }),
    ).rejects.toThrow();
    expect(engine.retiredProfiles).toHaveLength(1);
  });

  it('applies the §5.1 constraints as D-063 sizes them', async () => {
    const engine = new FakeEngine();
    await providerOver(engine).createSession({ sessionId: 's1' });

    expect(engine.created[0]?.limits).toEqual({
      memoryBytes: 8 * 1024 ** 3,
      memorySwapBytes: 8 * 1024 ** 3,
      cpus: 4.0,
      pidsLimit: 2048,
      noNewPrivileges: true,
      dropAllCapabilities: true,
      allowBrowserSandbox: true,
      shmSizeBytes: 512 * 1024 ** 2,
    });
    expect(SANDBOX_LIMITS.memorySwapBytes).toBe(SANDBOX_LIMITS.memoryBytes); // swap disabled
  });

  it('creates the sandbox bridge before the container', async () => {
    const engine = new FakeEngine();
    await providerOver(engine).createSession({ sessionId: 's1' });
    expect(engine.networks).toEqual(['agent-net']);
    expect(engine.created[0]?.network).toBe('agent-net');
  });

  it('labels the container with its session id', async () => {
    // M2-QA-02 counts this bot's containers while other tests create their own
    // from the same image, so ownership has to be a label rather than the image
    // name or creation order.
    const engine = new FakeEngine();
    await providerOver(engine).createSession({ sessionId: 's1' });
    expect(engine.created[0]?.labels[SANDBOX_LABELS.sessionId]).toBe('s1');
    expect(engine.created[0]?.labels[SANDBOX_LABELS.managedBy]).toBe('crewaid-orchestrator');
  });

  it('publishes the three §5 ports and the whole seat range', async () => {
    // D-046 / M5-BE-23: the seat ports travel with the machine's own because
    // a container publishes its ports at CREATION and `setPorts` is
    // deliberately not implemented. A seat opened later has nowhere to be
    // reached unless its port was published before any seat existed, so the
    // range is the machine's ceiling on concurrent seats and it is fixed for
    // the machine's life.
    const engine = new FakeEngine();
    await providerOver(engine).createSession({ sessionId: 's1' });

    expect(engine.created[0]?.publishPorts).toEqual([
      5900,
      9222,
      7070,
      ...SEAT_PORTS,
      ...SEAT_CDP_PORTS,
    ]);
    expect(SEAT_PORTS).toHaveLength(SEAT_PORT_COUNT);
    expect(SEAT_PORTS[0]).toBe(SEAT_PORT_BASE);
    // Sixteen stays the seat ceiling after D-063 raised the memory it was read
    // against: a desktop-only seat costs ~440 MB, so 8 GiB would carry more
    // than sixteen and the PORTS refuse the seventeenth first; a browsing seat
    // adds a ~350 MB browser, so once enough of them browse, memory binds
    // first again. Whichever binds, it is admission that refuses, not a crash.
    expect(SEAT_PORT_COUNT).toBe(16);
    expect(SEAT_CDP_PORTS).toEqual(Array.from({ length: 16 }, (_, i) => 9301 + i));
  });

  it('refuses a second create for a live session instead of returning it', async () => {
    // Quietly handing back the existing sandbox would hide a caller lifecycle
    // bug until two callers believed they owned the same desktop. Reattaching
    // is what resumeSession is for.
    const engine = new FakeEngine();
    engine.existing = new FakeContainer('container-live');

    await expect(providerOver(engine).createSession({ sessionId: 's1' })).rejects.toThrow(
      /already exists as container container-live.*resumeSession/s,
    );
  });

  it('hands onFirstCreate the reduced view, never the network session (R4)', async () => {
    const engine = new FakeEngine();
    let received: unknown = null;

    await providerOver(engine).createSession({
      sessionId: 's1',
      onFirstCreate: (session) => {
        received = session;
        return Promise.resolve();
      },
    });

    expect(received).not.toBeNull();
    expect(received).not.toHaveProperty('destroy');
    expect(received).not.toHaveProperty('getPortEndpoint');
    expect(received).toHaveProperty('run');
  });

  it('reports the entrypoint exit contract when the desktop dies during start', async () => {
    // The image exits non-zero when any supervised process dies (M2-IN-03).
    // Timing out on "ports were not published" would describe the symptom and
    // hide the cause.
    const engine = new FakeEngine();
    engine.nextContainer = new FakeContainer('container-dead', {
      running: false,
      exitCode: 1,
      portBindings: {},
      mounts: WORKSPACE_MOUNT,
      labels: {},
    });

    await expect(providerOver(engine).createSession({ sessionId: 's1' })).rejects.toThrow(
      /exited during start \(exit 1\).*supervised process/s,
    );
  });

  it('times out rather than hanging when ports never appear', async () => {
    const engine = new FakeEngine();
    engine.nextContainer = new FakeContainer('container-slow', {
      running: true,
      exitCode: null,
      portBindings: {},
      mounts: WORKSPACE_MOUNT,
      labels: {},
    });

    await expect(providerOver(engine).createSession({ sessionId: 's1' })).rejects.toThrow(
      /ports were not published within 200ms/,
    );
  });

  it('waits for the bridge, not merely for Docker to map the ports', async () => {
    // Docker publishes a mapping the instant the container starts, roughly two
    // seconds before anything listens behind it. Returning there hands the
    // caller a session that resolves every port and refuses every connection.
    const engine = new FakeEngine();
    const probed: string[] = [];
    let healthy = false;
    const provider = providerOver(engine, (url) => {
      probed.push(url);
      const answer = healthy;
      healthy = true; // ready on the second poll, as a real desktop is
      return Promise.resolve(answer);
    });

    await provider.createSession({ sessionId: 's1' });

    expect(probed.length).toBeGreaterThan(1);
    expect(probed[0]).toBe('http://127.0.0.1:32770'); // the bridge port, 7070
  });

  it('reports an unhealthy bridge distinctly from a dead container', async () => {
    // Both mean "not usable", but one says read the container log and the
    // other says the container is already gone.
    const engine = new FakeEngine();
    await expect(
      providerOver(engine, () => Promise.resolve(false)).createSession({ sessionId: 's1' }),
    ).rejects.toThrow(/agent-bridge at http:\/\/127\.0\.0\.1:32770 did not report healthy/);
  });

  it('removes a newly created container when initialization fails', async () => {
    const engine = new FakeEngine();
    await expect(
      providerOver(engine).createSession({
        sessionId: 's1',
        onFirstCreate: () => Promise.reject(new Error('initialization failed')),
      }),
    ).rejects.toThrow('initialization failed');
    expect(engine.nextContainer.lifecycle).toEqual(['start', 'remove']);
  });

  it('removes a newly created container when readiness times out', async () => {
    const engine = new FakeEngine();
    await expect(
      providerOver(engine, () => Promise.resolve(false)).createSession({
        sessionId: 's1',
      }),
    ).rejects.toThrow(/did not report healthy/);
    expect(engine.nextContainer.lifecycle).toEqual(['start', 'remove']);
  });

  it('does not create anything for an already aborted request', async () => {
    const engine = new FakeEngine();
    await expect(
      providerOver(engine).createSession({
        abortSignal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(engine.created).toEqual([]);
    expect(engine.networks).toEqual([]);
  });

  it('mints a session id when the caller does not supply one', async () => {
    // Prewarm paths call createSession with nothing.
    const session = await providerOver(new FakeEngine()).createSession();
    expect(session.id).toMatch(/^crewaid-[0-9a-f-]{36}$/);
  });
});

describe('the durable workspace (M2-BE-10, D-039)', () => {
  it('provisions twelve workspaces idempotently without desktop creation or networking', async () => {
    const engine = new FakeEngine();
    const provider = providerOver(engine);
    for (let i = 0; i < 12; i++) {
      const botId = `provision-${i}`;
      await provider.provisionWorkspace({ botId });
      await provider.provisionWorkspace({ botId });
      expect(await provider.inspectWorkspaceHistory({ botId })).toEqual({
        referenced: false,
        runtimeCreatedAt: null,
      });
    }
    expect(engine.volumes.size).toBe(12);
    expect(engine.volumesCreated).toHaveLength(12);
    expect(engine.created).toEqual([]);
    expect(engine.networks).toEqual([]);
    expect(engine.history.size).toBe(0);
  });

  it('refuses a missing workspace during runtime creation instead of replacing its bytes', async () => {
    const engine = new FakeEngine();
    const provider = providerOver(engine);
    await provider.provisionWorkspace({ botId: 'bot-1' });
    engine.volumes.delete(workspaceVolumeNameFor('bot-1'));
    await expect(
      provider.createSession({
        sessionId: 'bot-1',
        identity: 'bot-1',
        requireExistingWorkspace: true,
      }),
    ).rejects.toThrow('refusing to recreate');
    expect(engine.volumesCreated).toHaveLength(1);
    expect(engine.created).toEqual([]);
  });

  it('never adopts another bot volume during provisioning', async () => {
    const engine = new FakeEngine();
    engine.seedWorkspace('bot-1', {
      'crewaid.botId': 'other',
      'crewaid.managedBy': SANDBOX_MANAGED_BY,
    });
    await expect(providerOver(engine).provisionWorkspace({ botId: 'bot-1' })).rejects.toThrow(
      'not owned',
    );
    expect(engine.markers.size).toBe(0);
    expect(engine.created).toEqual([]);
  });

  it('records runtime history before startup and preserves it after failed readiness', async () => {
    const engine = new FakeEngine();
    engine.nextContainer.start = () => {
      expect(engine.history.has(workspaceVolumeNameFor('bot-1'))).toBe(true);
      return Promise.reject(new Error('start failed'));
    };
    const provider = providerOver(engine);
    await provider.provisionWorkspace({ botId: 'bot-1' });
    await expect(provider.createSession({ sessionId: 'bot-1', identity: 'bot-1' })).rejects.toThrow(
      'start failed',
    );
    expect(
      (await provider.inspectWorkspaceHistory({ botId: 'bot-1' })).runtimeCreatedAt,
    ).toBeGreaterThan(0);
    expect(engine.volumes.size).toBe(1);
  });
  it('creates a workspace volume for a bot that has never had one', async () => {
    const engine = new FakeEngine();

    await providerOver(engine).createSession({ sessionId: 'bot-1', identity: 'bot-1' });

    expect(engine.volumesCreated).toEqual([workspaceVolumeNameFor('bot-1')]);
    expect(engine.volumes.get(workspaceVolumeNameFor('bot-1'))?.labels).toEqual({
      [SANDBOX_LABELS.botId]: 'bot-1',
      [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
    });
  });

  it('mounts the workspace at the desktop home, as a volume and never a bind', async () => {
    const engine = new FakeEngine();

    await providerOver(engine).createSession({ sessionId: 'bot-1', identity: 'bot-1' });

    expect(engine.created[0]?.mounts).toEqual([
      { volume: workspaceVolumeNameFor('bot-1'), path: SANDBOX_WORKING_DIRECTORY },
    ]);
  });

  it('adopts the saved workspace instead of creating a second one', async () => {
    // D-039 §4, "replacement from saved workspace": the container is gone but
    // the bot's files are not. This is the path that makes losing a container
    // survivable, and creating a fresh volume here is exactly the silent
    // empty-desktop failure D-031 was written against.
    const engine = new FakeEngine();
    engine.seedWorkspace('bot-1');

    await providerOver(engine).createSession({ sessionId: 'bot-1', identity: 'bot-1' });

    expect(engine.volumesCreated).toEqual([]);
    expect(engine.created[0]?.mounts).toEqual([
      { volume: workspaceVolumeNameFor('bot-1'), path: SANDBOX_WORKING_DIRECTORY },
    ]);
  });

  it('refuses a workspace labelled for a different bot', async () => {
    // The worst failure available in this design: silent, and it leaks one
    // bot's files — and its logged-in browser sessions — into another's
    // desktop. The name matching is not evidence of ownership; the label is.
    const engine = new FakeEngine();
    engine.volumes.set(workspaceVolumeNameFor('bot-1'), {
      name: workspaceVolumeNameFor('bot-1'),
      labels: {
        [SANDBOX_LABELS.botId]: 'bot-2',
        [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
      },
    });

    await expect(
      providerOver(engine).createSession({ sessionId: 'bot-1', identity: 'bot-1' }),
    ).rejects.toThrow(/not owned by bot-1/);
    expect(engine.created).toEqual([]);
  });

  it('refuses a volume that carries our name but is not ours', async () => {
    // An operator's own `docker volume create crewaid-workspace-bot-1` has the
    // right name and none of the provenance.
    const engine = new FakeEngine();
    engine.volumes.set(workspaceVolumeNameFor('bot-1'), {
      name: workspaceVolumeNameFor('bot-1'),
      labels: {},
    });

    await expect(
      providerOver(engine).createSession({ sessionId: 'bot-1', identity: 'bot-1' }),
    ).rejects.toThrow(/crewaid.managedBy=unset/);
    expect(engine.created).toEqual([]);
  });

  it('revalidates the volume returned by create when another actor wins the race', async () => {
    // Docker's create-volume endpoint is idempotent on the name. If a foreign
    // volume appears after findVolume reports absent, createVolume returns that
    // existing volume rather than one carrying the labels we requested.
    const engine = new FakeEngine();
    engine.createVolume = (spec) =>
      Promise.resolve({
        name: spec.name,
        labels: {
          [SANDBOX_LABELS.botId]: 'bot-2',
          [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
        },
      });

    await expect(
      providerOver(engine).createSession({ sessionId: 'bot-1', identity: 'bot-1' }),
    ).rejects.toThrow(/not owned by bot-1/);
    expect(engine.created).toEqual([]);
  });

  it('gives a session with no identity no durable storage at all', async () => {
    // Deliberately explicit rather than defaulting to the session id: a
    // workspace minted under a name nothing will look for again is worse than
    // none, because it consumes disk and looks like it worked.
    const engine = new FakeEngine();

    await providerOver(engine).createSession({ sessionId: 'anonymous' });

    expect(engine.volumesCreated).toEqual([]);
    expect(engine.created[0]?.mounts).toEqual([]);
  });

  it('resolves the workspace before creating the container, not after', async () => {
    // A container that came up without its workspace is a working-looking
    // desktop with none of the bot's history. Failing first costs a start.
    const engine = new FakeEngine();
    engine.volumes.set(workspaceVolumeNameFor('bot-1'), {
      name: workspaceVolumeNameFor('bot-1'),
      labels: { [SANDBOX_LABELS.botId]: 'someone-else' },
    });

    await expect(
      providerOver(engine).createSession({ sessionId: 'bot-1', identity: 'bot-1' }),
    ).rejects.toThrow();

    expect(engine.created).toEqual([]);
    expect(engine.nextContainer.lifecycle).toEqual([]);
  });

  it('refuses to resume a bot container that has no workspace mounted', async () => {
    // Every container created before D-039 is in this state. Resuming one
    // hands the bot a desktop whose files die with the container, and nothing
    // about it looks wrong until the day the container is replaced.
    const engine = new FakeEngine();
    engine.existing = new FakeContainer('container-legacy', {
      running: true,
      exitCode: null,
      portBindings: {},
      mounts: [],
      labels: { [SANDBOX_IDENTITY_LABEL]: 'bot-1' },
    });

    await expect(providerOver(engine).resumeSession({ sessionId: 'bot-1' })).rejects.toThrow(
      /belongs to bot-1 but has no workspace mounted/,
    );
  });

  it('resumes an identity-less container that never had a workspace', async () => {
    // The other half of the same rule, and the reason it is keyed on the
    // identity label: a session created without an identity is ephemeral on
    // purpose. Refusing it would be the guard firing on the one case it was
    // never aimed at — which is exactly what the first version of it did.
    const engine = new FakeEngine();
    engine.existing = new FakeContainer('container-ephemeral', {
      running: true,
      exitCode: null,
      portBindings: {
        [SANDBOX_PORTS.rfb]: { host: '127.0.0.1', port: 32768 },
        [SANDBOX_PORTS.cdp]: { host: '127.0.0.1', port: 32769 },
        [SANDBOX_PORTS.bridge]: { host: '127.0.0.1', port: 32770 },
      },
      mounts: [],
      labels: {},
    });

    await expect(
      providerOver(engine).resumeSession({ sessionId: 'anonymous' }),
    ).resolves.toBeDefined();
  });

  it("refuses to resume a bot container mounting another bot's workspace", async () => {
    const engine = new FakeEngine();
    const container = new FakeContainer('container-cross-bot', {
      running: false,
      exitCode: 0,
      portBindings: {},
      mounts: [{ volume: workspaceVolumeNameFor('bot-2'), path: SANDBOX_WORKING_DIRECTORY }],
      labels: { [SANDBOX_IDENTITY_LABEL]: 'bot-1' },
    });
    engine.existing = container;

    await expect(providerOver(engine).resumeSession({ sessionId: 'bot-1' })).rejects.toThrow(
      /mounts workspace volume crewaid-workspace-bot-2.*expected crewaid-workspace-bot-1/s,
    );
    expect(container.lifecycle).toEqual([]);
  });

  it('revalidates the mounted workspace ownership before resuming', async () => {
    const engine = new FakeEngine();
    const container = new FakeContainer('container-relabelled', {
      running: false,
      exitCode: 0,
      portBindings: {},
      mounts: WORKSPACE_MOUNT,
      labels: { [SANDBOX_IDENTITY_LABEL]: 'bot-1' },
    });
    engine.existing = container;
    engine.seedWorkspace('bot-1', {
      [SANDBOX_LABELS.botId]: 'bot-2',
      [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
    });

    await expect(providerOver(engine).resumeSession({ sessionId: 'bot-1' })).rejects.toThrow(
      /not owned by bot-1/,
    );
    expect(container.lifecycle).toEqual([]);
  });

  it('resumes a bot container only after validating its mounted workspace', async () => {
    const engine = new FakeEngine();
    engine.existing = new FakeContainer('container-owned', {
      ...PUBLISHED,
      labels: { [SANDBOX_IDENTITY_LABEL]: 'bot-1' },
    });
    engine.seedWorkspace('bot-1');

    await expect(providerOver(engine).resumeSession({ sessionId: 'bot-1' })).resolves.toBeDefined();
  });
});

describe('attachSession', () => {
  it('returns a stopped container handle without starting or probing it', async () => {
    const engine = new FakeEngine();
    const container = new FakeContainer('container-existing', {
      running: false,
      exitCode: 0,
      portBindings: {},
      mounts: WORKSPACE_MOUNT,
      labels: {},
    });
    engine.existing = container;
    const provider = providerOver(engine, () => Promise.reject(new Error('must not probe')));
    const session = await provider.attachSession({ sessionId: 's1' });
    expect(session?.id).toBe('s1');
    expect(session?.containerId).toBe('container-existing');
    expect(container.lifecycle).toEqual([]);
    await session?.stop();
    expect(container.lifecycle).toEqual(['stop']);
  });

  it('returns null when the container is absent', async () => {
    await expect(
      providerOver(new FakeEngine()).attachSession({ sessionId: 'missing' }),
    ).resolves.toBeNull();
  });
});

describe('runtime reconciliation inventory (M2-BE-12)', () => {
  it('reports identity, state, and independently validated workspace ownership', async () => {
    const engine = new FakeEngine();
    engine.seedWorkspace('bot-1');
    engine.managed.push(
      new FakeContainer('container-bot-1', {
        ...PUBLISHED,
        labels: {
          [SANDBOX_LABELS.sessionId]: 'session-1',
          [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
          [SANDBOX_IDENTITY_LABEL]: 'bot-1',
        },
      }),
    );

    await expect(providerOver(engine).listManagedSessions()).resolves.toEqual([
      {
        containerId: 'container-bot-1',
        sessionId: 'session-1',
        botId: 'bot-1',
        running: true,
        workspace: { ok: true, volumeName: workspaceVolumeNameFor('bot-1') },
      },
    ]);
  });

  it('reports an inconsistent runtime without creating or replacing its workspace', async () => {
    const engine = new FakeEngine();
    engine.managed.push(
      new FakeContainer('container-no-workspace', {
        ...PUBLISHED,
        mounts: [],
        labels: {
          [SANDBOX_LABELS.sessionId]: 'bot-1',
          [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
          [SANDBOX_IDENTITY_LABEL]: 'bot-1',
        },
      }),
    );

    const [runtime] = await providerOver(engine).listManagedSessions();
    expect(runtime?.workspace).toEqual({
      ok: false,
      reason: 'bot runtime has no workspace mounted at /home/bot',
    });
    expect(engine.volumesCreated).toEqual([]);
  });

  it('removes exactly the observed managed container and never asks for a volume operation', async () => {
    const engine = new FakeEngine();
    const orphan = new FakeContainer('container-orphan', {
      ...PUBLISHED,
      labels: { [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY },
    });
    engine.managed.push(orphan);

    await providerOver(engine).removeManagedSession({ containerId: orphan.id });

    expect(orphan.lifecycle).toEqual(['stop', 'remove']);
    expect(engine.volumesCreated).toEqual([]);
  });

  it('refuses to remove a container whose ownership label changed after inventory', async () => {
    const engine = new FakeEngine();
    const foreign = new FakeContainer('container-foreign', { ...PUBLISHED, labels: {} });
    engine.managed.push(foreign);

    await expect(
      providerOver(engine).removeManagedSession({ containerId: foreign.id }),
    ).rejects.toThrow(/not managed by crewaid-orchestrator/);
    expect(foreign.lifecycle).toEqual([]);
  });
});

describe('resumeSession', () => {
  it('reattaches without restarting a container that is still running', async () => {
    // M2-QA-03 asserts the desktop is unchanged across an orchestrator restart.
    // A restart would pass "same container id" while losing every window the
    // bot had open.
    const engine = new FakeEngine();
    const running = new FakeContainer('container-live');
    engine.existing = running;

    const session = await providerOver(engine).resumeSession({ sessionId: 's1' });

    expect(running.lifecycle).not.toContain('start');
    expect(session.id).toBe('s1');
  });

  it('starts a container that was stopped', async () => {
    const engine = new FakeEngine();
    const stopped = new FakeContainer('container-stopped', {
      running: false,
      exitCode: 0,
      portBindings: {},
      mounts: WORKSPACE_MOUNT,
      labels: {},
    });
    engine.existing = stopped;
    // Once started it publishes its ports, the same as a real container does.
    stopped.start = () => {
      stopped.lifecycle.push('start');
      stopped.setStatus(PUBLISHED);
      return Promise.resolve();
    };

    await providerOver(engine).resumeSession({ sessionId: 's1' });
    expect(stopped.lifecycle).toEqual(['start']);
  });

  it('throws when no container carries the label, leaving the fallback to the caller', async () => {
    // The caller is the one that knows whether a missing container means
    // "create a fresh one" or "something removed a desktop we thought we had".
    const engine = new FakeEngine();
    engine.existing = null;

    await expect(providerOver(engine).resumeSession({ sessionId: 's1' })).rejects.toThrow(
      /no container carries crewaid\.sessionId=s1/,
    );
  });

  it('refuses to resume while an unrecorded running container mounts the workspace', async () => {
    const engine = new FakeEngine();
    engine.seedWorkspace('bot-1');
    const selected = new FakeContainer('container-selected', {
      ...PUBLISHED,
      labels: {
        [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
        [SANDBOX_IDENTITY_LABEL]: 'bot-1',
      },
    });
    const unrecorded = new FakeContainer('container-unrecorded', {
      ...PUBLISHED,
      // Even a malformed/unmanaged writer is still a writer. The mounted
      // volume, not our label, is the exclusivity evidence.
      labels: {},
    });
    engine.existing = selected;
    engine.managed.push(selected, unrecorded);

    await expect(providerOver(engine).resumeSession({ sessionId: 'bot-1' })).rejects.toThrow(
      /already mounted by running container container-unrecorded/,
    );
  });
});

describe('exclusive workspace writer (M2-BE-12, D-039 §5)', () => {
  it('refuses creation while an unrecorded running container mounts the workspace', async () => {
    const engine = new FakeEngine();
    engine.seedWorkspace('bot-1');
    engine.managed.push(
      new FakeContainer('container-unrecorded', {
        ...PUBLISHED,
        labels: {},
      }),
    );

    await expect(
      providerOver(engine).createSession({ sessionId: 'new-session', identity: 'bot-1' }),
    ).rejects.toThrow(/already mounted by running container container-unrecorded/);
    expect(engine.created).toEqual([]);
  });
});

describe('checkHealth (M2-BE-05)', () => {
  it('reports a healthy sandbox when the container runs and the bridge answers', async () => {
    const engine = new FakeEngine();
    engine.existing = new FakeContainer('container-live');

    await expect(providerOver(engine).checkHealth({ sessionId: 'bot-1' })).resolves.toEqual({
      ok: true,
    });
  });

  it('answers rather than throws when no container carries the session', async () => {
    // Gone entirely, deliberately NOT reported as stopped: D-031 requires a
    // missing runtime to surface as a recoverable error, so that a later start
    // cannot quietly replace a lost desktop with an empty one.
    const engine = new FakeEngine();
    engine.existing = null;

    const health = await providerOver(engine).checkHealth({ sessionId: 'bot-1' });
    expect(health.ok).toBe(false);
    expect(health.ok === false && health.reason).toContain(SANDBOX_LABELS.sessionId);
  });

  it('names the exit code when the container is present but not running', async () => {
    // The `docker kill` case M2-QA-04 drives. Probing the bridge alone would
    // report this as "unreachable" and lose the exit code, which is the part
    // that says what happened.
    const engine = new FakeEngine();
    engine.existing = new FakeContainer('container-dead', {
      running: false,
      exitCode: 137,
      portBindings: {},
      mounts: WORKSPACE_MOUNT,
      labels: {},
    });

    const health = await providerOver(engine).checkHealth({ sessionId: 'bot-1' });
    expect(health.ok).toBe(false);
    expect(health.ok === false && health.reason).toContain('exit 137');
  });

  it('is unhealthy when the container runs but publishes no bridge port', async () => {
    const engine = new FakeEngine();
    engine.existing = new FakeContainer('container-unbound', {
      running: true,
      exitCode: null,
      portBindings: {},
      mounts: WORKSPACE_MOUNT,
      labels: {},
    });

    const health = await providerOver(engine).checkHealth({ sessionId: 'bot-1' });
    expect(health.ok).toBe(false);
    expect(health.ok === false && health.reason).toContain(String(SANDBOX_PORTS.bridge));
  });

  it('is unhealthy, with the address, when the bridge does not report healthy', async () => {
    const engine = new FakeEngine();
    engine.existing = new FakeContainer('container-wedged');

    const health = await providerOver(engine, () => Promise.resolve(false)).checkHealth({
      sessionId: 'bot-1',
    });
    expect(health.ok).toBe(false);
    expect(health.ok === false && health.reason).toContain('127.0.0.1:32770');
  });

  it.each([1, 2])(
    'reports a container removed during inspection %i as unhealthy',
    async (failureAt) => {
      const engine = new FakeEngine();
      const container = new FakeContainer('container-removed');
      engine.existing = container;
      let inspections = 0;
      container.inspect = () => {
        inspections += 1;
        return inspections === failureAt
          ? Promise.reject(Object.assign(new Error('no such container'), { statusCode: 404 }))
          : Promise.resolve(PUBLISHED);
      };

      await expect(providerOver(engine).checkHealth({ sessionId: 'bot-1' })).resolves.toEqual({
        ok: false,
        reason: 'container container-removed no longer exists',
      });
    },
  );

  it('rejects a daemon failure during endpoint lookup instead of reporting a missing port', async () => {
    const engine = new FakeEngine();
    const container = new FakeContainer('container-live');
    engine.existing = container;
    let inspections = 0;
    container.inspect = () => {
      inspections += 1;
      return inspections === 1
        ? Promise.resolve(PUBLISHED)
        : Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    };

    await expect(providerOver(engine).checkHealth({ sessionId: 'bot-1' })).rejects.toBeInstanceOf(
      HarnessSandboxAuthenticationError,
    );
  });

  it('rejects when the daemon itself cannot be reached', async () => {
    // The one case that must NOT be an answer. A poller reads a rejection as
    // "no evidence about this sandbox" and leaves the row alone; folding it
    // into `ok: false` would flip every bot to UNHEALTHY on one Docker hiccup.
    const engine = new FakeEngine();
    const denied: Error & { code?: string } = new Error('permission denied');
    denied.code = 'EACCES';
    engine.findByLabel = () => Promise.reject(denied);

    await expect(providerOver(engine).checkHealth({ sessionId: 'bot-1' })).rejects.toBeInstanceOf(
      HarnessSandboxAuthenticationError,
    );
  });
});

describe('error mapping', () => {
  it('reports a refused daemon as an authentication failure, not an outage', async () => {
    // The harness has a distinct error for this so a framework integration can
    // tell a misconfiguration from Docker being down. They have different fixes.
    const engine = new FakeEngine();
    engine.createError = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    await expect(providerOver(engine).createSession({ sessionId: 's1' })).rejects.toBeInstanceOf(
      HarnessSandboxAuthenticationError,
    );
  });

  it('keeps other docker failures as plain harness errors', async () => {
    const engine = new FakeEngine();
    engine.createError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    await expect(
      providerOver(engine).createSession({ sessionId: 's1' }),
    ).rejects.not.toBeInstanceOf(HarnessSandboxAuthenticationError);
  });
});

describe('container naming', () => {
  it('is deterministic, so resume finds the same resource', () => {
    expect(containerNameFor('bot-7')).toBe('crewaid-sandbox-bot-7');
    expect(containerNameFor('bot-7')).toBe(containerNameFor('bot-7'));
  });

  it('sanitises a session id Docker would reject', () => {
    // The harness places no constraint on sessionId. Without this the failure
    // surfaces as a create error three layers from the id that caused it.
    expect(containerNameFor('a/b:c d')).toBe('crewaid-sandbox-a-b-c-d');
  });
});
