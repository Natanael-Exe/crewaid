/**
 * Runtime's API (withruntime.com), as this provider uses it.
 *
 * The only file that imports the `withruntime` SDK and the only one that reads
 * `RUNTIME_API_KEY`. The key manages every sandbox, image and volume on the
 * account, so it stays in the orchestrator's process: it is never passed to a
 * machine, and nothing else in the repo needs to know its name.
 *
 * The provider is written against the narrow `RuntimeApi` port below rather
 * than the SDK's classes, so its tests run against an in-memory fake with no
 * network, and an SDK release that reshapes a class changes this file only.
 * The SDK already retries transport failures, 429s and 5xx with idempotency
 * keys, so nothing here retries.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import {
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  Runtime,
  RuntimeError,
  type Sandbox,
  type Snapshot,
} from 'withruntime';

import {
  INSTALL_WORKSPACE,
  QUIESCE_DESKTOP,
  WORKSPACE_TRANSFER_SERVER,
  transferWorkspaceArchive,
} from './workspace-transfer.js';
import { COMPUTER_LABEL, UPGRADE_BACKUP_ROLE, UPGRADE_STAGE_ROLE } from './runtime-labels.js';

const KEY_ENV = 'RUNTIME_API_KEY';

export type RuntimeMachineState =
  'starting' | 'running' | 'pausing' | 'paused' | 'resuming' | 'stopping' | 'stopped';

/** The subset of a sandbox's record this provider reads. */
export interface RuntimeMachine {
  readonly id: string;
  readonly name: string | null;
  readonly state: RuntimeMachineState;
  readonly labels: Readonly<Record<string, string>>;
  readonly vcpu: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
}

export interface RuntimeMachineSpec {
  readonly image: string;
  readonly vcpu: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
  readonly labels: Readonly<Record<string, string>>;
}

