/**
 * The Cloudflare control Worker's API, as this provider uses it.
 *
 * The only file that talks to the Worker and the only one that reads
 * `SANDBOX_CF_CONTROL_SECRET`. The secret starts, stops and opens a shell-level
 * tunnel into every computer on the deployment, so it stays in the
 * orchestrator's process and is never passed into a machine.
 *
 * The Worker's routes are documented in `infra/cloudflare/control-worker`.
 */

import WebSocket from 'ws';

const SECRET_ENV = 'SANDBOX_CF_CONTROL_SECRET';

/** One computer as the Worker reports it. */
export interface ComputerStatus {
  readonly id: string;
  /** A workspace record exists: the computer was provisioned and not yet deleted. */
  readonly exists: boolean;
  readonly running: boolean;
  /** When a runtime first started on this workspace; `null` before the first start. */
  readonly runtimeCreatedAt?: number | null;
  readonly orphanedSince?: number | null;
  readonly savedAt?: number | null;
  readonly backupBytes?: number | null;
  readonly startedAt?: number | null;
  /** How the last runtime ended, when it ended on its own. */
  readonly exit?: {
    readonly code: number | null;
    readonly error?: string;
    readonly at: number;
  } | null;
  readonly pendingRetirements?: readonly string[];
}

export type RetentionOutcome = 'absent' | 'in-use' | 'retained' | 'deleted';

/** A refused or failed call, with the Worker's own code and message. */
export class CloudflareControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudflareControlError';
  }
}

export interface CloudflareControlOptions {
  /** The Worker's origin, `SANDBOX_CF_CONTROL_URL`. */
  readonly url: string;
  /** Defaults to `SANDBOX_CF_CONTROL_SECRET`. */
  readonly secret?: string;
  /** Seam for tests. */
  readonly fetch?: typeof fetch;
}

/**
 * Whether this process has the secret, without handing it out. The boot check
 * asks this so a missing credential fails at start, not at the first computer
 * someone opens.
 */
export function cloudflareControlSecretConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[SECRET_ENV] ?? '').trim() !== '';
}

export class CloudflareControl {
  readonly #url: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;

  constructor(options: CloudflareControlOptions) {
    const secret = (options.secret ?? process.env[SECRET_ENV] ?? '').trim();
    if (secret === '') {
      throw new Error(`${SECRET_ENV} is required for the Cloudflare sandbox provider`);
    }
    this.#secret = secret;
    this.#url = options.url.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  async list(): Promise<readonly ComputerStatus[]> {
    return (await this.#request<{ computers: ComputerStatus[] }>('GET', '/v1/computers')).computers;
  }

  status(id: string): Promise<ComputerStatus> {
    return this.#request('GET', this.#path(id));
  }

  provision(id: string): Promise<ComputerStatus> {
    return this.#request('POST', `${this.#path(id)}/provision`, {});
  }

  /** Restore the workspace and start the desktop. Resolves once the container runs. */
  start(id: string): Promise<ComputerStatus> {
    return this.#request('POST', `${this.#path(id)}/start`, {});
  }

  /** Close the bots' browsers, save the workspace, destroy the container. */
  stop(id: string): Promise<ComputerStatus> {
    return this.#request('POST', `${this.#path(id)}/stop`, {});
  }

  retireProfile(id: string, botId: string): Promise<{ retired: boolean; deferred: boolean }> {
    return this.#request('POST', `${this.#path(id)}/retire-profile`, { botId });
  }

  async retain(
    id: string,
    options: { orphaned: boolean; now: number; retentionMs: number },
  ): Promise<RetentionOutcome> {
    return (
      await this.#request<{ outcome: RetentionOutcome }>(
        'POST',
        `${this.#path(id)}/retain`,
        options,
      )
    ).outcome;
  }

  /**
   * One raw TCP connection to `port` inside the computer, as a WebSocket of
   * binary frames. Rejects on a refused upgrade, so a wrong secret or a
   * stopped computer shows up before any byte is relayed.
   */
  openTunnel(id: string, port: number): Promise<WebSocket> {
    const url = `${this.#url.replace(/^http/, 'ws')}${this.#path(id)}/tcp/${port}`;
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.#secret}` },
        perMessageDeflate: false,
      });
      socket.binaryType = 'nodebuffer';
      const onError = (error: Error) => reject(error);
      socket.once('open', () => {
        socket.off('error', onError);
        resolve(socket);
      });
      // Kept through a refused handshake: terminate() emits an 'error' as it
      // tears the request down, and one with no listener ends the process.
      socket.on('error', onError);
      socket.once('unexpected-response', (_request, response) => {
        socket.terminate();
        reject(
          new CloudflareControlError(
            response.statusCode ?? 0,
            'tunnel_refused',
            `tunnel to port ${port} was refused (${response.statusCode ?? 'no status'})`,
          ),
        );
      });
    });
  }

  #path(id: string): string {
    return `/v1/computers/${encodeURIComponent(id)}`;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(this.#url + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.#secret}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = parseJson(await response.text());
    if (!response.ok) {
      const detail = (parsed ?? {}) as { code?: unknown; message?: unknown };
      throw new CloudflareControlError(
        response.status,
        typeof detail.code === 'string' ? detail.code : 'http_error',
        typeof detail.message === 'string'
          ? detail.message
          : `${method} ${path} answered ${response.status}`,
      );
    }
    return parsed as T;
  }
}

/** `null` for an empty or non-JSON body: an error page from a proxy is not the Worker's answer. */
function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
