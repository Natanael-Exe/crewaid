import { describe, expect, it } from 'vitest';

import {
  CORRELATION_TOLERANCE_PX,
  CORRELATION_WINDOW_MS,
  correlateClicks,
  type CorrelatorRow,
} from '../src/recordings/click-correlator.js';

/**
 * M4-BE-05 — the correlator's judgement, against literals.
 *
 * §6/M4's required test lives here ("synthetic pairs at 0, 100, 200, 500 ms;
 * asserts ≤150 ms pairs merge and others do not"), and so does everything the
 * pairing must refuse: two clicks that are merely close, a wrong button, an
 * impossible order, a row that cannot say where it happened. The durable
 * write is `click-correlator.integration.test.ts`; the real page's coordinates
 * are `cdp-correlate-docker.integration.test.ts`.
 */

/** A CDP click as the capture script reports one, with an explicit desktop spot. */
function cdpClick(
  offsetMs: number,
  screenX: number,
  screenY: number,
  overrides: { dpr?: number; button?: number } = {},
): CorrelatorRow {
  return {
    id: `cdp-${offsetMs}-${screenX}-${screenY}`,
    tsOffsetMs: offsetMs,
    layer: 'CDP',
    type: 'click',
    payload: {
      screenX,
      screenY,
      dpr: overrides.dpr ?? 1,
      button: overrides.button ?? 0,
      clientX: 100,
      clientY: 100,
      url: 'https://example.test/',
    },
  };
}

/** One X11 pointer row; the button mask is the caller's business. */
function x11Pointer(offsetMs: number, x: number, y: number, buttonMask: number): CorrelatorRow {
  return {
    id: `x11-${offsetMs}-${x}-${y}`,
    tsOffsetMs: offsetMs,
    layer: 'X11',
    type: 'pointer',
    payload: { x, y, buttonMask },
  };
}

/** A whole click gesture: the button-down at `offsetMs` and its release 60 ms later. */
function x11Click(offsetMs: number, x: number, y: number): readonly CorrelatorRow[] {
  return [x11Pointer(offsetMs, x, y, 1), x11Pointer(offsetMs + 60, x, y, 0)];
}

function pairOf(rows: readonly CorrelatorRow[]): readonly { x11Id: string; cdpId: string }[] {
  return correlateClicks(rows);
}

describe('correlateClicks — the PRD’s window', () => {
  /**
   * §6/M4's required test: pairs at 0, 100, 200 and 500 ms; the first two
   * merge, the last two do not.
   */
  it.each([
    { deltaMs: 0, merges: true },
    { deltaMs: 100, merges: true },
    { deltaMs: 200, merges: false },
    { deltaMs: 500, merges: false },
  ])('a pair $deltaMs ms apart merges=$merges', ({ deltaMs, merges }) => {
    const gesture = x11Click(1000, 640, 400);
    const press = gesture[0]!;
    const click = cdpClick(1000 + deltaMs, 640, 400);
    const pairs = pairOf([...gesture, click]);
    expect(pairs).toEqual(merges ? [{ x11Id: press.id, cdpId: click.id }] : []);
  });

  it('merges at exactly the 150 ms boundary and not one millisecond past it', () => {
    const inside = pairOf([
      ...x11Click(1000, 640, 400),
      cdpClick(1000 + CORRELATION_WINDOW_MS, 640, 400),
    ]);
    expect(inside).toHaveLength(1);

    const outside = pairOf([
      ...x11Click(1000, 640, 400),
      cdpClick(1000 + CORRELATION_WINDOW_MS + 1, 640, 400),
    ]);
    expect(outside).toEqual([]);
  });

  it('writes both ids of the pair — the press row and the click row, pointing at each other', () => {
    const gesture = x11Click(500, 30, 40);
    const press = gesture[0]!;
    const click = cdpClick(560, 30, 40);
    const pairs = pairOf([...gesture, click]);
    // The release is not the anchor: the pair names the PRESS row's id.
    expect(pairs).toEqual([{ x11Id: press.id, cdpId: click.id }]);
  });
});

