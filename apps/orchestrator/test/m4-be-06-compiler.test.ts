import { describe, expect, it } from 'vitest';

import {
  constrainToResolver,
  cropCandidatesOf,
  foldCorrelated,
  renderTrace,
  selectCrops,
  type TraceRow,
} from '../src/skills/compile-input.js';
import { CDP_SELECTOR_KINDS } from '../src/recordings/cdp-events.js';

/**
 * M4-BE-06 — "Compiler emits Playwright for correlated steps; never both
 * layers".
 *
 * §6/M4: "an X11 click within 150 ms of a CDP click at the same coordinates
 * is the same action. Write `correlatedWithId` on both rows. The compiler
 * must not emit both." M4-BE-05 proves WHICH rows are one action; this suite
 * fences the other half — that the trace the model reads contains the action
 * exactly once, positioned where it happened, and that everything which is
 * NOT a proven pair survives byte-for-byte. The service-level half (the
 * model actually receiving the folded trace and the never-both instruction)
 * lives in `skill-compile.test.ts`.
 */

const press = (
  id: string,
  tsOffsetMs: number,
  x: number,
  y: number,
  over: Partial<TraceRow> = {},
): TraceRow => ({
  id,
  tsOffsetMs,
  layer: 'X11',
  type: 'pointer',
  payload: { x, y, buttonMask: 1 },
  screenshotKey: null,
  ...over,
});

const release = (id: string, tsOffsetMs: number, x: number, y: number): TraceRow => ({
  id,
  tsOffsetMs,
  layer: 'X11',
  type: 'pointer',
  payload: { x, y, buttonMask: 0 },
  screenshotKey: null,
});

const candidates = [
  { kind: 'testid', selector: '[data-testid="save"]', unique: true },
  { kind: 'css', selector: 'body > button', unique: false },
];

const report = (id: string, tsOffsetMs: number, over: Partial<TraceRow> = {}): TraceRow => ({
  id,
  tsOffsetMs,
  layer: 'CDP',
  type: 'click',
  payload: { url: 'https://example.test/', tag: 'button', testid: 'save', candidates, dpr: 1 },
  screenshotKey: null,
  ...over,
});

/** A mutual pair: `press` and `report` name each other's ids. */
const pair = (pressId: string, reportId: string, ts: number) => [
  press(pressId, ts, 640, 400, { correlatedWithId: reportId }),
  report(reportId, ts + 30, { correlatedWithId: pressId }),
];

