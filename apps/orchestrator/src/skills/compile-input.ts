/**
 * What the compiler shows the model (M3-BE-06; correlated folding M4-BE-06).
 *
 * "The model receives: the user's stated intent, the ordered event
 * trace (compact JSON, screenshots referenced by index), the sandbox
 * resolution, and up to 8 screenshot crops from the most ambiguous clicks."
 *
 * §6/M4 adds the other half: a click inside the browser is captured on two
 * layers, correlated into one action, and "the compiler must not
 * emit both" — so `foldCorrelated` collapses each pair before anything else
 * reads the rows, and the emission the model is told to write follows the
 * row it sees (a click carrying selectors is a Playwright call; raw input
 * stays a coordinate call). `constrainToResolver` sits between the fold and
 * the model: it keeps only candidate forms the shipped page resolver can
 * execute, and a click left without one falls back to its coordinates — so
 * "the emitted calls have something to run against" is a property of the
 * input too (M4-BE-06 fix wave).
 *
 * Pure, and separate from the service that runs the job, because everything
 * decided here — which crops, in what order, rendered how — is decided from
 * rows alone. A prompt built by a function that also needs Postgres, Redis and
 * a provider key is a prompt nobody can look at.
 */

/** "up to 8 screenshot crops". */
export const MAX_CROPS = 8;

/** The half of a `RecordingEvent` row this needs. Not the Prisma type: the
 * renderer must be drivable from a literal in a test. */
export interface TraceRow {
  /** The row id; the correlator's `correlatedWithId` names one of these. */
  readonly id?: string;
  readonly tsOffsetMs: number;
  readonly type: string;
  readonly payload: unknown;
  readonly screenshotKey: string | null;
  /** The capture layer the row was written on ("X11" / "CDP"), when known. */
  readonly layer?: string;
  /**
   * The correlation: the id of the row this one is the same physical
   * action as. Written on BOTH rows of a correlated click, and it is what
   * `foldCorrelated` consumes — see there for what "the same action" buys.
   */
  readonly correlatedWithId?: string | null;
}

/** A click whose crop is on disk, and where on screen it landed. */
export interface CropCandidate {
  readonly tsOffsetMs: number;
  readonly x: number;
  readonly y: number;
  readonly screenshotKey: string;
}

export interface ScreenSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * Which clicks the model gets a picture of.
 *
 * What "most ambiguous" is taken to mean
 *
 * §6 asks for "the most ambiguous clicks" and does not define ambiguity, so
 * this is a reading rather than a transcription. What the trace already says,
 * the model does not need a picture of: every click's coordinates are in the
 * trace, so a second crop of a region already shown is the one that adds
 * least. The eight are therefore chosen to be as UNLIKE each other as
 * possible — farthest-point selection, seeded from the first click.
 *
 * Two clicks count as different if they differ in EITHER where they landed or
 * when. That "either" is the whole point: the same button pressed ten minutes
 * apart is two different screens, because everything around it has changed,
 * while two clicks a second apart in the same menu are one screen photographed
 * twice.
 *
 * Why not simply the first eight
 *
 * Because a forty-click recording would show the model only its opening
 * seconds, and the compiler has to emit the whole task. Order in the trace is
 * not evidence of anything except order.
 */
