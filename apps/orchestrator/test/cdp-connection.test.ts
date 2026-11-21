import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { openCdpConnection, type CdpEvent } from '../src/recordings/cdp-connection.js';

/**
 * M4-BE-01 — the CDP wire client.
 *
 * Every test here runs against a REAL WebSocket server in-process: what the
 * client has to get right is framing (answers vs events, interleaved on one
 * socket), timing and teardown, and a mocked socket would decide all three by
 * hand. `ws` is already the transport the orchestrator serves its own §4.2
 * gateway on, so this is the same library on both ends of the wire.
 */

interface CdpServer {
  readonly url: string;
  /** Every frame the server received, in arrival order. */
  readonly received: Record<string, unknown>[];
  /** Upgrade requests, so a test can read the headers a connection carried. */
  readonly upgrades: IncomingMessage[];
  /** Server-side sockets, so a test can drop one mid-flight. */
  readonly sockets: Set<WebSocket>;
  /** Make the server answer every command with a given handler. */
  answerWith(handler: (socket: WebSocket, frame: Record<string, unknown>) => void): void;
  close(): Promise<void>;
}

async function cdpServer(): Promise<CdpServer> {
  const received: Record<string, unknown>[] = [];
  const upgrades: IncomingMessage[] = [];
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();
  let answer: (socket: WebSocket, frame: Record<string, unknown>) => void = () => undefined;

  server.on('upgrade', (request, socket, head) => {
    upgrades.push(request);
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(frame);
      answer(socket, frame);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    upgrades,
    sockets,
    answerWith: (handler) => {
      answer = handler;
    },
    close: async () => {
      for (const socket of [...sockets]) socket.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const running: CdpServer[] = [];

/** One fake CDP server, closed by the `afterEach` below whatever a test does. */
async function startedServer(): Promise<CdpServer> {
  const server = await cdpServer();
  running.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

/** A small connect budget: everything here is loopback. */
const CONNECT = { handshakeTimeoutMs: 1_000, commandTimeoutMs: 1_000 } as const;

describe('openCdpConnection', () => {
  it('opens against a reachable endpoint, and reports the close either way', async () => {
    const server = await startedServer();
    const connection = await openCdpConnection({ url: server.url, ...CONNECT });
    expect(connection.closed).toBe(false);
    expect(server.sockets.size).toBe(1);

    const outcome = vi.fn();
    connection.onClose(outcome);
    await connection.close();

    expect(connection.closed).toBe(true);
    await vi.waitFor(() => {
      expect(outcome).toHaveBeenCalledTimes(1);
    });
    // A close this process asked for is not a failure.
    expect(outcome).toHaveBeenCalledWith(null);
    // Idempotent, and it does not report a second time.
    await connection.close();
    expect(outcome).toHaveBeenCalledTimes(1);
    await expect(connection.send('Browser.getVersion')).rejects.toThrow(/closed/);
  });

  it('refuses to open when nothing is listening, rather than waiting out the handshake', async () => {
    const dead = await startedServer();
    const url = dead.url;
    await dead.close();
    running.splice(running.indexOf(dead), 1);

    await expect(openCdpConnection({ url, ...CONNECT })).rejects.toThrow(/did not open/);
  });

  it('sends the endpoint headers on the upgrade request (D-012)', async () => {
    const server = await startedServer();
    const connection = await openCdpConnection({
      url: server.url,
      headers: { authorization: 'Bearer endpoint-scoped', 'x-crewaid-endpoint': 'cdp' },
      ...CONNECT,
    });

    // The headers are what a provider issued the URL for; dropping them is
    // the connection failure that reads as a sandbox fault (D-012).
    expect(server.upgrades[0]?.headers['authorization']).toBe('Bearer endpoint-scoped');
    expect(server.upgrades[0]?.headers['x-crewaid-endpoint']).toBe('cdp');
    await connection.close();
  });

  it('matches answers to commands by id while several are in flight', async () => {
    const server = await startedServer();
    server.answerWith((socket, frame) => {
      socket.send(JSON.stringify({ id: frame['id'], result: { echoed: frame['method'] } }));
    });
    const connection = await openCdpConnection({ url: server.url, ...CONNECT });

    const [version, enable] = await Promise.all([
      connection.send('Browser.getVersion'),
      connection.send('Page.enable', { unused: true }, 'session-1'),
    ]);

    expect(version).toEqual({ echoed: 'Browser.getVersion' });
    expect(enable).toEqual({ echoed: 'Page.enable' });
    // The optional fields travel verbatim: a dropped `sessionId` would send a
    // target command to the browser session instead, which answers "not found".
    expect(server.received[1]).toMatchObject({
      method: 'Page.enable',
      params: { unused: true },
      sessionId: 'session-1',
    });
    await connection.close();
  });

  it('rejects a command the peer answers with an error', async () => {
    const server = await startedServer();
    server.answerWith((socket, frame) => {
      socket.send(
        JSON.stringify({
          id: frame['id'],
          error: { code: -32601, message: "Nope.method wasn't found" },
        }),
      );
    });
    const connection = await openCdpConnection({ url: server.url, ...CONNECT });

    await expect(connection.send('Nope.method')).rejects.toThrow(
      /Nope\.method failed: Nope\.method wasn't found \(code -32601\)/,
    );
    // An error answer settles that command, not the connection.
    expect(connection.closed).toBe(false);
    await connection.close();
  });

  it('times out a command that is never answered, and ignores the late answer', async () => {
    const server = await startedServer();
    const connection = await openCdpConnection({
      url: server.url,
      handshakeTimeoutMs: 1_000,
      commandTimeoutMs: 50,
    });

    await expect(connection.send('Browser.getVersion')).rejects.toThrow(
      /did not answer within 50 ms/,
    );

    // The answer that arrives afterwards settles nothing and fails nothing —
    // a timeout is the caller's exit, not a protocol violation.
    const [socket] = [...server.sockets];
    socket?.send(JSON.stringify({ id: 1, result: { Browser: 'late' } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connection.closed).toBe(false);
    await connection.close();
  });

  it('delivers protocol events to subscribers, with their session id, until unsubscribed', async () => {
    const server = await startedServer();
    const connection = await openCdpConnection({ url: server.url, ...CONNECT });
    const seen: CdpEvent[] = [];
    const off = connection.on('Page.frameNavigated', (event) => {
      seen.push(event);
    });

    const [socket] = [...server.sockets];
    socket?.send(
      JSON.stringify({
        method: 'Page.frameNavigated',
        params: { frame: { url: 'http://example.com' } },
        sessionId: 'target-1',
      }),
    );
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(seen[0]).toMatchObject({
      method: 'Page.frameNavigated',
      params: { frame: { url: 'http://example.com' } },
      sessionId: 'target-1',
    });

    off();
    socket?.send(JSON.stringify({ method: 'Page.frameNavigated', params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
    await connection.close();
  });

  it('keeps a throwing subscriber from reaching its siblings or the socket', async () => {
    const server = await startedServer();
    const onListenerError = vi.fn();
    const connection = await openCdpConnection({ url: server.url, onListenerError, ...CONNECT });
    connection.on('Page.frameNavigated', () => {
      throw new Error('subscriber bug');
    });
    const sibling = vi.fn();
    connection.on('Page.frameNavigated', sibling);

    const [socket] = [...server.sockets];
    socket?.send(JSON.stringify({ method: 'Page.frameNavigated', params: {} }));

    await vi.waitFor(() => {
      expect(sibling).toHaveBeenCalledTimes(1);
    });
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), 'Page.frameNavigated');
    expect(connection.closed).toBe(false);
    await connection.close();
  });

  it('drops a frame that is not JSON instead of failing the connection', async () => {
    const server = await startedServer();
    server.answerWith((socket, frame) => {
      socket.send(JSON.stringify({ id: frame['id'], result: {} }));
    });
    const connection = await openCdpConnection({ url: server.url, ...CONNECT });

    const [socket] = [...server.sockets];
    socket?.send('this is not a CDP frame');
    // The framer is still alive and still matches answers to commands.
    await expect(connection.send('Browser.getVersion')).resolves.toEqual({});
    expect(connection.closed).toBe(false);
    await connection.close();
  });

  it('rejects in-flight commands and reports the drop when the peer vanishes', async () => {
    const server = await startedServer();
    const connection = await openCdpConnection({ url: server.url, ...CONNECT });
    const dropped = vi.fn();
    connection.onClose(dropped);
    const pending = connection.send('Browser.getVersion');

    for (const socket of [...server.sockets]) socket.terminate();

    await expect(pending).rejects.toThrow(/dropped|closed/);
    await vi.waitFor(() => {
      expect(dropped).toHaveBeenCalledTimes(1);
    });
    expect(dropped.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(connection.closed).toBe(true);

    // A listener registered after the fact hears how it ended rather than
    // never — the socket can die between opening it and wiring it up.
    const late = vi.fn();
    connection.onClose(late);
    expect(late).toHaveBeenCalledWith(expect.any(Error));
  });
});