describe('foldCorrelated — one action, one row (§6/M4 "must not emit both")', () => {
  it('collapses a pair to the report, carrying the press position and time', () => {
    const rows = [...pair('p1', 'r1', 100), release('rel1', 140, 640, 400)];

    const folded = foldCorrelated(rows);

    expect(folded).toHaveLength(2);
    expect(folded[0]).toEqual({
      tsOffsetMs: 100,
      type: 'click',
      payload: {
        url: 'https://example.test/',
        tag: 'button',
        testid: 'save',
        candidates,
        dpr: 1,
        x: 640,
        y: 400,
      },
      screenshotKey: null,
    });
    // The release is not part of the correlated claim — it keeps its own row
    // (the legend tells the model it belongs to the click, not a step).
    expect(folded[1]).toEqual(release('rel1', 140, 640, 400));
  });

  it('keeps the press’s crop reference and origin on the merged row', () => {
    const rows = [
      press('p1', 100, 640, 400, {
        correlatedWithId: 'r1',
        screenshotKey: 'recordings/r/a.png',
        payload: { x: 640, y: 400, buttonMask: 1, cropX: 540, cropY: 300 },
      }),
      report('r1', 130, { correlatedWithId: 'p1' }),
    ];

    const folded = foldCorrelated(rows);

    expect(folded).toHaveLength(1);
    expect(folded[0]?.screenshotKey).toBe('recordings/r/a.png');
    // The crop still resolves to the same picture, at the same place.
    const crops = cropCandidatesOf(folded);
    expect(crops).toEqual([
      { tsOffsetMs: 100, x: 640, y: 400, screenshotKey: 'recordings/r/a.png' },
    ]);
    const line = JSON.parse(
      renderTrace(folded, selectCrops(crops, { widthPx: 1280, heightPx: 800 })),
    ) as Record<string, unknown>;
    expect(line).toMatchObject({ ms: 100, type: 'click', screenshot: 0, cropX: 540, cropY: 300 });
    expect(line['candidates']).toEqual(candidates);
  });

  it('emits the pair exactly once in the rendered trace — never both layers', () => {
    const rows = [...pair('p1', 'r1', 100)];
    const folded = foldCorrelated(rows);
    const text = renderTrace(folded, []);

    const lines = text.split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    // One action, one line: no separate pointer row with the same position.
    expect(parsed['type']).toBe('click');
    expect(parsed['x']).toBe(640);
    expect(parsed['y']).toBe(400);
    expect(text).not.toContain('"buttonMask"');
  });

  it('keeps an uncorrelated X11 press and an uncorrelated CDP report as they are', () => {
    const rows = [
      press('p1', 100, 10, 20),
      release('rel1', 130, 10, 20),
      report('r1', 200),
      {
        id: 'n1',
        tsOffsetMs: 300,
        layer: 'CDP',
        type: 'navigate',
        payload: { url: 'x' },
        screenshotKey: null,
      },
    ];

    // Nothing is correlated, so folding is a no-op: raw input keeps its
    // prescribed coordinate emission, and a CDP-only click (its X11 twin was
    // not captured) keeps its selectors.
    expect(foldCorrelated(rows)).toEqual(rows);
  });

  it('preserves trace order with the merged row where the action happened', () => {
    const rows = [
      press('p1', 100, 640, 400, { correlatedWithId: 'r1' }),
      {
        id: 'k1',
        tsOffsetMs: 120,
        layer: 'X11',
        type: 'key',
        payload: { combo: 'Return' },
        screenshotKey: null,
      },
      report('r1', 130, { correlatedWithId: 'p1' }),
      report('r2', 200),
    ];

    const folded = foldCorrelated(rows);

    // The report landed 30 ms after the press; replay order is the press's.
    expect(folded.map((row) => [row.tsOffsetMs, row.type])).toEqual([
      [100, 'click'],
      [120, 'key'],
      [200, 'click'],
    ]);
    // The merged row is the X11 press's, so its position is where the user's
    // action was — the CDP row at 130 must not drag it after the Return.
  });

  it('folds a pair at its earlier row whatever order the rows arrive in', () => {
    const rows = [
      press('p1', 100, 640, 400, { correlatedWithId: 'r1' }),
      report('r1', 130, { correlatedWithId: 'p1' }),
    ];

    const forward = foldCorrelated(rows);
    const backward = foldCorrelated([...rows].reverse());

    expect(forward).toEqual(backward);
    expect(forward).toHaveLength(1);
    expect(forward[0]?.tsOffsetMs).toBe(100);
  });

  it('still emits one row when a report sorts before its press (the impossible order)', () => {
    // Correlation requires dt >= 0 and the tee's offsets are strictly
    // increasing, so a report can never precede its press. If corrupted data
    // ever said otherwise, the pair must still collapse to ONE row — the
    // invariant is "never both", and an ordering the correlator forbids is
    // not a licence to emit the action twice.
    const rows = [
      press('p1', 130, 640, 400, { correlatedWithId: 'r1' }),
      report('r1', 100, { correlatedWithId: 'p1' }),
    ];

    const folded = foldCorrelated(rows);

    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      tsOffsetMs: 100,
      type: 'click',
      payload: { x: 640, y: 400 },
    });
  });

  it('does not fold a one-sided or non-mutual reference', () => {
    const oneSided = [
      press('p1', 100, 640, 400, { correlatedWithId: 'r1' }),
      report('r1', 130), // does not point back
    ];
    const dangling = [
      press('p1', 100, 640, 400, { correlatedWithId: 'missing' }),
      report('r1', 130, { correlatedWithId: 'p1' }),
    ];

    // A fold is a claim about two rows; where the claim cannot be checked
    // against the rows themselves the trace keeps both — a dropped row is an
    // action the skill can never reproduce.
    expect(foldCorrelated(oneSided)).toEqual(oneSided);
    expect(foldCorrelated(dangling)).toEqual(dangling);
  });

  it('does not fold rows of the wrong kinds, or a press without a position', () => {
    const wrongKinds = [
      press('p1', 100, 640, 400, { correlatedWithId: 'p2' }),
      press('p2', 110, 640, 400, { correlatedWithId: 'p1' }),
    ];
    const noPosition: TraceRow[] = [
      {
        id: 'p1',
        tsOffsetMs: 100,
        layer: 'X11',
        type: 'pointer',
        payload: { buttonMask: 1 },
        screenshotKey: null,
        correlatedWithId: 'r1',
      },
      report('r1', 130, { correlatedWithId: 'p1' }),
    ];

    expect(foldCorrelated(wrongKinds)).toEqual(wrongKinds);
    expect(foldCorrelated(noPosition)).toEqual(noPosition);
  });

  it('folds each press at most once when two claim the same report', () => {
    const rows = [
      press('p1', 100, 640, 400, { correlatedWithId: 'r1' }),
      press('p2', 110, 640, 400, { correlatedWithId: 'r1' }),
      report('r1', 130, { correlatedWithId: 'p1' }),
    ];

    const folded = foldCorrelated(rows);

    // The first press (in trace order) gets the report; the second keeps its
    // own row rather than consuming it twice.
    expect(folded).toHaveLength(2);
    expect(folded[0]?.type).toBe('click');
    expect(folded[1]).toEqual(rows[1]);
  });

  it('is idempotent: folding folded rows changes nothing', () => {
    const rows = [
      press('p1', 100, 640, 400, { correlatedWithId: 'r1' }),
      report('r1', 130, { correlatedWithId: 'p1' }),
      press('p2', 200, 10, 20),
    ];

    const once = foldCorrelated(rows);

    expect(foldCorrelated(once)).toEqual(once);
  });
});