export function selectCrops(
  candidates: readonly CropCandidate[],
  screen: ScreenSize,
  limit: number = MAX_CROPS,
): readonly CropCandidate[] {
  if (candidates.length === 0) return [];

  const diagonal = Math.hypot(Math.max(1, screen.widthPx), Math.max(1, screen.heightPx));
  const first = candidates[0]!;
  const last = candidates[candidates.length - 1]!;
  // Rows are read in `tsOffsetMs` order, so the span is the last minus the
  // first. Guarded: a recording whose clicks all land in the same millisecond
  // would otherwise divide by zero and make every pair infinitely far apart.
  const span = Math.max(1, last.tsOffsetMs - first.tsOffsetMs);

  const distance = (a: CropCandidate, b: CropCandidate): number =>
    Math.max(
      Math.hypot(a.x - b.x, a.y - b.y) / diagonal,
      Math.abs(a.tsOffsetMs - b.tsOffsetMs) / span,
    );

  // Seeded with the first click rather than an arbitrary one: a task's opening
  // move is the one the trace explains least, because nothing precedes it.
  const chosen: CropCandidate[] = [first];
  const rest = candidates.slice(1);
  // Distance from each remaining candidate to the NEAREST chosen one, kept
  // incrementally: recomputing it per round would be O(n²·k) for no benefit,
  // since adding a crop can only ever pull a candidate closer.
  const nearest = rest.map((candidate) => distance(candidate, first));

  while (chosen.length < limit) {
    let bestAt = -1;
    let bestDistance = -1;
    for (let i = 0; i < rest.length; i += 1) {
      const d = nearest[i]!;
      if (d > bestDistance) {
        bestDistance = d;
        bestAt = i;
      }
    }
    if (bestAt < 0) break;
    const picked = rest[bestAt]!;
    chosen.push(picked);
    rest.splice(bestAt, 1);
    nearest.splice(bestAt, 1);
    for (let i = 0; i < rest.length; i += 1) {
      nearest[i] = Math.min(nearest[i]!, distance(rest[i]!, picked));
    }
  }

  // Back into trace order. The model is reading a sequence of events, and a
  // list of images ordered by how they were chosen would put step nine's
  // picture before step two's.
  return chosen.sort((a, b) => a.tsOffsetMs - b.tsOffsetMs);
}

/**
 * Pull the crop candidates out of a trace.
 *
 * A row qualifies when M3-BE-04 stored an image for it, which is exactly the
 * button-downs — the key is null everywhere else. Coordinates come from the
 * payload the same coalescer wrote, and a row whose payload does not carry a
 * pair of numbers is skipped rather than guessed at: it would place a picture
 * at a point on screen that nothing clicked.
 */
export function cropCandidatesOf(rows: readonly TraceRow[]): readonly CropCandidate[] {
  const candidates: CropCandidate[] = [];
  for (const row of rows) {
    if (row.screenshotKey === null) continue;
    const payload = flattenedFields(row.payload);
    if (payload === null) continue;
    const x = payload['x'];
    const y = payload['y'];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    candidates.push({ tsOffsetMs: row.tsOffsetMs, x, y, screenshotKey: row.screenshotKey });
  }
  return candidates;
}

/**
 * Fold every correlated X11+CDP pair into the one action it is.
 *
 * "an X11 click within 150 ms of a CDP click at the same coordinates
 * is the same action. Write `correlatedWithId` on both rows. The compiler
 * must not emit both." the correlator proved WHICH press and which
 * page report are one action; this function is where that proof becomes
 * form. The model is shown the action once, so "never both layers" is a
 * property of what it reads rather than a rule it is trusted to obey — a
 * pair rendered as two rows is exactly the input that produces a script which
 * coordinate-clicks and Playwright-clicks the same spot.
 *
 * Which row survives, and where it sits
 *
 * The merged row is the CDP report, enriched with the press's desktop
 * position: the report carries the DOM identity (`candidates`) the script
 * needs to name the element, and the press carries where the click landed
 * (`x`/`y`) plus the screenshot crop, when one was taken. It keeps the
 * EARLIER of the two rows' offsets — in practice the press's, since a report
 * cannot precede the press it describes. The report is later evidence of an
 * action that already happened; stamped with the report's time, a merged row
 * would replay after everything that happened in between.
 *
 * What counts as a pair
 *
 * Only the shape the correlator writes, and only when BOTH sides name each
 * other: an X11 `pointer` row and a CDP `click` row whose `correlatedWithId`
 * point at each other, the press carrying a usable position. Anything less —
 * one side missing, a reference into a row that does not exist, a row already
 * consumed by another fold, a press with no `x`/`y` — is rendered exactly as
 * captured. The merge is a claim about two rows; where the claim cannot be
 * checked against the rows themselves the trace keeps BOTH, because a silently
 * dropped row is an action the skill can never reproduce.
 *
 * Pure and re-runnable: same rows in, same order out, and idempotent — the
 * folded row carries no correlation fields, so folding the output again is a
 * no-op.
 */
