import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingWarning } from '@crewaid/shared';

import { RecordingTeeService, totalEvents } from '../src/recordings/recording-tee.service.js';
import { MAX_RECORDING_EVENTS, MAX_RECORDING_MS } from '../src/recordings/recording-limits.js';
import { SECRET_TYPING_TEXT } from '../src/recordings/recording-events.js';
import type { CapturedCdpEvent } from '../src/recordings/cdp-events.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';
import type { RfbInputEvent } from '../src/screen/rfb-input.js';
import type {
  ClickScreenshotService,
  StoredCrop,
} from '../src/recordings/click-screenshot.service.js';

/**
 * M3-BE-01 — §4.3's tee.
 *
 * A unit test with a stub client, because what is under test is the shape of
 * the writes and their ORDER, not what Postgres does with them. The call site
 * is `screen.input`, which carries every mouse move the operator makes, so the
 * two properties that matter are that the path never blocks and that a batch
 * cannot overtake the batch before it.
 */

interface Batch {
  recordingId: string;
  tsOffsetMs: number;
  layer: string;
  type: string;
  payload: unknown;
  screenshotKey: string | null;
}

function fakePrisma() {
  const batches: Batch[][] = [];
  const held: (() => void)[] = [];
  const control = { holdFirst: 0, fail: null as Error | null };

  const prisma = {
    recordingEvent: {
      createMany: async ({ data }: { data: Batch[] }) => {
        if (control.fail !== null) throw control.fail;
        // Only the FIRST n writes are held, so a later batch is free to finish
        // early. Holding every write would make an unchained implementation
        // look correct: the gates release in insertion order, so the batches
        // would land in order by accident rather than by design.
        if (control.holdFirst > 0) {
          control.holdFirst -= 1;
          await new Promise<void>((resolve) => held.push(resolve));
        }
        // Pushed AFTER the wait, so the recorded order is completion order —
        // which is the thing the chaining is supposed to keep honest.
        batches.push(data);
        return { count: data.length };
      },
    },
  } as unknown as PrismaService;

  const releaseAll = () => {
    for (const resolve of held.splice(0)) resolve();
  };
  return { prisma, batches, control, releaseAll };
}

function fakeEvents() {
  const emitRecordingEvent = vi.fn();
  const events = { emitRecordingEvent, emitRecordingState: vi.fn() } as unknown as TurnEventBus;
  return { events, emitRecordingEvent };
}

/**
 * The M3-BE-04 capture, stubbed.
 *
 * `capture` is the only thing the tee asks of it, and the tee's contract is
 * that a click screenshot never delays or fails the trace — so the interesting
 * settings are the slow one and the failing one, not the happy path.
 */
function fakeScreenshots() {
  const calls: { botId: string; recordingId: string; x: number; y: number }[] = [];
  const control = { crop: null as StoredCrop | null, hold: false };
  const held: ((crop: StoredCrop | null) => void)[] = [];

  const capture = vi.fn(async (botId: string, recordingId: string, x: number, y: number) => {
    calls.push({ botId, recordingId, x, y });
    if (control.hold) return await new Promise<StoredCrop | null>((resolve) => held.push(resolve));
    return control.crop;
  });
  const forget = vi.fn();
  const screenshots = { capture, forget } as unknown as ClickScreenshotService;

  const release = (crop: StoredCrop | null = control.crop): void => {
    for (const resolve of held.splice(0)) resolve(crop);
  };
  return { screenshots, calls, control, release, capture, forget };
}

const crop = (key: string, x = 0, y = 0): StoredCrop => ({
  key,
  rect: { x, y, width: 200, height: 200 },
});

const pointer = (x: number, y: number, buttonMask = 0): RfbInputEvent => ({
  kind: 'pointer',
  buttonMask,
  x,
  y,
});

/**
 * A pointer event that is always stored: the mask changes on every call, so
 * these are button transitions rather than moves and the M3-BE-02 window never
 * suppresses them. The tests below are about how batches are written and
 * ordered, and would otherwise be measuring the coalescer instead.
 */
const button = (i: number, y = 0): RfbInputEvent => ({
  kind: 'pointer',
  buttonMask: i % 2 === 0 ? 1 : 0,
  x: i,
  y,
});

