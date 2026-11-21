/**
 * M4-QA-02 from-spec oracle — an INDEPENDENT re-derivation of §6/M4's
 * click-correlation rule, for the QA suite's cross-substrate comparison.
 *
 * Written from the spec text — PRD §6/M4 ("an X11 click within 150 ms of a
 * CDP click at the same coordinates is the same action") plus M4-BE-05's
 * delivered semantics (the window is [0,150] ms inclusive; coordinates are
 * compared after `round(screen * dpr)` with a ±2 px rounding budget; the
 * button must agree when the report names one; a report may only follow the
 * press it describes; the newest still-unmatched press wins; every row pairs
 * at most once) — NOT from `click-correlator.ts`. Its shape is deliberately
 * different (a forward candidate scan with an explicit "newest" reduce, vs
 * the product's backwards walk with an early break), so a wrong loop, a
 * changed constant or an off-by-one cannot agree with itself.
 *
 * The numbers below are the spec's, written by hand and NOT imported: a
 * product-side constant change must break the comparison, not travel through
 * it.
 */

/** §6/M4's window, literal. */
const WINDOW_MS = 150;

/** M4-BE-05's rounding budget in desktop pixels, literal. */
const TOLERANCE_PX = 2;

/** The button-mask bits that mean "a click button" (RFC 6143 §7.5.5, wheel excluded). */
const CLICK_BUTTON_BITS = 0b111;

export interface Qa02Row {
  readonly id: string;
  readonly tsOffsetMs: number;
  readonly layer: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface Qa02Pair {
  readonly x11Id: string;
  readonly cdpId: string;
}

interface Qa02Press {
  readonly id: string;
  readonly tsOffsetMs: number;
  readonly x: number;
  readonly y: number;
  readonly button: number;
}

function objOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fin(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The spec's answer for a trace: every provable (press, report) pair, in
 * report order. An empty list is a normal answer.
 */
export function oraclePairs(rows: readonly Qa02Row[]): Qa02Pair[] {
  // Trace order is the only order: `tsOffsetMs`, stable for equal stamps.
  const sorted = [...rows].sort((a, b) => a.tsOffsetMs - b.tsOffsetMs);

  // A press is a click-bit that went 0 -> 1 between consecutive X11 pointer
  // rows; buttons start released. (Junk masks neither press nor move the bit.)
  const presses: Qa02Press[] = [];
  let held = 0;
  for (const row of sorted) {
    if (row.layer !== 'X11' || row.type !== 'pointer') continue;
    const payload = objOf(row.payload);
    if (payload === null) continue;
    const mask = payload['buttonMask'];
    if (typeof mask !== 'number' || !Number.isInteger(mask) || mask < 0) continue;
    const wentDown = mask & ~held & CLICK_BUTTON_BITS;
    if (wentDown !== 0) {
      const x = payload['x'];
      const y = payload['y'];
      if (fin(x) && fin(y)) {
        presses.push({
          id: row.id,
          tsOffsetMs: row.tsOffsetMs,
          x,
          y,
          button: [0, 1, 2].find((bit) => (wentDown & (1 << bit)) !== 0) ?? 0,
        });
      }
    }
    held = mask;
  }

  // Each report takes the NEWEST still-unmatched press it could actually have
  // followed: dt in [0,150], mapped position within ±2 px on each axis, same
  // button when the report names one. An exact timestamp tie goes to the
  // later press in trace order (the stable-sort convention).
  const pairs: Qa02Pair[] = [];
  const claimed = new Set<string>();
  for (const row of sorted) {
    if (row.layer !== 'CDP' || row.type !== 'click') continue;
    const payload = objOf(row.payload);
    if (payload === null) continue;
    const screenX = payload['screenX'];
    const screenY = payload['screenY'];
    const dpr = payload['dpr'];
    if (!fin(screenX) || !fin(screenY) || !fin(dpr) || dpr <= 0) continue;
    const x = Math.round(screenX * dpr);
    const y = Math.round(screenY * dpr);
    const button = fin(payload['button']) ? payload['button'] : null;

    let newest: Qa02Press | null = null;
    for (const press of presses) {
      if (claimed.has(press.id)) continue;
      const dt = row.tsOffsetMs - press.tsOffsetMs;
      if (dt < 0 || dt > WINDOW_MS) continue;
      if (Math.abs(press.x - x) > TOLERANCE_PX || Math.abs(press.y - y) > TOLERANCE_PX) continue;
      if (button !== null && button !== press.button) continue;
      if (newest === null || press.tsOffsetMs >= newest.tsOffsetMs) newest = press;
    }
    if (newest !== null) {
      claimed.add(newest.id);
      pairs.push({ x11Id: newest.id, cdpId: row.id });
    }
  }

  return pairs;
}