export function foldCorrelated(rows: readonly TraceRow[]): readonly TraceRow[] {
  // Ordered by the trace's one order (offsets are strictly increasing by
  // construction; this sort is the same convention the correlator applies, so
  // the two agree about what happened).
  const ordered = [...rows].sort((a, b) => a.tsOffsetMs - b.tsOffsetMs);

  const byId = new Map<string, TraceRow>();
  for (const row of ordered) {
    if (row.id !== undefined) byId.set(row.id, row);
  }

  const consumed = new Set<string>();
  const out: TraceRow[] = [];
  for (const row of ordered) {
    if (row.id !== undefined && consumed.has(row.id)) continue;
    const pair = correlatedPairAt(row, byId, consumed);
    if (pair === null) {
      out.push(row);
      continue;
    }
    out.push(mergePair(pair));
    // BOTH ids are consumed, not only the report's: it keeps the fold total
    // even for an ordering the correlator cannot produce (a report sorted
    // before its press), where the pair is merged at whichever row came
    // first and the other must not leak through as a second step.
    consumed.add(pair.press.id ?? '');
    consumed.add(pair.report.id ?? '');
  }
  return out;
}

/** The two rows of one correlated click, identified by their roles, with the
 * press's validated position carried alongside so the merge needs no re-check. */
interface CorrelatedPair {
  readonly press: TraceRow;
  readonly report: TraceRow;
  readonly position: { readonly x: number; readonly y: number };
}

/**
 * The pair `row` belongs to, when it is `row`'s first member in trace order.
 *
 * Called as the fold walks the trace, so a pair is built once — at whichever
 * of its rows comes first — and the second member is skipped through the
 * consumed set. Validation is in the caller's terms: mutual references, the
 * two known types, one on each side, and a press that carries a usable
 * position.
 */
function correlatedPairAt(
  row: TraceRow,
  byId: ReadonlyMap<string, TraceRow>,
  consumed: ReadonlySet<string>,
): CorrelatedPair | null {
  const rowId = row.id;
  const partnerId = row.correlatedWithId;
  if (rowId === undefined || partnerId === undefined || partnerId === null) return null;
  const partner = byId.get(partnerId);
  if (partner === undefined || partner.id === undefined) return null;
  if (partner.correlatedWithId !== rowId) return null;
  if (consumed.has(partner.id)) return null;

  const press = row.type === 'pointer' ? row : partner.type === 'pointer' ? partner : null;
  const report = row.type === 'click' ? row : partner.type === 'click' ? partner : null;
  if (press === null || report === null || press === report) return null;
  const position = positionOf(press);
  if (position === null) return null;

  return { press, report, position };
}

/** The press's desktop position, or null when the row cannot answer. */
function positionOf(press: TraceRow): { readonly x: number; readonly y: number } | null {
  const payload = flattenedFields(press.payload);
  if (payload === null) return null;
  const x = payload['x'];
  const y = payload['y'];
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * The one row a pair becomes: the page's report, plus where the click landed.
 *
 * The report's fields all survive — the model reads the page's own story —
 * and the press contributes `x`/`y` (the desktop position every other
 * coordinate in the trace is expressed in) and its crop origin, when the
 * click's picture exists (D-043; `renderTrace` still drops the origin on a
 * crop nobody is shown). The `screenshotKey` travels with the press because
 * that is the row the capture hung the crop on.
 */
function mergePair(pair: CorrelatedPair): TraceRow {
  const report = flattenedFields(pair.report.payload) ?? {};
  const payload: Record<string, unknown> = { ...report, x: pair.position.x, y: pair.position.y };
  const press = flattenedFields(pair.press.payload) ?? {};
  for (const key of ['cropX', 'cropY']) {
    const value = press[key];
    if (typeof value === 'number') payload[key] = value;
  }
  return {
    tsOffsetMs: Math.min(pair.press.tsOffsetMs, pair.report.tsOffsetMs),
    // The CDP name: it IS a click, and one the page itself saw, so it carries
    // a DOM identity the compiler can emit a Playwright call from.
    type: pair.report.type,
    payload,
    screenshotKey: pair.press.screenshotKey,
  };
}

