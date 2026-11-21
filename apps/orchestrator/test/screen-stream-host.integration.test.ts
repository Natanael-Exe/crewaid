import { computerId, privateComputerBot } from './computer-fixtures.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import {
  SCREEN_STREAM_PATH,
  ScreenStreamServerMessageSchema,
  type ScreenStreamServerMessage,
} from '@crewaid/shared';
import {
  SCREEN_TICKET_TTL_MS,
  type ScreenGeometry,
  type ServerMessageMeta,
} from '@crewaid/screen-stream';

import { SeatService } from '../src/sandbox/seat.service.js';
import { FakeSeatService } from './sandbox-fakes.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../src/sandbox/sandbox.provider.js';
import { ScreenGrantService } from '../src/screen/screen-grant.service.js';
import { ScreenStreamHost } from '../src/screen/screen-stream.host.js';
import {
  RFB_UPSTREAM_FACTORY,
  type ScreenUpstream,
  type ScreenUpstreamOptions,
} from '../src/screen/screen-upstream.port.js';

/**
 * The orchestrator's own stream route, over a real socket: what a viewer gets
 * from a grant, what it is refused, and that the wire is the one the contract
 * names — RFB bytes as binary frames, a mark after each update, acks and
 * quality as JSON the other way.
 *
 * The fan-out and pacing behind it are `@crewaid/screen-stream`'s and tested
 * there; this suite is the host: tickets, the computer's state, the socket.
 * The route is mounted by hand because this module has no §4.2 gateway for
 * `CrewaidWsAdapter` to mount it beside; `ws-session.integration.test.ts`
 * proves the adapter does in the full app.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';
const BOT_PREFIX = 'screenhost';

class FakeUpstream implements ScreenUpstream {
  static readonly opened: FakeUpstream[] = [];
  isStreaming = true;
  screen: ScreenGeometry | null = { widthPx: 1280, heightPx: 800 };
  quality: number;
  closed = false;
  readonly calls: string[] = [];
  private messageFn: ((m: Buffer, meta: ServerMessageMeta) => void) | null = null;
  private readyFn: ((geometry: ScreenGeometry) => void) | null = null;

  constructor(readonly options: ScreenUpstreamOptions) {
    this.quality = options.quality;
    FakeUpstream.opened.push(this);
  }
  onReady(fn: (geometry: ScreenGeometry) => void): void {
    this.readyFn = fn;
  }
  onMessage(fn: (m: Buffer, meta: ServerMessageMeta) => void): void {
    this.messageFn = fn;
  }
  onClose(): void {}
  resume(minRequestIntervalMs = 0): void {
    this.calls.push(`resume:${minRequestIntervalMs}`);
  }
  pause(): void {
    this.calls.push('pause');
  }
  requestFullRepaint(): void {
    this.calls.push('fullRepaint');
  }
  setQuality(quality: number): void {
    this.quality = quality;
  }
  sendInput(): boolean {
    throw new Error('the stream route never forwards input');
  }
  close(): void {
    this.closed = true;
  }
  ready(): void {
    this.readyFn?.(this.screen ?? { widthPx: 1280, heightPx: 800 });
  }
  emit(bytes: string, fullRepaint: boolean): void {
    this.messageFn?.(Buffer.from(bytes, 'ascii'), { fullRepaint, update: true });
  }
}

class FakeSandboxProvider {
  provisionWorkspace = () => Promise.resolve();
  attachSession = (options: { sessionId: string }) =>
    Promise.resolve({
      id: options.sessionId,
      getPortEndpoint: () => Promise.resolve({ url: 'tcp://127.0.0.1:32768' }),
    });
}

/** One viewer's socket, recording what arrived in the order it arrived. */
interface Viewer {
  readonly socket: WebSocket;
  readonly binary: Buffer[];
  readonly text: ScreenStreamServerMessage[];
  readonly closed: Promise<number>;
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'the orchestrator screen stream route (real db, real socket)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let grants: ScreenGrantService;
    let host: ScreenStreamHost;
    let port: number;
    const provider = new FakeSandboxProvider();

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        imports: [(await import('../src/screen/screen.module.js')).ScreenModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider as unknown as SandboxProvider)
        .overrideProvider(RFB_UPSTREAM_FACTORY)
        .useValue((options: ScreenUpstreamOptions) => new FakeUpstream(options))
        .overrideProvider(SeatService)
        .useValue(new FakeSeatService())
        .compile();
      app = moduleRef.createNestApplication();
      await app.listen(0);
      port = (app.getHttpServer().address() as { port: number }).port;
      prisma = app.get(PrismaService);
      grants = app.get(ScreenGrantService);
      host = app.get(ScreenStreamHost);
      app
        .getHttpServer()
        .on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
          if (!request.url?.startsWith(SCREEN_STREAM_PATH)) return;
          host.server.handleUpgrade(request, socket, head, (ws) => {
            host.server.emit('connection', ws, request);
          });
        });
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
    });

    afterAll(async () => {
      await prisma?.bot
        .deleteMany({ where: { name: { startsWith: `${BOT_PREFIX}-` } } })
        .catch(() => undefined);
      await app?.close();
    });

    beforeEach(() => {
      FakeUpstream.opened.length = 0;
    });

    const runningBot = async (): Promise<string> => {
      const bot = await privateComputerBot(prisma, provider, USER_ID, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, bot.id) },
        data: { sessionId: `session-${bot.id}`, state: 'RUNNING' },
      });
      return bot.id;
    };

    const latest = (): FakeUpstream => {
      const upstream = FakeUpstream.opened.at(-1);
      if (upstream === undefined) throw new Error('no upstream was opened');
      return upstream;
    };

    const open = (query: string): Promise<{ status?: number; viewer?: Viewer }> =>
      new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${SCREEN_STREAM_PATH}?${query}`);
        const binary: Buffer[] = [];
        const text: ScreenStreamServerMessage[] = [];
        const closed = new Promise<number>((done) => socket.once('close', (code) => done(code)));
        socket.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            binary.push(Buffer.from(data));
            return;
          }
          text.push(ScreenStreamServerMessageSchema.parse(JSON.parse(data.toString())));
        });
        socket.once('open', () => resolve({ viewer: { socket, binary, text, closed } }));
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve({ status: response.statusCode });
        });
      });

    const ticketFor = async (botId: string): Promise<string> => (await grants.grant(botId)).ticket;

    it('grants a running computer’s screen on the orchestrator itself', async () => {
      const id = await runningBot();
      const grant = await grants.grant(id);
      expect(grant.endpoint).toEqual({ kind: 'orchestrator' });
      expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('streams RFB bytes, marks each update, and takes acks and quality back', async () => {
      const id = await runningBot();
      const { viewer } = await open(`ticket=${await ticketFor(id)}&quality=4`);
      expect(viewer).toBeDefined();
      await vi.waitFor(() => expect(FakeUpstream.opened).toHaveLength(1));
      const upstream = latest();
      await vi.waitFor(() => expect(upstream.quality).toBe(4));
      upstream.ready();
      upstream.emit('WHOLE-SCREEN', true);

      // The bytes after the reset are x11vnc's, unwrapped: a stream socket
      // carries one seat, so it needs no envelope to say whose.
      await vi.waitFor(() => expect(viewer!.text).toEqual([{ t: 'mark', seq: 1 }]));
      expect(viewer!.binary.at(-1)?.toString()).toBe('WHOLE-SCREEN');

      viewer!.socket.send(JSON.stringify({ t: 'quality', quality: 8 }));
      await vi.waitFor(() => expect(upstream.quality).toBe(8));
      viewer!.socket.close();
      await vi.waitFor(() => expect(upstream.closed).toBe(true));
    });

    it('refuses a missing or forged ticket before a socket exists', async () => {
      expect(await open('quality=4')).toEqual({ status: 401 });
      expect(await open('ticket=eyJ2IjoxfQ.c2ln')).toEqual({ status: 401 });
      expect(FakeUpstream.opened).toHaveLength(0);
    });

    it('opens one stream per ticket: a replay is refused', async () => {
      const id = await runningBot();
      const ticket = await ticketFor(id);
      const first = await open(`ticket=${ticket}`);
      expect(first.viewer).toBeDefined();
      expect(await open(`ticket=${ticket}`)).toEqual({ status: 401 });
      // Settle the first stream inside this case, so its upstream cannot land
      // in the next case's count.
      await vi.waitFor(() => expect(FakeUpstream.opened).toHaveLength(1));
      first.viewer?.socket.close();
      await first.viewer?.closed;
      await vi.waitFor(() => expect(latest().closed).toBe(true));
    });

    it('requires a fresh grant when an open relay viewer reaches expiry', async () => {
      const id = await runningBot();
      const { ticket } = await grants.grant(id, Date.now() - SCREEN_TICKET_TTL_MS + 250);
      const { viewer } = await open(`ticket=${ticket}`);
      expect(await viewer!.closed).toBe(1000);
      const renewed = await open(`ticket=${await ticketFor(id)}`);
      expect(renewed.viewer?.socket.readyState).toBe(WebSocket.OPEN);
      renewed.viewer?.socket.close();
    });

    it('tells a viewer whose computer was replaced since its grant, and closes', async () => {
      const id = await runningBot();
      const ticket = await ticketFor(id);
      // Stopped and started again: a different desktop under the same bot.
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, id) },
        data: { sessionId: `session-${randomUUID()}` },
      });
      const { viewer } = await open(`ticket=${ticket}`);
      await viewer!.closed;
      expect(viewer!.text).toEqual([
        { t: 'error', code: 'SCREEN_NOT_RUNNING', message: 'The computer is no longer running.' },
      ]);
      expect(FakeUpstream.opened).toHaveLength(0);
    });

    it('tells a viewer whose computer stopped since its grant, and wakes nothing', async () => {
      const id = await runningBot();
      const ticket = await ticketFor(id);
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, id) },
        data: { state: 'STOPPED' },
      });
      const { viewer } = await open(`ticket=${ticket}`);
      await viewer!.closed;
      expect(viewer!.text.at(-1)).toMatchObject({ t: 'error', code: 'SCREEN_NOT_RUNNING' });
      expect(FakeUpstream.opened).toHaveLength(0);
    });

    it('refuses a grant for a computer that is not running', async () => {
      const id = await runningBot();
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, id) },
        data: { state: 'STOPPED' },
      });
      await expect(grants.grant(id)).rejects.toMatchObject({ status: 409 });
    });

    it.each([
      [
        'binary from the viewer',
        (socket: WebSocket) => socket.send(Buffer.from([5, 0, 0, 1, 0, 1])),
        1003,
      ],
      ['text that is not JSON', (socket: WebSocket) => socket.send('hello'), 1007],
      [
        'JSON that is not a stream message',
        (socket: WebSocket) => socket.send('{"t":"rfb"}'),
        1008,
      ],
    ])('closes a viewer that sends %s', async (_name, send, code) => {
      // A viewer never speaks RFB: a pointer event sent here must reach no
      // desktop, and the stream is read-only by construction.
      const id = await runningBot();
      const { viewer } = await open(`ticket=${await ticketFor(id)}`);
      await vi.waitFor(() => expect(FakeUpstream.opened).toHaveLength(1));
      send(viewer!.socket);
      expect(await viewer!.closed).toBe(code);
    });
  },
);
