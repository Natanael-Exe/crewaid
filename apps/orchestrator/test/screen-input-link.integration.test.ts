import { computerId, privateComputerBot } from './computer-fixtures.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { SeatService } from '../src/sandbox/seat.service.js';
import { FakeSeatService } from './sandbox-fakes.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../src/sandbox/sandbox.provider.js';
import { ScreenService } from '../src/screen/screen.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import {
  RFB_UPSTREAM_FACTORY,
  type ScreenUpstream,
  type ScreenUpstreamOptions,
} from '../src/screen/screen-upstream.port.js';
import type { ScreenGeometry, ServerMessageMeta } from '@crewaid/screen-stream';

/**
 * Who watches each seat over §4.2, and the one connection their input goes
 * down (M2-BE-07, D-169), against a real database.
 *
 * Real Postgres because ownership and sandbox state are row reads that decide
 * whether a subscribe is allowed at all. Fake upstream because every guarantee
 * under test is bookkeeping — how many connections exist, which one an event
 * goes down, what the desktop is asked for — and none of it needs a desktop.
 *
 * The pixels are not here: they have a stream of their own, tested in
 * `@crewaid/screen-stream` and `screen-stream-host.integration.test.ts`. What
 * this suite adds about them is the negative — that watching over §4.2 never
 * reads a picture from the desktop.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';
const OTHER_USER_ID = 'usr_m2be06_other';
const BOT_PREFIX = 'm2be06';

/** Records what the service sends, and to whom. */
class FakeClient extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: Buffer[] = [];
  /** §4.2 JSON frames (D-168's `screen.control.state`, errors). */
  readonly json: { type: string; botId?: string; payload: unknown }[] = [];

  terminate(): void {
    this.readyState = 3;
  }

  send(data: Buffer | string, _options?: unknown, callback?: (error?: Error | null) => void): void {
    if (typeof data === 'string') {
      this.json.push(JSON.parse(data) as { type: string; payload: unknown });
    } else {
      this.frames.push(Buffer.from(data));
    }
    callback?.(null);
  }
}

/** Only the two members the connector reaches for: attach, then resolve the port. */
class FakeSandboxProvider {
  provisionWorkspace = () => Promise.resolve();
  attachReturnsNull = false;
  portEndpointHeaders: Record<string, string> | undefined = undefined;

  attachSession = (options: { sessionId: string }) => {
    if (this.attachReturnsNull) return Promise.resolve(null);
    return Promise.resolve({
      id: options.sessionId,
      getPortEndpoint: () =>
        Promise.resolve(
          this.portEndpointHeaders === undefined
            ? { url: 'tcp://127.0.0.1:32768' }
            : { url: 'tcp://127.0.0.1:32768', headers: this.portEndpointHeaders },
        ),
    });
  };

  reset(): void {
    this.attachReturnsNull = false;
    this.portEndpointHeaders = undefined;
  }
}

class FakeUpstream implements ScreenUpstream {
  static readonly opened: FakeUpstream[] = [];

  isStreaming = true;
  screen: ScreenGeometry | null = { widthPx: 1280, heightPx: 800 };
  closed = false;
  /** Every pump call, in order: an input connection must never make one. */
  readonly calls: string[] = [];
  readonly sentInput: Buffer[] = [];

  private messageFn: ((m: Buffer, meta: ServerMessageMeta) => void) | null = null;
  private closeFn: ((reason: Error | null) => void) | null = null;
  private readyFn: ((geometry: ScreenGeometry) => void) | null = null;

  constructor(readonly options: ScreenUpstreamOptions) {
    FakeUpstream.opened.push(this);
  }

