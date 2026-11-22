/**
 * Instabox's API (instabox.sh) and multiplexed SSH tunnel, as this provider uses them.
 *
 * The only file that reads `INSTABOX_API_KEY`, imports `@insforge/instabox-sdk`,
 * or imports `ssh2`. The API key manages every sandbox on the Instabox account,
 * so it stays in the orchestrator's process: it is never passed into a VM or
 * container, and nothing else in the repo needs to read it.
 *
 * Machine lifecycle, metadata, file uploads and guest commands go through the
 * official `@insforge/instabox-sdk`. A narrow `fetch` helper handles only
 * `POST/DELETE /v1/machines/{id}/ssh-tokens`, which `@insforge/instabox-sdk@0.9.0`
 * does not expose yet, so the provider can open one multiplexed `ssh2` tunnel
 * per running computer with SHA-256 host-key pinning and per-token revocation.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  DEFAULT_API_URL,
  InstaboxAuthError,
  InstaboxError,
  InstaboxQuotaError,
  Sandbox,
  type ConnectionOptions,
  type Machine,
  type MachineState,
  type SandboxInfo,
} from '@insforge/instabox-sdk';
import { Client as SshClient, type ClientChannel } from 'ssh2';

const KEY_ENV = 'INSTABOX_API_KEY';

/** Mint SSH tokens for 24 hours and recycle tunnels 5 minutes before expiry. */
const SSH_TOKEN_TTL_SECONDS = 86_400;
const SSH_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const SSH_READY_TIMEOUT_MS = 15_000;
const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
const SSH_KEEPALIVE_COUNT_MAX = 3;

export type InstaboxMachineState = MachineState;

/** The subset of an Instabox sandbox record this provider reads. */
export interface InstaboxMachine {
  readonly id: string;
  readonly name: string;
  readonly state: InstaboxMachineState;
  readonly metadata: Readonly<Record<string, string>>;
  readonly vcpus: number;
  readonly memoryMiB: number;
  readonly ready: boolean;
  readonly vault: boolean;
  readonly cooldownUntil: string | null;
  readonly maxRunMinutes: number | null;
}

export interface InstaboxCreateSpec {
  readonly name: string;
  readonly template: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly vcpus?: number;
  readonly memoryMiB?: number;
  readonly autoSuspendMs?: number;
}

export interface InstaboxExecResult {
  /** `null` when the command timed out before producing an exit status. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface InstaboxSshToken {
  readonly id: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly hostKeyFingerprint: string;
  /** Unix milliseconds, or `null` when the token has no expiry. */
  readonly expiresAt: number | null;
}

/** One local loopback listener carrying connections to a host port inside the VM. */
export interface InstaboxForward {
  readonly host: string;
  readonly port: number;
}

/**
 * One authenticated SSH tunnel into an Instabox VM's loopback. Every forwarded
 * port shares this connection, and closing it closes them all.
 */
export interface InstaboxTunnel {
  forward(hostPort: number): Promise<InstaboxForward>;
  close(): Promise<void>;
  /** Settles when the tunnel ends, by `close()` or because the connection dropped. */
  readonly closed: Promise<void>;
}

