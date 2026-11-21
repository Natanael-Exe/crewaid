import { describe, expect, it } from 'vitest';

import {
  CORRELATION_TOLERANCE_PX,
  CORRELATION_WINDOW_MS,
  correlateClicks,
  type CorrelatorRow,
} from '../src/recordings/click-correlator.js';
import { oraclePairs, type Qa02Row } from './m4-qa-02-oracle.js';

/**
 * M4-QA-02 — independent verification of the correlator's timing boundary.
 *
 * §6/M4's required test is "Unit: correlator at 0/100/200/500 ms; ≤150 ms
 * pairs merge, others don't". This suite is QA-authored end to end: its
 * fixtures, its windows and its oracle share nothing with the M4-BE-05
 * suite. Every answer is cross-checked by three substrates:
 *
 *   1. hand pins — literal expected pairs on this suite's own fixtures
 *      (ids, coordinates and timestamps chosen here), with the spec's
 *      numbers written as literals so a changed constant cannot hide;
 *   2. a from-spec oracle — `m4-qa-02-oracle.ts` re-derives the pairing in
 *      separate code with its own literals, compared to the product on a
 *      millisecond sweep, a combinatorial grid and seeded random traces;
 *   3. property checks — every pair the product reports is re-validated
 *      against the raw rows (window, causality, place, button, one-use).
 */

/** §6/M4's number, written literally on purpose. */
const WINDOW_MS = 150;
/** M4-BE-05's rounding budget in desktop pixels, written literally on purpose. */
const TOLERANCE_PX = 2;

/** This suite's primary desktop spot; scenario helpers vary it. */
const SPOT_X = 321;
const SPOT_Y = 654;

/** One X11 pointer row at an explicit mask. */
function pointer(id: string, ts: number, x: number, y: number, mask: number): CorrelatorRow {
  return { id, tsOffsetMs: ts, layer: 'X11', type: 'pointer', payload: { x, y, buttonMask: mask } };
}

/** A press and its release 40 ms later — one whole gesture. */
function gesture(
  prefix: string,
  ts: number,
  x = SPOT_X,
  y = SPOT_Y,
  mask = 1,
): [CorrelatorRow, CorrelatorRow] {
  return [
    pointer(`${prefix}-press`, ts, x, y, mask),
    pointer(`${prefix}-release`, ts + 40, x, y, 0),
  ];
}

/** One CDP click report; `extra` overrides/removes payload fields. */
function report(
  id: string,
  ts: number,
  screenX: number,
  screenY: number,
  extra: Record<string, unknown> = {},
): CorrelatorRow {
  return {
    id,
    tsOffsetMs: ts,
    layer: 'CDP',
    type: 'click',
    payload: {
      screenX,
      screenY,
      dpr: 1,
      button: 0,
      url: 'https://qa.example/',
      clientX: 12,
      clientY: 34,
      ...extra,
    },
  };
}

function pair(x11Id: string, cdpId: string): { x11Id: string; cdpId: string } {
  return { x11Id, cdpId };
}

describe('M4-QA-02 — the ladder: pairs at 0/100/200/500 ms', () => {
  it.each([
    { dt: 0, merges: true },
    { dt: 100, merges: true },
    { dt: 200, merges: false },
    { dt: 500, merges: false },
  ])('dt=$dt ms merges=$merges', ({ dt, merges }) => {
    const [down, up] = gesture('ladder', 9000);
    const click = report('ladder-report', 9000 + dt, SPOT_X, SPOT_Y);
    expect(correlateClicks([down, up, click])).toEqual(merges ? [pair(down.id, click.id)] : []);
  });
});

describe('M4-QA-02 — the exact boundary: [0,150] inclusive', () => {
  it.each([
    { dt: 149, merges: true },
    { dt: 150, merges: true },
    { dt: 151, merges: false },
    { dt: 152, merges: false },
  ])('dt=$dt ms merges=$merges', ({ dt, merges }) => {
    const [down, up] = gesture('edge', 4500);
    const click = report('edge-report', 4500 + dt, SPOT_X, SPOT_Y);
    expect(correlateClicks([down, up, click])).toEqual(merges ? [pair(down.id, click.id)] : []);
  });

  it('a millisecond sweep: merges exactly for dt in [0,150], and never outside', () => {
    const offenders: string[] = [];
    for (let dt = -20; dt <= 220; dt += 1) {
      const [down, up] = gesture('sweep', 2000);
      const click = report('sweep-report', 2000 + dt, SPOT_X, SPOT_Y);
      const merged = correlateClicks([down, up, click]).length === 1;
      const expected = dt >= 0 && dt <= WINDOW_MS;
      if (merged !== expected) offenders.push(`dt=${dt}: merged=${merged}, expected=${expected}`);
    }
    expect(offenders, 'milliseconds whose merge behaviour is not the spec’s').toEqual([]);
  });

  it.each([{ dt: -1 }, { dt: -50 }, { dt: -150 }, { dt: -300 }])(
    'a report stamped before the press it would pair with (dt=$dt ms) never merges',
    ({ dt }) => {
      const [down, up] = gesture('causality', 6000);
      const click = report('causality-report', 6000 + dt, SPOT_X, SPOT_Y);
      expect(correlateClicks([down, up, click])).toEqual([]);
    },
  );
});

