import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { SCREEN_STREAM_PATH } from '@crewaid/shared';
import { SCREEN_STREAM_MAX_CLIENT_FRAME_BYTES, type ScreenUpstream } from '@crewaid/screen-stream';

import { ScreenStreamHost } from '../src/screen/screen-stream.host.js';
import { ScreenTicketService } from '../src/screen/screen-ticket.service.js';

const COMPUTER = {
  state: 'RUNNING',
  sessionId: 'screen-host-session',
  widthPx: 1280,
  heightPx: 800,
};
const BOT_ID = 'clx9z8y7x6w5v4u3t2s1r0q9';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

/** Real sockets and tickets; only the database and the computer are fixtures. */
describe('screen stream host failure isolation', () => {
  let host: ScreenStreamHost;
  let http: Server;
  let tickets: ScreenTicketService;
  let port: number;
  const findFirst = vi.fn<() => Promise<typeof COMPUTER | null>>();
  const closeUpstream = vi.fn();
  const setQuality = vi.fn();
  const upstream: ScreenUpstream = {
    isStreaming: true,
    screen: null,
    onReady: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    requestFullRepaint: () => undefined,
    setQuality,
    sendInput: () => true,
    close: closeUpstream,
  };
  const openUpstream = vi.fn(async () => ({ upstream }));

  beforeEach(async () => {
    findFirst.mockReset().mockResolvedValue(COMPUTER);
    closeUpstream.mockClear();
    setQuality.mockClear();
    openUpstream.mockReset().mockResolvedValue({ upstream });
    tickets = new ScreenTicketService();
    host = new ScreenStreamHost(
      { sandbox: { findFirst } } as never,
      { open: openUpstream } as never,
      tickets,
    );
    http = createServer();
    http.on('upgrade', (request, socket, head) => {
      host.server.handleUpgrade(request, socket, head, (ws) => {
        host.server.emit('connection', ws, request);
      });
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    port = (http.address() as { port: number }).port;
  });

  afterEach(async () => {
    for (const socket of host.server.clients) socket.terminate();
    host.onModuleDestroy();
    await new Promise<void>((resolve, reject) => {
      http.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function open() {
    const ticket = tickets.sign({
      v: 1,
      aud: 'crewaid-screen',
      session: COMPUTER.sessionId,
      botId: BOT_ID,
      port: 5901,
      exp: Date.now() + 60_000,
      jti: randomUUID(),
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}${SCREEN_STREAM_PATH}?ticket=${ticket}`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await once(socket, 'open');
    const serverSocket = [...host.server.clients].at(-1);
    if (serverSocket === undefined) throw new Error('no server socket');
    return { socket, serverSocket, closed };
  }

  async function expectHealthyConnection(): Promise<void> {
    await open();
    await vi.waitFor(() => expect(host.streamCount()).toBe(1));
    expect(openUpstream).toHaveBeenCalledTimes(1);
  }

  it('rejects an oversized frame while the lookup is pending and keeps serving viewers', async () => {
    const lookup = deferred<typeof COMPUTER>();
    findFirst.mockReturnValueOnce(lookup.promise);
    const viewer = await open();
    const serverClosed = waitForClose(viewer.serverSocket);
    viewer.socket.send(Buffer.alloc(SCREEN_STREAM_MAX_CLIENT_FRAME_BYTES + 1));
    expect((await viewer.closed).code).toBe(1009);
    await serverClosed;
    lookup.resolve(COMPUTER);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(host.streamCount()).toBe(0);
    expect(openUpstream).not.toHaveBeenCalled();
    await expectHealthyConnection();
  });

  it('closes only the affected viewer when its computer lookup rejects', async () => {
    findFirst.mockRejectedValueOnce(new Error('private database failure detail'));
    const viewer = await open();
    expect(await viewer.closed).toEqual({ code: 1011, reason: 'The display could not be opened.' });
    expect(host.streamCount()).toBe(0);
    expect(openUpstream).not.toHaveBeenCalled();
    await expectHealthyConnection();
  });

  it('opens no upstream for a viewer that closed before the computer lookup finished', async () => {
    const lookup = deferred<typeof COMPUTER>();
    findFirst.mockReturnValueOnce(lookup.promise);
    const viewer = await open();
    const serverClosed = waitForClose(viewer.serverSocket);
    viewer.socket.close();
    await serverClosed;
    await viewer.closed;
    lookup.resolve(COMPUTER);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(host.streamCount()).toBe(0);
    expect(openUpstream).not.toHaveBeenCalled();
    await expectHealthyConnection();
  });

  it('closes an upstream that finishes opening after its viewer has left', async () => {
    const connection = deferred<{ upstream: ScreenUpstream }>();
    openUpstream.mockReturnValueOnce(connection.promise);
    const viewer = await open();
    await vi.waitFor(() => expect(openUpstream).toHaveBeenCalledTimes(1));
    const serverClosed = waitForClose(viewer.serverSocket);
    viewer.socket.close();
    await serverClosed;
    await viewer.closed;
    expect(host.streamCount()).toBe(0);
    connection.resolve({ upstream });
    await vi.waitFor(() => expect(closeUpstream).toHaveBeenCalledTimes(1));
    expect(host.streamCount()).toBe(0);
  });

  it('keeps a quality change sent immediately after opening while the lookup is pending', async () => {
    const lookup = deferred<typeof COMPUTER>();
    findFirst.mockReturnValueOnce(lookup.promise);
    const viewer = await open();
    const received = once(viewer.serverSocket, 'message');
    viewer.socket.send(JSON.stringify({ t: 'quality', quality: 9 }));
    await received;
    lookup.resolve(COMPUTER);
    await vi.waitFor(() => expect(setQuality).toHaveBeenCalledWith(9));
  });
});
