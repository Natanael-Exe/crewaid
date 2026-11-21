import { describe, expect, it } from 'vitest';

import {
  MAX_CROPS,
  cropCandidatesOf,
  renderTrace,
  selectCrops,
  type CropCandidate,
  type TraceRow,
} from '../src/skills/compile-input.js';

/**
 * M3-BE-06 — what the compiler shows the model.
 *
 * §6/M3: "the ordered event trace (compact JSON, screenshots referenced by
 * index), the sandbox resolution, and up to 8 screenshot crops from the most
 * ambiguous clicks."
 */

const SCREEN = { widthPx: 1280, heightPx: 800 };

const pointer = (
  tsOffsetMs: number,
  x: number,
  y: number,
  screenshotKey: string | null = null,
): TraceRow => ({
  tsOffsetMs,
  type: 'pointer',
  payload:
    screenshotKey === null
      ? { x, y, buttonMask: 1 }
      : { x, y, buttonMask: 1, cropX: Math.max(0, x - 100), cropY: Math.max(0, y - 100) },
  screenshotKey,
});

const typed = (tsOffsetMs: number, text: string): TraceRow => ({
  tsOffsetMs,
  type: 'type',
  payload: { text },
  screenshotKey: null,
});

describe('cropCandidatesOf — which rows have a picture', () => {
  it('takes the clicks that stored one, and nothing else', () => {
    const rows = [
      pointer(0, 10, 10),
      pointer(100, 640, 400, 'recordings/r/a.png'),
      typed(200, 'hello'),
      pointer(300, 20, 20, 'recordings/r/b.png'),
    ];

    expect(cropCandidatesOf(rows).map((c) => c.screenshotKey)).toEqual([
      'recordings/r/a.png',
      'recordings/r/b.png',
    ]);
  });

  it('skips a row whose payload has no position', () => {
    // A key row cannot carry a crop (M3-BE-04 stores one on button-downs
    // only), and placing a picture at coordinates nothing clicked would be
    // worse than having no picture.
    const rows: TraceRow[] = [
      { tsOffsetMs: 0, type: 'key', payload: { combo: 'ctrl+a' }, screenshotKey: 'x.png' },
      { tsOffsetMs: 1, type: 'pointer', payload: 'not an object', screenshotKey: 'y.png' },
    ];

    expect(cropCandidatesOf(rows)).toEqual([]);
  });
});

