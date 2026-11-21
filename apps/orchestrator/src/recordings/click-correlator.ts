/**
 * The M4 correlator: "an X11 click within 150 ms of a CDP click at
 * the same coordinates is the same action. Write `correlatedWithId` on both
 * rows. The compiler must not emit both."
 *
 * What this decides, and on what evidence
 *
 * One operator click inside a browser window reaches the trace TWICE: once as
 * X11 rows (the RFB frame the operator's client sent, written verbatim by the
 * tee) and once as a CDP row (the page reporting the DOM `click` event). The
 * two rows are the same physical action, and nothing downstream can tell that
 * from either row alone — so the compiler would otherwise replay both the
 * coordinate click and the Playwright click. This module is the proof: it
 * pairs the two rows, and the pair is what lets M4-BE-06 drop one of them.
 *
 * Two facts decide the pairing, both §6/M4's:
 *
 * - TIME. The rows' `tsOffsetMs` — the trace's only order — must be within
 * `CORRELATION_WINDOW_MS`. The window is one-sided: the report cannot have
 * been produced before the press it describes. The tee stamps the X11
 * frame BEFORE forwarding it to the sandbox (`ScreenService.input`),
 * Chrome receives the press after that, the page's click event fires
 * after that, and the report is written after that again — so a CDP click
 * stamped earlier than an X11 press is not that press's report, and pairing
 * the two would link a click to a press that had not happened yet.
 *
 * - COORDINATES. Both rows carry where the click landed on the DESKTOP: the
 * X11 row `x`/`y` are framebuffer pixels (RFB coordinates are exactly
 * that), and the CDP row's `screenX`/`screenY` are the mouse event's own
 * screen coordinates, which Chrome on X11 reports as the pointer's
 * position on the root window — the same pixels, in CSS units. `dpr`
 * converts, and `Math.round` lands back on the integer pixel the event
 * happened at.
 *
 * This was probed live against the sandbox's Chrome 152 rather than
 * derived from the DOM spec: an RFB PointerEvent at framebuffer (x, y)
 * produces a page click whose `event.screenX`/`screenY` ARE (x, y) —
 * exact at every position tried (13 clicks, dpr 1). The window's OWN
 * `screenX`/`screenY` are NOT usable for this: they are the WM-placed
 * window origin, whose offset to the viewport is window borders plus the
 * browser's own chrome — 143 px on the sandbox desktop, a number neither
 * layer knows. That is why the capture script reports the EVENT's screen
 * coordinates (see `cdp-capture-script.ts`), and why this module compares
 * against them.
 *
 * What counts as "the x11 click"
 *
 * A click is a gesture: the trace's legend reads "a press and a release at
 * the same point". The row this module pairs is the PRESS — the button-down —
 * for three reasons that all point the same way: it is the row the trace's
 * own vocabulary identifies a click by (the compile-input's crop candidates,
 * "every click's coordinates", are the button-downs); it is the row that has
 * the click's screenshot; and its coordinates are where the click
 * LANDED, while a release that drifted is the end of a drag. The press is
 * derived from the trace exactly as M3-BE-04 derived it live: the button mask
 * of consecutive X11 pointer rows, a click button that went from up to down.
 * Buttons start released (mask 0), matching the coalescer's own convention,
 * so a recording that begins mid-press reads its first pointer row as the
 * press it is.
 *
 * The tolerance
 *
 * §6/M4 says "the same coordinates"; `CORRELATION_TOLERANCE_PX` is how exact
 * that can be, `2` px. The error budget: the script rounds `screenX`/`screenY`
 * to whole CSS pixels before sending (±0.5 px each), the operator's client
 * rounds its framebuffer coordinates the same way, and the `dpr` multiply is
 * rounded here — all bounded by ±1 px at dpr 1, ±2 px at dpr ≤ 2. A larger
 * deviation is not a rounding artifact of one click; it is two different
 * points, and pairing them would be inventing an action.
 *
 * Determinism
 *
 * The pass is a pure function of the rows, designed to be re-runnable: a
 * correlation that runs twice (a retried settle, a recovery path) writes the
 * same pairs. Pairing proceeds in trace order — for each CDP click, the
 * LATEST unmatched press in its window, which is also the closest (the window
 * admits only dt ≥ 0). Each row pairs at most once, so a double-click's two
 * reports cannot both claim one press, and a second click that arrives while
 * an earlier press is still unmatched (a slow button, a spam click) pairs
 * with the press that could actually have caused it.
 *
 * What it deliberately does not do: guess facts a row does not carry (a
 * report without `screenX`/`screenY`/`dpr` is uncorrelatable, not assumed to
 * be at dpr 1); pair across buttons (a right-click's coordinates prove
 * nothing about a left-click's); or "clean up" a stale `correlatedWithId`
 * (the write is idempotent, and nothing else writes the field).
 */

/** The number, milliseconds. Both endpoints inclusive — 150 is in. */
export const CORRELATION_WINDOW_MS = 150;

/**
 * How far apart two mapped positions may be and still be the same click.
 * See the module comment for the error budget that puts it at two pixels.
 */
export const CORRELATION_TOLERANCE_PX = 2;

/**
 * The button-mask bits that mean "a click button", as M3-BE-04 fixed them
 * (RFC 6143 §7.5.5; the wheel's buttons 4/5 are positionless and excluded).
 * The bit's index is the button the CDP report calls by number: bit 0 is the
 * left button, which a `click` event reports as `button: 0`.
 */