export interface RuntimeExecResult {
  /** `null` when the command timed out or was killed before it exited. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One ready version of an image, as the provider compares and switches by it. */
export interface RuntimeImage {
  readonly id: string;
  /** The program a sandbox from it starts with; null when it has no start command. */
  readonly startArgv: readonly string[] | null;
}

/** A saved whole machine, as the provider reads one. */
export interface RuntimeSnapshot {
  readonly id: string;
  readonly name: string | null;
  readonly state: 'capturing' | 'ready' | 'failed';
  readonly backedUp: boolean;
  readonly backupFailed: boolean;
  /** What it stores; null until Runtime has measured it. */
  readonly sizeBytes: number | null;
  /** Unix milliseconds. */
  readonly createdAt: number;
  /** Unix milliseconds; null while it is kept as long as the account has credit. */
  readonly expiresAt: number | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly error: string | null;
}

/** One local listener carrying connections to a port inside the sandbox. */
export interface RuntimeForward {
  readonly host: string;
  readonly port: number;
}

/**
 * One authenticated tunnel into a sandbox's loopback. Every forwarded port
 * shares it, and closing it closes them all.
 */
export interface RuntimeTunnel {
  forward(port: number): Promise<RuntimeForward>;
  close(): Promise<void>;
  /** Settles when the tunnel ends, by `close` or because the sandbox went away. */
  readonly closed: Promise<void>;
}

export interface RuntimeApi {
  /** The sandbox with this exact name, stopped ones included; null when none. */
  findByName(name: string): Promise<RuntimeMachine | null>;
  /** Null when the sandbox no longer exists. */
  get(id: string): Promise<RuntimeMachine | null>;
  /** Every sandbox carrying all of `labels`, stopped ones included. */
  list(labels: Readonly<Record<string, string>>): Promise<RuntimeMachine[]>;
  /** Creates a sandbox and answers once it is running. */
  create(name: string, spec: RuntimeMachineSpec): Promise<RuntimeMachine>;
  /**
   * A new sandbox that starts as a running copy of a ready snapshot, at the
   * snapshot's size. Answers once it is running.
   */
  createFromSnapshot(
    name: string,
    snapshotId: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<RuntimeMachine>;
  /**
   * Saves the whole machine (files, memory, running programs), kept while the
   * account has credit. A running sandbox is paused for the capture and woken
   * after; a paused one stays paused. Answers once the capture has ended.
   */
  snapshot(
    id: string,
    options: { name: string; labels: Readonly<Record<string, string>>; abortSignal?: AbortSignal },
  ): Promise<RuntimeSnapshot>;
  /** The snapshot with this exact name that is not being deleted; null when none. */
  findSnapshot(name: string): Promise<RuntimeSnapshot | null>;
  listSnapshots(): Promise<RuntimeSnapshot[]>;
  renameSnapshot(id: string, name: string): Promise<void>;
  /** Deleting one already gone succeeds. */
  deleteSnapshot(id: string): Promise<void>;
  /** Keep this sandbox while paused for as long as the account has credit. */
  keepWhilePaused(id: string): Promise<void>;
  /** Replaces the sandbox's labels with exactly `labels`. */
  setLabels(id: string, labels: Readonly<Record<string, string>>): Promise<void>;
  /** One atomic settings update, so a rename cannot expose the old management role. */
  rename(id: string, name: string, labels: Readonly<Record<string, string>>): Promise<void>;
  /** Copy home and workspace to a fresh destination; source bytes are never removed. */
  copyWorkspace(
    sourceId: string,
    destinationId: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void>;
  pause(id: string): Promise<void>;
  wake(id: string): Promise<void>;
  /**
   * Boots a stopped sandbox again from its disk. Memory and processes are
   * gone, and Runtime does NOT rerun the image's start command (measured on
   * Runtime 2026-10-13): the caller starts what it needs.
   */
  restart(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  /** The version `ref` (an id, a name, `name:tag` or `name@version`) names now; null when none. */
  resolveImage(ref: string): Promise<RuntimeImage | null>;
  /**
   * Moves the sandbox to another image version. Runtime keeps `/workspace`
   * and discards the rest of the disk; the processes restart under the new
   * image's start command. A switch that fails is undone (`switch_undone`).
   */
  switchImage(id: string, imageId: string): Promise<void>;
  /** Runs `argv` without a shell, as the sandbox's own user (uid 1000, the image's `bot`). */
  exec(
    id: string,
    argv: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<RuntimeExecResult>;
  openTunnel(id: string): Promise<RuntimeTunnel>;
  /**
   * Shares `port` at a private HTTPS address (a Runtime preview), or reuses
   * the one already shared, with a token that admits new connections for
   * `ttlSeconds`. A connection opened with it outlives the token (measured).
   */
  sharePort(id: string, port: number, ttlSeconds: number): Promise<RuntimeSharedPort>;
  /**
   * Stops sharing every port. Runtime closes their open connections before it
   * answers, and a visit to a paused sandbox's preview would WAKE it, so a
   * computer never pauses with one left behind.
   */
  unshareAllPorts(id: string): Promise<void>;
}

/** A port shared privately: its address with the token in it, and when the token stops admitting. */
export interface RuntimeSharedPort {
  /** `https://…` carrying the token in its query; a WebSocket client uses it as it is. */
  readonly urlWithToken: string;
  /** Unix milliseconds. */
  readonly tokenExpiresAt: number;
}

/**
 * Every failure the port raises, with the HTTP status and Runtime's stable
 * error code, so the provider can tell a refused key from a fault without
 * knowing the SDK's classes.
 */
export class RuntimeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'RuntimeApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  /** The key is missing, wrong, revoked, or not allowed to manage sandboxes. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** For the boot check: whether the key is set, without handing out its value. */
export function runtimeApiKeyConfigured(): boolean {
  return (process.env[KEY_ENV] ?? '').trim() !== '';
}

/** The SDK behind the `RuntimeApi` port. */
export class SdkRuntimeApi implements RuntimeApi {
  readonly #runtime: Runtime;

  /** Throws at construction — which is boot — when the key is not set. */
  constructor(options: { readonly baseUrl?: string } = {}) {
    const apiKey = (process.env[KEY_ENV] ?? '').trim();
    // Refused here rather than left to the SDK: given no key, it falls back to
    // a connection its CLI saved on the machine, and a deployment must run on
    // the key it was configured with, never on whoever last logged in there.
    if (apiKey === '') {
      throw new RuntimeApiError(401, 'missing_api_key', `${KEY_ENV} is not set`);
    }
    this.#runtime = new Runtime({
      apiKey,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    });
  }

  findByName = (name: string): Promise<RuntimeMachine | null> =>
    translated(async () => {
      const page = await this.#runtime.sandboxes.list({ name, includeStopped: true });
      const found = (await page.toArray()).find((sandbox) => sandbox.info.name === name);
      return found === undefined ? null : machineOf(found);
    });

  get = (id: string): Promise<RuntimeMachine | null> =>
    translated(async () => {
      const sandbox = await this.#find(id);
      return sandbox === null ? null : machineOf(sandbox);
    });

  list = (labels: Readonly<Record<string, string>>): Promise<RuntimeMachine[]> =>
    translated(async () => {
      const page = await this.#runtime.sandboxes.list({
        labels: { ...labels },
        includeStopped: true,
      });
      return (await page.toArray()).map(machineOf);
    });

