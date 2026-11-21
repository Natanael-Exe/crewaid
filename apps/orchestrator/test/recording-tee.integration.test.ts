import { privateComputerBot } from './computer-fixtures.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { FakeProvider, FakeSeatService } from './sandbox-fakes.js';
import { MAX_RECORDING_EVENTS } from '../src/recordings/recording-limits.js';
import { SKILL_COMPILE_QUEUE } from '../src/skills/skill-compile.queue.js';

/**
 * M3-BE-01 — §4.3's tee end to end (§6/M3).
 *
 * Real database, fake provider and fake upstream: what is under test is that a
 * validated input event becomes a durable `RecordingEvent` row in the right
 * order, and Docker and x11vnc decide none of that. The path is driven through
 * `ScreenService.input` rather than by calling the tee directly, because the
 * wiring between them is exactly the thing that would regress silently — a tee
 * nobody calls persists nothing and fails no test that only knows about the
 * tee.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const BOT_PREFIX = 'm3be01tee';

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

/** One RFB KeyEvent (RFC 6143 §7.5.4). */
function keyEvent(down: boolean, keysym: number): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 4);
  view.setUint8(1, down ? 1 : 0);
  view.setUint32(4, keysym);
  return bytes;
}

/** Poll a durable condition: the auto-stop answers nobody, so nothing awaits it. */
async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the recording was never settled');
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M3-BE-01 recording tee (real db)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let bots: BotsService;
    let recordings: RecordingsService;
    let tee: RecordingTeeService;
    let screens: ScreenService;
    let botId: string;
    let client: FakeClient;
    const created: string[] = [];
    // §4.1's stop "enqueues compilation" (M3-BE-06). Recorded rather than run:
    // what this suite is about is the tee reaching Postgres, and a real BullMQ
    // queue would put Redis between every stop and its assertion.
    const enqueued: string[] = [];

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        // ScreenModule pulls in RecordingsModule, which is the wiring under
        // test: the tee has to be reachable from the input path.
        imports: [(await import('../src/screen/screen.module.js')).ScreenModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
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
      tee = app.get(RecordingTeeService);
      screens = app.get(ScreenService);
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
      // Stop capture before deleting anything. A recording this suite left
      // running still holds a flush timer, and letting it write into a
      // recordingId whose row is being cascaded away turns cleanup into a
      // foreign-key error the hook would report as its own failure.
      for (const id of created) await tee?.end(id).catch(() => undefined);
      // By id, not by a `startsWith` scan over every bot in a shared database:
      // the ids are already collected, and the indexed delete is what keeps
      // this hook inside its timeout when the box is busy.
      await prisma?.bot.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
      await app?.close();
    }, 30_000);

    beforeEach(async () => {
      const bot = await privateComputerBot(prisma, app.get(SANDBOX_PROVIDER), SINGLETON_USER_ID, {
        name: `${BOT_PREFIX}-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      botId = bot.id;
      created.push(botId);
      client = new FakeClient();
    });

    /** Start a recording, then attach a viewer so `input` is authorised. */
    async function startRecordingAndWatch(): Promise<string> {
      const { recordingId } = await recordings.start(SINGLETON_USER_ID, botId, {});
      await screens.subscribe(SINGLETON_USER_ID, client as unknown as WebSocket, botId);
      // Watching is not driving (D-168): the operator takes the seat first.
      await screens.control(client as unknown as WebSocket, botId, { botId, action: 'take' });
      return recordingId;
    }

    function eventsOf(recordingId: string) {
      return prisma.recordingEvent.findMany({
        where: { recordingId },
        orderBy: { tsOffsetMs: 'asc' },
      });
    }

    it('wakes the computer and opens a RECORDING row', async () => {
      const { recordingId } = await recordings.start(SINGLETON_USER_ID, botId, {
        intent: 'open the settings panel',
      });

      const row = await prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
      expect(row.state).toBe('RECORDING');
      expect(row.intent).toBe('open the settings panel');
      expect(row.endedAt).toBeNull();

      // D-039 §16: recording is one of the three things that may wake a
      // computer, and it goes through the same ensure-ready path as the rest.
      const sandbox = await prisma.sandbox.findFirstOrThrow({
        where: { bots: { some: { id: botId } } },
      });
      expect(sandbox.state).toBe('RUNNING');
    });

    it('refuses a second recording for the same bot', async () => {
      await recordings.start(SINGLETON_USER_ID, botId, {});

      // A second row could never be stopped: `stop` resolves the tee by bot.
      await expect(recordings.start(SINGLETON_USER_ID, botId, {})).rejects.toMatchObject({
        status: 409,
      });
    });

    it('persists one X11 row per validated input frame, in order', async () => {
      const recordingId = await startRecordingAndWatch();

      // §6/M3: "every validated inbound `screen.input` frame during an active
      // recording produces a `RecordingEvent` with `layer: X11`" — for frames
      // the next capture rule does not coalesce. The mask alternates, so all
      // twenty are button transitions and all twenty are expected rows; the
      // coalesced case has an integration test of its own below.
      for (let i = 0; i < 20; i += 1) {
        const mask = i % 2 === 0 ? 1 : 0;
        screens.input(
          client as unknown as WebSocket,
          botId,
          pointerEvent(mask, 100 + i, 200 + i),
          1,
        );
      }
      await recordings.stop(SINGLETON_USER_ID, recordingId);

      const rows = await eventsOf(recordingId);
      expect(rows).toHaveLength(20);
      expect(rows.every((row) => row.layer === 'X11')).toBe(true);
      expect(rows.map((row) => (row.payload as { x: number }).x)).toEqual(
        Array.from({ length: 20 }, (_, i) => 100 + i),
      );
      // Strictly increasing, not merely sorted: §3 gives the trace no
      // tiebreaker column, so equal offsets would leave the order of two
      // adjacent events up to Postgres.
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]!.tsOffsetMs).toBeGreaterThan(rows[i - 1]!.tsOffsetMs);
      }
    });

    it('records the decoded event rather than the bytes', async () => {
      const recordingId = await startRecordingAndWatch();

      screens.input(client as unknown as WebSocket, botId, pointerEvent(1, 640, 400), 1);
      screens.input(client as unknown as WebSocket, botId, keyEvent(true, 0x68), 1);
      await recordings.stop(SINGLETON_USER_ID, recordingId);

      const rows = await eventsOf(recordingId);
      // The keystroke reaches the trace as the text it types (M3-BE-03), and
      // only once `stop` ends the run — a keysym is not something a skill can
      // replay, and until something ends the run the next key may join it.
      expect(rows.map((row) => row.type)).toEqual(['pointer', 'type']);
      expect(rows[0]?.payload).toEqual({ x: 640, y: 400, buttonMask: 1 });
      expect(rows[1]?.payload).toEqual({ text: 'h' });
      // M3-BE-04 asks the bridge for a screenshot on button-down, and nothing
      // answers on the fake provider's port. A crop that cannot be captured
      // costs its own key and nothing else — the click is still a click.
      expect(rows[0]?.screenshotKey).toBeNull();
      expect(rows[0]?.payload).not.toHaveProperty('cropX');
    });

    it('stores a 200x200 crop on a button-down and names it on the row', async () => {
      const artifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-m3be04-'));
      const previousDir = process.env['ARTIFACT_DIR'];
      process.env['ARTIFACT_DIR'] = artifactDir;
      // The agent-bridge, stood in for at the port the provider published.
      // What is under test is the wiring — that the tee reaches a real
      // ClickScreenshotService through Nest, and that a real Prisma write
      // carries the key — not what scrot produces.
      const framebuffer = PNG.sync.write(new PNG({ width: 1280, height: 800 }));
      const fetchMock = vi.fn();
      // A fresh Response per call — one stubbed body answers both the crop
      // and the attach's `/json/version` discovery, and a Response's body can
      // only be read once. A `Uint8Array` copy, not the Buffer: it stands in
      // for `fetch`, whose body type takes a BufferSource.
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(new Uint8Array(framebuffer), {
            headers: { 'content-type': 'image/png' },
          }),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      try {
        const recordingId = await startRecordingAndWatch();
        screens.input(client as unknown as WebSocket, botId, pointerEvent(1, 640, 400), 1);
        // A move afterwards, to prove the key lands on the press and not on
        // whatever the batch happened to write beside it.
        screens.input(client as unknown as WebSocket, botId, pointerEvent(1, 700, 400), 1);
        await recordings.stop(SINGLETON_USER_ID, recordingId);

        const rows = await eventsOf(recordingId);
        // The crop's request, not "the first fetch": starting a recording now
        // also attaches to the sandbox's Chrome (M4-BE-01), and that attach's
        // `/json/version` discovery goes through this same stubbed fetch — it
        // degrades to X11-only here, because what answers it is a PNG.
        const cropCalls = fetchMock.mock.calls.filter((call) =>
          /\/screenshot\?botId=/.test(String(call[0])),
        );
        expect(cropCalls).toHaveLength(1);
        expect(rows).toHaveLength(2);
        expect(rows[1]?.screenshotKey).toBeNull();

        const key = rows[0]?.screenshotKey;
        expect(key).toMatch(new RegExp(`^recordings/${recordingId}/[0-9a-f-]+\\.png$`));
        const stored = PNG.sync.read(await readFile(path.join(artifactDir, key!)));
        expect({ width: stored.width, height: stored.height }).toEqual({ width: 200, height: 200 });
        // Centered: 640 - 100, 400 - 100, with room on every side.
        expect(rows[0]?.payload).toEqual({
          x: 640,
          y: 400,
          buttonMask: 1,
          cropX: 540,
          cropY: 300,
        });
      } finally {
        vi.unstubAllGlobals();
        await rm(artifactDir, { recursive: true, force: true });
        if (previousDir === undefined) delete process.env['ARTIFACT_DIR'];
        else process.env['ARTIFACT_DIR'] = previousDir;
      }
    });

    it('forwards the event to the desktop as well as recording it', async () => {
      const recordingId = await startRecordingAndWatch();

      screens.input(client as unknown as WebSocket, botId, pointerEvent(1, 7, 9), 1);
      await recordings.stop(SINGLETON_USER_ID, recordingId);

      // §4.3 tees IN ADDITION to forwarding. A recorder that swallowed the
      // event would leave the operator's click doing nothing.
      expect(await eventsOf(recordingId)).toHaveLength(1);
    });

    it('records nothing for a bot with no active recording', async () => {
      const recordingId = await startRecordingAndWatch();
      await recordings.stop(SINGLETON_USER_ID, recordingId);

      screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 1, 1), 1);
      await tee.settle(botId);

      expect(await eventsOf(recordingId)).toHaveLength(0);
    });

    it('merges typed keys down the real input path into one row', async () => {
      const recordingId = await startRecordingAndWatch();

      // "hi", then Return — the shape almost every recorded task starts with.
      for (const keysym of [0x68, 0x69]) {
        screens.input(client as unknown as WebSocket, botId, keyEvent(true, keysym), 1);
        screens.input(client as unknown as WebSocket, botId, keyEvent(false, keysym), 1);
      }
      screens.input(client as unknown as WebSocket, botId, keyEvent(true, 0xff0d), 1);
      await recordings.stop(SINGLETON_USER_ID, recordingId);

      const rows = await eventsOf(recordingId);
      // Five frames in, two rows out: the key-ups carry nothing SkillContext
      // could replay, and Return ends the run rather than joining it.
      expect(rows.map((row) => [row.type, row.payload])).toEqual([
        ['type', { text: 'hi' }],
        ['key', { combo: 'Return' }],
      ]);
    });

    it('coalesces a burst of moves down the real input path, keeping the last', async () => {
      const recordingId = await startRecordingAndWatch();

      // The mask never changes, so every frame after the first is a move. This
      // is the path `ScreenService.input` actually drives, so it proves the
      // coalescer is wired into the tee rather than merely correct in isolation.
      for (let i = 0; i < 200; i += 1) {
        screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 300 + i, 400 + i), 1);
      }
      await recordings.stop(SINGLETON_USER_ID, recordingId);

      const rows = await eventsOf(recordingId);
      // 200 frames inside one 100 ms window: the first opens it, and the last
      // is the held move the stop released. Nothing between them is a row.
      expect(rows.length).toBeLessThan(10);
      expect((rows.at(-1)?.payload as { x: number }).x).toBe(499);
      const offsets = rows.map((row) => row.tsOffsetMs);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    });

    it('settles to READY with the counts the trace actually holds', async () => {
      const recordingId = await startRecordingAndWatch();
      for (let i = 0; i < 5; i += 1) {
        screens.input(
          client as unknown as WebSocket,
          botId,
          pointerEvent(i % 2 === 0 ? 1 : 0, i, i),
          1,
        );
      }

      const status = await recordings.stop(SINGLETON_USER_ID, recordingId);

      // §4.1: "stop and enqueue compilation". The trace is whole, so the row
      // goes to COMPILING and the compiler takes it from there (M3-BE-06);
      // READY is what the compile settles it to once a skill exists.
      expect(status).toMatchObject({
        id: recordingId,
        state: 'COMPILING',
        error: null,
        counts: { x11: 5, cdp: 0, atspi: 0 },
        skillId: null,
      });
      expect(enqueued).toContain(recordingId);
      const row = await prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
      expect(row.endedAt).not.toBeNull();
    });

    it('does not enqueue a compile for a trace with a gap in it', async () => {
      const recordingId = await startRecordingAndWatch();
      screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 1, 1), 1);
      vi.spyOn(tee, 'end').mockResolvedValueOnce({
        counts: { x11: 1, cdp: 0, atspi: 0 },
        lostEvents: 2,
      });

      const status = await recordings.stop(SINGLETON_USER_ID, recordingId);

      // Compiling a trace with a hole produces a skill that silently skips
      // whatever was missing — worse than no skill, because it fails on the
      // user's screen at a step whose cause is long gone.
      expect(status.state).toBe('FAILED');
      expect(enqueued).not.toContain(recordingId);
      // §6 asks for "a FAILED recording with a readable error" (D-044).
      expect(status.error).toMatch(/never reached the database/);
      vi.restoreAllMocks();
      await tee.end(botId);
    });

    it('settles FAILED when the trace lost events on their way to Postgres', async () => {
      const recordingId = await startRecordingAndWatch();
      screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 1, 1), 1);
      // The tee counts a batch it could not write rather than retrying an
      // unavailable database forever; this asserts the lifecycle ACTS on that
      // count. Without it the recorder reports the loss to nobody and a
      // half-recorded trace settles READY, which M3-BE-06 would then compile
      // into a skill that silently skips whatever was in the hole.
      vi.spyOn(tee, 'end').mockResolvedValueOnce({
        counts: { x11: 1, cdp: 0, atspi: 0 },
        lostEvents: 3,
      });

      const status = await recordings.stop(SINGLETON_USER_ID, recordingId);

      expect(status.state).toBe('FAILED');
      vi.restoreAllMocks();
      await tee.end(botId);
    });

    it('refuses to stop a recording that already stopped', async () => {
      const recordingId = await startRecordingAndWatch();
      await recordings.stop(SINGLETON_USER_ID, recordingId);

      await expect(recordings.stop(SINGLETON_USER_ID, recordingId)).rejects.toMatchObject({
        status: 409,
      });
    });

    it('discards a recording and frees the bot to record again', async () => {
      const recordingId = await startRecordingAndWatch();
      screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 3, 3), 1);
      await prisma.skill.createMany({
        data: [
          {
            botId,
            name: 'discarded_take',
            description: 'draft one',
            paramsSchema: {},
            steps: [],
            script: 'export default async () => 1;',
            version: 1,
            status: 'DRAFT',
            sourceRecordingId: recordingId,
          },
          {
            botId,
            name: 'discarded_take',
            description: 'draft two',
            paramsSchema: {},
            steps: [],
            script: 'export default async () => 2;',
            version: 2,
            status: 'DRAFT',
            sourceRecordingId: recordingId,
          },
          {
            botId,
            name: 'discarded_take',
            description: 'approved history',
            paramsSchema: {},
            steps: [],
            script: 'export default async () => 3;',
            version: 3,
            status: 'APPROVED',
            sourceRecordingId: recordingId,
          },
        ],
      });

      const status = await recordings.discard(SINGLETON_USER_ID, recordingId);

      expect(status.state).toBe('DISCARDED');
      expect(
        await prisma.skill.count({ where: { sourceRecordingId: recordingId, status: 'DRAFT' } }),
      ).toBe(0);
      expect(
        await prisma.skill.count({ where: { sourceRecordingId: recordingId, status: 'APPROVED' } }),
      ).toBe(1);
      // The slot is the tee's, and a discard has to give it back or the bot
      // can never be taught anything again.
      await expect(recordings.start(SINGLETON_USER_ID, botId, {})).resolves.toMatchObject({
        recordingId: expect.any(String),
      });
    });

    it('reports counts without stopping, for a recording still in progress', async () => {
      const recordingId = await startRecordingAndWatch();
      screens.input(client as unknown as WebSocket, botId, pointerEvent(0, 1, 1), 1);
      screens.input(client as unknown as WebSocket, botId, pointerEvent(1, 2, 2), 1);

      const status = await recordings.status(SINGLETON_USER_ID, recordingId);

      // Buffered events are flushed first, so the number answered here is the
      // number a reader of the trace would find rather than one of two tallies.
      expect(status).toMatchObject({ state: 'RECORDING', counts: { x11: 2, cdp: 0, atspi: 0 } });
    });

    it('does not let status polling bypass pointer coalescing', async () => {
      const recordingId = await startRecordingAndWatch();
      // Fix arrival times without faking the timers used by database I/O.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      try {
        for (let i = 0; i < 20; i += 1) {
          screens.input(client as unknown as WebSocket, botId, pointerEvent(0, i, i), 1);
          const status = await recordings.status(SINGLETON_USER_ID, recordingId);
          expect(status.counts.x11).toBe(1);
          expect(await eventsOf(recordingId)).toHaveLength(1);
        }
        const stopped = await recordings.stop(SINGLETON_USER_ID, recordingId);
        expect(stopped.counts.x11).toBe(2);
        expect((await eventsOf(recordingId)).at(-1)?.payload).toMatchObject({ x: 19, y: 19 });
      } finally {
        clock.mockRestore();
      }
    });

    it('does not resolve a recording that belongs to someone else', async () => {
      const recordingId = await startRecordingAndWatch();

      await expect(recordings.status('some-other-user', recordingId)).rejects.toMatchObject({
        status: 404,
      });
      // The same sentence for absent and foreign: distinguishing them would
      // answer a question this route never had to answer.
      await expect(
        recordings.status(SINGLETON_USER_ID, 'ckzzzzzzzzzzzzzzzzzzzzzzz'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('stops itself at the event ceiling, and captures nothing after it', async () => {
      const recordingId = await startRecordingAndWatch();

      // Driven through `screens.input`, so what is under test includes the
      // wiring: a ceiling the tee enforces but the input path never reaches
      // would pass every unit test and hold nothing back in production.
      // Alternating masks are button transitions, which no capture rule
      // thins — 5000 frames in, 5000 events captured.
      for (let i = 0; i < MAX_RECORDING_EVENTS; i += 1) {
        screens.input(client as unknown as WebSocket, botId, pointerEvent(i % 2, i % 600, 1), 1);
      }
      await until(async () => {
        const row = await prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
        return row.state !== 'RECORDING';
      });

      const row = await prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
      // §6/M3: "Exceeding either auto-stops and marks the recording READY
      // with a warning." The warning is written when capture ends; the trace
      // is whole up to the ceiling, so it goes to the compiler like any other
      // and READY is where that settles it (M3-BE-06).
      expect(row).toMatchObject({ state: 'COMPILING', warning: 'EVENT_LIMIT' });
      expect(enqueued).toContain(recordingId);
      expect(row.endedAt).not.toBeNull();
      expect(await eventsOf(recordingId)).toHaveLength(MAX_RECORDING_EVENTS);

      // The operator has not noticed yet and is still using the desktop.
      // These frames are accepted and forwarded — `input` throws when they
      // are not — and simply stop being recorded: a full recording ends the
      // recorder, not the session someone is in the middle of.
      for (let i = 0; i < 50; i += 1) {
        screens.input(client as unknown as WebSocket, botId, pointerEvent(i % 2, i, 2), 1);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await eventsOf(recordingId)).toHaveLength(MAX_RECORDING_EVENTS);
    }, 60_000);

    it('settles a recording left open by a process that is gone', async () => {
      const orphan = await prisma.recording.create({ data: { botId } });

      await recordings.recoverInterruptedRecordings();

      // Its tee died with the last process, so it captures nothing — and §8's
      // idle sweep would still read it as work and pin the container open.
      const row = await prisma.recording.findUniqueOrThrow({ where: { id: orphan.id } });
      expect(row.state).toBe('FAILED');
      expect(row.endedAt).not.toBeNull();
    });

    it('re-queues a compile stranded in COMPILING by a process that is gone', async () => {
      const stranded = await prisma.recording.create({
        data: { botId, state: 'COMPILING' },
      });

      await recordings.recoverStrandedCompilations();

      // The row was settled but the process died before the job reached Redis
      // (or Redis lost it). Nothing else re-enqueues, so without the sweep the
      // row sits COMPILING with no error — D-044's silent stranding.
      const row = await prisma.recording.findUniqueOrThrow({ where: { id: stranded.id } });
      expect(row.state).toBe('COMPILING');
      expect(enqueued).toContain(stranded.id);
    });
  },
);