/**
 * Captured candidates have main-frame light-DOM CSS evidence. Text uniqueness
 * uses a different matcher from native Playwright; shadow rungs omit the host.
 * Retain the demonstrated coordinate fallback for those incomplete paths.
 */
describe('constrainToResolver — recording evidence identifies a safe native selector', () => {
  const resolvable = [
    { kind: 'testid', selector: '[data-testid="go"]', unique: true },
    { kind: 'id', selector: '#go', unique: true },
    { kind: 'aria', selector: '[role="button"][aria-label="Go"]', unique: false },
    { kind: 'css', selector: 'form > button:nth-of-type(2)', unique: true },
  ];

  const clickRow = (payload: Record<string, unknown>, over: Partial<TraceRow> = {}): TraceRow => ({
    id: 'r1',
    tsOffsetMs: 100,
    layer: 'CDP',
    type: 'click',
    payload: { url: 'https://example.test/', ...payload },
    screenshotKey: null,
    ...over,
  });

  it('leaves a row whose candidates all resolve exactly as it was', () => {
    const row = clickRow({ candidates: resolvable });

    const [kept] = constrainToResolver([row]);

    // Same object: "nothing to constrain" is not a rewrite.
    expect(kept).toBe(row);
  });

  it('sets aside unproven text uniqueness and incomplete shadow paths', () => {
    const row = clickRow({
      candidates: [
        { kind: 'id', selector: '#pay', unique: true },
        { kind: 'text', selector: 'text="Pay now"', unique: true },
        { kind: 'css', selector: 'button', unique: true, shadow: true },
      ],
    });

    const [kept] = constrainToResolver([row]);

    expect((kept!.payload as Record<string, unknown>)['candidates']).toEqual([
      { kind: 'id', selector: '#pay', unique: true },
    ]);
  });

  it('clears the candidates of a click that already carries a position', () => {
    const row = clickRow({
      x: 640,
      y: 400,
      candidates: [{ kind: 'text', selector: 'text="Pay now"', unique: true }],
    });

    const [kept] = constrainToResolver([row]);
    const payload = kept!.payload as Record<string, unknown>;

    // Nothing left to name the element: the row reads as the coordinate
    // click it must replay as, and keeps the position it had.
    expect(payload['candidates']).toBeUndefined();
    expect(payload).toMatchObject({ x: 640, y: 400 });
  });

  it('promotes the page-reported screen position when that is all the click has', () => {
    const row = clickRow({
      screenX: 652,
      screenY: 994,
      dpr: 1,
      candidates: [
        { kind: 'id', selector: '#in-shadow', unique: true, shadow: true },
        { kind: 'text', selector: 'text="Pay now"', unique: true },
      ],
    });

    const [kept] = constrainToResolver([row]);
    const payload = kept!.payload as Record<string, unknown>;

    // `screenX`/`screenY`+`dpr` is the desktop position both layers agree on
    // (M4-BE-05 records it as the triple the correlation rests on); on the
    // trace's own x/y convention the fallback has something to replay.
    expect(payload['candidates']).toBeUndefined();
    expect(payload).toMatchObject({ x: 652, y: 994 });
  });

  it('converts the screen position by dpr, the way the correlator does', () => {
    // `screenX`/`screenY` are CSS pixels; `x`/`y` everywhere else in the
    // trace are framebuffer pixels. Writing the one onto the other is right
    // only at dpr 1 — on any other display the emitted `ctx.click` lands
    // somewhere else and reports success, which is the failure this fence
    // exists to prevent. `click-correlator.ts` maps the same pair the same
    // way to decide whether a report and a press are one click.
    const row = clickRow({
      screenX: 326,
      screenY: 497.4,
      dpr: 2,
      candidates: [{ kind: 'text', selector: 'text="Pay now"', unique: true }],
    });

    const [kept] = constrainToResolver([row]);

    expect(kept!.payload).toMatchObject({ x: 652, y: 995 });
  });

  it('invents no position for a report that carries no dpr', () => {
    // The correlator's rule, for the correlator's reason: a position without
    // the ratio between CSS and desktop pixels is a guess, and `dpr` is not
    // optional even when it is 1. A click the model is given no coordinate
    // for is a step it cannot write; a guessed one is a step that runs.
    const row = clickRow({
      screenX: 652,
      screenY: 994,
      candidates: [{ kind: 'text', selector: 'text="Pay now"', unique: true }],
    });

    const [kept] = constrainToResolver([row]);
    const payload = kept!.payload as Record<string, unknown>;

    expect(payload['candidates']).toBeUndefined();
    expect(payload['x']).toBeUndefined();
    expect(payload['y']).toBeUndefined();
    // The facts the page did report survive; only the conclusion is withheld.
    expect(payload).toMatchObject({ screenX: 652, screenY: 994 });
  });

  it('promotes the screen position on a click that never had candidates at all', () => {
    // A report whose generator failed (the script keeps the interaction,
    // loses the rungs): still an action, still replayable from the triple.
    const row = clickRow({ screenX: 10, screenY: 20, dpr: 1 });

    const [kept] = constrainToResolver([row]);

    expect(kept!.payload).toMatchObject({ x: 10, y: 20 });
  });

  it('prefers an existing position over the screen pair, and invents nothing without one', () => {
    const withPosition = clickRow({
      x: 1,
      y: 2,
      screenX: 10,
      screenY: 20,
      dpr: 1,
      candidates: [{ kind: 'text', selector: 'text="x"', unique: true }],
    });
    const withoutPosition = clickRow({
      candidates: [{ kind: 'text', selector: 'text="x"', unique: true }],
    });

    const [first] = constrainToResolver([withPosition]);
    const [second] = constrainToResolver([withoutPosition]);

    expect(first!.payload as Record<string, unknown>).toMatchObject({ x: 1, y: 2 });
    expect((second!.payload as Record<string, unknown>)['x']).toBeUndefined();
    expect((second!.payload as Record<string, unknown>)['y']).toBeUndefined();
  });

  it('applies the same filter to a field row, without inventing coordinates', () => {
    const row: TraceRow = {
      id: 'i1',
      tsOffsetMs: 200,
      layer: 'CDP',
      type: 'input',
      payload: {
        value: 'otters',
        candidates: [
          { kind: 'text', selector: 'text="otters"', unique: true },
          { kind: 'id', selector: '#q', unique: true, shadow: true },
        ],
      },
      screenshotKey: null,
    };

    const [kept] = constrainToResolver([row]);
    const payload = kept!.payload as Record<string, unknown>;

    expect(payload).toMatchObject({ value: 'otters' });
    expect(payload['candidates']).toBeUndefined();
    // A fill has nothing to click: no x/y is invented for it.
    expect(payload['x']).toBeUndefined();
    expect(payload['y']).toBeUndefined();
  });

  it('leaves rows without candidates, and non-object payloads, alone', () => {
    const pointerRow = press('p1', 50, 5, 6);
    const scalar: TraceRow = {
      id: 'x1',
      tsOffsetMs: 60,
      type: 'type',
      payload: 'scalar',
      screenshotKey: null,
    };

    const [first, second] = constrainToResolver([pointerRow, scalar]);

    expect(first).toBe(pointerRow);
    expect(second).toBe(scalar);
  });

  it('is pure and idempotent', () => {
    const rows = [
      clickRow({
        screenX: 1,
        screenY: 2,
        dpr: 2,
        candidates: [{ kind: 'text', selector: 'text="x"', unique: true }],
      }),
    ];
    const snapshot = JSON.stringify(rows);

    const once = constrainToResolver(rows);
    const twice = constrainToResolver(once);

    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(twice).toEqual(once);
  });

  it('keeps the CSS ladder kinds with recorder scope evidence', () => {
    // The filter is an allowlist, and this is the pin that makes the
    // vocabulary growing a conscious act: if the ladder gains a kind, this
    // fails until someone proves the resolver can execute it.
    const row = clickRow({
      candidates: CDP_SELECTOR_KINDS.map((kind) => ({
        kind,
        selector: `#k-${kind}`,
        unique: true,
      })),
    });

    const [kept] = constrainToResolver([row]);
    const kinds = (
      (kept!.payload as Record<string, unknown>)['candidates'] as ReadonlyArray<{ kind: string }>
    ).map((candidate) => candidate.kind);

    expect(kinds).toEqual([...CDP_SELECTOR_KINDS].filter((kind) => kind !== 'text'));
  });
});

