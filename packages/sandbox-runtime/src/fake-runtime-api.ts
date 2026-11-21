/**
 * An in-memory Runtime behind the `RuntimeApi` port, for the provider's tests.
 *
 * Sandboxes are plain records. A tunnel's `forward` opens a real loopback
 * listener that pipes each connection to `ports.get(port)` on 127.0.0.1, so
 * tests move real bytes; pausing or deleting a sandbox ends its tunnels the
 * way Runtime's host does, destroying the connections under them.
 */

import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import {
  RuntimeApiError,
  type RuntimeApi,
  type RuntimeExecResult,
  type RuntimeForward,
  type RuntimeImage,
  type RuntimeMachine,
  type RuntimeMachineSpec,
  type RuntimeMachineState,
  type RuntimeSharedPort,
  type RuntimeSnapshot,
  type RuntimeTunnel,
} from './runtime-client.js';

export interface FakeSnapshot {
  id: string;
  name: string | null;
  state: 'capturing' | 'ready' | 'failed';
  backedUp: boolean;
  backupFailed: boolean;
  labels: Record<string, string>;
  sourceId: string;
  /** What the machine held when it was taken, and its state then. */
  files: Map<string, string>;
  imageId: string | null;
  vcpu: number;
  memoryMiB: number;
  diskMiB: number;
  createdAt: number;
}

export interface FakeMachine {
  id: string;
  name: string;
  state: RuntimeMachineState;
  labels: Record<string, string>;
  spec: RuntimeMachineSpec | null;
  keptWhilePaused: boolean;
  /** The image version it runs; null for one added without saying. */
  imageId: string | null;
  vcpu: number;
  memoryMiB: number;
  diskMiB: number;
  files: Map<string, string>;
}

export interface FakeExecCall {
  readonly machineId: string;
  readonly argv: readonly string[];
}

export class FakeRuntime implements RuntimeApi {
  readonly machines = new Map<string, FakeMachine>();
  readonly execs: FakeExecCall[] = [];
  /** Every call by name, in order, for asserting what did and did not happen. */
  readonly calls: string[] = [];
  /** Sandbox port → the local port its tunnel connects to. */
  readonly ports = new Map<number, number>();
  /** Answers every exec; the default succeeds with no output. */
  execHandler: (call: FakeExecCall) => RuntimeExecResult = () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  /** Runs when the desktop launcher is exec'd, as the entrypoint coming up would. */
  onLaunch: ((id: string) => void) | null = null;
  /** When set, every call is refused with this status, as a bad key would be. */
  refuseWith: number | null = null;
  /** When set, `keepWhilePaused` fails, as an API fault would. */
  failKeepWhilePaused = false;
  /** When set, `keepWhilePaused` is refused as on an account without credit. */
  withoutCredit = false;
  /** Image refs (`name:tag`, ids) and the version each names now. */
  readonly images = new Map<string, RuntimeImage>();
  /** When set, `switchImage` is refused with this code and the sandbox is left as it was. */
  refuseSwitchWith: string | null = null;
  /** Every switch that happened, oldest first. */
  readonly switches: { machineId: string; imageId: string }[] = [];
  readonly copies: { sourceId: string; destinationId: string }[] = [];
  failCopy = false;
  readonly snapshots = new Map<string, FakeSnapshot>();
  /** When set, a capture ends in this state instead of `ready`. */
  snapshotOutcome: 'ready' | 'failed' = 'ready';
  snapshotBackedUp = true;

  readonly #tunnels = new Set<FakeTunnel>();
  #nextId = 1;

  /** A sandbox that already exists, as a provisioned computer would. */
  addMachine(
    name: string,
    options: {
      state?: RuntimeMachineState;
      labels?: Record<string, string>;
      imageId?: string;
    } = {},
  ): FakeMachine {
    const machine: FakeMachine = {
      id: `sbx-${this.#nextId++}`,
      name,
      state: options.state ?? 'paused',
      labels: options.labels ?? { crewaid: 'computer' },
      spec: null,
      keptWhilePaused: true,
      imageId: options.imageId ?? null,
      vcpu: 4,
      memoryMiB: 8192,
      diskMiB: 20_480,
      files: new Map(),
    };
    this.machines.set(machine.id, machine);
    return machine;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#tunnels].map((tunnel) => tunnel.close()));
  }

