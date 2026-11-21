import { computerId, privateComputerBot } from './computer-fixtures.js';
import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import { encodeScreenInputFrame } from '@crewaid/shared';

import { SeatService } from '../src/sandbox/seat.service.js';
import { FakeSeatService } from './sandbox-fakes.js';
import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../src/sandbox/sandbox.provider.js';
import {
  RFB_UPSTREAM_FACTORY,
  type ScreenUpstream,
  type ScreenUpstreamOptions,
} from '../src/screen/screen-upstream.port.js';
import type { ScreenGeometry } from '@crewaid/screen-stream';
import type { ServerMessageMeta } from '@crewaid/screen-stream';
import { signIn } from './auth-fixture.js';

/**
 * M2-BE-07 — `screen.input` over a real socket (§4.3, R6).
 *
 * The multiplex suite drives `ScreenService` directly, which proves the
 * routing and the refusals but says nothing about the two pieces only a real
 * WebSocket exercises: that a BINARY frame reaches a handler at all, and that
 * a refusal comes back as a §4.2 `error` rather than as silence.
 *
 * Both have a specific way of failing that no unit test can see. Nest's stock
 * WsAdapter drops a frame whose routed event has no handler, and before
 * M2-BE-07 a binary frame was fed to `JSON.parse`, failed, and was answered
 * "not a §4.2 envelope" — so every mouse move would have been refused with a
 * message pointing at the wrong thing entirely.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
let TOKEN: string;
const BOT_PREFIX = 'm2be07';

class FakeUpstream implements ScreenUpstream {
  static readonly opened: FakeUpstream[] = [];

  isStreaming = true;
  screen: ScreenGeometry | null = { widthPx: 1280, heightPx: 800 };
  readonly sentInput: Buffer[] = [];

  private readyFn: ((geometry: ScreenGeometry) => void) | null = null;

  constructor(readonly options: ScreenUpstreamOptions) {
    FakeUpstream.opened.push(this);
    // The broker registers its callbacks after construction, so announcing
    // readiness on the next tick is what a real socket's timing looks like.
    setTimeout(() => this.readyFn?.(this.screen as ScreenGeometry), 0);
  }

  onReady(fn: (geometry: ScreenGeometry) => void): void {
    this.readyFn = fn;
  }
  onMessage(_fn: (m: Buffer, meta: ServerMessageMeta) => void): void {}
  onClose(_fn: (reason: Error | null) => void): void {}
  resume(): void {}
  pause(): void {}
  requestFullRepaint(): void {}
  setQuality(_quality: number): void {}
  sendInput(bytes: Uint8Array): boolean {
    this.sentInput.push(Buffer.from(bytes));
    return true;
  }
  close(): void {}
}

class FakeSandboxProvider {
  provisionWorkspace = () => Promise.resolve();
  attachSession = (options: { sessionId: string }) =>
    Promise.resolve({
      id: options.sessionId,
      getPortEndpoint: () => Promise.resolve({ url: 'tcp://127.0.0.1:32768' }),
    });
}

/** One RFB PointerEvent (RFC 6143 §7.5.5). */
function pointerEvent(mask: number, x: number, y: number): Uint8Array {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 5);
  view.setUint8(1, mask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return bytes;
}

interface ErrorFrame {
  type: string;
  /** `mode` is on `screen.control.state` (D-168), which arrives on the same socket. */
  payload: { code: string; message: string; mode?: string };
}

/** Collects the JSON frames a socket receives; binary replies are not expected. */
class Inbox extends EventEmitter {
  readonly frames: ErrorFrame[] = [];