export interface InstaboxApi {
  /** The sandbox with this exact name, stopped/suspended ones included; null when none. */
  findByName(name: string): Promise<InstaboxMachine | null>;
  /** Null when the sandbox no longer exists. */
  get(id: string): Promise<InstaboxMachine | null>;
  /** Every sandbox carrying all of `metadata`, stopped/suspended ones included. */
  list(metadata: Readonly<Record<string, string>>): Promise<InstaboxMachine[]>;
  /** Creates a sandbox with `vault: false` and answers once it is running. */
  create(spec: InstaboxCreateSpec): Promise<InstaboxMachine>;
  /** Replaces the sandbox's metadata atomically without waking a paused VM. */
  setMetadata(id: string, metadata: Readonly<Record<string, string>>): Promise<void>;
  /** Suspends memory and disks (`POST /suspend`). */
  pause(id: string): Promise<void>;
  /** Resumes a suspended VM from memory or starts a stopped VM from disk. */
  resume(id: string): Promise<void>;
  /** Cold-stops the VM while preserving `/data` and root disk. */
  stop(id: string): Promise<void>;
  /** Permanently deletes the VM and its disks. Missing VMs succeed. */
  delete(id: string): Promise<void>;
  /** Writes a UTF-8 file inside the running VM via the SDK's atomic file route. */
  writeFile(
    id: string,
    path: string,
    content: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void>;
  /** Runs a shell command inside the running VM without throwing on non-zero exit. */
  exec(
    id: string,
    command: string,
    options?: {
      envs?: Readonly<Record<string, string>>;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    },
  ): Promise<InstaboxExecResult>;
  /** Opens one multiplexed SSH tunnel into the running VM's loopback. */
  openTunnel(id: string): Promise<InstaboxTunnel>;
}

/**
 * Every API failure the port raises, with HTTP status and Instabox's machine
 * error code so the provider can classify auth vs plan/quota vs cooldown errors
 * without depending on SDK classes.
 */
export class InstaboxApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly unauthorized: boolean;
  readonly quotaExceeded: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: {
      readonly requestId?: string;
      readonly retryable?: boolean;
      readonly unauthorized?: boolean;
      readonly quotaExceeded?: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'InstaboxApiError';
    this.status = status;
    this.code = code;
    this.requestId = options?.requestId;
    this.retryable = options?.retryable ?? false;
    this.unauthorized = options?.unauthorized ?? (status === 401 || status === 403);
    this.quotaExceeded = options?.quotaExceeded ?? (status === 402 || status === 429);
  }
}

/** For the boot check: whether the key is set, without handing out its value. */
export function instaboxApiKeyConfigured(): boolean {
  return (process.env[KEY_ENV] ?? '').trim() !== '';
}

/**
 * Verifies an SSH server host key (raw key bytes from `ssh2`, or a 64-char
 * SHA-256 hex digest) against Instabox's OpenSSH `SHA256:<base64>` fingerprint
 * using constant-time comparison. Fails closed on malformed inputs.
 */
export function verifyHostKeyFingerprint(
  actualKeyOrHex: Buffer | string,
  expectedFingerprint: string,
): boolean {
  const trimmed = expectedFingerprint.trim();
  if (!trimmed.startsWith('SHA256:')) return false;
  const expectedB64 = trimmed.slice('SHA256:'.length);
  if (expectedB64.length === 0) return false;
  const expectedDigest = Buffer.from(expectedB64, 'base64');
  if (expectedDigest.length !== 32) return false;

  let actualDigest: Buffer;
  if (Buffer.isBuffer(actualKeyOrHex)) {
    actualDigest = createHash('sha256').update(actualKeyOrHex).digest();
  } else if (/^[0-9a-f]{64}$/i.test(actualKeyOrHex)) {
    actualDigest = Buffer.from(actualKeyOrHex, 'hex');
  } else {
    return false;
  }

  return (
    actualDigest.length === expectedDigest.length && timingSafeEqual(actualDigest, expectedDigest)
  );
}

/** The official Instabox SDK + ssh2 tunnel behind the `InstaboxApi` port. */
export class SdkInstaboxApi implements InstaboxApi {
  readonly #apiKey: string;
  readonly #apiUrl: string;
  readonly #conn: ConnectionOptions;
  readonly #sandboxes = new Map<string, Sandbox>();
  /**
   * Free-tier orgs reject `autoSuspendMs: 0` with a plan-limit error. Once
   * observed, skip sending `autoSuspendMs: 0` on subsequent creates rather
   * than paying a rejected round trip every time.
   */
  #autoSuspendDisableUnsupported = false;

  /** Throws at construction — which is boot — when the key is not set. */
  constructor(options: { readonly apiUrl?: string } = {}) {
    const apiKey = (process.env[KEY_ENV] ?? '').trim();
    // Refused here rather than left to the SDK: given no key, the SDK may fall
    // back to a CLI session on the host, and a deployment must run strictly on
    // the API key it was configured with.
    if (apiKey === '') {
      throw new InstaboxApiError(401, 'missing_api_key', `${KEY_ENV} is not set`, {
        unauthorized: true,
      });
    }
    this.#apiKey = apiKey;
    this.#apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.#conn = { apiKey: this.#apiKey, apiUrl: this.#apiUrl };
  }

