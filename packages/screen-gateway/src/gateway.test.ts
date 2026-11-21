import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ScreenTicketClaims, ScreenSeatBinding } from '@crewaid/shared';
import { connect } from 'node:net';
import { once } from 'node:events';
import {
  exportScreenTicketPublicKey,
  generateScreenTicketKeys,
  SILENT_SCREEN_LOGGER,
  signScreenTicket,
  type ScreenGeometry,
  type ScreenUpstream,
  type ScreenUpstreamOptions,
  type ServerMessageMeta,
} from '@crewaid/screen-stream';

import { SCREEN_KEY_FILENAME, ScreenGateway } from './gateway.js';

/**
 * The gateway as a viewer meets it: a real HTTP server and real sockets, with
 * x11vnc replaced by a fake. What is under test is who gets in — the stream
 * itself is `@crewaid/screen-stream`'s and tested there.
 */

class FakeUpstream implements ScreenUpstream {
  isStreaming = true;
  screen: ScreenGeometry | null = { widthPx: 1280, heightPx: 800 };
  closed = false;
  private messageFn: ((m: Buffer, meta: ServerMessageMeta) => void) | null = null;
  private readyFn: ((geometry: ScreenGeometry) => void) | null = null;
  private closeFn: ((reason: Error | null) => void) | null = null;

  constructor(readonly options: ScreenUpstreamOptions) {}
  onReady(fn: (geometry: ScreenGeometry) => void): void {
    this.readyFn = fn;
  }
  onMessage(fn: (m: Buffer, meta: ServerMessageMeta) => void): void {
    this.messageFn = fn;
  }
  onClose(fn: (reason: Error | null) => void): void {
    this.closeFn = fn;
  }
  resume(): void {}
  pause(): void {}
  requestFullRepaint(): void {
    // A desktop answers the first request with the whole screen.
    queueMicrotask(() =>
      this.messageFn?.(Buffer.from('WHOLE-SCREEN'), { fullRepaint: true, update: true }),
    );
  }
  setQuality(): void {}
  sendInput(): boolean {
    throw new Error('the gateway never forwards input');
  }
  close(): void {
    this.closed = true;
  }
  ready(): void {
    this.readyFn?.(this.screen ?? { widthPx: 1280, heightPx: 800 });
  }
  drop(): void {
    this.closeFn?.(new Error('RFB connection lost'));
  }
}

const NOW = 1_791_900_000_000;
const SESSION = 'crewaid-cmv6rarhx000201pg54qta71v';
const BOT = 'clx9z8y7x6w5v4u3t2s1r0q9';