/** Let the flush chain settle without advancing the fake clock. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function build() {
  const { prisma, batches, control, releaseAll } = fakePrisma();
  const { events, emitRecordingEvent } = fakeEvents();
  const shots = fakeScreenshots();
  const tee = new RecordingTeeService(prisma, events, shots.screenshots);
  expect(tee.reserve('bot-1')).toBe(true);
  tee.begin('bot-1', 'rec-1', new Date(Date.now()));
  return { tee, batches, control, releaseAll, emitRecordingEvent, shots };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RecordingTeeService — the active set', () => {
  it('ignores input for a bot that is not recording', async () => {
    const { prisma, batches } = fakePrisma();
    const { events } = fakeEvents();
    const { screenshots } = fakeScreenshots();
    const tee = new RecordingTeeService(prisma, events, screenshots);

    // The hot path costs nothing at all when nothing is recording, which is
    // the normal case for every bot the operator is merely watching.
    for (let i = 0; i < 500; i += 1) tee.tee('bot-1', pointer(i, i));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(batches).toEqual([]);
    expect(tee.isRecording('bot-1')).toBe(false);
  });

  it('refuses a second reservation, so two starts cannot both create a row', () => {
    const { prisma } = fakePrisma();
    const { events } = fakeEvents();
    const { screenshots } = fakeScreenshots();
    const tee = new RecordingTeeService(prisma, events, screenshots);

    expect(tee.reserve('bot-1')).toBe(true);
    // No await between the check and the set inside `reserve`, which is what
    // makes this atomic against a concurrent POST /bots/:id/recordings.
    expect(tee.reserve('bot-1')).toBe(false);
  });

  it('captures nothing while a slot is reserved but its row does not exist yet', async () => {
    const { prisma, batches } = fakePrisma();
    const { events } = fakeEvents();
    const { screenshots } = fakeScreenshots();
    const tee = new RecordingTeeService(prisma, events, screenshots);
    tee.reserve('bot-1');

    tee.tee('bot-1', pointer(1, 1));
    await vi.advanceTimersByTimeAsync(1_000);

    // Those events happened before the recording started; there is no row to
    // hang them on and no offset to measure them from.
    expect(batches).toEqual([]);
    expect(tee.isRecording('bot-1')).toBe(false);
  });

  it('frees the slot when the row was never created', () => {
    const { prisma } = fakePrisma();
    const { events } = fakeEvents();
    const { screenshots } = fakeScreenshots();
    const tee = new RecordingTeeService(prisma, events, screenshots);

    tee.reserve('bot-1');
    tee.abandon('bot-1');

    expect(tee.reserve('bot-1')).toBe(true);
  });
});

describe('RecordingTeeService — persistence', () => {
  it('writes a full batch as one statement without waiting for the timer', async () => {
    const { tee, batches } = build();

    for (let i = 0; i < RecordingTeeService.FLUSH_BATCH; i += 1) tee.tee('bot-1', button(i));
    await settle();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(RecordingTeeService.FLUSH_BATCH);
    expect(batches[0]?.[0]).toMatchObject({ recordingId: 'rec-1', layer: 'X11', type: 'pointer' });
  });

  it('flushes a partial batch once input stops', async () => {
    const { tee, batches } = build();

    tee.tee('bot-1', pointer(5, 5));
    expect(batches).toEqual([]);

    await vi.advanceTimersByTimeAsync(RecordingTeeService.FLUSH_INTERVAL_MS);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('keeps batches in the order they were filled when a write is slow', async () => {
    const { tee, batches, control, releaseAll } = build();
    // Only the first write blocks. The second would complete instantly if it
    // were allowed to start, which is precisely what must not happen.
    control.holdFirst = 1;

    for (let i = 0; i < RecordingTeeService.FLUSH_BATCH; i += 1) tee.tee('bot-1', button(i, 0));
    await settle();
    // The second batch is filled while the first is still in flight. Two
    // concurrent createMany calls could commit in either order, and
    // `tsOffsetMs` is a value we assigned rather than one Postgres derives —
    // so a reader taking rows in insertion order would see them interleaved.
    for (let i = 0; i < RecordingTeeService.FLUSH_BATCH; i += 1) tee.tee('bot-1', button(i, 1));
    await settle();

    // The discriminating assertion: without the chain the second batch has
    // already been written by now, ahead of the first.
    expect(batches).toEqual([]);
    releaseAll();
    await settle();

    expect(batches).toHaveLength(2);
    expect(batches[0]?.[0]?.payload).toMatchObject({ y: 0 });
    expect(batches[1]?.[0]?.payload).toMatchObject({ y: 1 });
  });

  it('assigns strictly increasing offsets across a same-millisecond burst', async () => {
    const { tee, batches } = build();

    // Clicks land several per millisecond too. Without the nudge these all
    // share one offset and the trace loses its order.
    for (let i = 0; i < RecordingTeeService.FLUSH_BATCH; i += 1) tee.tee('bot-1', button(i, i));
    await settle();

    const offsets = (batches[0] ?? []).map((row) => row.tsOffsetMs);
    expect(offsets).toHaveLength(RecordingTeeService.FLUSH_BATCH);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
    }
  });

  it('measures offsets from the moment the recording started', async () => {
    const { tee, batches } = build();

    await vi.advanceTimersByTimeAsync(750);
    tee.tee('bot-1', pointer(1, 1));
    await vi.advanceTimersByTimeAsync(RecordingTeeService.FLUSH_INTERVAL_MS);

    expect(batches[0]?.[0]?.tsOffsetMs).toBe(750);
  });

  it('flushes and deregisters on end, reporting the exact count', async () => {
    const { tee, batches } = build();

    tee.tee('bot-1', pointer(1, 1));
    tee.tee('bot-1', { kind: 'key', down: true, keysym: 0x68 });
    const result = await tee.end('bot-1');

    expect(result).toEqual({ counts: { x11: 2, cdp: 0, atspi: 0 }, lostEvents: 0 });
    expect(batches.flat()).toHaveLength(2);
    expect(tee.isRecording('bot-1')).toBe(false);
    expect(await tee.end('bot-1')).toBeNull();
  });

  it('drops input that arrives after the final flush', async () => {
    const { tee, batches } = build();

    await tee.end('bot-1');
    tee.tee('bot-1', pointer(9, 9));
    await vi.advanceTimersByTimeAsync(1_000);

    // A row written after `endedAt` is one no reader of the trace expects.
    expect(batches.flat()).toEqual([]);
  });

  it('makes the buffered tail durable without ending the recording', async () => {
    const { tee, batches } = build();

    tee.tee('bot-1', pointer(1, 1));
    const result = await tee.settle('bot-1');

    expect(batches.flat()).toHaveLength(1);
    expect(result).toEqual({ counts: { x11: 1, cdp: 0, atspi: 0 }, lostEvents: 0 });
    expect(tee.isRecording('bot-1')).toBe(true);
  });
});

describe('RecordingTeeService — a batch that cannot be written', () => {
  it('counts the loss instead of retrying an unavailable database forever', async () => {
    const { tee, batches, control } = build();
    control.fail = new Error('connection terminated');

    tee.tee('bot-1', pointer(1, 1));
    await vi.advanceTimersByTimeAsync(RecordingTeeService.FLUSH_INTERVAL_MS);
    control.fail = null;
    tee.tee('bot-1', pointer(2, 2));
    const result = await tee.end('bot-1');

    // The recording keeps capturing — the buffer is not allowed to grow
    // without bound — and the loss is reported so `stop` can mark it FAILED.
    // A hole is not recoverable: the compiler cannot see what is missing, so
    // it emits a skill that silently skips those steps.
    expect(result?.lostEvents).toBe(1);
    expect(batches.flat()).toHaveLength(1);
  });

  it('does not let one failed batch poison the batches after it', async () => {
    const { tee, batches, control } = build();

    control.fail = new Error('deadlock detected');
    tee.tee('bot-1', pointer(1, 1));
    await vi.advanceTimersByTimeAsync(RecordingTeeService.FLUSH_INTERVAL_MS);

    control.fail = null;
    for (let i = 0; i < RecordingTeeService.FLUSH_BATCH; i += 1) tee.tee('bot-1', button(i, i));
    await settle();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(RecordingTeeService.FLUSH_BATCH);
  });
});

describe('RecordingTeeService — §4.2 notification', () => {
  it('sends one frame per interval carrying exact counts', async () => {
    const { tee, emitRecordingEvent } = build();

    // Button transitions, because the throttle has to hold for the events the
    // M3-BE-02 coalescer does NOT reduce: a burst of moves is already thinned
    // to one per 100 ms, so measuring the throttle with moves would prove
    // nothing about the socket the desktop is streaming over.
    for (let tick = 0; tick < 30; tick += 1) {
      for (let i = 0; i < 17; i += 1) tee.tee('bot-1', button(i, tick));
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(emitRecordingEvent.mock.calls.length).toBeLessThanOrEqual(31);

    // Every count that IS sent is exact — §4.2's payload carries `counts`, not
    // a delta, so a throttled frame never leaves the counter wrong, only
    // briefly behind. Here the last frame opens the 30th tick (29 * 17 + 1)
    // and the 16 events after it are folded into a frame that never needed to
    // be sent, because the operator stopped moving. The trailing window closes
    // at `stop`, whose response body carries the settled counts.
    const last = emitRecordingEvent.mock.calls.at(-1);
    expect(last?.[4]).toEqual({ x11: 29 * 17 + 1, cdp: 0 });
    expect(last?.[2]).toBe('X11');
  });

  it('names the recording and the event type that moved the counter', async () => {
    const { tee, emitRecordingEvent } = build();

    // A printable key opens a run of typing and stores nothing yet, so the
    // event that moves the counter is the one that ENDS the run.
    tee.tee('bot-1', { kind: 'key', down: true, keysym: 0x68 });
    tee.tee('bot-1', { kind: 'key', down: true, keysym: 0xff0d }); // Return

    expect(emitRecordingEvent).toHaveBeenCalledWith('bot-1', 'rec-1', 'X11', 'key', {
      x11: 2,
      cdp: 0,
    });
  });
});

describe('RecordingTeeService — the pointer-move coalescer (M3-BE-02)', () => {
  it('stores one position per window instead of every sample of a drag', async () => {
    const { tee } = build();

    tee.tee('bot-1', pointer(0, 0, 1)); // press
    for (let i = 1; i <= 60; i += 1) {
      await vi.advanceTimersByTimeAsync(10);
      tee.tee('bot-1', pointer(i, i, 1)); // 600 ms of drag samples
    }
    tee.tee('bot-1', pointer(60, 60, 0)); // release
    const result = await tee.end('bot-1');

    // 62 events in, 8 rows out: the press, six windows over 600 ms, and the
    // release. The endpoints are what M3-BE-06 compiles a drag from; the 54
    // positions between them are interpolation.
    expect(result?.counts.x11).toBe(8);
  });

  it('stores the move the recording ended on, which nothing else would release', async () => {
    const { tee, batches } = build();

    tee.tee('bot-1', pointer(0, 0));
    await vi.advanceTimersByTimeAsync(20);
    tee.tee('bot-1', pointer(700, 400)); // inside the window — held, not written
    const result = await tee.end('bot-1');

    // Where the user left the cursor is the likeliest thing in the trace to
    // matter, and it is the one event no later event would ever release.
    expect(result?.counts.x11).toBe(2);
    expect(batches.flat().map((row) => row.payload)).toContainEqual({
      x: 700,
      y: 400,
      buttonMask: 0,
    });
  });

  it('keeps the move that aimed a click ahead of the click, at its own offset', async () => {
    const { tee, batches } = build();

    tee.tee('bot-1', pointer(0, 0)); // first move: opens the window
    await vi.advanceTimersByTimeAsync(20);
    tee.tee('bot-1', pointer(640, 400)); // held: 20 ms into the window
    await vi.advanceTimersByTimeAsync(5);
    tee.tee('bot-1', pointer(640, 400, 1)); // the press releases it
    await tee.end('bot-1');

    const rows = batches.flat();
    expect(rows.map((row) => row.payload)).toEqual([
      { x: 0, y: 0, buttonMask: 0 },
      { x: 640, y: 400, buttonMask: 0 },
      { x: 640, y: 400, buttonMask: 1 },
    ]);
    // The released move carries the time it ARRIVED. Stamping it with the
    // press's time would collapse the hover and the click into one instant,
    // which is exactly the pair the hold exists to keep apart.
    expect(rows.map((row) => row.tsOffsetMs)).toEqual([0, 20, 25]);
  });

  it('keeps the rate bound when status is polled after every move', async () => {
    const { tee, batches } = build();

    for (let i = 0; i < 500; i += 1) {
      if (i > 0) await vi.advanceTimersByTimeAsync(6);
      tee.tee('bot-1', pointer(i, i));
      const status = await tee.settle('bot-1');
      expect(status?.counts.x11).toBe(batches.flat().length);
    }

    expect(batches.flat().length).toBeLessThanOrEqual(30);
    expect(tee.isRecording('bot-1')).toBe(true);
    const result = await tee.end('bot-1');
    expect(result?.counts.x11).toBeLessThanOrEqual(31);
    expect(batches.flat().at(-1)?.payload).toEqual({ x: 499, y: 499, buttonMask: 0 });
  });

  it('retains a pre-click move across a status read', async () => {
    const { tee, batches } = build();
    tee.tee('bot-1', pointer(0, 0));
    await vi.advanceTimersByTimeAsync(20);
    tee.tee('bot-1', pointer(700, 400));
    expect((await tee.settle('bot-1'))?.counts.x11).toBe(1);
    await vi.advanceTimersByTimeAsync(5);
    tee.tee('bot-1', pointer(700, 400, 1));
    await tee.end('bot-1');

    expect(batches.flat().map((row) => row.tsOffsetMs)).toEqual([0, 20, 25]);
    expect(batches.flat().map((row) => row.payload)).toEqual([
      { x: 0, y: 0, buttonMask: 0 },
      { x: 700, y: 400, buttonMask: 0 },
      { x: 700, y: 400, buttonMask: 1 },
    ]);
  });
});

describe('RecordingTeeService — the keystroke coalescer (M3-BE-03)', () => {
  const keyDown = (keysym: number): RfbInputEvent => ({ kind: 'key', down: true, keysym });
  const keyUp = (keysym: number): RfbInputEvent => ({ kind: 'key', down: false, keysym });

  it('stores a typed word as one row rather than one row per keystroke', async () => {
    const { tee, batches } = build();

    for (const keysym of [0x68, 0x65, 0x6c, 0x6c, 0x6f]) {
      tee.tee('bot-1', keyDown(keysym));
      tee.tee('bot-1', keyUp(keysym));
    }
    const result = await tee.end('bot-1');

    // Ten frames in, one row out. The 5000-event ceiling M3-BE-05 puts on a
    // recording is a ceiling on rows, so this is the difference between a
    // recording that can hold a sentence and one that cannot.
    expect(result?.counts.x11).toBe(1);
    expect(batches.flat()[0]).toMatchObject({ type: 'type', payload: { text: 'hello' } });
  });

  it('stores the run the recording ended on, which nothing else would release', async () => {
    const { tee, batches } = build();

    tee.tee('bot-1', keyDown(0x68));
    tee.tee('bot-1', keyDown(0x69));
    const result = await tee.end('bot-1');

    // Text typed with no click after it is still text the user typed.
    expect(result?.counts.x11).toBe(1);
    expect(batches.flat()[0]?.payload).toEqual({ text: 'hi' });
  });

  it('keeps a run ahead of the click that ended it, at its own offset', async () => {
    const { tee, batches } = build();

    tee.tee('bot-1', keyDown(0x68));
    await vi.advanceTimersByTimeAsync(30);
    tee.tee('bot-1', keyDown(0x69));
    await vi.advanceTimersByTimeAsync(20);
    tee.tee('bot-1', pointer(640, 400, 1));
    await tee.end('bot-1');

    const rows = batches.flat();
    expect(rows.map((row) => [row.type, row.tsOffsetMs])).toEqual([
      ['type', 0],
      ['pointer', 50],
    ]);
  });

  const passwordInput = (inputType = 'password'): CapturedCdpEvent => ({
    type: 'input',
    payload: { inputType, id: 'pw' },
  });
  const typeWord = (tee: RecordingTeeService, word: string): void => {
    for (const char of word) tee.tee('bot-1', keyDown(char.charCodeAt(0)));
  };
  const typedRows = (batches: ReadonlyArray<ReadonlyArray<{ type: string; payload: unknown }>>) =>
    batches.flat().filter((row) => row.type === 'type');

  it('never stores the keys of a run the page says went into a password field', async () => {
    const { tee, batches } = build();

    typeWord(tee, 'hunter');
    tee.teeCdp('bot-1', passwordInput('Password'));
    typeWord(tee, '22');
    tee.tee('bot-1', pointer(640, 400, 1));
    await tee.end('bot-1');

    expect(typedRows(batches)).toEqual([
      expect.objectContaining({ payload: { text: SECRET_TYPING_TEXT, secret: true } }),
    ]);
    expect(JSON.stringify(batches)).not.toContain('hunter');
  });

  it('redacts a run that ended just before the page’s report arrived', async () => {
    const { tee, batches } = build();

    typeWord(tee, 'hunter22');
    tee.tee('bot-1', pointer(640, 400, 1));
    tee.teeCdp('bot-1', passwordInput());
    await tee.end('bot-1');

    expect(typedRows(batches)).toEqual([
      expect.objectContaining({ payload: { text: SECRET_TYPING_TEXT, secret: true } }),
    ]);
    expect(JSON.stringify(batches)).not.toContain('hunter22');
  });

  it('keeps ordinary typing, next to a field that is not a password', async () => {
    const { tee, batches } = build();

    typeWord(tee, 'hello');
    tee.teeCdp('bot-1', passwordInput('text'));
    await tee.end('bot-1');

    expect(typedRows(batches)).toEqual([expect.objectContaining({ payload: { text: 'hello' } })]);
  });
});

describe("RecordingTeeService — §6/M3's hard limits", () => {
  /** `build`, plus the listener the lifecycle registers (M3-BE-05). */
  function buildWithLimits() {
    const built = build();
    const reached: { botId: string; recordingId: string; warning: string }[] = [];
    built.tee.onLimitReached((botId, recordingId, warning) => {
      reached.push({ botId, recordingId, warning });
    });
    return { ...built, reached };
  }

  const keyDown = (keysym: number): RfbInputEvent => ({ kind: 'key', down: true, keysym });

  /** Fill the trace to `n` events using transitions the coalescer never thins. */
  const fill = (tee: RecordingTeeService, n: number, from = 0): void => {
    for (let i = from; i < from + n; i += 1) tee.tee('bot-1', button(i));
  };

  it('counts every layer, because M4 writes CDP rows into the same trace', () => {
    // §6/M3 says "5000 events", and the compiler is sent all of them whatever
    // layer wrote them. Counting one layer would silently raise the real
    // ceiling the moment a second one starts producing rows.
    expect(totalEvents({ x11: 4000, cdp: 900, atspi: 100 })).toBe(MAX_RECORDING_EVENTS);
  });

  it('captures the last event the ceiling allows, and refuses the next', async () => {
    const { tee, batches, reached } = buildWithLimits();

    fill(tee, MAX_RECORDING_EVENTS);
    await vi.advanceTimersByTimeAsync(1_000);
    const atCeiling = batches.flat().length;
    // Ten more frames from an operator who has not noticed anything yet.
    fill(tee, 10, MAX_RECORDING_EVENTS);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(atCeiling).toBe(MAX_RECORDING_EVENTS);
    expect(batches.flat()).toHaveLength(MAX_RECORDING_EVENTS);
    expect(reached).toEqual([{ botId: 'bot-1', recordingId: 'rec-1', warning: 'EVENT_LIMIT' }]);
  });

  it('stops capture without waiting for the settle it triggers', async () => {
    const { tee, reached } = buildWithLimits();

    // Nothing is awaited between these two lines: no flush, no listener, no
    // database. If the ceiling were enforced by whatever the listener goes on
    // to do, this event would still be captured.
    fill(tee, MAX_RECORDING_EVENTS);
    tee.tee('bot-1', button(MAX_RECORDING_EVENTS));

    const result = await tee.end('bot-1');
    expect(result?.counts.x11).toBe(MAX_RECORDING_EVENTS);
    expect(reached).toHaveLength(1);
  });

  it('stops a recording nobody is touching after twenty minutes', async () => {
    const { tee, reached } = buildWithLimits();

    // Not one input event: §8's idle sweep will not stop a sandbox that has a
    // RECORDING row, so this is the case where a forgotten recording pins a
    // container open for as long as the orchestrator runs.
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS);

    expect(reached).toEqual([{ botId: 'bot-1', recordingId: 'rec-1', warning: 'TIME_LIMIT' }]);
  });

  it('notices the deadline on the input path when the timer runs late', async () => {
    const { tee, batches, reached } = buildWithLimits();

    // The clock moves without the event loop running the timeout, which is
    // what a busy process looks like: a timer is a request, not a promise.
    vi.setSystemTime(Date.now() + MAX_RECORDING_MS);
    tee.tee('bot-1', button(1));

    expect(reached).toEqual([{ botId: 'bot-1', recordingId: 'rec-1', warning: 'TIME_LIMIT' }]);
    await tee.end('bot-1');
    expect(batches.flat()).toHaveLength(0);
  });

  it('tells the lifecycle once, however many ceilings are reached', async () => {
    const { tee, reached } = buildWithLimits();

    fill(tee, MAX_RECORDING_EVENTS);
    // The deadline is still armed at the moment the event ceiling fires; if it
    // were not disarmed, this would settle the same row a second time.
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS);

    expect(reached).toHaveLength(1);
    expect(reached[0]?.warning).toBe('EVENT_LIMIT');
  });

  it('keeps what the coalescer was holding when the ceiling stopped capture', async () => {
    const { tee, batches, reached } = buildWithLimits();

    // A run of typing emits nothing until something ends it, so at the moment
    // the deadline fires these two keystrokes exist only in the coalescer.
    // Refusing to capture more must not throw away what is already captured.
    tee.tee('bot-1', keyDown(0x68));
    tee.tee('bot-1', keyDown(0x69));
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS);
    expect(reached).toEqual([{ botId: 'bot-1', recordingId: 'rec-1', warning: 'TIME_LIMIT' }]);

    // What the lifecycle does next, once the listener has settled the row.
    await tee.end('bot-1');
    expect(batches.flat()).toMatchObject([{ type: 'type', payload: { text: 'hi' } }]);
  });

  it('disarms the deadline when the recording ends first', async () => {
    const { tee, reached } = buildWithLimits();

    await tee.end('bot-1');
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS * 2);

    // A recording that is already over has nothing left to stop, and the row
    // it would name has been settled by whoever stopped it.
    expect(reached).toEqual([]);
  });

  it('measures the deadline from the row, not from when begin happened to run', async () => {
    const { prisma } = fakePrisma();
    const { events } = fakeEvents();
    const { screenshots } = fakeScreenshots();
    const tee = new RecordingTeeService(prisma, events, screenshots);
    const reached: string[] = [];
    tee.onLimitReached((_botId, _recordingId, warning) => reached.push(warning));

    // The row is nineteen minutes old before capture attaches to it — the
    // shape a restart-recovered or slow insert leaves behind. The recording is
    // as old as the row a reader will find.
    tee.reserve('bot-1');
    tee.begin('bot-1', 'rec-1', new Date(Date.now() - 19 * 60 * 1000));

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(reached).toEqual(['TIME_LIMIT']);
  });
});