/** The keys `renderTrace` writes itself; a payload may not take one over. */
function isRenderedKey(key: string): boolean {
  return key === 'ms' || key === 'type' || key === 'screenshot';
}

/**
 * Recording candidates carry main-frame, root-local CSS evidence. The recorder's
 * text uniqueness uses a different matcher from Playwright; a shadow-root rung
 * does not identify its host. Keep those coordinate fallbacks until capture can
 * prove a full path and native selector uniqueness. The runtime can execute native
 * text and explicit frame selectors in reviewed scripts without inventing them
 * from incomplete recording evidence.
 */
const RESOLVER_SAFE_KINDS: readonly string[] = ['testid', 'id', 'aria', 'css'];

function isResolverCandidate(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !RESOLVER_SAFE_KINDS.includes(kind)) return false;
  const selector = record['selector'];
  if (typeof selector !== 'string' || selector.length === 0) return false;
  return record['shadow'] !== true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Preserve raw rows; constrain only the compiler's view and retain real coordinates. */
export function constrainToResolver(rows: readonly TraceRow[]): readonly TraceRow[] {
  return rows.map((row) => constrainRow(row));
}

function constrainRow(row: TraceRow): TraceRow {
  const payload = flattenedFields(row.payload);
  if (payload === null) return row;

  const candidates = payload['candidates'];
  const list = Array.isArray(candidates) ? candidates : null;
  const kept = list === null ? null : list.filter(isResolverCandidate);
  const dropped = list !== null && kept !== null && kept.length !== list.length;
  const cleared = kept !== null && kept.length === 0;

  // The fallback: a click the page reported, with nothing left that names
  // its element, is still an action the skill must reproduce — from the
  // position both layers agree on.
  const promoted =
    row.type === 'click' &&
    (cleared || kept === null) &&
    !(isFiniteNumber(payload['x']) && isFiniteNumber(payload['y']))
      ? desktopPositionOf(payload)
      : null;

  if (!dropped && !cleared && promoted === null) return row;

  const next: Record<string, unknown> = { ...payload };
  if (cleared) delete next['candidates'];
  else if (dropped) next['candidates'] = kept;
  if (promoted !== null) {
    next['x'] = promoted.x;
    next['y'] = promoted.y;
  }
  return { ...row, payload: next };
}

/**
 * A page report's position in the pixels the rest of the trace is written in,
 * or null when the row cannot answer.
 *
 * `screenX`/`screenY` are CSS pixels and the trace's `x`/`y` are framebuffer
 * pixels; `dpr` is the ratio between them. This is the same conversion, with
 * the same rounding, that `click-correlator.ts` matches a report against an
 * X11 press by — and it takes all three or nothing for that module's stated
 * reason: a position without the ratio is a guess, and `dpr` is not optional
 * even when it is 1. Writing the CSS pixels straight onto `x`/`y` would put
 * the fallback click where it belongs only on a 1:1 display and silently
 * elsewhere on any other — the wrong click that reports success, which is
 * what this whole fence exists to prevent. A report that cannot be converted
 * keeps its own fields and asserts no position: a missing coordinate is a
 * step the model cannot write, while a wrong one is a step that runs.
 */
function desktopPositionOf(
  payload: Record<string, unknown>,
): { readonly x: number; readonly y: number } | null {
  const screenX = payload['screenX'];
  const screenY = payload['screenY'];
  const dpr = payload['dpr'];
  if (!isFiniteNumber(screenX) || !isFiniteNumber(screenY)) return null;
  if (!isFiniteNumber(dpr) || dpr <= 0) return null;
  return { x: Math.round(screenX * dpr), y: Math.round(screenY * dpr) };
}