  create = (name: string, spec: RuntimeMachineSpec): Promise<RuntimeMachine> =>
    translated(async () => {
      const sandbox = await this.#runtime.sandboxes.create({
        name,
        image: spec.image,
        vcpu: spec.vcpu,
        memoryMiB: spec.memoryMiB,
        diskMiB: spec.diskMiB,
        labels: { ...spec.labels },
        // The orchestrator decides when a computer is idle (WORKSPACE.md §8);
        // Runtime's own idle pause would pause a machine a viewer is watching.
        idlePauseSeconds: spec.labels[COMPUTER_LABEL.key] === UPGRADE_STAGE_ROLE ? 300 : 0,
        // No time limit: a computer runs until the orchestrator pauses it.
        timeoutSeconds: 0,
        wait: true,
      });
      return machineOf(sandbox);
    });

  createFromSnapshot = (
    name: string,
    snapshotId: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<RuntimeMachine> =>
    translated(async () => {
      const sandbox = await this.#runtime.sandboxes.create({
        name,
        snapshot: snapshotId,
        labels: { ...labels },
        // As `create`: the orchestrator pauses a computer, and a staged one
        // that nobody promotes pauses itself rather than billing.
        idlePauseSeconds: labels[COMPUTER_LABEL.key] === UPGRADE_STAGE_ROLE ? 300 : 0,
        timeoutSeconds: 0,
        wait: true,
      });
      return machineOf(sandbox);
    });

  snapshot = (
    id: string,
    options: { name: string; labels: Readonly<Record<string, string>>; abortSignal?: AbortSignal },
  ): Promise<RuntimeSnapshot> =>
    translated(async () => {
      const taken = await (
        await this.#sandbox(id)
      ).snapshot({
        mode: 'memory',
        name: options.name,
        labels: { ...options.labels },
        // Kept while the account has credit: replacing it is the only way it goes.
        retentionDays: null,
        // A machine's memory can take a while to write; past this Runtime
        // leaves it paused and names the snapshot in the error.
        timeoutMs: 1_800_000,
        ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
      });
      return snapshotOf(taken);
    });

  findSnapshot = (name: string): Promise<RuntimeSnapshot | null> =>
    translated(async () => {
      const page = await this.#runtime.snapshots.list({ name });
      const found = (await page.toArray()).find(
        (snapshot) =>
          snapshot.name === name && snapshot.state !== 'deleting' && snapshot.state !== 'deleted',
      );
      return found === undefined ? null : snapshotOf(found);
    });

  listSnapshots = (): Promise<RuntimeSnapshot[]> =>
    translated(async () => {
      const page = await this.#runtime.snapshots.list();
      return (await page.toArray())
        .filter((snapshot) => snapshot.state !== 'deleting' && snapshot.state !== 'deleted')
        .map(snapshotOf);
    });

  renameSnapshot = (id: string, name: string): Promise<void> =>
    translated(async () => {
      await this.#runtime.snapshots.update(id, { name });
    });

  deleteSnapshot = (id: string): Promise<void> =>
    translated(async () => {
      try {
        await this.#runtime.snapshots.delete(id);
      } catch (error: unknown) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    });

  keepWhilePaused = (id: string): Promise<void> =>
    translated(async () => {
      await (await this.#sandbox(id)).setRetention(null);
    });

  setLabels = (id: string, labels: Readonly<Record<string, string>>): Promise<void> =>
    translated(async () => {
      await (await this.#sandbox(id)).update({ labels: { ...labels } });
    });

  rename = (id: string, name: string, labels: Readonly<Record<string, string>>): Promise<void> =>
    translated(async () => {
      await (
        await this.#sandbox(id)
      ).update({
        name,
        labels: { ...labels },
        idlePauseSeconds: labels[COMPUTER_LABEL.key] === COMPUTER_LABEL.value ? 0 : 300,
        autoWake: labels[COMPUTER_LABEL.key] !== UPGRADE_BACKUP_ROLE,
      });
    });

  copyWorkspace = (
    sourceId: string,
    destinationId: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void> =>
    translated(async () => {
      const [source, destination] = await Promise.all([
        this.#sandbox(sourceId),
        this.#sandbox(destinationId),
      ]);
      const id = randomUUID();
      const temporary = `/tmp/crewaid-transfer-${id}`;
      const stage = `/workspace/.crewaid-transfer-${id}`;
      const token = randomBytes(32).toString('hex');
      const signal = AbortSignal.any([
        AbortSignal.timeout(600_000),
        ...(options?.abortSignal === undefined ? [] : [options.abortSignal]),
      ]);
      const tunnels: Awaited<ReturnType<Sandbox['tunnel']>>[] = [];
      const processes: Awaited<ReturnType<Sandbox['spawn']>>[] = [];
      const checked = async (sandbox: Sandbox, argv: readonly string[]) => {
        const result = await sandbox.exec(argv, { cwd: '/tmp', timeoutMs: 120_000, signal });
        if (result.exitCode !== 0)
          throw new Error(`Workspace preparation failed: ${result.stderr.slice(0, 300)}`);
      };
      try {
        await Promise.all(
          [source, destination].map(async (sandbox) => {
            await sandbox.files.mkdir(temporary);
            await checked(sandbox, ['sudo', '-n', 'python3', '-c', QUIESCE_DESKTOP]);
          }),
        );
        const start = async (sandbox: Sandbox, mode: 'send' | 'receive', root: string) => {
          const ready = `${temporary}/port`;
          const process = await sandbox.spawn(
            [
              'sudo',
              '-n',
              'python3',
              '-u',
              '-c',
              WORKSPACE_TRANSFER_SERVER,
              mode,
              token,
              ready,
              root,
            ],
            { cwd: '/tmp', timeoutMs: 660_000 },
          );
          processes.push(process);
          let port = 0;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            signal.throwIfAborted();
            if (await sandbox.files.exists(ready)) {
              port = Number(await sandbox.files.readText(ready));
              if (Number.isInteger(port) && port > 0 && port < 65536) break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error('Workspace transfer server did not start');
          const tunnel = await sandbox.tunnel();
          tunnels.push(tunnel);
          const forward = await tunnel.forward(port, { host: '127.0.0.1', localPort: 0 });
          return { host: forward.host, port: forward.localPort };
        };
        const [from, to] = await Promise.all([
          start(source, 'send', '/'),
          start(destination, 'receive', stage),
        ]);
        await transferWorkspaceArchive(from, to, token, signal);
        await checked(destination, ['sudo', '-n', 'python3', '-c', INSTALL_WORKSPACE, stage]);
      } finally {
        for (const tunnel of tunnels) tunnel.close();
        await Promise.allSettled(processes.map((process) => process.kill()));
        // Only transfer-owned scratch paths, never a source workspace or a restored home.
        if (!signal.aborted)
          await Promise.allSettled(
            [source, destination].map((sandbox) =>
              sandbox.exec(['sudo', '-n', 'rm', '-rf', temporary], {
                cwd: '/tmp',
                timeoutMs: 10_000,
              }),
            ),
          );
      }
    });

  pause = (id: string): Promise<void> =>
    translated(async () => {
      await (await this.#sandbox(id)).pause({ wait: true });
    });

  wake = (id: string): Promise<void> =>
    translated(async () => {
      await (await this.#sandbox(id)).wake({ wait: true });
    });

  restart = (id: string): Promise<void> =>
    translated(async () => {
      await (await this.#sandbox(id)).restart({ wait: true });
    });

  delete = (id: string): Promise<void> =>
    translated(async () => {
      try {
        await this.#runtime.sandboxes.delete(id);
      } catch (error: unknown) {
        // Deleting what is already gone is the outcome the caller wanted.
        if (!(error instanceof NotFoundError)) throw error;
      }
    });

  resolveImage = (ref: string): Promise<RuntimeImage | null> =>
    translated(async () => {
      try {
        const image = await this.#runtime.images.resolve(ref);
        const start = image.start ?? null;
        const startArgv =
          start?.argv !== undefined
            ? [...start.argv]
            : start?.command !== undefined
              ? [start.command]
              : null;
        return { id: image.id, startArgv };
      } catch (error: unknown) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    });

  switchImage = (id: string, imageId: string): Promise<void> =>
    translated(async () => {
      await (await this.#sandbox(id)).switchImage(imageId);
    });

  exec = (
    id: string,
    argv: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<RuntimeExecResult> =>
    translated(async () => {
      const result = await (
        await this.#sandbox(id)
      ).exec(argv, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    });

  openTunnel = (id: string): Promise<RuntimeTunnel> =>
    translated(async () => {
      const tunnel = await (await this.#sandbox(id)).tunnel();
      const forwards: { close(): Promise<void> }[] = [];
      return {
        forward: (port: number) =>
          translated(async () => {
            const forward = await tunnel.forward(port, { localPort: 0, host: '127.0.0.1' });
            forwards.push(forward);
            return { host: forward.host, port: forward.localPort };
          }),
        close: async () => {
          // The listeners first, so nothing new is accepted into a tunnel
          // that is about to go.
          await Promise.allSettled(forwards.splice(0).map((forward) => forward.close()));
          tunnel.close();
        },
        closed: tunnel.closed.then(
          () => undefined,
          () => undefined,
        ),
      };
    });

  sharePort = (id: string, port: number, ttlSeconds: number): Promise<RuntimeSharedPort> =>
    translated(async () => {
      const preview = await (
        await this.#sandbox(id)
      ).previews.create(port, { visibility: 'private', ttlSeconds });
      if (preview.urlWithToken === null || preview.tokenExpiresAt === null) {
        throw new RuntimeApiError(
          502,
          'preview_not_private',
          `port ${port} is not shared privately`,
        );
      }
      return {
        urlWithToken: preview.urlWithToken,
        tokenExpiresAt: Date.parse(preview.tokenExpiresAt),
      };
    });

  unshareAllPorts = (id: string): Promise<void> =>
    translated(async () => {
      const sandbox = await this.#find(id);
      if (sandbox === null) return;
      for (const preview of await sandbox.previews.list()) {
        try {
          await sandbox.previews.delete(preview.port);
        } catch (error: unknown) {
          // Already gone is the outcome wanted.
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
    });

  async #find(id: string): Promise<Sandbox | null> {
    try {
      return await this.#runtime.sandboxes.get(id);
    } catch (error: unknown) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async #sandbox(id: string): Promise<Sandbox> {
    const sandbox = await this.#find(id);
    if (sandbox === null)
      throw new RuntimeApiError(404, 'not_found', `sandbox ${id} no longer exists`);
    return sandbox;
  }
}

function machineOf(sandbox: Sandbox): RuntimeMachine {
  const info = sandbox.info;
  return {
    id: info.id,
    name: info.name,
    state: info.state,
    labels: info.labels,
    vcpu: info.vcpu,
    memoryMiB: info.memoryMiB,
    diskMiB: info.diskMiB,
  };
}

function snapshotOf(snapshot: Snapshot): RuntimeSnapshot {
  const time = (value: string | null): number | null => {
    if (value === null) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    id: snapshot.id,
    name: snapshot.name,
    // `deleting` is filtered out by every lookup; reading one as failed is the safe side.
    state: snapshot.state === 'ready' || snapshot.state === 'capturing' ? snapshot.state : 'failed',
    backedUp: snapshot.backedUp,
    backupFailed: snapshot.durability?.state === 'failed',
    sizeBytes: snapshot.storedBytes,
    createdAt: time(snapshot.createdAt) ?? Date.now(),
    expiresAt: time(snapshot.expiresAt),
    labels: stringRecord(snapshot['labels']),
    error: snapshot.error,
  };
}

/** The SDK's `Snapshot` type does not declare labels, though the API returns them. */
function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** Every SDK failure leaves this file as a `RuntimeApiError`. */
async function translated<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (error instanceof RuntimeApiError) throw error;
    if (error instanceof RuntimeError) {
      const status =
        error instanceof AuthenticationError
          ? 401
          : error instanceof PermissionDeniedError
            ? 403
            : error.status;
      throw new RuntimeApiError(status, error.code, error.message, error.requestId);
    }
    throw error;
  }
}