  findByName = (name: string): Promise<RuntimeMachine | null> =>
    this.#call('findByName', () => {
      const found = [...this.machines.values()].find((machine) => machine.name === name);
      return found === undefined ? null : view(found);
    });

  get = (id: string): Promise<RuntimeMachine | null> =>
    this.#call('get', () => {
      const found = this.machines.get(id);
      return found === undefined ? null : view(found);
    });

  list = (labels: Readonly<Record<string, string>>): Promise<RuntimeMachine[]> =>
    this.#call('list', () =>
      [...this.machines.values()]
        .filter((machine) =>
          Object.entries(labels).every(([key, value]) => machine.labels[key] === value),
        )
        .map(view),
    );

  create = (name: string, spec: RuntimeMachineSpec): Promise<RuntimeMachine> =>
    this.#call('create', () => {
      if ([...this.machines.values()].some((machine) => machine.name === name)) {
        throw new RuntimeApiError(409, 'name_taken', `a sandbox is already named ${name}`);
      }
      const machine: FakeMachine = {
        id: `sbx-${this.#nextId++}`,
        name,
        state: 'running',
        labels: { ...spec.labels },
        spec,
        keptWhilePaused: false,
        imageId: spec.image,
        vcpu: spec.vcpu,
        memoryMiB: spec.memoryMiB,
        diskMiB: spec.diskMiB,
        files: new Map(),
      };
      this.machines.set(machine.id, machine);
      return view(machine);
    });

  createFromSnapshot = (
    name: string,
    snapshotId: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<RuntimeMachine> =>
    this.#call('createFromSnapshot', () => {
      const snapshot = this.snapshots.get(snapshotId);
      if (snapshot?.state !== 'ready') {
        throw new RuntimeApiError(409, 'snapshot_not_ready', `snapshot ${snapshotId} is not ready`);
      }
      if ([...this.machines.values()].some((machine) => machine.name === name)) {
        throw new RuntimeApiError(409, 'name_taken', `a sandbox is already named ${name}`);
      }
      const machine: FakeMachine = {
        id: `sbx-${this.#nextId++}`,
        name,
        state: 'running',
        labels: { ...labels },
        spec: null,
        keptWhilePaused: false,
        imageId: snapshot.imageId,
        vcpu: snapshot.vcpu,
        memoryMiB: snapshot.memoryMiB,
        diskMiB: snapshot.diskMiB,
        files: new Map(snapshot.files),
      };
      this.machines.set(machine.id, machine);
      return view(machine);
    });

  /** Like Runtime: a running machine pauses for the capture and is woken; a paused one stays paused. */
  snapshot = (
    id: string,
    options: { name: string; labels: Readonly<Record<string, string>> },
  ): Promise<RuntimeSnapshot> =>
    this.#call('snapshot', () => {
      const machine = this.#machine(id);
      if ([...this.snapshots.values()].some((snapshot) => snapshot.name === options.name)) {
        throw new RuntimeApiError(409, 'name_taken', `a snapshot is already named ${options.name}`);
      }
      const snapshot: FakeSnapshot = {
        id: `snap-${this.#nextId++}`,
        name: options.name,
        state: this.snapshotOutcome,
        backedUp: this.snapshotBackedUp,
        backupFailed: false,
        labels: { ...options.labels },
        sourceId: id,
        files: new Map(machine.files),
        imageId: machine.imageId,
        vcpu: machine.vcpu,
        memoryMiB: machine.memoryMiB,
        diskMiB: machine.diskMiB,
        createdAt: Date.now(),
      };
      this.snapshots.set(snapshot.id, snapshot);
      return snapshotView(snapshot);
    });

  findSnapshot = (name: string): Promise<RuntimeSnapshot | null> =>
    this.#call('findSnapshot', () => {
      const found = [...this.snapshots.values()].find((snapshot) => snapshot.name === name);
      return found === undefined ? null : snapshotView(found);
    });

  listSnapshots = (): Promise<RuntimeSnapshot[]> =>
    this.#call('listSnapshots', () => [...this.snapshots.values()].map(snapshotView));

  renameSnapshot = (id: string, name: string): Promise<void> =>
    this.#call('renameSnapshot', () => {
      const snapshot = this.snapshots.get(id);
      if (snapshot === undefined) throw new RuntimeApiError(404, 'not_found', `no snapshot ${id}`);
      if ([...this.snapshots.values()].some((other) => other.id !== id && other.name === name)) {
        throw new RuntimeApiError(409, 'name_taken', `a snapshot is already named ${name}`);
      }
      snapshot.name = name;
    });

  deleteSnapshot = (id: string): Promise<void> =>
    this.#call('deleteSnapshot', () => {
      this.snapshots.delete(id);
    });

  setLabels = (id: string, labels: Readonly<Record<string, string>>): Promise<void> =>
    this.#call('setLabels', () => {
      this.#machine(id).labels = { ...labels };
    });

  rename = (id: string, name: string, labels: Readonly<Record<string, string>>): Promise<void> =>
    this.#call('rename', () => {
      if (
        [...this.machines.values()].some((machine) => machine.id !== id && machine.name === name)
      ) {
        throw new RuntimeApiError(409, 'name_taken', 'Sandbox name is taken');
      }
      const machine = this.#machine(id);
      machine.name = name;
      machine.labels = { ...labels };
    });

  copyWorkspace = (sourceId: string, destinationId: string): Promise<void> =>
    this.#call('copyWorkspace', () => {
      if (this.failCopy) throw new Error('archive was truncated');
      this.#machine(destinationId).files = new Map(this.#machine(sourceId).files);
      this.copies.push({ sourceId, destinationId });
    });

  keepWhilePaused = (id: string): Promise<void> =>
    this.#call('keepWhilePaused', () => {
      if (this.failKeepWhilePaused) throw new RuntimeApiError(500, 'internal', 'retention failed');
      if (this.withoutCredit) {
        throw new RuntimeApiError(
          409,
          'retention_unavailable',
          'This sandbox was made without credit, so a pause keeps it seven days for free.',
        );
      }
      this.#machine(id).keptWhilePaused = true;
    });

  pause = (id: string): Promise<void> =>
    this.#call('pause', () => {
      this.#machine(id).state = 'paused';
      this.#endTunnels(id);
    });

  wake = (id: string): Promise<void> =>
    this.#call('wake', () => {
      this.#machine(id).state = 'running';
    });

  /** Boots from disk. Like Runtime, this does NOT run the image's start command. */
  restart = (id: string): Promise<void> =>
    this.#call('restart', () => {
      this.#endTunnels(id);
      this.#machine(id).state = 'running';
    });

  delete = (id: string): Promise<void> =>
    this.#call('delete', () => {
      this.machines.delete(id);
      this.#endTunnels(id);
    });

  resolveImage = (ref: string): Promise<RuntimeImage | null> =>
    this.#call('resolveImage', () => {
      const named = this.images.get(ref);
      if (named !== undefined) return named;
      return [...this.images.values()].find((image) => image.id === ref) ?? null;
    });

  /**
   * Like Runtime: the sandbox's tunnels end, it boots the other image, and
   * the start command brings its processes back; a refused switch changes
   * nothing.
   */
  switchImage = (id: string, imageId: string): Promise<void> =>
    this.#call('switchImage', () => {
      const machine = this.#machine(id);
      if (this.refuseSwitchWith !== null) {
        throw new RuntimeApiError(
          409,
          this.refuseSwitchWith,
          `the switch to ${imageId} was undone`,
        );
      }
      this.#endTunnels(id);
      machine.imageId = imageId;
      machine.state = 'running';
      this.switches.push({ machineId: id, imageId });
    });

  exec = (
    id: string,
    argv: readonly string[],
    _options?: { timeoutMs?: number },
  ): Promise<RuntimeExecResult> =>
    this.#call('exec', () => {
      // Runtime's exec wakes a paused sandbox (autoWake).
      this.#machine(id).state = 'running';
      const call = { machineId: id, argv };
      this.execs.push(call);
      if (argv.join(' ') === 'sudo -n /usr/local/bin/crewaid-desktop-up') this.onLaunch?.(id);
      return this.execHandler(call);
    });

  openTunnel = (id: string): Promise<RuntimeTunnel> =>
    this.#call('openTunnel', () => {
      const machine = this.#machine(id);
      if (machine.state !== 'running') {
        throw new RuntimeApiError(409, 'not_running', `sandbox ${id} is ${machine.state}`);
      }
      const tunnel = new FakeTunnel(id, this.ports, () => this.#tunnels.delete(tunnel));
      this.#tunnels.add(tunnel);
      return tunnel;
    });

  /** Ports each sandbox shares privately, as Runtime previews would. */
  readonly shared = new Map<string, Set<number>>();

  sharePort = (id: string, port: number, ttlSeconds: number): Promise<RuntimeSharedPort> =>
    this.#call('sharePort', () => {
      this.#machine(id);
      const ports = this.shared.get(id) ?? new Set<number>();
      ports.add(port);
      this.shared.set(id, ports);
      return {
        urlWithToken: `https://${port}-${id}.runtimehost.test/?runtime_preview_token=t-${ttlSeconds}`,
        tokenExpiresAt: Date.now() + ttlSeconds * 1000,
      };
    });

  unshareAllPorts = (id: string): Promise<void> =>
    this.#call('unshareAllPorts', () => {
      this.shared.delete(id);
    });

  #endTunnels(id: string): void {
    for (const tunnel of this.#tunnels) if (tunnel.machineId === id) void tunnel.close();
  }

  #machine(id: string): FakeMachine {
    const machine = this.machines.get(id);
    if (machine === undefined) throw new RuntimeApiError(404, 'not_found', `no sandbox ${id}`);
    return machine;
  }

  async #call<T>(name: string, fn: () => T): Promise<T> {
    this.calls.push(name);
    await Promise.resolve();
    if (this.refuseWith !== null) {
      throw new RuntimeApiError(this.refuseWith, 'unauthorized', 'the API key was refused');
    }
    return fn();
  }
}