describe('correlateClicks — coordinates', () => {
  it('merges through the dpr scale: CSS screen pixels map back to desktop pixels', () => {
    // At dpr 2 the desktop position is twice the CSS pair.
    const pairs = pairOf([...x11Click(0, 640, 400), cdpClick(50, 320, 200, { dpr: 2 })]);
    expect(pairs).toHaveLength(1);

    // The same report against the UNSCALED position is a different point.
    const wrong = pairOf([...x11Click(0, 320, 200), cdpClick(50, 320, 200, { dpr: 2 })]);
    expect(wrong).toEqual([]);
  });

  it('allows the rounding tolerance on each axis, alone and together', () => {
    for (const [dx, dy] of [
      [CORRELATION_TOLERANCE_PX, 0],
      [0, CORRELATION_TOLERANCE_PX],
      [CORRELATION_TOLERANCE_PX, CORRELATION_TOLERANCE_PX],
      [-CORRELATION_TOLERANCE_PX, -CORRELATION_TOLERANCE_PX],
    ] as const) {
      const pairs = pairOf([...x11Click(0, 640, 400), cdpClick(40, 640 + dx, 400 + dy)]);
      expect(pairs, `offset (${dx}, ${dy}) should merge`).toHaveLength(1);
    }
  });

  it('refuses one pixel past the tolerance', () => {
    const past = CORRELATION_TOLERANCE_PX + 1;
    expect(pairOf([...x11Click(0, 640, 400), cdpClick(40, 640 + past, 400)])).toEqual([]);
    expect(pairOf([...x11Click(0, 640, 400), cdpClick(40, 640, 400 - past)])).toEqual([]);
  });

  it('refuses a report that cannot say where the click landed', () => {
    const withoutPosition = cdpClick(40, 640, 400);
    const rows = {
      ...withoutPosition,
      payload: { dpr: 1, clientX: 100, clientY: 100, button: 0 },
    } as CorrelatorRow;
    expect(pairOf([...x11Click(0, 640, 400), rows])).toEqual([]);

    // ...and one that cannot say how CSS units scale, because 1 is a guess.
    const withoutDpr = cdpClick(40, 640, 400);
    const guessed = {
      ...withoutDpr,
      payload: { screenX: 640, screenY: 400, button: 0 },
    } as CorrelatorRow;
    expect(pairOf([...x11Click(0, 640, 400), guessed])).toEqual([]);
  });
});