/**
 * The payload's own fields, when the renderer may write them flat on the line.
 *
 * Why structured values flatten under their own name
 *
 * M3 kept every non-scalar payload nested — correct while every payload the
 * pipeline wrote was flat. M4 widened them: a browser interaction
 * carries `candidates`, the selector ladder, and that is the ONE field the
 * whole M4 compile exists to read. Nesting it (the M3 rule) would render
 * every browser click as `{"ms":100,"type":"click","payload":{…15 fields…}}`,
 * spending tokens on a word the model must navigate to find the single fact
 * it acts on, while §6/M3 asks for "compact JSON". So a structured value
 * flattens too, under its own name — as itself, nothing dropped.
 *
 * The reserved keys still win: a payload carrying `ms`, `type` or
 * `screenshot` nests WHOLE rather than partially, because a half-flat line
 * could not carry both readings honestly — and `type` is exactly the field
 * name a CDP report might otherwise smuggle over the event kind the sequence
 * is read by.
 */
function flattenedFields(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>));
}

/**
 * The trace, as the compact JSON §6 asks for: one object per line.
 *
 * Why the payload is flattened
 *
 * `{"ms":0,"type":"pointer","x":640,"y":400,"buttonMask":1}` rather than
 * nesting the payload under its own key. At the 5000-event ceiling the
 * difference is tens of thousands of tokens spent on the word "payload", and
 * the model is being asked to read a sequence, not to navigate a structure.
 * A payload that is not an object at all is kept nested instead; a payload
 * whose keys would overwrite the renderer's own three is kept nested too (see
 * `flattenedFields`).
 *
 * WHY `cropX`/`cropY` SURVIVE ONLY ON A SHOWN CLICK
 *
 * They exist to locate the click inside its own crop. On a
 * click whose crop was not selected they answer a question nobody can ask,
 * and there are up to 5000 of those.
 */
export function renderTrace(rows: readonly TraceRow[], shown: readonly CropCandidate[]): string {
  const indexByKey = new Map<string, number>();
  shown.forEach((candidate, index) => indexByKey.set(candidate.screenshotKey, index));

  const lines: string[] = [];
  let moves: TraceRow[] = [];
  const flushMoves = () => {
    if (moves.length === 1) {
      const row = moves[0]!;
      lines.push(
        JSON.stringify({ ms: row.tsOffsetMs, type: row.type, ...flattenedFields(row.payload) }),
      );
    } else if (moves.length > 1) {
      // Prompt-only, lossless packing: keep every position and timestamp for
      // hover interpretation without repeating four JSON keys per sample.
      lines.push(
        JSON.stringify({
          ms: moves[0]!.tsOffsetMs,
          type: 'pointer-path',
          points: moves.map((row) => {
            const payload = flattenedFields(row.payload)!;
            return [row.tsOffsetMs, payload['x'], payload['y']];
          }),
        }),
      );
    }
    moves = [];
  };
  let lastButtonMask = 0;
  for (const row of rows) {
    const fields = flattenedFields(row.payload);
    const mask = fields?.['buttonMask'];
    const isFreeMove =
      row.type === 'pointer' &&
      mask === 0 &&
      lastButtonMask === 0 &&
      row.screenshotKey === null &&
      fields !== null &&
      Object.keys(fields).every((key) => ['x', 'y', 'buttonMask'].includes(key)) &&
      isFiniteNumber(fields['x']) &&
      isFiniteNumber(fields['y']);
    if (row.type === 'pointer' && typeof mask === 'number') lastButtonMask = mask;
    // Folding a CDP click consumes its X11 press. Treat the following zero
    // mask as its release rather than folding it into a mouse-movement run.
    if (row.type === 'click') lastButtonMask = 1;
    if (isFreeMove) {
      moves.push(row);
      if (moves.length === 64) flushMoves();
      continue;
    }
    flushMoves();
    const shownAt = row.screenshotKey === null ? undefined : indexByKey.get(row.screenshotKey);
    const line: Record<string, unknown> = { ms: row.tsOffsetMs, type: row.type };
    const payload = flattenedFields(row.payload);
    if (payload === null || Object.keys(payload).some(isRenderedKey)) {
      line['payload'] = row.payload;
    } else {
      for (const [key, value] of Object.entries(payload)) {
        if (shownAt === undefined && (key === 'cropX' || key === 'cropY')) continue;
        line[key] = value;
      }
    }
    if (shownAt !== undefined) line['screenshot'] = shownAt;
    lines.push(JSON.stringify(line));
  }
  flushMoves();
  return lines.join('\n');
}