describe("RecordingTeeService — §6/M3's click screenshot (M3-BE-04)", () => {
  /** A pointer event with an explicit mask, so presses and releases are exact. */
  const at = (x: number, y: number, buttonMask: number): RfbInputEvent => ({
    kind: 'pointer',
    buttonMask,
    x,
    y,
  });

  it('captures on a button-down, at the point the user clicked', async () => {
    const { tee, shots } = build();
    shots.control.crop = crop('recordings/rec-1/a.png', 540, 300);

    tee.tee('bot-1', at(640, 400, 1));
    await tee.end('bot-1');

    expect(shots.calls).toEqual([{ botId: 'bot-1', recordingId: 'rec-1', x: 640, y: 400 }]);
  });

  it('captures nothing for a move', async () => {
    const { tee, shots } = build();

    // Far enough apart to clear the M3-BE-02 window, so these are stored
    // events rather than suppressed ones — and still not clicks.
    tee.tee('bot-1', at(10, 10, 0));
    vi.setSystemTime(Date.now() + 200);
    tee.tee('bot-1', at(20, 20, 0));
    await tee.end('bot-1');

    expect(shots.calls).toEqual([]);
  });

  it('captures nothing for a release', async () => {
    const { tee, shots } = build();

    tee.tee('bot-1', at(50, 50, 1));
    tee.tee('bot-1', at(50, 50, 0));
    await tee.end('bot-1');

    // Both rows exist in the trace; only the press names an image. Releasing
    // is when the user has stopped looking at the thing they aimed at.
    expect(shots.calls).toHaveLength(1);
    expect(shots.calls[0]?.x).toBe(50);
  });

  it('captures nothing for a wheel notch', async () => {
    const { tee, shots } = build();

    // Buttons 4 and 5 (RFC 6143 §7.5.5) are the wheel: a press and a release
    // of something with no position of its own. Scrolling one long page would
    // otherwise be the gesture that costs the most screenshots, to photograph
    // a target that does not exist.
    for (const mask of [0b1000, 0, 0b10000, 0]) tee.tee('bot-1', at(300, 300, mask));
    await tee.end('bot-1');

    expect(shots.calls).toEqual([]);
  });

  it('captures once for a drag, not once per sample', async () => {
    const { tee, shots } = build();

    tee.tee('bot-1', at(10, 10, 1));
    for (let i = 0; i < 20; i += 1) {
      vi.setSystemTime(Date.now() + 150);
      tee.tee('bot-1', at(10 + i, 10 + i, 1));
    }
    await tee.end('bot-1');

    // The button never came back up, so there is one button-DOWN here. A
    // held button is not a new click on every sample that reports it.
    expect(shots.calls).toHaveLength(1);
  });

  it('captures a second button pressed while the first is held', async () => {
    const { tee, shots } = build();

    tee.tee('bot-1', at(10, 10, 0b1));
    tee.tee('bot-1', at(10, 10, 0b101));

    // A bit that was not set and now is: a press, whatever else is down.
    expect(shots.calls).toHaveLength(2);
    await tee.end('bot-1');
  });

  it('puts the key on the press row and on nothing else', async () => {
    const { tee, shots, batches } = build();
    shots.control.crop = crop('recordings/rec-1/a.png', 440, 200);

    // A held move and a run of typing are both released by the press, so this
    // one frame writes three rows and exactly one of them is the click.
    tee.tee('bot-1', at(5, 5, 0));
    tee.tee('bot-1', { kind: 'key', down: true, keysym: 0x68 });
    vi.setSystemTime(Date.now() + 10);
    tee.tee('bot-1', at(540, 300, 1));
    await tee.end('bot-1');

    const rows = batches.flat();
    expect(rows.map((row) => row.type)).toEqual(['pointer', 'type', 'pointer']);
    expect(rows.map((row) => row.screenshotKey)).toEqual([null, null, 'recordings/rec-1/a.png']);
  });

  it('carries the crop origin on the event, because the window is clamped', async () => {
    const { tee, shots, batches } = build();
    shots.control.crop = crop('recordings/rec-1/a.png', 0, 0);

    tee.tee('bot-1', at(4, 7, 1));
    await tee.end('bot-1');

    // The click is at (4, 7) of its own crop rather than at the center. Made
    // recoverable here so nothing downstream re-derives the clamp — M3-BE-07
    // hands this trace to a model, not to code that could.
    expect(batches.flat()[0]?.payload).toEqual({
      x: 4,
      y: 7,
      buttonMask: 1,
      cropX: 0,
      cropY: 0,
    });
  });

  it('leaves the payload alone for an event with no crop', async () => {
    const { tee, batches } = build();

    tee.tee('bot-1', at(4, 7, 1));
    await tee.end('bot-1');

    // The default fake resolves null: a click whose screenshot failed is a
    // click, and its payload is the one M3-BE-01 defined.
    expect(batches.flat()[0]?.payload).toEqual({ x: 4, y: 7, buttonMask: 1 });
    expect(batches.flat()[0]?.screenshotKey).toBeNull();
  });

  it('does not write the row until the crop it names is on disk', async () => {
    const { tee, shots, batches } = build();
    shots.control.hold = true;

    tee.tee('bot-1', at(640, 400, 1));
    const ended = tee.end('bot-1');
    await settle();

    // A `screenshotKey` written ahead of its file names something that does
    // not exist yet, and M3-BE-06 reads a finished recording with no way to
    // tell "not there yet" from "never arrived".
    expect(batches).toEqual([]);

    shots.release(crop('recordings/rec-1/a.png', 540, 300));
    await ended;
    expect(batches.flat()[0]?.screenshotKey).toBe('recordings/rec-1/a.png');
  });

  it('never lets a crop hold up a batch that has no click in it', async () => {
    const { tee, shots, batches } = build();
    shots.control.hold = true;

    tee.tee('bot-1', at(640, 400, 1));
    await settle();
    // A separate later batch, with no click of its own.
    for (let i = 0; i < RecordingTeeService.FLUSH_BATCH; i += 1) {
      vi.setSystemTime(Date.now() + 150);
      tee.tee('bot-1', at(700 + i, 400, 1));
    }
    await vi.advanceTimersByTimeAsync(RecordingTeeService.FLUSH_INTERVAL_MS * 2);

    // The chain is ordered, so nothing may overtake the held batch — that is
    // the M3-BE-01 guarantee, and it costs the slowest crop in a batch, not
    // the sum of every crop in the recording.
    expect(batches).toEqual([]);
    shots.release(null);
    await tee.end('bot-1');
    expect(batches.flat().length).toBeGreaterThan(RecordingTeeService.FLUSH_BATCH);
  });

  it('keeps every event when a capture rejects outright', async () => {
    const { tee, shots, batches } = build();
    shots.capture.mockRejectedValue(new Error('the screenshot service broke its contract'));

    tee.tee('bot-1', at(640, 400, 1));
    tee.tee('bot-1', { kind: 'key', down: true, keysym: 0xff0d });
    const result = await tee.end('bot-1');

    // `drain` awaits the whole batch at once, so one rejected crop reaching it
    // would count every event beside it as lost and mark an otherwise perfect
    // recording FAILED.
    expect(result?.lostEvents).toBe(0);
    expect(batches.flat()).toHaveLength(2);
    expect(batches.flat()[0]?.screenshotKey).toBeNull();
  });

  it('gives back the bot state when the recording ends', async () => {
    const { tee, shots } = build();

    await tee.end('bot-1');

    // Held for the process's life otherwise, and — worse than the memory — the
    // bot's NEXT recording would inherit this one's cached endpoint.
    expect(shots.forget).toHaveBeenCalledWith('bot-1');
  });

  it('gives it back on shutdown too', async () => {
    const { tee, shots } = build();

    tee.tee('bot-1', at(1, 1, 1));
    await tee.onModuleDestroy();

    expect(shots.forget).toHaveBeenCalledWith('bot-1');
  });
});

