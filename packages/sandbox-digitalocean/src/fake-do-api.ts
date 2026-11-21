/**
 * An in-process stand-in for DigitalOcean's Harness Runtime API, for tests.
 *
 * It serves the routes `DigitalOceanApi` calls with the shapes godo documents,
 * and the port-forward WebSocket, relaying each stream to a local TCP server
 * that plays the port inside the machine. Like the real service, a stream
 * opened to a paused session resumes it, and a port with nothing listening
 * closes with 4002.
 *
 * Not exported from the package: it is test support, and lives in `src` only
 * so the test files can import it without a second build config.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

import type { HarnessSession, SessionStatus } from './do-api.js';

export const FAKE_TOKEN = 'dop_v1_test';

interface FakeSession {
  session_id: string;
  name: string;
  status: SessionStatus;
  pause_reason?: string;
  config_id: string;
}

export interface ExecCall {
  readonly sessionId: string;
  readonly argv: readonly string[];
}

export class FakeDigitalOcean {
  readonly sessions = new Map<string, FakeSession>();
  readonly configs: { id: string; name: string; manifest_yaml: string }[] = [];
  readonly execs: ExecCall[] = [];
  readonly calls: string[] = [];
  /** Remote port → the local port that plays it. */
  readonly ports = new Map<number, number>();
  /** Each session's runtime marker, kept as the file on its disk would be: written once. */
  readonly runtimeMarkers = new Map<string, number>();
  /** Answers DigitalOcean's exec; defaults to the marker programs' happy path. */
  execHandler: (call: ExecCall) => { exit_code: number; stdout: string; stderr: string } = (call) =>
    defaultExec(call, this.runtimeMarkers);
  url = '';

  readonly #http: Server;
  readonly #wss = new WebSocketServer({ noServer: true });
  #next = 1;

  constructor() {
    this.#http = createServer((req, res) => void this.#route(req, res));
    this.#http.on('upgrade', (req, socket, head) => {
      const match = /^\/v2\/agents\/sessions\/([^/]+)\/port-forward\/(\d+)$/.exec(req.url ?? '');
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const session = match === null ? undefined : this.sessions.get(match[1] ?? '');
      if (match === null || session === undefined) {
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) =>
        this.#forward(ws, session, Number(match[2])),
      );
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#http.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.#http.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const client of this.#wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  addSession(name: string, status: SessionStatus = 'SESSION_STATUS_PAUSED'): FakeSession {
    const session: FakeSession = {
      session_id: `01fake${String(this.#next++).padStart(4, '0')}`,
      name,
      status,
      ...(status === 'SESSION_STATUS_PAUSED' ? { pause_reason: 'manual' } : {}),
      config_id: 'cfg-existing',
    };
    this.sessions.set(session.session_id, session);
    return session;
  }

  #forward(ws: WebSocket, session: FakeSession, port: number): void {
    // The real service resumes a paused session to open a tunnel into it.
    if (session.status === 'SESSION_STATUS_PAUSED') {
      session.status = 'SESSION_STATUS_READY';
      delete session.pause_reason;
    }
    const target = this.ports.get(port);
    if (target === undefined) {
      ws.close(4002, 'guest port unreachable');
      return;
    }
    const guest = connect(target, '127.0.0.1');
    guest.on('data', (chunk: Buffer) => ws.send(chunk, { binary: true }));
    guest.on('end', () => ws.close(1000));
    guest.on('error', () => ws.close(4002, 'guest port unreachable'));
    ws.on('message', (data: Buffer) => guest.write(data));
    ws.on('close', () => guest.end());
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    this.calls.push(`${req.method} ${path}`);
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      send(res, 401, { id: 'unauthorized', message: 'Unable to authenticate you' });
      return;
    }
    const body = await readJson(req);
    const bySession = /^\/v2\/agents\/sessions\/([^/]+)(\/.*)?$/.exec(path);

    if (req.method === 'GET' && path === '/v2/agents/configs') {
      send(res, 200, { configs: this.configs.map(({ id, name }) => ({ id, name })) });
    } else if (req.method === 'POST' && path === '/v2/agents/configs') {
      const config = {
        id: `cfg-${this.configs.length + 1}`,
        name: String(body['name']),
        manifest_yaml: String(body['manifest_yaml']),
      };
      this.configs.push(config);
      send(res, 201, { config: { id: config.id, name: config.name } });
    } else if (req.method === 'GET' && path === '/v2/agents/sessions') {
      const name = url.searchParams.get('name');
      const sessions = [...this.sessions.values()]
        .filter((s) => name === null || s.name.startsWith(name))
        .map(view);
      send(res, 200, { sessions, next_page_token: '' });
    } else if (req.method === 'POST' && path === '/v2/agents/sessions') {
      const name = String(body['name']);
      if ([...this.sessions.values()].some((s) => s.name === name)) {
        send(res, 409, { id: 'conflict', message: 'name in use' });
        return;
      }
      const session: FakeSession = {
        session_id: `01fake${String(this.#next++).padStart(4, '0')}`,
        name,
        status: 'SESSION_STATUS_READY',
        config_id: String(body['config_id']),
      };
      this.sessions.set(session.session_id, session);
      send(res, 201, { session: view(session) });
    } else if (bySession !== null) {
      const session = this.sessions.get(bySession[1] ?? '');
      const action = bySession[2] ?? '';
      if (session === undefined) {
        send(res, 404, { id: 'not_found', message: 'session not found' });
      } else if (req.method === 'GET' && action === '') {
        send(res, 200, { session: view(session) });
      } else if (req.method === 'POST' && action === '/pause') {
        // As the real service answers: a warm session never pauses.
        const config = this.configs.find((c) => c.id === session.config_id);
        if (config?.manifest_yaml.includes('keep_warm: true') === true) {
          send(res, 409, {
            error: {
              code: 409,
              message:
                'session declares keep_warm and cannot be paused; stop or destroy it instead',
            },
          });
          return;
        }
        session.status = 'SESSION_STATUS_PAUSED';
        session.pause_reason = 'manual';
        send(res, 200, {});
      } else if (req.method === 'POST' && action === '/resume') {
        session.status = 'SESSION_STATUS_READY';
        delete session.pause_reason;
        send(res, 200, {});
      } else if (req.method === 'DELETE' && action === '') {
        this.sessions.delete(session.session_id);
        res.writeHead(204).end();
      } else if (req.method === 'POST' && action === '/sandbox/exec') {
        // DigitalOcean's exec resumes a paused session too.
        session.status = 'SESSION_STATUS_READY';
        delete session.pause_reason;
        const call = { sessionId: session.session_id, argv: body['argv'] as string[] };
        this.execs.push(call);
        send(res, 200, this.execHandler(call));
      } else {
        send(res, 404, { id: 'not_found', message: `no route ${req.method} ${path}` });
      }
    } else {
      send(res, 404, { id: 'not_found', message: `no route ${req.method} ${path}` });
    }
  }
}

