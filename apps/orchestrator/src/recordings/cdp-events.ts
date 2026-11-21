/**
 * The CDP capture vocabulary, and the parser for what the page reports
 * (M4-BE-02).
 *
 * The report crosses a trust boundary
 *
 * §6/M4's capture script is injected into the sandbox's browser, and the
 * sandbox is the untrusted side of this process. The binding the
 * script reports over is callable by ANY script on the page: the page's own
 * code can invoke it with whatever JSON it likes, and so can whatever site the
 * operator visits. A report is therefore a value to inspect, never a shape to
 * assume — `parseCaptureReport` is the only way one reaches the trace, and it
 * returns null for anything that does not survive field-by-field validation.
 *
 * Why the bounds live here and not in the script
 *
 * The script truncates before it sends (it must: an unbounded string would be
 * serialised in the page, on the interaction path), and the parser truncates
 * again after parsing. Both read the same constants — the script's are passed
 * to it in its injected options, built from this module. One source for both
 * is what keeps "what the page sends" and "what the trace accepts" from
 * drifting apart, and the parser does not trust that the script ran at all.
 *
 * Selector candidates
 *
 * A report may also carry `candidates`: the selector ladder's rungs for the
 * element the interaction landed on, in priority order, each with the
 * uniqueness the page saw at that moment. They are the one structured value
 * a payload field holds, and they get the same treatment as every scalar —
 * validated entry by entry against a closed vocabulary and bounded lengths.
 * One asymmetry is deliberate: a scalar past its ceiling is truncated, while
 * a selector past its ceiling is DROPPED, because truncating a selector does
 * not shorten it, it points it somewhere else.
 */

/**
 * The four interactions §6/M4 fixes, verbatim: "listening for `click`,
 * `input`, `change`, and `submit` in the capture phase".
 *
 * The vocabulary is closed on this side: a report naming anything else is
 * dropped rather than stored, because `RecordingEvent.type` is read by the
 * compiler and an unknown type is a sentence the model has no schema for.
 */
export const CDP_EVENT_TYPES = ['click', 'input', 'change', 'submit'] as const;

export type CdpEventType = (typeof CDP_EVENT_TYPES)[number];

/**
 * Ceilings on what one report may contribute to a row's payload.
 *
 * Sized so a real page never notices them and a hostile one cannot make the
 * trace expensive: attributes are identifiers, `text` is a human-matchable
 * snippet, `value` is a form field's contents (a password's is never sent at
 * all — see the script), `url` is long enough for a real address with a
 * query string, and `selector` is long enough for a deep CSS path or an
 * attribute form an id needed escaping into. A whole report still fits its
 * own ceiling — `CDP_MAX_REPORT_CHARS` — with five candidates at this size.
 */
export const CDP_PAYLOAD_LIMITS = {
  url: 512,
  attribute: 120,
  text: 120,
  value: 200,
  selector: 240,
} as const;

/**
 * The selector ladder's stages, in priority order: `data-testid` →
 * `id` → `aria-label` + role → the shortest unique CSS path → a text match.
 *
 * Closed vocabulary, like the event types and for the same reason: a
 * candidate's kind is what a compiler or a resolver switches on, and a kind
 * nobody defined is a branch neither of them can take.
 */
export const CDP_SELECTOR_KINDS = ['testid', 'id', 'aria', 'css', 'text'] as const;

export type CdpSelectorKind = (typeof CDP_SELECTOR_KINDS)[number];

/** One rung of the ladder, as the page reported it.
 *
 * A type alias, not an interface, on purpose: values of this shape land in a
 * Prisma `Json` column through `TracePayload`, and Prisma's input types are
 * index-signature shapes that only object-literal aliases satisfy — an
 * interface would be rejected at the write site for having no index
 * signature, not for being wrong.
 */
export type CdpSelectorCandidate = {
  readonly kind: CdpSelectorKind;
  readonly selector: string;
  /**
   * Whether the selector matched exactly one element in the page at the
   * moment of the interaction. A fact about an instant, not a promise; a
   * non-unique candidate is kept rather than dropped, because it says the
   * name exists and is shared, which is more than its absence would.
   */
  readonly unique: boolean;
  /**
   * True when the rung was generated against a shadow root rather than the
   * document (M4-BE-06 fix wave). It is the one fact that says the selector
   * cannot cross the shadow boundary into the replayer's document-level
   * resolver; the compile fence drops these before a step can be emitted
   * from one. Absent on ordinary document-scoped rungs, so nothing changes
   * for them.
   */
  readonly shadow?: boolean;
};