describe('selectCrops — §6/M3\'s "up to 8 ... most ambiguous clicks"', () => {
  const clickAt = (tsOffsetMs: number, x: number, y: number): CropCandidate => ({
    tsOffsetMs,
    x,
    y,
    screenshotKey: `k-${tsOffsetMs}`,
  });

  it('sends every crop when there are no more than eight', () => {
    const candidates = Array.from({ length: MAX_CROPS }, (_, i) => clickAt(i * 100, i, i));

    expect(selectCrops(candidates, SCREEN)).toEqual(candidates);
  });

  it('never sends more than the ceiling', () => {
    const candidates = Array.from({ length: 60 }, (_, i) => clickAt(i * 100, i * 20, i * 10));

    expect(selectCrops(candidates, SCREEN)).toHaveLength(MAX_CROPS);
  });

  it('spreads the choice across the whole recording, not just its opening', () => {
    // Forty clicks marching across the screen over forty seconds. Taking the
    // first eight would show the model only the first fifth of the task.
    const candidates = Array.from({ length: 40 }, (_, i) => clickAt(i * 1000, i * 30, 400));

    const chosen = selectCrops(candidates, SCREEN);

    expect(chosen[0]?.tsOffsetMs).toBe(0);
    expect(chosen.at(-1)?.tsOffsetMs).toBe(39_000);
    // Not clustered: the last chosen is well past the halfway mark, which
    // "the first eight" could never manage.
    expect(chosen.filter((c) => c.tsOffsetMs > 20_000).length).toBeGreaterThan(1);
  });

  it('prefers a click far away in space when time says nothing', () => {
    // Twenty clicks in the same millisecond — a burst, where the clock cannot
    // separate anything. Only position is left to judge by, so the far corner
    // has to win over the twentieth click of a huddle.
    const huddle = Array.from({ length: 19 }, (_, i) => ({
      tsOffsetMs: 0,
      x: 100 + i,
      y: 100,
      screenshotKey: `huddle-${i}`,
    }));
    const outlier = { tsOffsetMs: 0, x: 1200, y: 700, screenshotKey: 'outlier' };

    const chosen = selectCrops([...huddle, outlier], SCREEN);

    expect(chosen).toContainEqual(outlier);
  });

  it('returns everything, in trace order, when it all fits', () => {
    const candidates = [clickAt(300, 5, 5), clickAt(100, 1, 1), clickAt(200, 3, 3)];

    // No separate "it all fits" path: one route to the answer means one order
    // to reason about, and the model is reading a sequence.
    expect(selectCrops(candidates, SCREEN).map((c) => c.tsOffsetMs)).toEqual([100, 200, 300]);
  });

  it('has nothing to choose from a recording with no clicks', () => {
    expect(selectCrops([], SCREEN)).toEqual([]);
  });

  it('counts the same spot at a very different time as a different screen', () => {
    // The same button, pressed at the start and again ten minutes later.
    // Everything around it has changed, so the second is not a duplicate.
    const early = Array.from({ length: 8 }, (_, i) => clickAt(i * 50, 300, 300));
    const late = clickAt(600_000, 300, 300);

    expect(selectCrops([...early, late], SCREEN)).toContainEqual(late);
  });

  it('returns the chosen crops in trace order', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => clickAt(i * 700, (i * 37) % 1280, 400));

    const offsets = selectCrops(candidates, SCREEN).map((c) => c.tsOffsetMs);

    // The model reads a sequence. A list of images ordered by how they were
    // chosen would put step nine's picture before step two's.
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it('always keeps the opening click', () => {
    const candidates = Array.from({ length: 25 }, (_, i) => clickAt(i * 400, i * 40, i * 20));

    // Nothing precedes it, so it is the click the trace explains least.
    expect(selectCrops(candidates, SCREEN)[0]).toEqual(candidates[0]);
  });

  it('survives a recording whose clicks all land in the same millisecond', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => clickAt(0, i * 10, 0));

    // A zero time span would divide by zero and make every pair infinitely
    // far apart, which is the shape that turns a selection into a crash.
    expect(selectCrops(candidates, SCREEN)).toHaveLength(MAX_CROPS);
  });
});

describe('renderTrace — the compact JSON §6 asks for', () => {
  it('flattens a payload onto its event', () => {
    const line = renderTrace([pointer(120, 640, 400)], []);

    expect(JSON.parse(line)).toEqual({ ms: 120, type: 'pointer', x: 640, y: 400, buttonMask: 1 });
  });

  it('numbers the screenshots by their position in what was sent', () => {
    const rows = [pointer(0, 10, 10, 'a.png'), typed(50, 'hi'), pointer(90, 900, 500, 'b.png')];
    const shown = selectCrops(cropCandidatesOf(rows), SCREEN);

    const lines = renderTrace(rows, shown)
      .split('\n')
      .map((l) => JSON.parse(l) as unknown);

    expect(lines[0]).toMatchObject({ screenshot: 0 });
    expect(lines[1]).toEqual({ ms: 50, type: 'type', text: 'hi' });
    expect(lines[2]).toMatchObject({ screenshot: 1 });
  });

  it('keeps a crop origin only on a click whose picture was sent', () => {
    const shownRow = pointer(0, 640, 400, 'a.png');
    const unshownRow = pointer(50, 200, 200, 'b.png');

    const lines = renderTrace(
      [shownRow, unshownRow],
      [{ tsOffsetMs: 0, x: 640, y: 400, screenshotKey: 'a.png' }],
    )
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // cropX/cropY locate the click inside its own crop (D-043). On a click
    // with no crop attached they answer a question nobody can ask — and at
    // the 5000-event ceiling there are up to 5000 of those.
    expect(lines[0]).toMatchObject({ cropX: 540, cropY: 300, screenshot: 0 });
    expect(lines[1]).not.toHaveProperty('cropX');
    expect(lines[1]).not.toHaveProperty('screenshot');
  });

  it('keeps a structured value under its own name rather than nesting everything', () => {
    // M4-BE-03 widened payloads: a browser interaction carries `candidates`,
    // the selector ladder, beside scalar facts. Nesting the whole payload
    // again (the M3 rule) would hide the one field the M4 compiler must read
    // behind a `payload` wrapper on every browser interaction — §6/M3 asks
    // for compact JSON. Nothing is dropped: scalars flatten, and the
    // structured value rides under its own key.
    const rows: TraceRow[] = [
      {
        tsOffsetMs: 0,
        type: 'navigate',
        payload: { url: 'x', frames: [1, 2] },
        screenshotKey: null,
      },
    ];

    expect(JSON.parse(renderTrace(rows, []))).toEqual({
      ms: 0,
      type: 'navigate',
      url: 'x',
      frames: [1, 2],
    });
  });

  it('keeps a payload it cannot flatten at all nested rather than dropping fields', () => {
    const rows: TraceRow[] = [
      { tsOffsetMs: 0, type: 'weird', payload: ['not', 'an', 'object'], screenshotKey: null },
    ];

    expect(JSON.parse(renderTrace(rows, []))).toEqual({
      ms: 0,
      type: 'weird',
      payload: ['not', 'an', 'object'],
    });
  });

  it('emits one line per event, in order', () => {
    const rows = [pointer(0, 1, 1), typed(10, 'a'), pointer(20, 2, 2)];

    expect(renderTrace(rows, []).split('\n')).toHaveLength(3);
  });
});