  onReady(fn: (geometry: ScreenGeometry) => void): void {
    this.readyFn = fn;
  }
  onMessage(fn: (m: Buffer, meta: ServerMessageMeta) => void): void {
    this.messageFn = fn;
  }
  onClose(fn: (reason: Error | null) => void): void {
    this.closeFn = fn;
  }
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
    this.calls.push(`quality:${quality}`);
  }
  sendInput(bytes: Uint8Array): boolean {
    if (!this.isStreaming) return false;
    this.sentInput.push(Buffer.from(bytes));
    return true;
  }
  close(): void {
    this.closed = true;
  }

  /** Drive the service the way a real connection would. */
  ready(): void {
    this.readyFn?.(this.screen ?? { widthPx: 1280, heightPx: 800 });
  }
  /** What x11vnc might send unasked: a Bell, a clipboard change. */
  unsolicited(bytes: string): void {
    this.messageFn?.(Buffer.from(bytes, 'ascii'), { fullRepaint: false, update: false });
  }
  drop(reason: Error | null): void {
    this.isStreaming = false;
    this.closeFn?.(reason);
  }
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'screen watchers and input (real db)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let screens: ScreenService;
    let provider: FakeSandboxProvider;
    let botId: string;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      provider = new FakeSandboxProvider();
      const moduleRef = await Test.createTestingModule({
        imports: [(await import('../src/screen/screen.module.js')).ScreenModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider as unknown as SandboxProvider)
        .overrideProvider(RFB_UPSTREAM_FACTORY)
        .useValue((options: ScreenUpstreamOptions) => new FakeUpstream(options))
        .overrideProvider(SeatService)
        // D-046 / M5-BE-23: the connection is to the bot's SEAT, and resolving
        // one is an HTTP call into the machine. The provider here is a fake
        // with no bridge behind it, so the seat resolver is stubbed too.
        .useValue(new FakeSeatService())
        .compile();

      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      screens = app.get(ScreenService);
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
      await dropOwnBots();
    });

    afterAll(async () => {
      await dropOwnBots();
      await prisma?.user.deleteMany({ where: { id: OTHER_USER_ID } }).catch(() => undefined);
      await app?.close();
    });

    const dropOwnBots = async (): Promise<void> => {
      await prisma.bot
        .deleteMany({ where: { name: { startsWith: `${BOT_PREFIX}-` } } })
        .catch(() => undefined);
    };

    const newBot = async (userId = USER_ID): Promise<string> => {
      const bot = await privateComputerBot(prisma, provider, userId, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      return bot.id;
    };

    /** A bot whose sandbox is RUNNING, which is what watching requires. */
    const runningBot = async (): Promise<string> => {
      const id = await newBot();
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, id) },
        data: { sessionId: id, state: 'RUNNING', vncPort: 32768 },
      });
      return id;
    };

    const setState = async (id: string, state: 'RUNNING' | 'STOPPED' | 'UNHEALTHY') =>
      prisma.sandbox.update({ where: { id: await computerId(prisma, id) }, data: { state } });

    const latest = (): FakeUpstream => {
      const upstream = FakeUpstream.opened.at(-1);
      if (upstream === undefined) throw new Error('no upstream was opened');
      return upstream;
    };

    /**
     * Finish the handshake, then forget what the seat let go of on first
     * contact (D-168): those key-ups are the orchestrator's, not the input a
     * test sends.
     */
    const up = (upstream = latest()): FakeUpstream => {
      upstream.ready();
      upstream.sentInput.length = 0;
      return upstream;
    };

    /** Take the seat, as the viewer's Take control does: watching is not driving (D-168). */
    const drive = async (client: FakeClient, id: string): Promise<void> => {
      await screens.control(client as never, id, { botId: id, action: 'take' });
    };

    beforeEach(async () => {
      provider.reset();
      FakeUpstream.opened.length = 0;
      botId = await newBot();
    });

    describe('one input connection per seat', () => {
      it('opens a single upstream no matter how many clients subscribe', async () => {
        const id = await runningBot();
        await Promise.all([
          screens.subscribe(USER_ID, new FakeClient() as never, id),
          screens.subscribe(USER_ID, new FakeClient() as never, id),
          screens.subscribe(USER_ID, new FakeClient() as never, id),
        ]);
        expect(FakeUpstream.opened).toHaveLength(1);
        expect(screens.subscriberCount(id)).toBe(3);
      });

      it('never asks the desktop for a picture, and sends no pixels on §4.2', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        const upstream = latest();
        upstream.ready();
        upstream.unsolicited('bell');
        screens.unsubscribe(client as never, id);
        await screens.subscribe(USER_ID, client as never, id);

        // The pixels have a stream of their own. A request here would read the
        // desktop through this process for nobody — exactly the traffic that
        // moved off it — and a binary frame here would be a picture on the
        // chat socket again.
        expect(upstream.calls.filter((call) => !call.startsWith('quality:'))).toEqual([]);
        expect(client.frames).toEqual([]);
      });

      it('keeps the connection when the last watcher leaves', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        up();
        screens.unsubscribe(client as never, id);

        // It costs no reads, and closing it would make D-163's first contact —
        // which also moves the pointer — happen again on every reopen.
        expect(latest().closed).toBe(false);
        expect(screens.subscriberCount(id)).toBe(0);
        expect(screens.streamCount()).toBeGreaterThan(0);
        await screens.subscribe(USER_ID, new FakeClient() as never, id);
        expect(FakeUpstream.opened).toHaveLength(1);
      });

      it('drops a link whose upstream ends while nobody is watching', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        const upstream = latest();
        upstream.ready();
        screens.unsubscribe(client as never, id);

        // `subscriberCount` reads 0 for a bot with no link and for a link with
        // no watchers alike, so the assertion is on the entry itself.
        const before = screens.streamCount();
        upstream.drop(new Error('container went away'));
        expect(screens.streamCount()).toBe(before - 1);

        await screens.subscribe(USER_ID, new FakeClient() as never, id);
        expect(FakeUpstream.opened).toHaveLength(2);
      });

      it('treats a dropped socket as an unsubscribe from every bot it watched', async () => {
        const first = await runningBot();
        const second = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, first);
        await screens.subscribe(USER_ID, client as never, second);
        expect(FakeUpstream.opened).toHaveLength(2);

        screens.detach(client as never);

        expect(screens.subscriberCount(first)).toBe(0);
        expect(screens.subscriberCount(second)).toBe(0);
      });
    });

    describe('subscription cancellation races', () => {
      it('does not resurrect a subscription cancelled during ownership reads', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        const pending = screens.subscribe(USER_ID, client as never, id);
        screens.unsubscribe(client as never, id);
        await pending;
        expect(screens.subscriberCount(id)).toBe(0);
        expect(FakeUpstream.opened).toHaveLength(0);
      });

      it('keeps no watcher whose socket closed while the endpoint was resolving', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        const original = provider.attachSession;
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        provider.attachSession = async (options) => {
          entered();
          await gate;
          return original(options);
        };
        try {
          const pending = screens.subscribe(USER_ID, client as never, id);
          await started;
          screens.detach(client as never);
          release();
          await pending;
          expect(screens.subscriberCount(id)).toBe(0);
          expect(latest().closed).toBe(true);
        } finally {
          provider.attachSession = original;
        }
      });
    });

    describe('refusals', () => {
      it('404s another user’s bot without leaking that it exists (R7)', async () => {
        await prisma.user.upsert({
          where: { id: OTHER_USER_ID },
          create: { id: OTHER_USER_ID, name: 'Test User', email: `${OTHER_USER_ID}@test.invalid` },
          update: {},
        });
        const id = await runningBot();

        // An authenticated socket is not an authorisation to drive any
        // desktop. The message is the same one a missing bot gets.
        await expect(
          screens.subscribe(OTHER_USER_ID, new FakeClient() as never, id),
        ).rejects.toThrow('Bot not found');
        expect(FakeUpstream.opened).toHaveLength(0);
      });

      it('says the sandbox is not running rather than timing out on a socket', async () => {
        await expect(screens.subscribe(USER_ID, new FakeClient() as never, botId)).rejects.toThrow(
          /STOPPED; start it before subscribing/,
        );
        expect(FakeUpstream.opened).toHaveLength(0);
      });

      it('refuses a screen endpoint that needs headers a TCP socket cannot send (D-012)', async () => {
        const id = await runningBot();
        provider.portEndpointHeaders = { authorization: 'Bearer tunnel' };

        // Dropping them would surface as a refused socket or a hung
        // handshake — the exact "looks like a networking fault" D-012 names.
        await expect(screens.subscribe(USER_ID, new FakeClient() as never, id)).rejects.toThrow(
          /headers \[authorization\].*D-012/s,
        );
        expect(screens.subscriberCount(id)).toBe(0);
      });

      it('leaves no half-registered watcher when opening the upstream fails', async () => {
        const id = await runningBot();
        provider.attachReturnsNull = true;

        await expect(screens.subscribe(USER_ID, new FakeClient() as never, id)).rejects.toThrow(
          /no sandbox container/,
        );
        expect(screens.subscriberCount(id)).toBe(0);
      });
    });

    describe('inbound input (M2-BE-07, §4.3)', () => {
      const pointer = (mask: number, x: number, y: number): Uint8Array => {
        const bytes = new Uint8Array(6);
        const view = new DataView(bytes.buffer);
        view.setUint8(0, 5);
        view.setUint8(1, mask);
        view.setUint16(2, x);
        view.setUint16(4, y);
        return bytes;
      };

      it('forwards a validated event upstream byte-for-byte', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        up();
        await drive(client, id);

        const click = pointer(0b1, 640, 400);
        screens.input(client as never, id, click, 1);

        // §4.3 forwards; it does not re-encode. What x11vnc receives is what
        // the operator's client produced.
        expect(latest().sentInput.map((b) => [...b])).toEqual([[...click]]);
      });

      it('routes to the bot named in the frame, not to the last subscription', async () => {
        const first = await runningBot();
        const second = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, first);
        const firstUpstream = latest();
        await screens.subscribe(USER_ID, client as never, second);
        const secondUpstream = latest();
        await drive(client, first);

        // The reason D-035 puts a bot id on the wire: one socket, two
        // desktops, and no envelope on a binary frame to carry it otherwise.
        screens.input(client as never, first, pointer(1, 1, 1), 1);

        expect(firstUpstream.sentInput).toHaveLength(1);
        expect(secondUpstream.sentInput).toHaveLength(0);
      });

      it('refuses input from a socket that never subscribed', async () => {
        const id = await runningBot();
        await screens.subscribe(USER_ID, new FakeClient() as never, id);

        // An authenticated socket is not an authorisation to drive a desktop,
        // and a connection that exists for someone else is not an opening.
        expect(() => screens.input(new FakeClient() as never, id, pointer(1, 5, 5), 1)).toThrow(
          /not subscribed/,
        );
        expect(latest().sentInput).toHaveLength(0);
      });

      it('refuses input for a bot the socket has unsubscribed from', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        const upstream = latest();
        screens.unsubscribe(client as never, id);

        expect(() => screens.input(client as never, id, pointer(1, 5, 5), 1)).toThrow(
          /not subscribed/,
        );
        expect(upstream.sentInput).toHaveLength(0);
      });

      it('answers the same way for an unknown bot as for an unsubscribed one', async () => {
        const client = new FakeClient();
        // Distinguishing them would answer "does this bot exist" over a
        // channel that never had to.
        expect(() =>
          screens.input(client as never, 'cmtk4b0x20009a03bc8vtxx0w', pointer(1, 1, 1), 1),
        ).toThrow(/not subscribed/);
      });

      it.each([
        ['SetPixelFormat', 0, 20],
        ['SetEncodings', 2, 12],
        ['FramebufferUpdateRequest', 3, 10],
        ['ClientCutText', 6, 16],
      ])('refuses %s and forwards nothing', async (_name, type, length) => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        up();

        const message = new Uint8Array(length);
        message[0] = type;
        // Each of these reconfigures a connection that is SHARED with every
        // other watcher of this desktop; see rfb-input.ts for what each breaks.
        expect(() => screens.input(client as never, id, message, 1)).toThrow(/not forwarded/);
        expect(latest().sentInput).toHaveLength(0);
      });

      it('refuses a well-formed event with a message smuggled after it', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        up();

        const smuggled = new Uint8Array([...pointer(1, 4, 4), 0, ...new Uint8Array(19)]);
        expect(() => screens.input(client as never, id, smuggled, 1)).toThrow(/oversized/);
        expect(latest().sentInput).toHaveLength(0);
      });

      it('says the connection is gone rather than dropping the event in silence', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        const upstream = latest();
        upstream.ready();
        upstream.isStreaming = false;

        expect(() => screens.input(client as never, id, pointer(1, 4, 4), 1)).toThrow(
          /not connected/,
        );
      });
    });

    describe('losing the upstream', () => {
      it('reports failure after three unsuccessful reconnects, without looping forever', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        const listener = new FakeClient();
        app.get(TurnEventBus).add(listener as never, {
          userId: () => USER_ID,
          expired: () => undefined,
        });

        await screens.subscribe(USER_ID, client as never, id);
        const upstream = latest();
        upstream.ready();
        upstream.drop(new Error('container went away'));
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await vi.waitFor(() => expect(FakeUpstream.opened).toHaveLength(attempt + 2), {
            timeout: 4500,
          });
          latest().drop(new Error('container went away'));
        }
        expect(screens.subscriberCount(id)).toBe(0);
        // Delivered a round trip after it is emitted: the bus reads the bot's
        // owner before its first frame goes anywhere.
        await vi.waitFor(() => expect(listener.json.length).toBeGreaterThan(0));

        const lost = listener.json.find((f) => f.type === 'error') as
          { botId?: string; payload: { code: string; message: string } } | undefined;
        expect(lost?.payload.code).toBe('SCREEN_STREAM_LOST');
        expect(lost?.payload.message).toMatch(/could not reconnect/);
        expect(lost?.botId).toBe(id);
      }, 10_000);

      it('stays quiet when the upstream closes without a fault', async () => {
        const id = await runningBot();
        const listener = new FakeClient();
        app.get(TurnEventBus).add(listener as never, {
          userId: () => USER_ID,
          expired: () => undefined,
        });
        await screens.subscribe(USER_ID, new FakeClient() as never, id);
        const upstream = latest();
        upstream.ready();

        // An ordinary close is what shutting down causes. Reporting it as an
        // error would make every normal teardown look like a failure.
        upstream.drop(null);
        expect(listener.json).toHaveLength(0);
      });

      it('recovers, ignoring callbacks from the old connection, and input goes to the new one', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        const upstream = latest();
        upstream.ready();
        upstream.drop(new Error('transport lost'));
        expect(screens.subscriberCount(id)).toBe(1);
        await vi.waitFor(() => expect(FakeUpstream.opened).toHaveLength(2));
        const replacement = latest();
        replacement.ready();
        await drive(client, id);
        upstream.drop(new Error('late close'));
        expect(screens.subscriberCount(id)).toBe(1);
        screens.input(client as never, id, new Uint8Array([5, 0, 0, 40, 0, 50]), 2);
        expect([...replacement.sentInput.at(-1)!]).toEqual([5, 0, 0, 40, 0, 50]);
      });

      it('stops recovery quietly when the computer was intentionally stopped', async () => {
        const id = await runningBot();
        const listener = new FakeClient();
        app.get(TurnEventBus).add(listener as never, {
          userId: () => USER_ID,
          expired: () => undefined,
        });
        await screens.subscribe(USER_ID, new FakeClient() as never, id);
        latest().ready();
        await setState(id, 'STOPPED');
        latest().drop(new Error('RFB upstream closed unexpectedly'));
        await vi.waitFor(() => expect(screens.subscriberCount(id)).toBe(0));
        expect(FakeUpstream.opened).toHaveLength(1);
        expect(listener.json).toHaveLength(0);
      });

      it('cancels pending recovery when its last watcher leaves', async () => {
        const id = await runningBot();
        const client = new FakeClient();
        await screens.subscribe(USER_ID, client as never, id);
        latest().ready();
        latest().drop(new Error('transport lost'));
        screens.unsubscribe(client as never, id);
        expect(screens.subscriberCount(id)).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(FakeUpstream.opened).toHaveLength(1);
      });
    });
  },
);