/**
 * Any value one payload field may hold.
 *
 * Core facts are scalars; a CDP row may additionally carry the selector
 * candidates, the one structured value any layer writes. Everything that
 * stores or forwards a payload treats it opaquely — the compiler's trace
 * renderer already keeps a non-scalar payload nested rather than pretending
 * to flatten it, which is what lets this widen without a rewrite
 * there.
 */
export type CdpPayloadValue = number | boolean | string | readonly CdpSelectorCandidate[];

/** The payload of one trace row written from a capture report. */
export type TracePayload = Readonly<Record<string, CdpPayloadValue>>;

/**
 * The ceiling on a whole report, checked before `JSON.parse` runs.
 *
 * Everything the script sends fits in well under a kilobyte; this is the
 * bound on what a page can make this process parse per binding call, and
 * `JSON.parse` is the only unbounded-cost operation on the path that does not
 * need the event loop to cooperate.
 */
export const CDP_MAX_REPORT_CHARS = 4096;

/**
 * Every `type` the CDP layer may write to the trace: the four interactions
 * §6/M4 fixes plus the two navigation rows §6/M4 asks for beside
 * them (M4-BE-04, `cdp-nav-events.ts`).
 *
 * The union is the trace's vocabulary, not a second entry point. The four
 * interactions are closed on the page-authored side — `parseCaptureReport`
 * returns only those, so a page cannot report a navigation it did not
 * perform, and a test pins that — while the navigation rows are written only
 * from protocol events by their own parser. Widen this line with a parser
 * that earns the type, and with the docker suite that re-proves it.
 */
export type CdpTraceType = CdpEventType | 'navigate' | 'load';

/** One validated report: the event's name, and the facts that go on its row. */
export interface CapturedCdpEvent {
  readonly type: CdpTraceType;
  /**
   * Flat, primitive, and sparse — the shape M3-BE-01's rows already use, for
   * the same reasons: the compiler reads this as JSON, and a field that is
   * absent is a fact the event did not carry rather than a null to interpret.
   * The candidates are the one exception: a list of validated records rather
   * than a scalar fact.
   */
  readonly payload: TracePayload;
}

/** String facts and the ceiling each is truncated to. */
const STRING_FIELDS = {
  url: CDP_PAYLOAD_LIMITS.url,
  tag: CDP_PAYLOAD_LIMITS.attribute,
  id: CDP_PAYLOAD_LIMITS.attribute,
  testid: CDP_PAYLOAD_LIMITS.attribute,
  ariaLabel: CDP_PAYLOAD_LIMITS.attribute,
  role: CDP_PAYLOAD_LIMITS.attribute,
  name: CDP_PAYLOAD_LIMITS.attribute,
  inputType: CDP_PAYLOAD_LIMITS.attribute,
  text: CDP_PAYLOAD_LIMITS.text,
  value: CDP_PAYLOAD_LIMITS.value,
} as const;

/**
 * Numeric facts, rounded to whole pixels.
 *
 * Rounded because these are compared against X11 coordinates, and
 * those are integers by construction; a click reported at 640.4 px is a click
 * at 640, and keeping the fraction would only make two equal clicks differ.
 */
const INTEGER_FIELDS = [
  'clientX',
  'clientY',
  'pageX',
  'pageY',
  'button',
  'screenX',
  'screenY',
  'scrollX',
  'scrollY',
] as const;

/** Boolean facts. `checked` is the one a checkbox/radio's `change` carries. */
const BOOLEAN_FIELDS = ['checked'] as const;

/**
 * Parse one `Runtime.bindingCalled` payload into an event, or null.
 *
 * Null is not an error path with a log — the reporter is the page, and a page
 * invoking the binding with junk is a page doing what pages may do. The call
 * site counts nothing and rethrows nothing; the report is simply not evidence.
 */