  findByName = (name: string): Promise<InstaboxMachine | null> =>
    translated(async () => {
      const all = await Sandbox.list(this.#conn);
      const found = all.find((info) => info.name === name);
      return found === undefined ? null : machineOfInfo(found);
    });

  get = (id: string): Promise<InstaboxMachine | null> =>
    translated(async () => {
      try {
        const cached = this.#sandboxes.get(id);
        if (cached !== undefined) {
          return machineOfInfo(await cached.getInfo());
        }
        const sbx = await Sandbox.connect(id, { ...this.#conn, resume: false });
        this.#sandboxes.set(id, sbx);
        return machineOfInfo(await sbx.getInfo());
      } catch (error: unknown) {
        if (isNotFoundError(error)) {
          this.#sandboxes.delete(id);
          return null;
        }
        throw error;
      }
    });

  list = (metadata: Readonly<Record<string, string>>): Promise<InstaboxMachine[]> =>
    translated(async () => {
      const items = await Sandbox.list({ ...this.#conn, metadata: { ...metadata } });
      return items.map(machineOfInfo);
    });

  create = (spec: InstaboxCreateSpec): Promise<InstaboxMachine> =>
    translated(async () => {
      const baseOpts = {
        ...this.#conn,
        name: spec.name,
        metadata: { ...spec.metadata },
        // Hard rule: never inject the operator's personal Instabox Vault into
        // customer VMs. Omitting org `secrets` leaves none selected either.
        vault: false as const,
        ...(spec.vcpus !== undefined ? { vcpus: spec.vcpus } : {}),
        ...(spec.memoryMiB !== undefined ? { memMiB: spec.memoryMiB } : {}),
      };

      const wantNoAutoSuspend = spec.autoSuspendMs === 0 && !this.#autoSuspendDisableUnsupported;
      const createOpts =
        spec.autoSuspendMs !== undefined && (spec.autoSuspendMs !== 0 || wantNoAutoSuspend)
          ? { ...baseOpts, autoSuspendMs: spec.autoSuspendMs }
          : baseOpts;

      let sbx: Sandbox;
      try {
        sbx = await Sandbox.create(spec.template, createOpts);
      } catch (error: unknown) {
        // Free-tier orgs fix idle auto-suspend to 30 minutes and refuse `0`.
        // Fall back to the plan's default idle window when no custom size was requested.
        if (
          wantNoAutoSuspend &&
          spec.vcpus === undefined &&
          spec.memoryMiB === undefined &&
          isAutoSuspendRejection(error)
        ) {
          this.#autoSuspendDisableUnsupported = true;
          sbx = await Sandbox.create(spec.template, baseOpts);
        } else {
          throw error;
        }
      }

      this.#sandboxes.set(sbx.sandboxId, sbx);
      return machineOfInfo(await sbx.getInfo());
    });

  setMetadata = (id: string, metadata: Readonly<Record<string, string>>): Promise<void> =>
    translated(async () => {
      const sbx = await this.#sandbox(id);
      await sbx.setMetadata({ ...metadata });
    });

  pause = (id: string): Promise<void> =>
    translated(async () => {
      const sbx = await this.#sandbox(id);
      await sbx.pause();
    });

  resume = (id: string): Promise<void> =>
    translated(async () => {
      const sbx = await this.#sandbox(id);
      await sbx.resume();
    });

  stop = (id: string): Promise<void> =>
    translated(async () => {
      const sbx = await this.#sandbox(id);
      await sbx.stop();
    });

  delete = (id: string): Promise<void> =>
    translated(async () => {
      this.#sandboxes.delete(id);
      await Sandbox.kill(id, this.#conn);
    });

  writeFile = (
    id: string,
    path: string,
    content: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void> =>
    translated(async () => {
      const sbx = await this.#sandbox(id);
      await sbx.files.write(
        path,
        content,
        options?.abortSignal !== undefined ? { signal: options.abortSignal } : undefined,
      );
    });

  exec = (
    id: string,
    command: string,
    options?: {
      envs?: Readonly<Record<string, string>>;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    },
  ): Promise<InstaboxExecResult> =>
    translated(async () => {
      const sbx = await this.#sandbox(id);
      const result = await sbx.commands.exec(command, {
        ...(options?.envs !== undefined ? { envs: { ...options.envs } } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.abortSignal !== undefined ? { signal: options.abortSignal } : {}),
      });
      return {
        exitCode: result.timedOut ? null : result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    });

  openTunnel = (id: string): Promise<InstaboxTunnel> =>
    translated(async () => {
      const token = await this.#createSshToken(id);
      try {
        return await Ssh2InstaboxTunnel.connect(token, () =>
          this.#revokeSshToken(id, token.id).catch(() => undefined),
        );
      } catch (error: unknown) {
        await this.#revokeSshToken(id, token.id).catch(() => undefined);
        throw error;
      }
    });

  async #sandbox(id: string): Promise<Sandbox> {
    const cached = this.#sandboxes.get(id);
    if (cached !== undefined) return cached;
    const sbx = await Sandbox.connect(id, { ...this.#conn, resume: false });
    this.#sandboxes.set(id, sbx);
    return sbx;
  }

  /**
   * Mints a short-lived SSH token via `POST /v1/machines/{id}/ssh-tokens`.
   * `@insforge/instabox-sdk@0.9.0` exposes only OpenSSH user certificates
   * (`sshCredentials`), which `ssh2` does not support natively.
   */
  async #createSshToken(machineId: string): Promise<InstaboxSshToken> {
    const response = await fetch(
      `${this.#apiUrl}/v1/machines/${encodeURIComponent(machineId)}/ssh-tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'crewaid-tunnel',
          ttlSeconds: SSH_TOKEN_TTL_SECONDS,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw await parseHttpError(response);
    }
    const raw: unknown = await response.json();
    return parseSshToken(raw);
  }

  async #revokeSshToken(machineId: string, tokenId: string): Promise<void> {
    const response = await fetch(
      `${this.#apiUrl}/v1/machines/${encodeURIComponent(machineId)}/ssh-tokens/${encodeURIComponent(tokenId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.#apiKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw await parseHttpError(response);
    }
  }
}

/**
 * One multiplexed `ssh2` connection to Instabox's SSH gateway, serving local
 * loopback TCP listeners that forward directly to `127.0.0.1:<hostPort>` inside
 * the VM via SSH `direct-tcpip` channels.
 */
class Ssh2InstaboxTunnel implements InstaboxTunnel {
  readonly #client: SshClient;
  readonly #onClose: () => Promise<void>;
  readonly #listeners = new Map<number, Promise<{ server: Server; forward: InstaboxForward }>>();
  readonly #liveSockets = new Set<Socket>();
  readonly #expiryTimer: ReturnType<typeof setTimeout> | null;
  readonly #resolveClosed: () => void;
  readonly closed: Promise<void>;
  #closing: Promise<void> | null = null;

  private constructor(client: SshClient, expiresAt: number | null, onClose: () => Promise<void>) {
    this.#client = client;
    this.#onClose = onClose;
    let resolveClosed = (): void => undefined;
    this.closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;

    const handleDrop = (): void => {
      void this.close();
    };
    this.#client.once('close', handleDrop);
    this.#client.once('end', handleDrop);
    this.#client.on('error', handleDrop);

    if (expiresAt !== null) {
      const delayMs = Math.max(1_000, expiresAt - Date.now() - SSH_TOKEN_REFRESH_MARGIN_MS);
      this.#expiryTimer = setTimeout(() => {
        void this.close();
      }, delayMs);
      this.#expiryTimer.unref();
    } else {
      this.#expiryTimer = null;
    }
  }

  static connect(
    token: InstaboxSshToken,
    onClose: () => Promise<void>,
  ): Promise<Ssh2InstaboxTunnel> {
    return new Promise<Ssh2InstaboxTunnel>((resolve, reject) => {
      const client = new SshClient();
      let settled = false;

      const onReady = (): void => {
        settled = true;
        client.off('error', onError);
        client.off('close', onPrematureClose);
        resolve(new Ssh2InstaboxTunnel(client, token.expiresAt, onClose));
      };
      // Stays attached after a failed handshake: a destroyed client can still
      // emit a late socket error, and an unheard 'error' ends the process.
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        client.off('ready', onReady);
        client.off('close', onPrematureClose);
        client.destroy();
        reject(error);
      };
      const onPrematureClose = (): void => {
        if (settled) return;
        settled = true;
        client.off('ready', onReady);
        client.off('error', onError);
        reject(new Error(`SSH tunnel to ${token.host}:${token.port} closed before ready`));
      };

      client.once('ready', onReady);
      client.on('error', onError);
      client.once('close', onPrematureClose);

      client.connect({
        host: token.host,
        port: token.port,
        username: token.token,
        authHandler: (methodsLeft) => {
          // Instabox SSH tokens authenticate via the SSH `none` method using
          // the token as the username. Refuse retries if `none` is rejected.
          return methodsLeft === null ? 'none' : false;
        },
        hostVerifier: (key: Buffer | string) =>
          verifyHostKeyFingerprint(key, token.hostKeyFingerprint),
        keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
        readyTimeout: SSH_READY_TIMEOUT_MS,
      });
    });
  }

  async forward(hostPort: number): Promise<InstaboxForward> {
    if (this.#closing !== null) {
      throw new Error('the SSH tunnel serving this Instabox computer has closed');
    }
    let entry = this.#listeners.get(hostPort);
    if (entry === undefined) {
      entry = this.#listen(hostPort);
      this.#listeners.set(hostPort, entry);
      entry.catch(() => {
        if (this.#listeners.get(hostPort) === entry) this.#listeners.delete(hostPort);
      });
    }
    return (await entry).forward;
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closing = this.#doClose();
    return this.#closing;
  }

  async #doClose(): Promise<void> {
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);

    for (const socket of this.#liveSockets) socket.destroy();
    this.#liveSockets.clear();

    const listeners = [...this.#listeners.values()];
    this.#listeners.clear();
    await Promise.all(
      listeners.map(async (entry) => {
        const resolved = await entry.catch(() => null);
        if (resolved === null) return;
        await new Promise<void>((resolve) => resolved.server.close(() => resolve()));
      }),
    );

    this.#client.end();
    this.#client.destroy();
    this.#resolveClosed();
    await this.#onClose().catch(() => undefined);
  }

  #listen(hostPort: number): Promise<{ server: Server; forward: InstaboxForward }> {
    return new Promise((resolve, reject) => {
      const server = createServer((local) => this.#relay(hostPort, local));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        // Once listening, an accept failure (EMFILE under load) affects only the
        // connection being accepted; unheard, it would end the process.
        server.on('error', () => undefined);
        server.unref();
        const { port } = server.address() as AddressInfo;
        resolve({ server, forward: { host: '127.0.0.1', port } });
      });
    });
  }

  #relay(hostPort: number, local: Socket): void {
    this.#liveSockets.add(local);
    local.once('close', () => this.#liveSockets.delete(local));
    relayThroughChannel(
      local,
      (callback) =>
        this.#client.forwardOut(
          '127.0.0.1',
          0,
          '127.0.0.1',
          hostPort,
          (error: Error | undefined, channel: ClientChannel | undefined) =>
            callback(error, channel),
        ),
      () => this.#closing !== null,
    );
  }
}

/** Opens one SSH `direct-tcpip` channel; ssh2's `forwardOut`, or a stand-in under test. */
export type OpenRelayChannel = (
  callback: (error: Error | undefined, channel: Duplex | undefined) => void,
) => void;

/**
 * Pipes one accepted loopback connection through a freshly opened SSH channel.
 *
 * The socket and the channel each get an `'error'` listener before anything can
 * fail. An `'error'` event with no listener is fatal to the whole Node process,
 * and a channel is refused whenever nothing listens on the port inside the VM:
 * a container that crashed, is being recreated, or has not come back after a
 * boot. That has to end this one connection, never the orchestrator. The socket
 * is therefore closed with a plain `destroy()`, never `destroy(error)`, which
 * would emit the error again.
 */
export function relayThroughChannel(
  local: Socket,
  open: OpenRelayChannel,
  aborted: () => boolean,
): void {
  local.on('error', () => undefined);
  if (aborted()) {
    local.destroy();
    return;
  }
  local.setNoDelay(true);
  // Hold bytes written immediately on connect (HTTP requests, RFB greetings)
  // until the channel exists to carry them.
  local.pause();

  open((error, channel) => {
    channel?.on('error', () => undefined);
    if (error !== undefined || channel === undefined || local.destroyed || aborted()) {
      channel?.destroy();
      local.destroy();
      return;
    }
    channel.on('error', () => local.destroy());
    channel.once('close', () => local.destroy());
    local.once('close', () => channel.destroy());
    local.pipe(channel);
    channel.pipe(local);
    local.resume();
  });
}

function machineOfInfo(info: SandboxInfo): InstaboxMachine {
  const raw: Machine = info.machine;
  return {
    id: info.sandboxId,
    name: info.name,
    state: info.state,
    metadata: { ...info.metadata },
    vcpus: raw.spec.vcpus,
    memoryMiB: raw.spec.memMiB,
    ready: raw.runtime.ready,
    vault: info.vault,
    cooldownUntil: readOptionalStringField(raw, 'cooldownUntil'),
    maxRunMinutes: readOptionalNumberField(raw, 'maxRunMinutes'),
  };
}

function readOptionalStringField(record: object, key: string): string | null {
  const value: unknown = Reflect.get(record, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readOptionalNumberField(record: object, key: string): number | null {
  const value: unknown = Reflect.get(record, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseSshToken(raw: unknown): InstaboxSshToken {
  if (typeof raw !== 'object' || raw === null) {
    throw new InstaboxApiError(
      502,
      'malformed_ssh_token',
      'Instabox returned an invalid SSH token payload',
      {
        unauthorized: false,
        quotaExceeded: false,
      },
    );
  }
  const id = readOptionalStringField(raw, 'id');
  const token = readOptionalStringField(raw, 'token');
  const host = readOptionalStringField(raw, 'host');
  const port = readOptionalNumberField(raw, 'port');
  const hostKeyFingerprint = readOptionalStringField(raw, 'hostKeyFingerprint');
  const expiresAtRaw = readOptionalStringField(raw, 'expiresAt');
  if (
    id === null ||
    token === null ||
    host === null ||
    port === null ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    hostKeyFingerprint === null
  ) {
    throw new InstaboxApiError(
      502,
      'malformed_ssh_token',
      'Instabox SSH token response is missing required connection fields',
      { unauthorized: false, quotaExceeded: false },
    );
  }
  const parsedExpiry = expiresAtRaw === null ? null : Date.parse(expiresAtRaw);
  const expiresAt = parsedExpiry !== null && Number.isFinite(parsedExpiry) ? parsedExpiry : null;
  return { id, token, host, port, hostKeyFingerprint, expiresAt };
}

async function parseHttpError(response: Response): Promise<InstaboxApiError> {
  const text = await response.text().catch(() => '');
  let code = `http_${response.status}`;
  let message = text.trim() || `Instabox HTTP ${response.status}`;
  let requestId: string | undefined;
  let retryable = response.status >= 500 || response.status === 429;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const envelope: unknown = Reflect.get(parsed, 'error');
      const body = typeof envelope === 'object' && envelope !== null ? envelope : parsed;
      const parsedCode = readOptionalStringField(body, 'code');
      const parsedMessage = readOptionalStringField(body, 'message');
      const parsedReqId = readOptionalStringField(body, 'requestId');
      const parsedRetryable: unknown = Reflect.get(body, 'retryable');
      if (parsedCode !== null) code = parsedCode;
      if (parsedMessage !== null) message = parsedMessage;
      if (parsedReqId !== null) requestId = parsedReqId;
      if (typeof parsedRetryable === 'boolean') retryable = parsedRetryable;
    }
  } catch {
    // Non-JSON error body; keep fallback message.
  }
  return new InstaboxApiError(response.status, code, message, {
    ...(requestId !== undefined ? { requestId } : {}),
    retryable,
    unauthorized: response.status === 401 || response.status === 403,
    quotaExceeded: response.status === 402 || response.status === 429,
  });
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof InstaboxApiError) {
    return error.status === 404 || error.code === 'not_found';
  }
  if (error instanceof InstaboxError) {
    return error.status === 404 || error.code === 'not_found';
  }
  return false;
}

function isAutoSuspendRejection(error: unknown): boolean {
  if (!(error instanceof InstaboxError)) return false;
  if (error.code === 'spec_not_allowed' || error.code === 'auto_suspend_not_allowed') {
    return true;
  }
  return (
    (error.status === 400 || error.status === 403) &&
    /auto.?suspend|idle|free\s+plan/i.test(error.message)
  );
}

async function translated<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (error instanceof InstaboxApiError) throw error;
    if (error instanceof InstaboxAuthError) {
      throw new InstaboxApiError(error.status || 401, error.code, error.message, {
        ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
        retryable: false,
        unauthorized: true,
        quotaExceeded: false,
        cause: error,
      });
    }
    if (error instanceof InstaboxQuotaError) {
      throw new InstaboxApiError(error.status || 429, error.code, error.message, {
        ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
        retryable: error.retryable,
        unauthorized: false,
        quotaExceeded: true,
        cause: error,
      });
    }
    if (error instanceof InstaboxError) {
      throw new InstaboxApiError(error.status, error.code, error.message, {
        ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
        retryable: error.retryable,
        unauthorized: false,
        quotaExceeded: false,
        cause: error,
      });
    }
    throw error;
  }
}