/**
 * M4-BE-02 — the CDP layer of the same trace.
 *
 * A binding call is not an RFB sample: it arrives once, when the interaction
 * happened, and there is nothing to coalesce. What it must share with the X11
 * half is the ORDER (`tsOffsetMs` is the trace's only order — a page click
 * and the click that delivered it interleave in one gesture), the ceiling,
 * and the contract: synchronous, unawaited, never throwing.
 */
describe('RecordingTeeService — the CDP layer (M4-BE-02)', () => {
  const click = (id: string): CapturedCdpEvent => ({
    type: 'click',
    payload: { id, clientX: 10, clientY: 20 },
  });

  it('writes CDP rows through the same buffer, in the same order', async () => {
    const { tee, batches } = build();

    tee.tee('bot-1', button(0));
    tee.teeCdp('bot-1', click('pay'));
    await vi.advanceTimersByTimeAsync(RecordingTeeService.FLUSH_INTERVAL_MS);

    const rows = batches.flat();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ layer: 'X11', type: 'pointer' });
    expect(rows[1]).toMatchObject({
      layer: 'CDP',
      type: 'click',
      payload: { id: 'pay', clientX: 10, clientY: 20 },
    });
    // One chain of offsets: the two layers cannot swap order between the
    // gesture that aimed a click and the click itself.
    expect(rows[1]!.tsOffsetMs).toBeGreaterThan(rows[0]!.tsOffsetMs);
  });

  it('captures nothing while the bot is not recording', async () => {
    const { prisma, batches } = fakePrisma();
    const { events } = fakeEvents();
    const { screenshots } = fakeScreenshots();
    const tee = new RecordingTeeService(prisma, events, screenshots);

    tee.teeCdp('bot-1', click('no'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(batches).toEqual([]);
  });

  it('counts CDP events toward the same 5000-event ceiling and stops at it', async () => {
    const { tee, batches } = build();
    const warnings: RecordingWarning[] = [];
    tee.onLimitReached((_botId, _recordingId, warning) => warnings.push(warning));

    for (let i = 0; i < MAX_RECORDING_EVENTS; i += 1) tee.teeCdp('bot-1', click(`e${i}`));
    // One more, after the ceiling: dropped before it can reach the buffer.
    tee.teeCdp('bot-1', click('beyond'));

    // §6/M3's 5000 is a ceiling on the TRACE — `totalEvents` counts every
    // layer — so a chatty page cannot push the real value past it either.
    expect(warnings).toEqual(['EVENT_LIMIT']);
    const result = await tee.end('bot-1');
    expect(result?.counts.cdp).toBe(MAX_RECORDING_EVENTS);
    expect(batches.flat()).toHaveLength(MAX_RECORDING_EVENTS);
  });

  it('tells the client the layer and both counters', async () => {
    const { tee, emitRecordingEvent } = build();

    tee.teeCdp('bot-1', click('a'));

    // `begin` leaves the throttle window open, so this is the first
    // notification of the recording — and it names what the operator is
    // watching fill: which layer, and how much of each.
    expect(emitRecordingEvent).toHaveBeenCalledWith('bot-1', 'rec-1', 'CDP', 'click', {
      x11: 0,
      cdp: 1,
    });
  });
});