const CLICK_BUTTONS = 0b111;

/**
 * The half of a `RecordingEvent` this needs. Not the Prisma type: the
 * judgement must be drivable from a literal in a test, and from a database
 * row, without either growing a dependency on the other.
 */
export interface CorrelatorRow {
  readonly id: string;
  readonly tsOffsetMs: number;
  readonly layer: string;
  readonly type: string;
  readonly payload: unknown;
}

/** Two rows that are provably one action, on the two layers. */
export interface ClickPair {
  readonly x11Id: string;
  readonly cdpId: string;
}

/** One X11 button-down: the row, its position, and which button. */
interface Press {
  readonly id: string;
  readonly tsOffsetMs: number;
  readonly x: number;
  readonly y: number;
  /** Bit index of the pressed button (0 = left). */
  readonly button: number;
}

/**
 * Pair every X11 press with the CDP click it caused, where both facts agree.
 *
 * Pure, ordered only by `tsOffsetMs` (the trace's one order — stable for the
 * impossible tie, so the same rows always answer the same pairs), and
 * stateless: nothing here reads `correlatedWithId`, so the pass means the
 * same thing before and after a write. An empty list is a normal answer: an
 * X11-only recording, or one where no click was verifiable.
 */
export function correlateClicks(rows: readonly CorrelatorRow[]): readonly ClickPair[] {
  const ordered = [...rows].sort((a, b) => a.tsOffsetMs - b.tsOffsetMs);

  const presses = pressRowsOf(ordered);
  const pairs: ClickPair[] = [];
  const matched = new Set<string>();

  for (const row of ordered) {
    if (row.layer !== 'CDP' || row.type !== 'click') continue;
    const cdp = desktopClickOf(row.payload);
    if (cdp === null) continue;

    // The latest unmatched press this report could actually have followed.
    // Reverse order because the presses are already in time order: walking
    // backwards, `dt` only grows, so the first press inside the window is the
    // newest one — and once one press is too old, every older one is too.
    let chosen: Press | null = null;
    for (let index = presses.length - 1; index >= 0; index -= 1) {
      const press = presses[index]!;
      const dt = row.tsOffsetMs - press.tsOffsetMs;
      if (dt > CORRELATION_WINDOW_MS) break;
      if (dt < 0 || matched.has(press.id)) continue;
      if (Math.abs(press.x - cdp.x) > CORRELATION_TOLERANCE_PX) continue;
      if (Math.abs(press.y - cdp.y) > CORRELATION_TOLERANCE_PX) continue;
      // Only when both sides name a button: a report without one cannot
      // disagree, and the script always sends it for clicks.
      if (cdp.button !== null && cdp.button !== press.button) continue;
      chosen = press;
      break;
    }

    if (chosen !== null) {
      matched.add(chosen.id);
      pairs.push({ x11Id: chosen.id, cdpId: row.id });
    }
  }

  return pairs;
}

/**
 * Every X11 button-down in the trace, in order.
 *
 * The mask is read from every X11 pointer row — a held move carries the same
 * mask as its press, and skipping those would make the next pulse look like
 * one — and a press is a click bit that was 0 on the previous row and is 1
 * here. That is `isClickPress`'s rule from the live path,
 * re-derived from the trace: the coalescer emits both edges of every mask
 * change, so the sequence of rows preserves the sequence of transitions.
 */
function pressRowsOf(ordered: readonly CorrelatorRow[]): readonly Press[] {
  const presses: Press[] = [];
  let mask = 0;

  for (const row of ordered) {
    if (row.layer !== 'X11' || row.type !== 'pointer') continue;
    const payload = recordOf(row.payload);
    const next = payload?.['buttonMask'];
    if (typeof next !== 'number' || !Number.isInteger(next) || next < 0) continue;
    const pressed = next & ~mask & CLICK_BUTTONS;
    if (pressed !== 0) {
      const x = payload?.['x'];
      const y = payload?.['y'];
      if (finiteNumber(x) && finiteNumber(y)) {
        presses.push({
          id: row.id,
          tsOffsetMs: row.tsOffsetMs,
          x,
          y,
          button: lowestBitIndex(pressed),
        });
      }
    }
    mask = next;
  }

  return presses;
}

/** A CDP click's desktop position, or null when the row cannot answer. */
function desktopClickOf(payload: unknown): { x: number; y: number; button: number | null } | null {
  const record = recordOf(payload);
  if (record === null) return null;
  const screenX = record['screenX'];
  const screenY = record['screenY'];
  const dpr = record['dpr'];
  // All three, or nothing: a position without the ratio between CSS and
  // desktop pixels is a guess, and `dpr` is not optional even when it is 1.
  if (!finiteNumber(screenX) || !finiteNumber(screenY)) return null;
  if (!finiteNumber(dpr) || dpr <= 0) return null;
  const button = record['button'];
  return {
    x: Math.round(screenX * dpr),
    y: Math.round(screenY * dpr),
    button: finiteNumber(button) ? button : null,
  };
}

function recordOf(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const BIT_INDEXES = [0, 1, 2] as const;

/** The index of a mask's lowest set bit — the button that was pressed. */
function lowestBitIndex(mask: number): number {
  for (const index of BIT_INDEXES) {
    if ((mask & (1 << index)) !== 0) return index;
  }
  return 0;
}