describe('M4-QA-02 — time alone is not the rule; the conjunction with place', () => {
  it('in the window AND at the same place merges; either half alone does not', () => {
    const [down, up] = gesture('conj', 8000);
    const inPlace = report('conj-ok', 8100, SPOT_X, SPOT_Y);
    expect(correlateClicks([down, up, inPlace])).toEqual([pair(down.id, inPlace.id)]);

    const nearInTime = report('conj-near', 8100, SPOT_X + 3, SPOT_Y);
    expect(correlateClicks([down, up, nearInTime])).toEqual([]);

    const farInTime = report('conj-far', 8200, SPOT_X, SPOT_Y);
    expect(correlateClicks([down, up, farInTime])).toEqual([]);
  });

  it('maps the report’s CSS screen coordinates onto desktop pixels by round(screen * dpr)', () => {
    // dpr 2 at the same DESKTOP point: the CSS pair is half of it.
    const [down] = gesture('dpr2', 400, 642, 1308);
    const scaled = report('dpr2-report', 460, 321, 654, { dpr: 2 });
    expect(correlateClicks([down, scaled])).toEqual([pair(down.id, scaled.id)]);

    // The same report against the UNSCALED point is a different place.
    const [unscaledDown] = gesture('dpr2-wrong', 400, 321, 654);
    expect(correlateClicks([unscaledDown, scaled])).toEqual([]);

    // A fractional product rounds to the nearest desktop pixel: 267 * 1.5 = 400.5 -> 401.
    const [fractional] = gesture('frac', 500, 401, 900);
    const fractionalReport = report('frac-report', 560, 267, 600, { dpr: 1.5 });
    expect(correlateClicks([fractional, fractionalReport])).toEqual([
      pair(fractional.id, fractionalReport.id),
    ]);
  });
});

describe('M4-QA-02 — the ±2 px rounding tolerance at its edges', () => {
  it('holds at exactly 2 on either axis alone and together, and is closed at 3', () => {
    const [down, up] = gesture('tol', 7000, 480, 360);
    for (const [dx, dy] of [
      [2, 0],
      [0, 2],
      [2, 2],
      [-2, -2],
    ] as const) {
      const near = report('tol-near', 7050, 480 + dx, 360 + dy);
      expect(correlateClicks([down, up, near]), `offset (${dx},${dy}) merges`).toHaveLength(1);
    }
    for (const [dx, dy] of [
      [3, 0],
      [0, 3],
      [3, -3],
    ] as const) {
      const far = report('tol-far', 7050, 480 + dx, 360 + dy);
      expect(correlateClicks([down, up, far]), `offset (${dx},${dy}) must not merge`).toEqual([]);
    }
  });
});

describe('M4-QA-02 — buttons must agree when the report names one', () => {
  it('pairs only the same button bit, and tolerates a report that names none', () => {
    const [left, leftUp] = gesture('btn-left', 300, 700, 350);
    expect(correlateClicks([left, leftUp, report('btn-left-ok', 340, 700, 350)])).toHaveLength(1);
    expect(
      correlateClicks([left, leftUp, report('btn-left-bad', 340, 700, 350, { button: 2 })]),
    ).toEqual([]);

    const [middle, middleUp] = gesture('btn-mid', 300, 720, 350, 2);
    expect(
      correlateClicks([middle, middleUp, report('btn-mid-ok', 340, 720, 350, { button: 1 })]),
    ).toHaveLength(1);
    expect(
      correlateClicks([middle, middleUp, report('btn-mid-bad', 340, 720, 350, { button: 0 })]),
    ).toEqual([]);

    // A button-less report cannot disagree; it still pairs (the script always
    // sends one — a row that cannot say must not veto).
    const buttonless = report('btnless', 340, 700, 350);
    buttonless.payload = { screenX: 700, screenY: 350, dpr: 1 };
    expect(correlateClicks([left, leftUp, buttonless])).toHaveLength(1);
  });
});