  constructor(ws: WebSocket) {
    super();
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      this.frames.push(JSON.parse(data.toString('utf8')) as ErrorFrame);
      this.emit('frame');
    });
  }

  next(timeoutMs = 2000): Promise<ErrorFrame> {
    const pending = this.frames.length;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no reply — the frame was dropped')),
        timeoutMs,
      );
      const check = (): void => {
        const frame = this.frames[pending];
        if (frame === undefined) return;
        clearTimeout(timer);
        this.off('frame', check);
        resolve(frame);
      };
      this.on('frame', check);
      check();
    });
  }
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M2-BE-07 screen.input over the §4.2 socket',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    /** The signed-in user this suite acts as, and owns its rows with. */
    let ACTOR: string;
    let bots: BotsService;
    let port: number;
    let botId: string;
    let ws: WebSocket;
    let inbox: Inbox;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeSandboxProvider() as unknown as SandboxProvider)
        .overrideProvider(RFB_UPSTREAM_FACTORY)
        .useValue((options: ScreenUpstreamOptions) => new FakeUpstream(options))
        .overrideProvider(SeatService)
        // D-046 / M5-BE-23: the §4.3 stream is the bot's SEAT now, and
        // resolving one is an HTTP call into the machine. This suite is about
        // the multiplexer, and its provider is a fake with no bridge behind
        // it, so the seat resolver is stubbed the same way the upstream
        // factory already is. `seat-allocation.test.ts` is where the resolver
        // itself is tested.
        .useValue(new FakeSeatService())
        .compile();

      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      await app.listen(0);
      port = (app.getHttpServer().address() as { port: number }).port;

      prisma = app.get(PrismaService);
      // V1-08: a real session for a real user, in place of the static
      // ORCH_API_TOKEN every request used to carry.
      // ACTOR, so nothing here depends on a user somebody else seeded.
      ({ token: TOKEN, userId: ACTOR } = await signIn(prisma, { label: 'screeninput' }));
      bots = app.get(BotsService);
      await prisma.user.upsert({
        where: { id: ACTOR },
        create: { id: ACTOR, name: 'Test User', email: `${ACTOR}@test.invalid` },
        update: {},
      });
      await dropOwnBots();

      const bot = await privateComputerBot(prisma, app.get(SANDBOX_PROVIDER), ACTOR, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      botId = bot.id;
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { sessionId: botId, state: 'RUNNING', vncPort: 32768 },
      });

      ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
      inbox = new Inbox(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: 'screen.subscribe',
          ts: Date.now(),
          payload: { botId },
        }),
      );
      await waitFor(() => FakeUpstream.opened.length > 0);

      // Watching is not driving (D-168): take the seat the way the viewer's
      // Take control does. Every test then starts from a quiet inbox and a
      // display that has had nothing but the first-contact release.
      const display = FakeUpstream.opened[0] as FakeUpstream;
      ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: 'screen.control',
          ts: Date.now(),
          payload: { botId, action: 'take' },
        }),
      );
      await waitFor(() =>
        inbox.frames.some((f) => f.type === 'screen.control.state' && f.payload.mode === 'human'),
      );
      await waitFor(() => display.sentInput.length >= 11);
      inbox.frames.length = 0;
      display.sentInput.length = 0;
    });

    afterAll(async () => {
      ws?.close();
      await dropOwnBots();
      await app?.close();
    });

    const dropOwnBots = async (): Promise<void> => {
      await prisma.bot
        .deleteMany({ where: { name: { startsWith: `${BOT_PREFIX}-` } } })
        .catch(() => undefined);
    };

    const upstream = (): FakeUpstream => FakeUpstream.opened[0] as FakeUpstream;

    it('carries a pointer event from the socket to x11vnc, unchanged (R6)', async () => {
      const click = pointerEvent(0b1, 640, 400);
      ws.send(encodeScreenInputFrame(botId, 1, click), { binary: true });

      await waitFor(() => upstream().sentInput.length > 0);
      expect([...(upstream().sentInput[0] as Buffer)]).toEqual([...click]);
      // R6 is the whole point: the client never opens a socket to the
      // sandbox's VNC port, so this is the only path input can take.
      expect(inbox.frames).toHaveLength(0);
    });

    it('answers a refused message instead of dropping it silently', async () => {
      const before = upstream().sentInput.length;
      const setPixelFormat = new Uint8Array(20);
      ws.send(encodeScreenInputFrame(botId, 1, setPixelFormat), { binary: true });

      const frame = await inbox.next();
      expect(frame.type).toBe('error');
      expect(frame.payload.message).toMatch(/type 0 is not forwarded/);
      expect(upstream().sentInput).toHaveLength(before);
      // A refused input frame must not take the socket down: the client is
      // still watching this desktop and possibly others.
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('does not mistake a binary frame for a malformed JSON envelope', async () => {
      ws.send(encodeScreenInputFrame(botId, 1, new Uint8Array([5, 1, 2])), { binary: true });

      const frame = await inbox.next();
      // Before the adapter grew a binary channel this said "Frame is not a
      // §4.2 envelope", which sends the reader looking at their JSON.
      expect(frame.payload.message).toMatch(/truncated PointerEvent/);
      expect(frame.payload.message).not.toMatch(/envelope/);
    });

    it('answers a frame that is not §4.3-framed at all', async () => {
      // A client that forgets the D-035 header sends the RFB message bare;
      // its first byte is then read as a bot id length.
      ws.send(Buffer.from([5]), { binary: true });

      const frame = await inbox.next();
      expect(frame.type).toBe('error');
      expect(frame.payload.message).toMatch(/no RFB message after its bot id/);
    });

    it('refuses input for a bot this socket is not watching', async () => {
      const before = upstream().sentInput.length;
      ws.send(encodeScreenInputFrame('cmtk4b0x20009a03bc8vtxx0w', 1, pointerEvent(1, 1, 1)), {
        binary: true,
      });

      const frame = await inbox.next();
      expect(frame.payload.message).toMatch(/not subscribed/);
      expect(upstream().sentInput).toHaveLength(before);
    });
  },
);

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