describe("renderTrace — the legend keys are the renderer's own", () => {
  it('nests a payload that would overwrite ms, type or screenshot', () => {
    // M4 writes CDP rows into this same trace, and `type` is an ordinary field
    // name for one. Flattening it would replace the event kind the model reads
    // the sequence by, with no way for it to notice.
    const line = renderTrace(
      [
        {
          tsOffsetMs: 40,
          type: 'cdp',
          payload: { type: 'keyDown', key: 'a' },
          screenshotKey: null,
        },
      ],
      [],
    );

    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['type']).toBe('cdp');
    expect(parsed['payload']).toEqual({ type: 'keyDown', key: 'a' });
  });

  it('still flattens an ordinary payload', () => {
    const line = renderTrace(
      [{ tsOffsetMs: 0, type: 'pointer', payload: { x: 1, y: 2 }, screenshotKey: null }],
      [],
    );

    expect(JSON.parse(line)).toEqual({ ms: 0, type: 'pointer', x: 1, y: 2 });
  });
});

describe('lossless pointer-path packing', () => {
  const move = (ms: number, mask = 0): TraceRow => ({
    tsOffsetMs: ms,
    type: 'pointer',
    payload: { x: ms % 1280, y: ms % 800, buttonMask: mask },
    screenshotKey: null,
  });

  it('keeps all hover positions and timestamps while shrinking a long trace', () => {
    const rows = Array.from({ length: 1254 }, (_, i) => move(i * 100));
    const text = renderTrace(rows, []);
    const packed = text.split('\n').map((line) => JSON.parse(line));
    const points = packed.flatMap((row) => row.points ?? [[row.ms, row.x, row.y]]);
    expect(points).toEqual(
      rows.map((row) => [row.tsOffsetMs, (row.payload as any).x, (row.payload as any).y]),
    );
    expect(text.length).toBeLessThan(JSON.stringify(rows).length / 3);
    expect(packed.every((row) => (row.points?.length ?? 1) <= 64)).toBe(true);
  });

  it('never packs button transitions, drag paths, scroll, or a folded click release', () => {
    const rows = [
      move(0),
      move(100),
      move(200, 1),
      move(250, 1),
      move(300),
      move(400, 8),
      move(500),
      { tsOffsetMs: 600, type: 'click', payload: { x: 1, y: 2 }, screenshotKey: null },
      move(700),
      move(800),
      move(900),
    ];
    const packed = renderTrace(rows, [])
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(packed.map((row) => row.type)).toEqual([
      'pointer-path',
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'click',
      'pointer',
      'pointer-path',
    ]);
    expect(packed[3]).toMatchObject({ ms: 300, buttonMask: 0 });
    expect(packed[7]).toMatchObject({ ms: 700, buttonMask: 0 });
  });

  it('preserves unknown metadata and screenshots rather than packing them away', () => {
    const rows = [
      move(0),
      { ...move(100), payload: { x: 5, y: 6, buttonMask: 0, hover: 'menu' } },
      { ...move(200), screenshotKey: 'crop.png' },
      move(300),
    ];
    const packed = renderTrace(rows, [])
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(packed).toHaveLength(4);
    expect(packed[1].hover).toBe('menu');
  });
});