export function parseCaptureReport(raw: string): CapturedCdpEvent | null {
  if (raw.length > CDP_MAX_REPORT_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const report = parsed as Record<string, unknown>;

  const type = report['type'];
  if (typeof type !== 'string' || !isCdpEventType(type)) return null;

  const payload: Record<string, CdpPayloadValue> = {};
  for (const [key, limit] of Object.entries(STRING_FIELDS)) {
    takeString(report, key, limit, payload);
  }
  for (const key of INTEGER_FIELDS) takeInteger(report, key, payload);
  for (const key of BOOLEAN_FIELDS) takeBoolean(report, key, payload);
  // `dpr` is the one fact that is not a pixel: it is a ratio, and rounding it
  // to 1 or 2 would make a 150%-scaled page and a 100%-scaled one lie in the
  // same direction.
  takeRatio(report, 'dpr', payload);
  takeCandidates(report, payload);

  return { type, payload };
}

function isCdpEventType(value: string): value is CdpEventType {
  return (CDP_EVENT_TYPES as readonly string[]).includes(value);
}

function isSelectorKind(value: string): value is CdpSelectorKind {
  return (CDP_SELECTOR_KINDS as readonly string[]).includes(value);
}

/**
 * The selector candidates, entry by entry, or nothing.
 *
 * A list longer than the ladder has rungs did not come from the ladder — the
 * script can emit five kinds at most — so it is dropped whole rather than
 * capped: a page adding "more candidates" is trying to say something the
 * vocabulary cannot. Within a correctly-sized list each entry stands or falls
 * alone, and an entry whose selector is past the ceiling is dropped rather
 * than truncated, because truncating a selector points it somewhere else.
 */
function takeCandidates(
  report: Record<string, unknown>,
  payload: Record<string, CdpPayloadValue>,
): void {
  const value = report['candidates'];
  if (!Array.isArray(value) || value.length === 0) return;
  if (value.length > CDP_SELECTOR_KINDS.length) return;
  const kept: CdpSelectorCandidate[] = [];
  for (const entry of value) {
    const candidate = candidateOf(entry);
    if (candidate !== null) kept.push(candidate);
  }
  if (kept.length > 0) payload['candidates'] = kept;
}

function candidateOf(entry: unknown): CdpSelectorCandidate | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !isSelectorKind(kind)) return null;
  const selector = record['selector'];
  if (
    typeof selector !== 'string' ||
    selector.length === 0 ||
    selector.length > CDP_PAYLOAD_LIMITS.selector
  ) {
    return null;
  }
  const unique = record['unique'];
  if (typeof unique !== 'boolean') return null;
  // `shadow` (M4-BE-06 fix wave) is optional and strict: present, it must be
  // a boolean, and only the true form is stored — a rung is either shadow-
  // scoped or ordinary, and absence is how the ordinary one is spelled.
  const shadow = record['shadow'];
  if (shadow !== undefined && typeof shadow !== 'boolean') return null;
  return shadow === true ? { kind, selector, unique, shadow: true } : { kind, selector, unique };
}

function takeString(
  report: Record<string, unknown>,
  key: string,
  limit: number,
  payload: Record<string, CdpPayloadValue>,
): void {
  const value = report[key];
  if (typeof value !== 'string' || value.length === 0) return;
  payload[key] = value.length > limit ? value.slice(0, limit) : value;
}

function takeInteger(
  report: Record<string, unknown>,
  key: string,
  payload: Record<string, CdpPayloadValue>,
): void {
  const value = report[key];
  // `Number.isFinite` rejects the forms JSON can carry but a sensor cannot:
  // `1e999` parses to Infinity, and a coordinate of Infinity would sort
  // nonsense into the trace the correlator reads.
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  payload[key] = Math.round(value);
}

function takeBoolean(
  report: Record<string, unknown>,
  key: string,
  payload: Record<string, CdpPayloadValue>,
): void {
  const value = report[key];
  if (typeof value === 'boolean') payload[key] = value;
}

function takeRatio(
  report: Record<string, unknown>,
  key: string,
  payload: Record<string, CdpPayloadValue>,
): void {
  const value = report[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
  payload[key] = value;
}
