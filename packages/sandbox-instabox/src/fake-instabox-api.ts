/**
 * In-memory fake of `InstaboxApi` for fast, deterministic unit tests with no
 * network, no Instabox account, and no SSH gateway.
 */

import type {
  InstaboxApi,
  InstaboxCreateSpec,
  InstaboxExecResult,
  InstaboxForward,
  InstaboxMachine,
  InstaboxMachineState,
  InstaboxTunnel,
} from './instabox-client.js';

export interface FakeMachineRecord {
  id: string;
  name: string;
  state: InstaboxMachineState;
  metadata: Record<string, string>;
  vcpus: number;
  memoryMiB: number;
  ready: boolean;
  vault: boolean;
  cooldownUntil: string | null;
  maxRunMinutes: number | null;
}

export interface RecordedWrite {
  readonly machineId: string;
  readonly path: string;
  readonly content: string;
}

export interface RecordedExec {
  readonly machineId: string;
  readonly command: string;
  readonly envs: Readonly<Record<string, string>> | undefined;
}

export class FakeTunnel implements InstaboxTunnel {
  readonly forwardedHostPorts: number[] = [];
  readonly #resolveClosed: () => void;
  readonly closed: Promise<void>;
  isClosed = false;
  readonly #basePort: number;

  constructor(basePort = 40_000) {
    this.#basePort = basePort;
    let resolveClosed = (): void => undefined;
    this.closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  forward(hostPort: number): Promise<InstaboxForward> {
    if (this.isClosed) {
      return Promise.reject(new Error('tunnel closed'));
    }
    this.forwardedHostPorts.push(hostPort);
    return Promise.resolve({ host: '127.0.0.1', port: this.#basePort + (hostPort % 10_000) });
  }

  close(): Promise<void> {
    if (!this.isClosed) {
      this.isClosed = true;
      this.#resolveClosed();
    }
    return Promise.resolve();
  }

  /** Simulates an unexpected SSH connection drop from the gateway or VM. */
  drop(): void {
    if (!this.isClosed) {
      this.isClosed = true;
      this.#resolveClosed();
    }
  }
}

export class FakeInstaboxApi implements InstaboxApi {
  readonly machines = new Map<string, FakeMachineRecord>();
  readonly creates: InstaboxCreateSpec[] = [];
  readonly writes: RecordedWrite[] = [];
  readonly execs: RecordedExec[] = [];
  readonly tunnels: { readonly machineId: string; readonly tunnel: FakeTunnel }[] = [];
  readonly events: string[] = [];
  /** How often each lookup ran, to prove hot paths read by ID rather than listing. */
  readonly lookups = { findByName: 0, get: 0, list: 0 };

  nextError: Error | null = null;
  execHandler:
    | ((
        machineId: string,
        command: string,
        envs?: Readonly<Record<string, string>>,
      ) => InstaboxExecResult)
    | null = null;
  ensureResult = {
    imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    recreated: true,
    skippedUpgradeForDiskSpace: false,
  };

  #seq = 0;

  seed(
    record: Partial<FakeMachineRecord> & Pick<FakeMachineRecord, 'id' | 'name'>,
  ): FakeMachineRecord {
    const full: FakeMachineRecord = {
      state: 'running',
      metadata: {},
      vcpus: 4,
      memoryMiB: 8192,
      ready: true,
      vault: false,
      cooldownUntil: null,
      maxRunMinutes: null,
      ...record,
    };
    this.machines.set(full.id, full);
    return full;
  }

  #checkError(): void {
    if (this.nextError !== null) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
  }

  findByName(name: string): Promise<InstaboxMachine | null> {
    this.#checkError();
    this.lookups.findByName += 1;
    for (const record of this.machines.values()) {
      if (record.name === name) return Promise.resolve(snapshotOf(record));
    }
    return Promise.resolve(null);
  }

  get(id: string): Promise<InstaboxMachine | null> {
    this.#checkError();
    this.lookups.get += 1;
    const found = this.machines.get(id);
    return Promise.resolve(found === undefined ? null : snapshotOf(found));
  }

  list(metadata: Readonly<Record<string, string>>): Promise<InstaboxMachine[]> {
    this.#checkError();
    this.lookups.list += 1;
    const pairs = Object.entries(metadata);
    const matched = [...this.machines.values()]
      .filter((record) => pairs.every(([k, v]) => record.metadata[k] === v))
      .map(snapshotOf);
    return Promise.resolve(matched);
  }

  create(spec: InstaboxCreateSpec): Promise<InstaboxMachine> {
    this.#checkError();
    this.creates.push(spec);
    this.#seq += 1;
    const id = `m_fake_${this.#seq}`;
    this.events.push(`create:${id}`);
    const record: FakeMachineRecord = {
      id,
      name: spec.name,
      state: 'running',
      metadata: { ...spec.metadata },
      vcpus: spec.vcpus ?? 4,
      memoryMiB: spec.memoryMiB ?? 8192,
      ready: true,
      vault: false,
      cooldownUntil: null,
      maxRunMinutes: null,
    };
    this.machines.set(id, record);
    return Promise.resolve(snapshotOf(record));
  }

  setMetadata(id: string, metadata: Readonly<Record<string, string>>): Promise<void> {
    this.#checkError();
    const record = this.machines.get(id);
    if (record === undefined) return Promise.reject(new Error(`machine ${id} not found`));
    this.events.push(`setMetadata:${id}`);
    record.metadata = { ...metadata };
    return Promise.resolve();
  }

  pause(id: string): Promise<void> {
    this.#checkError();
    const record = this.machines.get(id);
    if (record === undefined) return Promise.reject(new Error(`machine ${id} not found`));
    this.events.push(`pause:${id}`);
    record.state = 'suspended';
    record.ready = false;
    return Promise.resolve();
  }

  resume(id: string): Promise<void> {
    this.#checkError();
    const record = this.machines.get(id);
    if (record === undefined) return Promise.reject(new Error(`machine ${id} not found`));
    this.events.push(`resume:${id}`);
    record.state = 'running';
    record.ready = true;
    return Promise.resolve();
  }

  stop(id: string): Promise<void> {
    this.#checkError();
    const record = this.machines.get(id);
    if (record === undefined) return Promise.reject(new Error(`machine ${id} not found`));
    this.events.push(`stop:${id}`);
    record.state = 'stopped';
    record.ready = false;
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.#checkError();
    this.events.push(`delete:${id}`);
    this.machines.delete(id);
    return Promise.resolve();
  }

  writeFile(id: string, path: string, content: string): Promise<void> {
    this.#checkError();
    this.events.push(`writeFile:${id}:${path}`);
    this.writes.push({ machineId: id, path, content });
    return Promise.resolve();
  }

  exec(
    id: string,
    command: string,
    options?: { envs?: Readonly<Record<string, string>>; timeoutMs?: number },
  ): Promise<InstaboxExecResult> {
    this.#checkError();
    this.events.push(`exec:${id}`);
    this.execs.push({ machineId: id, command, envs: options?.envs });
    if (this.execHandler !== null) {
      return Promise.resolve(this.execHandler(id, command, options?.envs));
    }
    if (command.includes('CREWAID_ENSURE_JSON=')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `CREWAID_ENSURE_JSON=${JSON.stringify(this.ensureResult)}\n`,
        stderr: '',
        timedOut: false,
      });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
  }

  openTunnel(id: string): Promise<InstaboxTunnel> {
    this.#checkError();
    this.events.push(`openTunnel:${id}`);
    const tunnel = new FakeTunnel(40_000 + this.tunnels.length * 100);
    this.tunnels.push({ machineId: id, tunnel });
    return Promise.resolve(tunnel);
  }
}

function snapshotOf(record: FakeMachineRecord): InstaboxMachine {
  return {
    id: record.id,
    name: record.name,
    state: record.state,
    metadata: { ...record.metadata },
    vcpus: record.vcpus,
    memoryMiB: record.memoryMiB,
    ready: record.ready,
    vault: record.vault,
    cooldownUntil: record.cooldownUntil,
    maxRunMinutes: record.maxRunMinutes,
  };
}
