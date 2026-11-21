import { privateComputerBot } from './computer-fixtures.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { WebSocket } from 'ws';

import { BotsService } from '../src/bots/bots.service.js';
import { SeatService } from '../src/sandbox/seat.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SINGLETON_USER_ID } from '../src/auth/singleton-user.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { RecordingsService } from '../src/recordings/recordings.service.js';
import { RecordingTeeService } from '../src/recordings/recording-tee.service.js';
import { ClickCorrelatorService } from '../src/recordings/click-correlator.service.js';
import type { CapturedCdpEvent } from '../src/recordings/cdp-events.js';
import { ScreenService } from '../src/screen/screen.service.js';
import {
  RFB_UPSTREAM_FACTORY,
  type ScreenUpstream,
  type ScreenUpstreamOptions,
} from '../src/screen/screen-upstream.port.js';
import type { ScreenGeometry } from '@crewaid/screen-stream';
import type { ServerMessageMeta } from '@crewaid/screen-stream';
import { SKILL_COMPILE_QUEUE } from '../src/skills/skill-compile.queue.js';
import { FakeProvider, FakeSeatService } from './sandbox-fakes.js';

/**
 * M4-BE-05 — the correlator against a real database and the real stop path.
 *
 * What is real here: the whole module graph (ScreenModule → RecordingsModule),
 * the §4.3 input entry (`ScreenService.input`, so the X11 rows are produced by
 * the real tee from real RFB frames), the tee's offset chain, the correlator
 * and its writes, and the lifecycle that runs them at stop. What is synthetic:
 * the CDP side, which is written straight to the tee as a validated report —
 * the page standing in for itself. That a real PAGE produces such a report,
 * with real coordinates, is `cdp-correlate-docker.integration.test.ts`; the
 * parser between a page and the tee is M4-BE-02's own suites.
 *
 * The timing is the test's to control, which is the point: the offset chain is
 * what decides a pair, so a real sleep between two tee calls is the honest
 * fixture — no injected offsets, no clock fake (the tee reads `Date.now`).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const BOT_PREFIX = 'm4be05corr';

/** Enough of an upstream for a subscription to exist and stay open. */
class FakeUpstream implements ScreenUpstream {
  isStreaming = true;
  screen: ScreenGeometry | null = { widthPx: 1280, heightPx: 800 };
  readonly sentInput: Uint8Array[] = [];
  private readyFn: ((geometry: ScreenGeometry) => void) | null = null;

  constructor(readonly options: ScreenUpstreamOptions) {
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
    this.sentInput.push(bytes);
    return true;
  }
  close(): void {}
}

class FakeClient extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send(_data: Buffer, _o?: unknown, callback?: (error?: Error | null) => void): void {
    callback?.(null);
  }
  terminate(): void {
    this.readyState = 3;
  }
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

