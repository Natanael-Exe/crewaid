/**
 * DigitalOcean Harness Runtime's API, as this provider uses it.
 *
 * The only file that talks to `api.digitalocean.com` and the only one that
 * reads `DIGITALOCEAN_ACCESS_TOKEN`. The token grants everything the team can
 * do, so it stays in the orchestrator's process: it is never passed to a
 * machine, and nothing else in the repo needs to know its name.
 *
 * Shapes follow `digitalocean/godo`'s `hosted_agents.go`, the client `doctl`
 * is built on: sessions under `/v2/agents/sessions`, environments (called
 * configs on the wire) under `/v2/agents/configs`, and the port-forward
 * WebSocket at `/v2/agents/sessions/{id}/port-forward/{port}`.
 */

import WebSocket from 'ws';

export const DEFAULT_API_URL = 'https://api.digitalocean.com';
const TOKEN_ENV = 'DIGITALOCEAN_ACCESS_TOKEN';

export type SessionStatus =
  | 'SESSION_STATUS_UNSPECIFIED'
  | 'SESSION_STATUS_PROVISIONING'
  | 'SESSION_STATUS_READY'
  | 'SESSION_STATUS_DETACHED'
  | 'SESSION_STATUS_DESTROYING'
  | 'SESSION_STATUS_DESTROYED'
  | 'SESSION_STATUS_FAILED'
  | 'SESSION_STATUS_PAUSED';

/** The subset of godo's `HostedAgentSession` this provider reads. */
export interface HarnessSession {
  readonly session_id: string;
  readonly name?: string;
  readonly status: SessionStatus;
  readonly created_at?: string;
  readonly pause_reason?: string;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A refused or failed API call, with DigitalOcean's own id and message. */
export class DigitalOceanApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'DigitalOceanApiError';
  }
}

/**
 * The port-forward close codes (godo's port-forward RFC). The reason text on
 * the wire is fixed and non-diagnostic by contract, so the code is what a
 * caller acts on.
 */
export const TUNNEL_CLOSE = {
  sessionEnded: 4001,
  nothingListening: 4002,
  retryable: 4011,
} as const;

export interface DigitalOceanApiOptions {
  /** Defaults to `DIGITALOCEAN_ACCESS_TOKEN`. */
  readonly token?: string;
  /**
   * Defaults to the public API. A session is bound to the API host that
   * created it, so every call — the tunnel included — must use the same one.
   */
  readonly apiUrl?: string;
  /** Seam for tests. */
  readonly fetch?: typeof fetch;
}

/**
 * Whether this process has a token, without handing it out. The orchestrator's
 * boot check asks this so a missing credential fails at start, not at the
 * first computer someone opens.
 */
export function digitalOceanTokenConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[TOKEN_ENV] ?? '').trim() !== '';
}

const TERMINAL: ReadonlySet<SessionStatus> = new Set([
  'SESSION_STATUS_DESTROYING',
  'SESSION_STATUS_DESTROYED',
  'SESSION_STATUS_FAILED',
]);