class FakeTunnel implements RuntimeTunnel {
  readonly machineId: string;
  readonly closed: Promise<void>;
  readonly #ports: ReadonlyMap<number, number>;
  readonly #servers: Server[] = [];
  readonly #sockets = new Set<Socket>();
  readonly #onClose: () => void;
  #resolveClosed!: () => void;
  #isClosed = false;

  constructor(machineId: string, ports: ReadonlyMap<number, number>, onClose: () => void) {
    this.machineId = machineId;
    this.#ports = ports;
    this.#onClose = onClose;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async forward(port: number): Promise<RuntimeForward> {
    if (this.#isClosed) throw new RuntimeApiError(409, 'tunnel_closed', 'the tunnel is closed');
    const server = createServer((local) => {
      this.#sockets.add(local);
      local.once('close', () => this.#sockets.delete(local));
      const target = this.#ports.get(port);
      // Nothing listens there: Runtime closes such a connection at once.
      if (target === undefined) {
        local.destroy();
        return;
      }
      const remote = connect(target, '127.0.0.1');
      this.#sockets.add(remote);
      remote.once('close', () => {
        this.#sockets.delete(remote);
        local.destroy();
      });
      local.once('close', () => remote.destroy());
      remote.on('error', () => local.destroy());
      local.on('error', () => remote.destroy());
      local.pipe(remote);
      remote.pipe(local);
    });
    this.#servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  }

  async close(): Promise<void> {
    if (this.#isClosed) return;
    this.#isClosed = true;
    for (const socket of this.#sockets) socket.destroy();
    await Promise.all(
      this.#servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    this.#onClose();
    this.#resolveClosed();
  }
}

function snapshotView(snapshot: FakeSnapshot): RuntimeSnapshot {
  return {
    id: snapshot.id,
    name: snapshot.name,
    state: snapshot.state,
    backedUp: snapshot.backedUp,
    backupFailed: snapshot.backupFailed,
    sizeBytes: snapshot.state === 'ready' ? 1_024 : null,
    createdAt: snapshot.createdAt,
    expiresAt: null,
    labels: { ...snapshot.labels },
    error: snapshot.state === 'failed' ? 'capture failed' : null,
  };
}

function view(machine: FakeMachine): RuntimeMachine {
  return {
    id: machine.id,
    name: machine.name,
    state: machine.state,
    labels: { ...machine.labels },
    vcpu: machine.vcpu,
    memoryMiB: machine.memoryMiB,
    diskMiB: machine.diskMiB,
  };
}
