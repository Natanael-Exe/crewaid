import { privateComputerBot } from './computer-fixtures.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * M4-BE-07 — §6/M4's degradation clause, end to end.
 *
 * "If Chrome or CDP is unreachable, recording degrades silently to X11-only
 * and sets `Recording.cdpAvailable = false`." What is real here: the whole
 * module graph (ScreenModule → RecordingsModule), the real lifecycle, the
 * real CDP attach making a real connection attempt, the real tee, the real
 * §4.3 input entry (`ScreenService.input`), and a real database. What is
 * faked: the sandbox provider, whose CDP endpoint answers an address with
 * nothing on it — the attach must fail the way a sandbox without a browser
 * makes it fail — and the RFB upstream, which the input frames need to exist
 * somewhere downstream of the tee.
 *
 * The real-Chrome side of the drop — an attach that succeeds and a browser
 * that dies mid-recording — is `cdp-degrade-docker.integration.test.ts`.
 * This suite is the CI-visible half: the attach-failure path, the row's flag,
 * the X11 layer continuing untouched, and no user-visible error anywhere.
 *
 * The fakes are the tee suite's (`recording-tee.integration.test.ts`), kept
 * in step with it by hand because that suite owns the full behaviour; these
 * are the parts this one needs.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const BOT_PREFIX = 'm4be07deg';

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

/**
 * A port with nothing behind it: bound to prove it is free, then released.
 * Deterministic where a guessed port number would be a race with whatever
 * else this host is running.
 */
async function deadAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** Poll a durable condition; the attach answers nobody, so nothing awaits it. */
async function until(condition: () => Promise<boolean>, message: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting until ${message}`);
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M4-BE-07 CDP degradation (real db, no Chrome behind the endpoint)',
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
        // ScreenModule pulls in RecordingsModule, which is the wiring under
        // test: the CDP layer has to be reachable from the recording start.
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
      // Stop capture before deleting anything: a flush timer writing into a
      // recordingId whose row is being cascaded away turns cleanup into a
      // foreign-key error the hook would report as its own failure.
      for (const id of created) await tee?.end(id).catch(() => undefined);
      await prisma?.bot.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
      await app?.close();
    }, 30_000);

    beforeEach(async () => {
      const bot = await privateComputerBot(prisma, provider, SINGLETON_USER_ID, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      botId = bot.id;
      created.push(botId);
      client = new FakeClient();
      // Everything in this suite records against a CDP endpoint that refuses
      // connections — the browser the deploy did not have (or lost).
      provider.cdpUrl = await deadAddress();
    });

    it('records the degradation on the row while capture continues over X11', async () => {
      const { recordingId } = await recordings.start(SINGLETON_USER_ID, botId, {
        intent: 'teach me something, browser or not',
      });

      // The attach is fire-and-forget; the row is where its outcome becomes
      // durable. `start` answered before any of this was decided.
      await until(async () => {
        const row = await prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
        return row.cdpAvailable === false;
      }, 'the row to record cdpAvailable=false');

      // Nothing else moved and nothing is user-visible: still capturing, no
      // warning, no error, not settled.
      const degraded = await prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
      expect(degraded).toMatchObject({
        state: 'RECORDING',
        cdpAvailable: false,
        warning: null,
        error: null,
        endedAt: null,
      });

      // The X11 half is untouched (§6/M4): a viewer attaches, and validated
      // input frames keep producing rows through the real §4.3 entry.
      await screens.subscribe(SINGLETON_USER_ID, client as unknown as WebSocket, botId);
      // Watching is not driving (D-168): the operator takes the seat first.
      await screens.control(client as unknown as WebSocket, botId, { botId, action: 'take' });
      screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 100, 100), 1);
      screens.input(client as unknown as WebSocket, botId, pointerEvent(1, 120, 140), 1);

      const status = await recordings.status(SINGLETON_USER_ID, recordingId);
      expect(status).toMatchObject({
        state: 'RECORDING',
        cdpAvailable: false,
        warning: null,
        error: null,
        counts: { x11: 2, cdp: 0 },
      });

      // And the recording settles through the normal path — a stop with no
      // error anywhere, handed to the compiler like any X11-only trace.
      const settled = await recordings.stop(SINGLETON_USER_ID, recordingId);
      expect(settled).toMatchObject({
        id: recordingId,
        cdpAvailable: false,
        warning: null,
        error: null,
      });
      expect(enqueued).toContain(recordingId);

      const rows = await prisma.recordingEvent.findMany({
        where: { recordingId },
        orderBy: { tsOffsetMs: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.layer === 'X11')).toBe(true);
    }, 30_000);
  },
);