/**
 * Property-style: the fold's promises hold over generated traces, not only
 * over the cases someone wrote down. The generator is seeded, so a failure
 * prints the exact rows that produced it and reruns identically.
 */
describe('foldCorrelated — the never-both-layers invariant, over generated traces', () => {
  /** xorshift32: tiny, seeded, deterministic. */
  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0xffffffff;
    };
  }

  interface Generated {
    readonly rows: readonly TraceRow[];
    readonly pairCount: number;
  }

  function generate(seed: number): Generated {
    const random = prng(seed);
    const rows: TraceRow[] = [];
    const pairs: Array<{ pressId: string; reportId: string }> = [];
    let ts = 0;
    let n = 0;
    const count = 6 + Math.floor(random() * 24);
    for (let i = 0; i < count; i += 1) {
      ts += 1 + Math.floor(random() * 20);
      n += 1;
      const roll = random();
      if (roll < 0.3) {
        // A correlated pair, both sides naming each other.
        const pressId = `p${n}`;
        const reportId = `r${n}`;
        rows.push(press(pressId, ts, 100 + n, 200 + n, { correlatedWithId: reportId }));
        ts += 1 + Math.floor(random() * 10);
        rows.push(report(reportId, ts, { correlatedWithId: pressId }));
        pairs.push({ pressId, reportId });
      } else if (roll < 0.45) {
        rows.push(press(`p${n}`, ts, 100 + n, 200 + n));
      } else if (roll < 0.6) {
        rows.push(release(`rel${n}`, ts, 100 + n, 200 + n));
      } else if (roll < 0.75) {
        rows.push(report(`r${n}`, ts));
      } else if (roll < 0.85) {
        rows.push({
          id: `t${n}`,
          tsOffsetMs: ts,
          layer: 'X11',
          type: 'type',
          payload: { text: 'x' },
          screenshotKey: null,
        });
      } else {
        rows.push({
          id: `k${n}`,
          tsOffsetMs: ts,
          layer: 'X11',
          type: 'key',
          payload: { combo: 'Return' },
          screenshotKey: null,
        });
      }
    }
    return { rows, pairCount: pairs.length };
  }

  it('never emits both layers, loses nothing, and reorders nothing (250 traces)', () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const { rows, pairCount } = generate(seed);
      const folded = foldCorrelated(rows);

      // 1. Exactly one row per action: each proven pair contributes one.
      expect(folded.length, `seed ${seed}: pair count`).toBe(rows.length - pairCount);

      // 2. Nothing is lost: the output's ids are the input's, minus BOTH
      //    members of each folded pair — the merged row is a new row (it
      //    carries neither original id), and every other id appears exactly
      //    once.
      const inputIds = rows.map((row) => row.id);
      const isPairReport = (row: TraceRow): boolean =>
        row.type === 'click' &&
        row.correlatedWithId !== undefined &&
        rows.some(
          (other) => other.id === row.correlatedWithId && other.correlatedWithId === row.id,
        );
      const pairReportIds = new Set(rows.filter(isPairReport).map((row) => row.id));
      const pairPressIds = new Set(
        rows
          .filter((row) => row.type === 'pointer' && row.correlatedWithId !== undefined)
          .map((row) => row.id),
      );
      const outputIds = folded.map((row) => row.id).filter((id) => id !== undefined);
      const expectedIds = inputIds.filter(
        (id) => id !== undefined && !pairReportIds.has(id) && !pairPressIds.has(id),
      );
      expect(outputIds.slice().sort(), `seed ${seed}: ids`).toEqual(expectedIds.slice().sort());
      expect(new Set(outputIds).size, `seed ${seed}: no duplicate id`).toBe(outputIds.length);

      // 3. Order is the trace's one order, and no uncorrelated row moved.
      const offsets = folded.map((row) => row.tsOffsetMs);
      expect(
        [...offsets].sort((a, b) => a - b),
        `seed ${seed}: order`,
      ).toEqual(offsets);
      const untouched = rows.filter(
        (row) => !pairReportIds.has(row.id ?? '') && !pairPressIds.has(row.id ?? ''),
      );
      for (const row of untouched) {
        expect(folded, `seed ${seed}: row ${row.id} survives verbatim`).toContainEqual(row);
      }

      // 4. Stable under input permutation and under a second fold.
      const shuffled = [...rows];
      const shuffle = prng(seed * 7919);
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(shuffle() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(foldCorrelated(shuffled), `seed ${seed}: permutation`).toEqual(folded);
      expect(foldCorrelated(folded), `seed ${seed}: idempotent`).toEqual(folded);
    }
  });
});