describe('correlateClicks — what must never pair', () => {
  it('does not pair clicks that are near in time but not in place', () => {
    expect(pairOf([...x11Click(0, 100, 100), cdpClick(50, 800, 700)])).toEqual([]);
  });

  it('does not pair a report with a press that happened after it', () => {
    // The report is stamped first; the press it would be paired with came
    // later, so it cannot be what produced the report. No pair either way.
    expect(pairOf([...x11Click(200, 640, 400), cdpClick(100, 640, 400)])).toEqual([]);
  });

  it('does not pair across buttons', () => {
    expect(pairOf([...x11Click(0, 640, 400), cdpClick(50, 640, 400, { button: 2 })])).toEqual([]);
    // And a report without a button still pairs (the script always sends one;
    // a row that cannot disagree must not veto).
    const buttonless = cdpClick(50, 640, 400);
    const rows = {
      ...buttonless,
      payload: { screenX: 640, screenY: 400, dpr: 1 },
    } as CorrelatorRow;
    expect(pairOf([...x11Click(0, 640, 400), rows])).toHaveLength(1);
  });

  it('does not treat a held move as a press — only the button-down counts', () => {
    // A small drag: the press at (640,400), then held moves that wander a few
    // pixels while the button stays down.
    const rows = [
      x11Pointer(0, 640, 400, 1),
      x11Pointer(40, 640, 404, 1),
      x11Pointer(80, 640, 408, 1),
    ];
    // A click reported where the drag had moved to proves nothing about the
    // press four pixels away — moves are not button-downs, so nothing pairs.
    expect(pairOf([...rows, cdpClick(120, 640, 404)])).toEqual([]);
    // ...while a click at the press's own position does pair.
    expect(pairOf([...rows, cdpClick(120, 640, 400)])).toHaveLength(1);
  });

  it('does not pair non-click rows of either layer', () => {
    const rows = [
      { ...x11Pointer(0, 640, 400, 0), id: 'move' },
      { ...cdpClick(10, 640, 400), id: 'input', type: 'input' },
      { ...cdpClick(20, 640, 400), id: 'submit', type: 'submit' },
      { ...cdpClick(30, 640, 400), id: 'navigate', type: 'navigate' },
      ...x11Click(0, 640, 400).map((row, index) => ({ ...row, id: `gesture-${index}` })),
      { ...x11Pointer(400, 10, 10, 0), id: 'release-only' },
    ];
    expect(pairOf(rows)).toEqual([]);
  });

  it('pairs each row at most once: one press cannot answer two double-click reports', () => {
    const press = x11Pointer(0, 640, 400, 1);
    const first = cdpClick(40, 640, 400);
    const second = cdpClick(90, 640, 400);
    const pairs = pairOf([press, first, second]);
    expect(pairs).toEqual([{ x11Id: press.id, cdpId: first.id }]);
  });

  it('gives a late report the NEWEST press that could have caused it', () => {
    // Two complete clicks at the same spot (a double click, say), each a
    // press and its release; the first report arrives before the second
    // gesture's press exists, the second after both.
    const firstGesture = x11Click(0, 640, 400);
    const secondGesture = x11Click(300, 640, 400);
    const early = cdpClick(80, 640, 400);
    const late = cdpClick(360, 640, 400);
    const pairs = pairOf([...firstGesture, ...secondGesture, early, late]);
    expect(pairs).toEqual([
      { x11Id: firstGesture[0]!.id, cdpId: early.id },
      { x11Id: secondGesture[0]!.id, cdpId: late.id },
    ]);
  });

  it('survives junk payloads without pairing or throwing', () => {
    const rows = [
      { id: 'a', tsOffsetMs: 0, layer: 'X11', type: 'pointer', payload: null },
      { id: 'b', tsOffsetMs: 1, layer: 'X11', type: 'pointer', payload: 'not an object' },
      { id: 'c', tsOffsetMs: 2, layer: 'X11', type: 'pointer', payload: [1, 2, 3] },
      { id: 'd', tsOffsetMs: 3, layer: 'X11', type: 'pointer', payload: { buttonMask: 1.5 } },
      { id: 'e', tsOffsetMs: 4, layer: 'X11', type: 'pointer', payload: { buttonMask: -1 } },
      {
        id: 'f',
        tsOffsetMs: 5,
        layer: 'X11',
        type: 'pointer',
        payload: { buttonMask: 1, x: '0', y: null },
      },
      { id: 'g', tsOffsetMs: 6, layer: 'CDP', type: 'click', payload: [] },
      {
        id: 'h',
        tsOffsetMs: 7,
        layer: 'CDP',
        type: 'click',
        payload: { screenX: 0, screenY: 0, dpr: 0 },
      },
      {
        id: 'i',
        tsOffsetMs: 8,
        layer: 'CDP',
        type: 'click',
        payload: { screenX: Infinity, screenY: 0, dpr: 1 },
      },
    ] as readonly CorrelatorRow[];
    expect(pairOf(rows)).toEqual([]);
  });
});

describe('correlateClicks — ordering', () => {
  it('answers from the trace order, not the array order it is handed', () => {
    const press = x11Pointer(0, 640, 400, 1);
    const click = cdpClick(60, 640, 400);
    const shuffled = [click, press];
    expect(pairOf(shuffled)).toEqual(pairOf([press, click]));
  });

  it('is deterministic — the same rows always answer the same pairs', () => {
    const rows = [
      ...x11Click(0, 640, 400),
      ...x11Click(100, 200, 200),
      cdpClick(70, 640, 400),
      cdpClick(180, 200, 200),
      cdpClick(400, 900, 900),
    ];
    expect(pairOf(rows)).toEqual(pairOf(rows));
    expect(pairOf(rows)).toHaveLength(2);
  });

  it('pairs a report with an older unmatched press while a newer press sits after it', () => {
    // The newer press cannot have caused the report (it had not happened
    // yet); the older one can, and is still unmatched — so it must pair.
    const older = x11Pointer(0, 640, 400, 1);
    const newer = x11Pointer(220, 640, 400, 1);
    const report = cdpClick(120, 640, 400);
    expect(pairOf([older, newer, report])).toEqual([{ x11Id: older.id, cdpId: report.id }]);
  });
});
