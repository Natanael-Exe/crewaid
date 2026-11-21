/**
 * An in-process stand-in for the Cloudflare control Worker, for tests.
 *
 * It serves the Worker's routes and its tunnel WebSocket, relaying each stream
 * to a local TCP server that plays the port inside the computer. Computers are
 * records in memory: a start marks one running and restores its "workspace",
 * a stop saves and marks it stopped, as the real Worker does.
 *
 * Not exported from the package: it is test support, and lives in `src` only
 * so the test files can import it without a second build config.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ComputerStatus } from './cf-control.js';

export const FAKE_SECRET = 'fake-control-secret-0123456789abcdef';

export interface FakeComputer {
  id: string;
  running: boolean;
  runtimeCreatedAt: number | null;
  orphanedSince: number | null;
  savedAt: number | null;
  pendingRetirements: string[];
  retired: string[];
  exit: { code: number | null; error?: string; at: number } | null;
  starts: number;
  stops: number;
}

export class FakeCloudflareControl {
  readonly computers = new Map<string, FakeComputer>();
  readonly calls: string[] = [];
  /** Remote port → the local port that plays it. */
  readonly ports = new Map<number, number>();
  /** When set, the next start leaves the computer exited with this code. */
  exitOnStart: number | null = null;
  url = '';

  readonly #http: Server;
  readonly #wss = new WebSocketServer({ noServer: true });

  constructor() {
    this.#http = createServer((req, res) => void this.#route(req, res));
    this.#http.on('upgrade', (req, socket, head) => {
      const match = /^\/v1\/computers\/([^/]+)\/tcp\/(\d+)$/.exec(req.url ?? '');
      if (req.headers.authorization !== `Bearer ${FAKE_SECRET}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const computer =
        match === null ? undefined : this.computers.get(decodeURIComponent(match[1] ?? ''));
      if (match === null || computer === undefined || !computer.running) {
        socket.end('HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#forward(ws, Number(match[2])));
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

  add(id: string, patch: Partial<FakeComputer> = {}): FakeComputer {
    const computer: FakeComputer = {
      id,
      running: false,
      runtimeCreatedAt: null,
      orphanedSince: null,
      savedAt: null,
      pendingRetirements: [],
      retired: [],
      exit: null,
      starts: 0,
      stops: 0,
      ...patch,
    };
    this.computers.set(id, computer);
    return computer;
  }

  /** The number of tunnels currently open, as the real Worker would hold them. */
  get openTunnels(): number {
    return this.#wss.clients.size;
  }

  #forward(ws: WebSocket, port: number): void {
    const target = this.ports.get(port);
    if (target === undefined) {
      ws.close(4002, 'nothing listening');
      return;
    }
    const guest = connect(target, '127.0.0.1');
    guest.on('data', (chunk: Buffer) => ws.send(chunk, { binary: true }));
    guest.on('end', () => ws.close(1000));
    guest.on('error', () => ws.close(4002, 'guest port unreachable'));
    ws.on('message', (data: Buffer) => guest.write(data));
    ws.on('close', () => guest.end());
  }

  #view(id: string): ComputerStatus {
    const c = this.computers.get(id);
    if (c === undefined) return { id, exists: false, running: false };
    return {
      id,
      exists: true,
      running: c.running,
      runtimeCreatedAt: c.runtimeCreatedAt,
      orphanedSince: c.orphanedSince,
      savedAt: c.savedAt,
      exit: c.exit,
      pendingRetirements: c.pendingRetirements,
    };
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    this.calls.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${FAKE_SECRET}`) {
      send(res, 401, { code: 'unauthorized', message: 'unauthorized' });
      return;
    }
    const body = await readJson(req);
    if (req.method === 'GET' && url.pathname === '/v1/computers') {
      send(res, 200, { computers: [...this.computers.keys()].map((id) => this.#view(id)) });
      return;
    }
    const match = /^\/v1\/computers\/([^/]+)(?:\/([a-z-]+))?$/.exec(url.pathname);
    if (match === null) {
      send(res, 404, { code: 'route', message: 'not found' });
      return;
    }
    const id = decodeURIComponent(match[1] ?? '');
    const action = match[2];
    const c = this.computers.get(id);
    if (req.method === 'GET' && action === undefined) {
      send(res, 200, this.#view(id));
    } else if (action === 'provision') {
      if (c === undefined) this.add(id);
      send(res, 200, this.#view(id));
    } else if (c === undefined && action === 'retain') {
      send(res, 200, { outcome: 'absent' });
    } else if (c === undefined) {
      send(res, 404, { code: 'workspace_missing', message: `computer ${id} has no workspace` });
    } else if (action === 'start') {
      c.starts += 1;
      if (this.exitOnStart !== null) {
        c.running = false;
        c.exit = { code: this.exitOnStart, error: 'exited while starting', at: Date.now() };
        this.exitOnStart = null;
      } else if (!c.running) {
        c.running = true;
        c.runtimeCreatedAt ??= Date.now();
        c.orphanedSince = null;
        c.exit = null;
        // Applied at every start; pending until a save captures them.
        for (const botId of c.pendingRetirements)
          if (!c.retired.includes(botId)) c.retired.push(botId);
      }
      send(res, 200, this.#view(id));
    } else if (action === 'stop') {
      if (c.running) {
        c.stops += 1;
        c.savedAt = Date.now();
        c.pendingRetirements = [];
        c.running = false;
      }
      send(res, 200, this.#view(id));
    } else if (action === 'retire-profile') {
      const botId = String(body['botId']);
      if (c.running) c.retired.push(botId);
      if (!c.pendingRetirements.includes(botId)) c.pendingRetirements.push(botId);
      send(res, 200, { retired: c.running, deferred: !c.running });
    } else if (action === 'retain') {
      const orphaned = body['orphaned'] === true;
      const now = Number(body['now']);
      const retentionMs = Number(body['retentionMs']);
      if (!orphaned) {
        c.orphanedSince = null;
        send(res, 200, { outcome: 'retained' });
      } else if (c.running) {
        send(res, 200, { outcome: 'in-use' });
      } else {
        c.orphanedSince ??= now;
        if (now - c.orphanedSince < retentionMs) send(res, 200, { outcome: 'retained' });
        else {
          this.computers.delete(id);
          send(res, 200, { outcome: 'deleted' });
        }
      }
    } else {
      send(res, 404, { code: 'route', message: `no route ${action ?? ''}` });
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}