/** A validated capture report as the page would send it, at desktop (x, y). */
function cdpClickAt(x: number, y: number): CapturedCdpEvent {
  return {
    type: 'click',
    payload: {
      url: 'data:text/html,<body>correlation fixture</body>',
      tag: 'body',
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      scrollX: 0,
      scrollY: 0,
      dpr: 1,
      button: 0,
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A port with nothing behind it: bound to prove it is free, then released.
 * The CDP attach burns itself against it exactly as it does in M4-BE-07's
 * suite; the rows this suite is about come from the tee.
 */
async function deadAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M4-BE-05 click correlation (real db, real tee, real stop)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let bots: BotsService;
    let recordings: RecordingsService;
    let screens: ScreenService;
    let tee: RecordingTeeService;
    let provider: FakeProvider;
    let botId: string;
    let client: FakeClient;
    const created: string[] = [];
    const enqueued: string[] = [];

    beforeAll(async () => {
      provider = new FakeProvider();
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        imports: [(await import('../src/screen/screen.module.js')).ScreenModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .overrideProvider(RFB_UPSTREAM_FACTORY)
        .useValue((options: ScreenUpstreamOptions) => new FakeUpstream(options))
        .overrideProvider(SKILL_COMPILE_QUEUE)
        .useValue({
          enqueue: (recordingId: string) => {
            enqueued.push(recordingId);
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        })
        .overrideProvider(SeatService)
        // D-046 / M5-BE-23: the §4.3 stream is the bot's seat, and resolving
        // one is an HTTP call into the machine. This suite's provider is a
        // fake with no bridge behind it.
        .useValue(new FakeSeatService())
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      bots = app.get(BotsService);
      recordings = app.get(RecordingsService);
      screens = app.get(ScreenService);
      tee = app.get(RecordingTeeService);
      await prisma.user.upsert({
        where: { id: SINGLETON_USER_ID },
        create: {
          id: SINGLETON_USER_ID,
          name: 'Test User',
          email: `${SINGLETON_USER_ID}@test.invalid`,
        },
        update: {},
      });
    });

    afterAll(async () => {
      for (const id of created) await tee?.end(id).catch(() => undefined);
      await prisma?.bot.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
      await app?.close();
    }, 30_000);

    it('marks both rows of a provable pair, and only a provable one', async () => {
      const bot = await privateComputerBot(prisma, provider, SINGLETON_USER_ID, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      botId = bot.id;
      created.push(botId);
      client = new FakeClient();
      provider.cdpUrl = await deadAddress();

      const { recordingId } = await recordings.start(SINGLETON_USER_ID, botId, {
        intent: 'click the button',
      });

      // The real §4.3 entry: a viewer subscribes, and its input frames are
      // teed — the X11 rows below are the tee's own work.
      await screens.subscribe(SINGLETON_USER_ID, client as unknown as WebSocket, botId);
      // Watching is not driving (D-168): the operator takes the seat first.
      await screens.control(client as unknown as WebSocket, botId, { botId, action: 'take' });

      // ── a pair that must correlate: the page reports while the press is
      // fresh, at exactly the framebuffer coordinates the press carried ─────
      screens.input(client as unknown as WebSocket, botId, pointerEvent(1, 300, 200), 1);
      await sleep(30);
      tee.teeCdp(botId, cdpClickAt(300, 200));
      screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 300, 200), 1);

      await sleep(10);

      // ── a pair that must not: same place, far outside the 150 ms window ──
      screens.input(client as unknown as WebSocket, botId, pointerEvent(1, 700, 500), 1);
      await sleep(400);
      tee.teeCdp(botId, cdpClickAt(700, 500));
      screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 700, 500), 1);

      await sleep(10);

      // ── a pair that must not: within the window, a different place ───────
      screens.input(client as unknown as WebSocket, botId, pointerEvent(1, 100, 100), 1);
      await sleep(30);
      tee.teeCdp(botId, cdpClickAt(600, 600));
      screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 100, 100), 1);

      // The stop settles the trace and runs the correlator — nothing below
      // calls it directly; this is the lifecycle wiring under test.
      const settled = await recordings.stop(SINGLETON_USER_ID, recordingId);
      expect(settled.state).toBe('COMPILING');
      expect(enqueued).toContain(recordingId);

      const rows = await prisma.recordingEvent.findMany({
        where: { recordingId },
        orderBy: { tsOffsetMs: 'asc' },
      });
      const pressAt = (x: number, y: number) =>
        rows.find(
          (row) =>
            row.layer === 'X11' &&
            row.type === 'pointer' &&
            (row.payload as Record<string, unknown>)['buttonMask'] === 1 &&
            (row.payload as Record<string, unknown>)['x'] === x &&
            (row.payload as Record<string, unknown>)['y'] === y,
        );
      const clickAt = (x: number, y: number) =>
        rows.find(
          (row) =>
            row.layer === 'CDP' &&
            row.type === 'click' &&
            (row.payload as Record<string, unknown>)['screenX'] === x,
        );

      // The in-window pair: BOTH rows name each other, which is what lets the
      // compiler (M4-BE-06) drop one layer's row.
      const press = pressAt(300, 200);
      const click = clickAt(300, 200);
      expect(press, 'the press row').toBeDefined();
      expect(click, 'the CDP click row').toBeDefined();
      const dt = click!.tsOffsetMs - press!.tsOffsetMs;
      expect(dt, 'the fixture pair must be inside the window').toBeGreaterThanOrEqual(0);
      expect(dt, 'the fixture pair must be inside the window').toBeLessThanOrEqual(150);
      expect(press!.correlatedWithId).toBe(click!.id);
      expect(click!.correlatedWithId).toBe(press!.id);

      // The slow click: the report arrived 400 ms after the press, so §6/M4
      // does not call them one action — both rows stay as captured.
      const slowPress = pressAt(700, 500);
      const slowClick = clickAt(700, 500);
      expect(slowClick!.tsOffsetMs - slowPress!.tsOffsetMs).toBeGreaterThan(150);
      expect(slowPress!.correlatedWithId).toBeNull();
      expect(slowClick!.correlatedWithId).toBeNull();

      // The elsewhere click: quick, but at a different point — nothing pairs.
      expect(pressAt(100, 100)!.correlatedWithId).toBeNull();
      expect(clickAt(600, 600)!.correlatedWithId).toBeNull();

      // A release closes a gesture; it is not a click and never carries a
      // correlation — only the two rows of a pair do.
      const releases = rows.filter(
        (row) =>
          row.layer === 'X11' &&
          row.type === 'pointer' &&
          (row.payload as Record<string, unknown>)['buttonMask'] === 0,
      );
      expect(releases).toHaveLength(3);
      expect(releases.every((row) => row.correlatedWithId === null)).toBe(true);

      // Re-running the pass is a no-op that answers the same pairs: the
      // judgement is a function of the rows, and the write is idempotent.
      const again = await app.get(ClickCorrelatorService).correlate(recordingId);
      expect(again).toBe(1);
      const after = await prisma.recordingEvent.findMany({
        where: { recordingId },
        orderBy: { tsOffsetMs: 'asc' },
      });
      expect(after.map((row) => row.correlatedWithId)).toEqual(
        rows.map((row) => row.correlatedWithId),
      );
    }, 30_000);
  },
);