describe('ScreenGateway', () => {
  let directory: string;
  let gateway: ScreenGateway;
  let opened: FakeUpstream[];
  let keys: ReturnType<typeof generateScreenTicketKeys>;
  let seat: ScreenSeatBinding | null;
  const resolveSeat = vi.fn<(botId: string) => Promise<ScreenSeatBinding | null>>();

  const claims = (overrides: Partial<ScreenTicketClaims> = {}): ScreenTicketClaims => ({
    v: 1,
    aud: 'crewaid-screen',
    session: SESSION,
    botId: BOT,
    port: 5901,
    exp: NOW + 60_000,
    jti: `jti-${Math.random().toString(36).slice(2, 12)}`,
    ...overrides,
  });

  const deliverKey = (session = SESSION): void => {
    writeFileSync(
      join(directory, SCREEN_KEY_FILENAME),
      JSON.stringify({ publicKey: exportScreenTicketPublicKey(keys.publicKey), session }),
    );
  };

  /** Open a socket and report what the Upgrade did. */
  const open = (query: string, path = '/v1/stream') =>
    new Promise<{
      status?: number | undefined;
      socket?: WebSocket;
      binary: Buffer[];
      text: unknown[];
    }>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}${path}?${query}`);
      const binary: Buffer[] = [];
      const text: unknown[] = [];
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) binary.push(Buffer.from(data));
        else text.push(JSON.parse(data.toString()));
      });
      socket.once('open', () => resolve({ socket, binary, text }));
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve({ status: response.statusCode, binary, text });
      });
    });

  const ticket = (overrides: Partial<ScreenTicketClaims> = {}): string =>
    encodeURIComponent(signScreenTicket(claims(overrides), keys.privateKey));

  const createGateway = () =>
    new ScreenGateway({
      keyFile: join(directory, SCREEN_KEY_FILENAME),
      logger: SILENT_SCREEN_LOGGER,
      now: () => NOW,
      resolveSeat,
      createUpstream: (options) => {
        const upstream = new FakeUpstream(options);
        opened.push(upstream);
        // After the stream has bound its handlers, as a real handshake is.
        setTimeout(() => upstream.ready(), 5);
        return upstream;
      },
    });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'screen-gateway-'));
    keys = generateScreenTicketKeys();
    opened = [];
    seat = { seatId: 'seat-a', botId: BOT, rfbPort: 5901 };
    resolveSeat
      .mockReset()
      .mockImplementation((botId) => Promise.resolve(seat?.botId === botId ? seat : null));
    gateway = createGateway();
    await gateway.listen(0);
  });

  afterEach(async () => {
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('streams the seat its ticket names, read from this machine’s loopback', async () => {
    deliverKey();
    seat = { seatId: 'seat-a', botId: BOT, rfbPort: 5903 };
    const viewer = await open(`ticket=${ticket({ port: 5903 })}&quality=4`);
    expect(viewer.socket).toBeDefined();
    await vi.waitFor(() => expect(viewer.binary.map(String)).toContain('WHOLE-SCREEN'));
    expect(opened.map((upstream) => [upstream.options.host, upstream.options.port])).toEqual([
      ['127.0.0.1', 5903],
    ]);
    // Every update is marked for the viewer to ack, as on the orchestrator.
    await vi.waitFor(() => expect(viewer.text).toContainEqual({ t: 'mark', seq: 1 }));
    viewer.socket?.close();
    await vi.waitFor(() => expect(opened[0]?.closed).toBe(true));
  });

  it('ends an admitted viewer at its signed expiry while a newer viewer stays connected', async () => {
    deliverKey();
    const short = await open(`ticket=${ticket({ exp: NOW + 150 })}`);
    const closed = once(short.socket!, 'close');
    const fresh = await open(`ticket=${ticket()}`);
    await closed;
    expect(fresh.socket?.readyState).toBe(WebSocket.OPEN);
    fresh.socket?.close();
  });

  it('answers a health check, for the image to wait on', async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/health`);
    expect([response.status, await response.text()]).toEqual([200, 'ok']);
  });

  it.each([
    ['no ticket', () => 'quality=4'],
    ['a forged ticket', () => `ticket=${encodeURIComponent('eyJ2IjoxfQ.c2ln')}`],
    ['an expired ticket', () => `ticket=${ticket({ exp: NOW })}`],
    ['a ticket for another computer', () => `ticket=${ticket({ session: 'crewaid-other' })}`],
    ['a ticket for a port that is not a seat', () => `ticket=${ticket({ port: 7070 })}`],
  ])('refuses %s before a socket exists, and dials nothing', async (_name, query) => {
    deliverKey();
    expect(await open(query())).toMatchObject({ status: 401 });
    expect(opened).toEqual([]);
  });

  it('refuses a ticket signed by a key it was not given', async () => {
    deliverKey();
    const other = generateScreenTicketKeys();
    const forged = encodeURIComponent(signScreenTicket(claims(), other.privateKey));
    expect(await open(`ticket=${forged}`)).toMatchObject({ status: 401 });
  });

  it('opens one stream per ticket', async () => {
    deliverKey();
    const once = ticket();
    const first = await open(`ticket=${once}`);
    expect(first.socket).toBeDefined();
    expect(await open(`ticket=${once}`)).toMatchObject({ status: 401 });
    first.socket?.close();
  });

  it('refuses everything until the orchestrator has delivered its key', async () => {
    expect(await open(`ticket=${ticket()}`)).toMatchObject({ status: 401 });
    deliverKey();
    expect((await open(`ticket=${ticket()}`)).socket).toBeDefined();
  });

  it('takes a replaced key at once: an orchestrator that restarted signs with a new one', async () => {
    deliverKey();
    const before = ticket();
    keys = generateScreenTicketKeys();
    deliverKey();
    expect(await open(`ticket=${before}`)).toMatchObject({ status: 401 });
    expect((await open(`ticket=${ticket()}`)).socket).toBeDefined();
  });

  it('serves nothing but the stream path', async () => {
    deliverKey();
    expect(await open(`ticket=${ticket()}`, '/exec')).toMatchObject({ status: 404 });
  });

  it('refuses an unused ticket after its port is reassigned to another bot', async () => {
    deliverKey();
    const old = ticket();
    seat = { seatId: 'seat-b', botId: 'bot-b', rfbPort: 5901 };
    expect(await open(`ticket=${old}`)).toMatchObject({ status: 401 });
    expect(opened).toEqual([]);
  });

  it('checks ownership again before connecting the upstream', async () => {
    deliverKey();
    resolveSeat.mockResolvedValueOnce(seat).mockResolvedValueOnce(null);
    const viewer = await open(`ticket=${ticket()}`);
    await vi.waitFor(() =>
      expect(viewer.text).toContainEqual(expect.objectContaining({ code: 'SCREEN_NOT_RUNNING' })),
    );
    expect(opened).toEqual([]);
  });

  it.each(['retired', 'unavailable'])(
    'ends existing viewers when a late join finds the seat %s',
    async (failure) => {
      deliverKey();
      const first = await open(`ticket=${ticket()}`);
      await vi.waitFor(() => expect(first.binary.map(String)).toContain('WHOLE-SCREEN'));
      resolveSeat.mockResolvedValueOnce(seat);
      if (failure === 'retired') resolveSeat.mockResolvedValueOnce(null);
      else resolveSeat.mockRejectedValueOnce(new Error('bridge unavailable'));
      const second = await open(`ticket=${ticket()}`);
      const code = failure === 'retired' ? 'SCREEN_NOT_RUNNING' : 'SCREEN_STREAM_LOST';
      await vi.waitFor(() => expect(first.text).toContainEqual(expect.objectContaining({ code })));
      await vi.waitFor(() => expect(second.text).toContainEqual(expect.objectContaining({ code })));
      expect(opened).toHaveLength(1);
      expect(opened[0]?.closed).toBe(true);
    },
  );

  it.each([
    { seatId: 'replacement-b', botId: 'bot-b', rfbPort: 5901 },
    { seatId: 'replacement-a', botId: BOT, rfbPort: 5901 },
  ])(
    'quarantines a connection when the seat changes during its handshake ($seatId)',
    async (replacement) => {
      deliverKey();
      resolveSeat
        .mockResolvedValueOnce(seat)
        .mockResolvedValueOnce(seat)
        .mockResolvedValueOnce(replacement);
      const viewer = await open(`ticket=${ticket()}`);
      await vi.waitFor(() => expect(opened[0]?.closed).toBe(true));
      expect(viewer.binary).toEqual([]);
    },
  );

  it('does not recover a retired stream onto the next bot occupying its port', async () => {
    deliverKey();
    const viewer = await open(`ticket=${ticket()}`);
    await vi.waitFor(() => expect(viewer.binary.map(String)).toContain('WHOLE-SCREEN'));
    seat = { seatId: 'seat-b', botId: 'bot-b', rfbPort: 5901 };
    opened[0]?.drop();
    await vi.waitFor(() =>
      expect(viewer.text).toContainEqual(expect.objectContaining({ code: 'SCREEN_NOT_RUNNING' })),
    );
    expect(opened).toHaveLength(1);
  });

  it('does not share an old seat generation with a newly granted viewer', async () => {
    deliverKey();
    const first = await open(`ticket=${ticket()}`);
    await vi.waitFor(() => expect(first.binary.map(String)).toContain('WHOLE-SCREEN'));
    seat = { seatId: 'replacement-a', botId: BOT, rfbPort: 5901 };
    const second = await open(`ticket=${ticket()}`);
    await vi.waitFor(() => expect(second.binary.map(String)).toContain('WHOLE-SCREEN'));
    expect(opened).toHaveLength(2);
  });

  it('keeps a consumed ticket refused after a gateway restart on the same port', async () => {
    deliverKey();
    const used = ticket();
    const port = gateway.port;
    const first = await open(`ticket=${used}`);
    first.socket?.close();
    await vi.waitFor(() => expect(first.socket?.readyState).toBe(WebSocket.CLOSED));
    await gateway.close();
    gateway = createGateway();
    await gateway.listen(port);
    expect(await open(`ticket=${used}`)).toMatchObject({ status: 401 });
    expect((await open(`ticket=${ticket()}`)).socket).toBeDefined();
  });

  it('admits only one of two simultaneous uses of a ticket', async () => {
    deliverKey();
    const shared = ticket();
    const viewers = await Promise.all([open(`ticket=${shared}`), open(`ticket=${shared}`)]);
    expect(viewers.filter((v) => v.socket !== undefined)).toHaveLength(1);
    expect(viewers.filter((v) => v.status === 401)).toHaveLength(1);
  });

  it('refuses another base64 spelling of a consumed signature', async () => {
    deliverKey();
    const used = ticket();
    expect((await open(`ticket=${used}`)).socket).toBeDefined();
    const alias = encodeURIComponent(decodeURIComponent(used) + '=');
    expect(await open(`ticket=${alias}`)).toMatchObject({ status: 401 });
  });

  it('refuses admission when consumed IDs cannot be stored', async () => {
    deliverKey();
    writeFileSync(join(directory, `${SCREEN_KEY_FILENAME}.used`), 'not a directory');
    expect(await open(`ticket=${ticket()}`)).toMatchObject({ status: 503 });
    expect(opened).toEqual([]);
  });

  it('closes an oversized sender without dropping a healthy viewer or the gateway', async () => {
    deliverKey();
    const healthy = await open(`ticket=${ticket()}`);
    await vi.waitFor(() => expect(healthy.binary.map(String)).toContain('WHOLE-SCREEN'));
    const bad = await open(`ticket=${ticket()}`);
    if (bad.socket === undefined) throw new Error('viewer was refused');
    const closed = new Promise<number>((resolve) => bad.socket?.once('close', resolve));
    bad.socket.send(Buffer.alloc(1025));
    expect(await closed).toBe(1009);
    expect(healthy.socket?.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`http://127.0.0.1:${gateway.port}/health`)).status).toBe(200);
    expect((await open(`ticket=${ticket()}`)).socket).toBeDefined();
  });

  it('refuses a malformed upgrade target and continues serving valid viewers', async () => {
    const socket = connect(gateway.port, '127.0.0.1');
    const response = new Promise<string>((resolve, reject) => {
      let text = '';
      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString();
      });
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    await once(socket, 'connect');
    socket.write(
      'GET // HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    );
    expect(await response).toMatch(/^HTTP\/1\.1 400 /);
    deliverKey();
    expect((await open(`ticket=${ticket()}`)).socket).toBeDefined();
  });

  it('contains a rejected asynchronous admission lookup to that request', async () => {
    deliverKey();
    resolveSeat.mockRejectedValueOnce(new Error('private lookup failure detail'));
    expect(await open(`ticket=${ticket()}`)).toMatchObject({ status: 503 });
    expect(opened).toEqual([]);
    expect((await open(`ticket=${ticket()}`)).socket).toBeDefined();
  });
});