export class DigitalOceanApi {
  readonly #token: string;
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: DigitalOceanApiOptions = {}) {
    const token = (options.token ?? process.env[TOKEN_ENV] ?? '').trim();
    if (token === '') {
      throw new Error(`${TOKEN_ENV} is required for the DigitalOcean sandbox provider`);
    }
    this.#token = token;
    this.#apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  // environments (configs on the wire)

  /**
   * The id of the environment named `name`, creating it from `manifestYaml`
   * when there is none. Every session is created from this one environment
   * by id, so creating a session no longer leaves a saved environment behind
   * the way creating one from a manifest does.
   */
  async ensureEnvironment(name: string, manifestYaml: string): Promise<string> {
    let pageToken = '';
    do {
      const query = pageToken === '' ? '' : `?page_token=${encodeURIComponent(pageToken)}`;
      const page = await this.#request<{
        configs?: { id: string; name: string }[];
        next_page_token?: string;
      }>('GET', `/v2/agents/configs${query}`);
      const found = page.configs?.find((config) => config.name === name);
      if (found !== undefined) return found.id;
      pageToken = page.next_page_token ?? '';
    } while (pageToken !== '');

    const created = await this.#request<{ config?: { id: string } }>('POST', '/v2/agents/configs', {
      name,
      manifest_yaml: manifestYaml,
    });
    if (created.config?.id === undefined) {
      throw new DigitalOceanApiError(502, 'no_config', 'environment create returned no id', null);
    }
    return created.config.id;
  }

  // sessions

  async createSession(name: string, configId: string): Promise<HarnessSession> {
    const created = await this.#request<{ session?: HarnessSession }>(
      'POST',
      '/v2/agents/sessions',
      {
        name,
        config_id: configId,
      },
    );
    if (created.session === undefined) {
      throw new DigitalOceanApiError(502, 'no_session', 'session create returned no session', null);
    }
    return created.session;
  }

  /** `null` when DigitalOcean has no such session. */
  async getSession(sessionId: string): Promise<HarnessSession | null> {
    try {
      const found = await this.#request<{ session?: HarnessSession }>(
        'GET',
        `/v2/agents/sessions/${encodeURIComponent(sessionId)}`,
      );
      return found.session ?? null;
    } catch (error: unknown) {
      if (error instanceof DigitalOceanApiError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Every live session — not destroying, destroyed or failed — across pages.
   * Sessions carry no labels, so a provider recognises its own by name.
   */
  async listSessions(): Promise<HarnessSession[]> {
    const sessions: HarnessSession[] = [];
    let pageToken = '';
    do {
      const query = pageToken === '' ? '' : `?page_token=${encodeURIComponent(pageToken)}`;
      const page = await this.#request<{ sessions?: HarnessSession[]; next_page_token?: string }>(
        'GET',
        `/v2/agents/sessions${query}`,
      );
      for (const session of page.sessions ?? []) {
        if (!TERMINAL.has(session.status)) sessions.push(session);
      }
      pageToken = page.next_page_token ?? '';
    } while (pageToken !== '');
    return sessions;
  }

  /** The live session with exactly this name, or `null`. Names are unique per team. */
  async findSessionByName(name: string): Promise<HarnessSession | null> {
    const page = await this.#request<{ sessions?: HarnessSession[] }>(
      'GET',
      `/v2/agents/sessions?name=${encodeURIComponent(name)}`,
    );
    // Filtered here as well: whether the server matches `name` exactly is
    // not documented, and a prefix match would hand one computer another's.
    return (
      page.sessions?.find((session) => session.name === name && !TERMINAL.has(session.status)) ??
      null
    );
  }

  pause(sessionId: string): Promise<void> {
    return this.#request('POST', `/v2/agents/sessions/${encodeURIComponent(sessionId)}/pause`, {});
  }

  resume(sessionId: string): Promise<void> {
    return this.#request('POST', `/v2/agents/sessions/${encodeURIComponent(sessionId)}/resume`, {});
  }

  /** Removes the session AND its disk: on this host the runtime is the workspace. */
  destroy(sessionId: string): Promise<void> {
    return this.#request('DELETE', `/v2/agents/sessions/${encodeURIComponent(sessionId)}`);
  }

  /**
   * DigitalOcean's own exec: one request, one response, run as root, no stdin
   * and no stream. The provider uses it only where the bridge cannot answer —
   * starting the desktop, and the workspace markers that must work while it
   * is down. Everything else goes through the bridge's `/exec`.
   */
  async exec(
    sessionId: string,
    argv: readonly string[],
    options: { workdir?: string; timeoutSeconds?: number } = {},
  ): Promise<ExecResult> {
    const result = await this.#request<{ exit_code?: number; stdout?: string; stderr?: string }>(
      'POST',
      `/v2/agents/sessions/${encodeURIComponent(sessionId)}/sandbox/exec`,
      {
        argv,
        ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
        ...(options.timeoutSeconds !== undefined
          ? { timeout_seconds: options.timeoutSeconds }
          : {}),
      },
    );
    return {
      exitCode: result.exit_code ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  // tunnel

  /**
   * One port-forward stream to `port` inside the session, open and ready.
   * Rejects with the HTTP status when the upgrade is refused, which is how a
   * wrong token or a gone session shows up before any byte is relayed.
   */
  openPortForward(sessionId: string, port: number): Promise<WebSocket> {
    const url =
      this.#apiUrl.replace(/^http/, 'ws') +
      `/v2/agents/sessions/${encodeURIComponent(sessionId)}/port-forward/${port}`;
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.#token}` },
        perMessageDeflate: false,
      });
      socket.binaryType = 'nodebuffer';
      const onError = (error: Error) => reject(error);
      socket.once('open', () => {
        socket.off('error', onError);
        resolve(socket);
      });
      // Kept through a refused handshake: terminate emits an 'error' as it
      // tears the request down, and one with no listener ends the process.
      // The promise has already settled by then, so the extra reject is inert.
      socket.on('error', onError);
      socket.once('unexpected-response', (_request, response) => {
        socket.terminate();
        reject(
          new DigitalOceanApiError(
            response.statusCode ?? 0,
            'tunnel_refused',
            `port-forward to ${port} was refused (${response.statusCode ?? 'no status'})`,
            headerValue(response.headers['x-request-id']),
          ),
        );
      });
    });
  }

  // plumbing

  async #request<T = void>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(this.#apiUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      let code = 'http_error';
      let message = text.slice(0, 300) || response.statusText;
      try {
        const parsed = JSON.parse(text) as { id?: unknown; message?: unknown };
        if (typeof parsed.id === 'string') code = parsed.id;
        if (typeof parsed.message === 'string') message = parsed.message;
      } catch {
        // Not JSON — an edge proxy's page. Keep the truncated text.
      }
      throw new DigitalOceanApiError(
        response.status,
        code,
        `${method} ${path.split('?')[0]}: ${response.status} ${message}`,
        response.headers.get('x-request-id'),
      );
    }
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