describe('M4-QA-02 — one report, one press', () => {
  it('gives the report the NEWEST unmatched press it could follow', () => {
    const older = gesture('newest-older', 1000, 500, 220);
    const newer = gesture('newest-newer', 1100, 500, 220);
    const click = report('newest-report', 1140, 500, 220);
    // Both presses are inside the window (140 ms and 40 ms back); the newest
    // wins. Each gesture carries its release — a held mask is not a new press.
    expect(correlateClicks([...older, ...newer, click])).toEqual([
      pair('newest-newer-press', click.id),
    ]);
  });

  it('pairs a press at most once: a second report in the window finds nothing', () => {
    const [down] = gesture('once', 1000, 520, 240);
    const first = report('once-first', 1040, 520, 240);
    const second = report('once-second', 1100, 520, 240);
    expect(correlateClicks([down, first, second])).toEqual([pair(down.id, first.id)]);
  });

  it('an again-reported double click cannot claim the press a second time', () => {
    const [down, up] = gesture('dbl', 1000, 540, 260);
    const first = report('dbl-first', 1030, 540, 260);
    const second = report('dbl-second', 1060, 540, 260);
    const again = report('dbl-again', 1090, 540, 260);
    expect(correlateClicks([down, up, first, second, again])).toEqual([pair(down.id, first.id)]);
  });
});

describe('M4-QA-02 — determinism', () => {
  it('is order-independent: permutations of the same rows answer the same pairs', () => {
    const trace = [
      ...gesture('det-a', 1000, 100, 100),
      ...gesture('det-b', 1200, 300, 300),
      ...gesture('det-c', 1400, 500, 500),
      report('det-a-report', 1060, 100, 100),
      report('det-b-report', 1250, 300, 300),
      report('det-z-report', 2600, 500, 500),
    ];
    const canonical = correlateClicks(trace);
    expect(canonical).toEqual([
      pair('det-a-press', 'det-a-report'),
      pair('det-b-press', 'det-b-report'),
    ]);

    const permutations = [
      [...trace].reverse(),
      [
        trace[4]!,
        trace[0]!,
        trace[6]!,
        trace[2]!,
        trace[5]!,
        trace[8]!,
        trace[1]!,
        trace[3]!,
        trace[7]!,
      ],
      [...trace.slice(3), ...trace.slice(0, 3)],
    ];
    for (const permuted of permutations) {
      expect(correlateClicks(permuted)).toEqual(canonical);
    }
    // Repeat runs on the same rows answer identically too.
    expect(correlateClicks(trace)).toEqual(canonical);
  });
});

describe('M4-QA-02 — hostile payloads never throw and never pair', () => {
  it('answers [] for junk rows of both layers', () => {
    const junk = [
      { id: 'qa02-j1', tsOffsetMs: 0, layer: 'X11', type: 'pointer', payload: null },
      { id: 'qa02-j2', tsOffsetMs: 1, layer: 'X11', type: 'pointer', payload: 'x' },
      { id: 'qa02-j3', tsOffsetMs: 2, layer: 'X11', type: 'pointer', payload: ['mask'] },
      { id: 'qa02-j4', tsOffsetMs: 3, layer: 'X11', type: 'pointer', payload: { buttonMask: 1.5 } },
      { id: 'qa02-j5', tsOffsetMs: 4, layer: 'X11', type: 'pointer', payload: { buttonMask: -1 } },
      {
        id: 'qa02-j6',
        tsOffsetMs: 5,
        layer: 'X11',
        type: 'pointer',
        payload: { buttonMask: 1, x: '0', y: 0 },
      },
      { id: 'qa02-j7', tsOffsetMs: 6, layer: 'CDP', type: 'click', payload: [] },
      {
        id: 'qa02-j8',
        tsOffsetMs: 7,
        layer: 'CDP',
        type: 'click',
        payload: { screenX: 0, screenY: 0, dpr: 0 },
      },
      {
        id: 'qa02-j9',
        tsOffsetMs: 8,
        layer: 'CDP',
        type: 'click',
        payload: { screenX: NaN, screenY: 0, dpr: 1 },
      },
    ] as readonly CorrelatorRow[];
    expect(correlateClicks(junk)).toEqual([]);
  });

  it('exports the spec’s numbers', () => {
    expect(CORRELATION_WINDOW_MS).toBe(WINDOW_MS);
    expect(CORRELATION_TOLERANCE_PX).toBe(TOLERANCE_PX);
  });
});