/** The marker programs' happy path, and the launcher reporting it started. */
function defaultExec(
  call: ExecCall,
  runtimeMarkers: Map<string, number>,
): { exit_code: number; stdout: string; stderr: string } {
  const argv = call.argv;
  const mode = argv[argv.length - 1];
  if (argv.includes('-c') && argv.some((a) => a.includes('.crewaid-runtime-created-at'))) {
    if (mode === 'write' && !runtimeMarkers.has(call.sessionId)) {
      runtimeMarkers.set(call.sessionId, Number(argv[4]));
    }
    const marker = runtimeMarkers.get(call.sessionId);
    return {
      exit_code: 0,
      stdout: `crewaid-runtime:${marker ?? 'none'}\n`,
      stderr: '',
    };
  }
  if (argv.includes('-c') && argv.some((a) => a.includes('.crewaid-orphaned-at'))) {
    return {
      exit_code: 0,
      stdout: mode === 'clear' ? 'clear\n' : `crewaid-retention:${argv[4]}\n`,
      stderr: '',
    };
  }
  return { exit_code: 0, stdout: 'ok\n', stderr: '' };
}

function view(session: FakeSession): HarnessSession {
  return {
    session_id: session.session_id,
    name: session.name,
    status: session.status,
    ...(session.pause_reason !== undefined ? { pause_reason: session.pause_reason } : {}),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'x-request-id': 'req-test' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}