describe('M4-QA-02 — the from-spec oracle agrees everywhere', () => {
  it('agrees on a sweep of every dt from -260 to +260 ms', () => {
    const mismatches: string[] = [];
    for (let dt = -260; dt <= 260; dt += 1) {
      const [down, up] = gesture('osweep', 3000);
      const click = report('osweep-report', 3000 + dt, SPOT_X, SPOT_Y);
      const trace = [down, up, click];
      const product = correlateClicks(trace);
      const oracle = oraclePairs(trace as readonly Qa02Row[]);
      if (JSON.stringify(product) !== JSON.stringify(oracle)) {
        mismatches.push(
          `dt=${dt}: product=${JSON.stringify(product)} oracle=${JSON.stringify(oracle)}`,
        );
      }
    }
    expect(mismatches, 'dt values where product and oracle disagree').toEqual([]);
  });

  it('agrees on a combinatorial grid of presses × reports', () => {
    const pressConfigs = [
      { x: 640, y: 480, ts: 5000 },
      { x: 642, y: 482, ts: 5060 },
      { x: 700, y: 500, ts: 7000 },
    ];
    const clickConfigs: {
      dt: number;
      dx: number;
      dy: number;
      button?: number | null;
      dpr: number;
    }[] = [
      { dt: -10, dx: 0, dy: 0, dpr: 1 },
      { dt: 0, dx: 0, dy: 0, dpr: 1 },
      { dt: 60, dx: 0, dy: 0, dpr: 1 },
      { dt: 60, dx: 2, dy: -2, dpr: 1 },
      { dt: 60, dx: 3, dy: 0, dpr: 1 },
      { dt: 150, dx: 0, dy: 0, dpr: 1 },
      { dt: 151, dx: 0, dy: 0, dpr: 1 },
      { dt: 200, dx: 0, dy: 0, dpr: 1 },
      { dt: 60, dx: 0, dy: 0, button: null, dpr: 1 },
      { dt: 60, dx: 0, dy: 0, button: 2, dpr: 1 },
      { dt: 60, dx: 0, dy: 0, dpr: 2 },
    ];

    const mismatches: string[] = [];
    let cases = 0;
    for (const pressConfig of pressConfigs) {
      for (const clickConfig of clickConfigs) {
        cases += 1;
        const [down, up] = gesture('ogrid', pressConfig.ts, pressConfig.x, pressConfig.y);
        const extra: Record<string, unknown> = { dpr: clickConfig.dpr };
        // `undefined` = the field is absent (a report that cannot name a button).
        if (clickConfig.button === null) extra['button'] = undefined;
        else if (clickConfig.button !== undefined) extra['button'] = clickConfig.button;
        const click = report(
          'ogrid-report',
          pressConfig.ts + clickConfig.dt,
          pressConfig.x + clickConfig.dx,
          pressConfig.y + clickConfig.dy,
          extra,
        );
        const trace = [down, up, click];
        const product = correlateClicks(trace);
        const oracle = oraclePairs(trace as readonly Qa02Row[]);
        if (JSON.stringify(product) !== JSON.stringify(oracle)) {
          mismatches.push(
            `press=(${pressConfig.x},${pressConfig.y})@${pressConfig.ts} click=${JSON.stringify(clickConfig)}: ` +
              `product=${JSON.stringify(product)} oracle=${JSON.stringify(oracle)}`,
          );
        }
      }
    }
    expect(cases).toBe(pressConfigs.length * clickConfigs.length);
    expect(mismatches, 'grid cases where product and oracle disagree').toEqual([]);
  });

  it('agrees on seeded random traces, and every product pair re-validates against the rows', () => {
    // Deterministic LCG: every run explores the same traces, so this evidence
    // is reproducible.
    let state = 0x5eeda02;
    const rand = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)]!;
    const spots: readonly [number, number][] = [
      [100, 100],
      [100, 104],
      [104, 104],
      [200, 150],
      [300, 300],
      [380, 260],
    ];

    const mismatches: string[] = [];
    const violations: string[] = [];
    let traces = 0;
    let pairTotal = 0;

    for (let n = 0; n < 350; n += 1) {
      traces += 1;
      const rows: CorrelatorRow[] = [];
      const pressPlan: { id: string; ts: number; x: number; y: number }[] = [];
      let ts = n * 7;
      const pressCount = 1 + Math.floor(rand() * 4);
      for (let p = 0; p < pressCount; p += 1) {
        ts += 10 + Math.floor(rand() * 240);
        const [x, y] = pick(spots);
        const prefix = `f${n}-p${p}`;
        const [down, up] = gesture(prefix, ts, x, y);
        rows.push(down, up);
        pressPlan.push({ id: down.id, ts, x, y });
      }
      const clickCount = 1 + Math.floor(rand() * 3);
      for (let c = 0; c < clickCount; c += 1) {
        const anchor = pick(pressPlan);
        // dt: 45% inside [0,150], the rest split over both rejection sides —
        // enough cases on every side of the boundary.
        const dt =
          rand() < 0.45
            ? Math.floor(rand() * 151)
            : rand() < 0.5
              ? -1 - Math.floor(rand() * 150)
              : 151 + Math.floor(rand() * 200);
        // Desktop offset of the report from its anchor press: 65% inside the
        // ±2 px tolerance, 35% clearly outside it.
        const offset = (): number => {
          const magnitude = rand() < 0.65 ? Math.floor(rand() * 3) : 3 + Math.floor(rand() * 4);
          return rand() < 0.5 ? magnitude : -magnitude;
        };
        const ddx = offset();
        const ddy = offset();
        const dpr = pick([1, 1.25, 1.5, 2] as const);
        const extra: Record<string, unknown> = { dpr };
        const buttonRoll = rand();
        if (buttonRoll > 0.75) extra['button'] = undefined;
        else if (buttonRoll > 0.5) extra['button'] = Math.floor(rand() * 3);
        // The capture script sends CSS pixels: dividing by dpr here makes the
        // report's mapped desktop position land back on the intended offset.
        rows.push(
          report(
            `f${n}-c${c}`,
            anchor.ts + dt,
            (anchor.x + ddx) / dpr,
            (anchor.y + ddy) / dpr,
            extra,
          ),
        );
      }

      const product = correlateClicks(rows);
      const oracle = oraclePairs(rows as readonly Qa02Row[]);
      pairTotal += product.length;
      if (JSON.stringify(product) !== JSON.stringify(oracle)) {
        mismatches.push(
          `trace ${n}: product=${JSON.stringify(product)} oracle=${JSON.stringify(oracle)}`,
        );
      }

      // Property checks: each reported pair must re-validate against the raw
      // rows, and no row may appear in two pairs.
      const byId = new Map(rows.map((row) => [row.id, row]));
      const seenIds = new Set<string>();
      for (const p of product) {
        const pressRow = byId.get(p.x11Id);
        const clickRow = byId.get(p.cdpId);
        if (!pressRow || !clickRow) {
          violations.push(`trace ${n}: pair references unknown rows ${JSON.stringify(p)}`);
          continue;
        }
        const pressPayload = pressRow.payload as Record<string, unknown>;
        const clickPayload = clickRow.payload as Record<string, unknown>;
        const dt = clickRow.tsOffsetMs - pressRow.tsOffsetMs;
        if (dt < 0 || dt > WINDOW_MS) violations.push(`trace ${n}: pair outside window dt=${dt}`);
        const mappedX = Math.round(
          (clickPayload['screenX'] as number) * (clickPayload['dpr'] as number),
        );
        const mappedY = Math.round(
          (clickPayload['screenY'] as number) * (clickPayload['dpr'] as number),
        );
        if (Math.abs((pressPayload['x'] as number) - mappedX) > TOLERANCE_PX) {
          violations.push(`trace ${n}: pair past x tolerance ${JSON.stringify(p)}`);
        }
        if (Math.abs((pressPayload['y'] as number) - mappedY) > TOLERANCE_PX) {
          violations.push(`trace ${n}: pair past y tolerance ${JSON.stringify(p)}`);
        }
        const reportButton = clickPayload['button'];
        if (typeof reportButton === 'number') {
          const mask = pressPayload['buttonMask'] as number;
          const bits = [0, 1, 2].filter((bit) => (mask & (1 << bit)) !== 0);
          if (!bits.includes(reportButton)) {
            violations.push(`trace ${n}: pair across buttons ${JSON.stringify(p)}`);
          }
        }
        if (seenIds.has(p.x11Id) || seenIds.has(p.cdpId)) {
          violations.push(`trace ${n}: a row paired twice ${JSON.stringify(p)}`);
        }
        seenIds.add(p.x11Id);
        seenIds.add(p.cdpId);
      }
    }

    // The summary rides in the assertion message so evidence logs carry it.
    expect(
      mismatches,
      `product vs oracle mismatches (${traces} traces, ${pairTotal} pairs)`,
    ).toEqual([]);
    expect(violations, 'property violations in the product’s own answers').toEqual([]);
    // Productivity floor: the generator must keep exercising the merge zone
    // (measured: 109 pairs on the seeded sequence); collapsing near zero would
    // make the agreement vacuous.
    expect(pairTotal).toBeGreaterThan(80);
  });
});
