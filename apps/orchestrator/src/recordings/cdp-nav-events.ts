/**
 * The navigation rows of the trace — what the page did to itself, as opposed
 * to what the operator did to it.
 *
 * "Also record `Page.frameNavigated` and `Network.loadingFinished` so
 * the compiler can emit real wait conditions." A wait condition is a promise
 * about the PAGE — `page.waitForLoadState` — so the two events are recorded
 * as the one pair they are: a `navigate` row when a main-frame document
 * commits, a `load` row when that document's own network load finishes. The
 * compiler sees the pair sitting between two interactions and can spend it
 * on a real wait instead of the coordinate-blind delay §6/M4 forbids.
 *
 * Why main-frame documents and nothing else
 *
 * `Page.frameNavigated` fires for every frame that commits a document, and
 * `Network.loadingFinished` fires for EVERY request — images, fonts, XHRs, a
 * favicon. Recorded verbatim they would be both noise and a lie:
 * `waitForLoadState` waits on the page's main frame, so a subframe's document
 * load is not a condition the compiler could honestly emit from it. The
 * filter is definitional, not heuristic. A top-level frame is a frame with no
 * `parentId` (probe against Chrome 152: subframes always carry it), and a
 * finished request is a document load exactly when the request that carried
 * it was one — which `requestWillBeSent` says and `loadingFinished`
 * deliberately does not. That event carries a `requestId` and nothing else
 * about identity, and the probe caught a subframe and a favicon completing
 * between a navigation and its own load on a fixture as simple as this one;
 * "the first completion after a navigation" would have mispaired immediately.
 *
 * Why the pairing is state
 *
 * So each page session keeps a small map of the DOCUMENT requests it has seen
 * (`requestWillBeSent` with `type: 'Document'`), keyed by the `requestId` the
 * completion will arrive under. A `load` row is emitted for a completion only
 * when its request's frame is the session's main frame, which is also what
 * keeps an iframe's navigation out of the trace even though its request
 * passed through the same map. The map is bounded by
 * `MAX_TRACKED_DOCUMENT_REQUESTS`: nothing else prunes it (a cancelled
 * request never produces the completion that would), and a page must not be
 * able to grow this process's memory with document loads it never finishes.
 *
 * The state is an explicit value rather than module scope — same reason as
 * `InputCoalescer`: one recording's pairing must not be another
 * recording's, and the service keeps one per page session.
 *
 * The trust boundary
 *
 * These params arrive over the same socket as everything else, from Chrome
 * inside the sandbox — the untrusted side of the connection.
 * Nothing here trusts a shape: every field is read, type-checked and bounded
 * before it is stored or becomes a row, an unbounded string is dropped rather
 * than kept as a lookup key, and every failure path is a dropped event, never
 * a throw. The callers are WebSocket frames, and a recorder that can be
 * crashed by what it observes is not a recorder.
 */

import { CDP_PAYLOAD_LIMITS, type CapturedCdpEvent } from './cdp-events.js';

/**
 * The two row types this module writes.
 *
 * `navigate` is the trace's own word for a committed document — the example
 * vocabulary names it — and `load` is its completion, distinguished from the
 * other layer's rows by the CDP layer it is written under.
 */
export const NAV_TRACE_TYPES = ['navigate', 'load'] as const;

/** How many document requests one page session may remember as loading. */
export const MAX_TRACKED_DOCUMENT_REQUESTS = 64;

/**
 * A protocol string this module is willing to use as a lookup key — a frame
 * id, a request id — or null.
 *
 * Bounded because the peer is untrusted: real ids are tens of characters,
 * and a value too long for any of them is a value that is not one. Dropped
 * rather than truncated, because a truncated key collides with the real key
 * it was cut from — two different frames would share a main-frame judgement.
 */
const MAX_TOKEN_CHARS = 128;

/** One request whose completion would be a `load` row, while it is still loading. */
interface TrackedDocument {
  /** The frame the document belongs to; only the main frame's becomes a row. */
  readonly frameId: string;
  /** The URL of the most recent hop — a redirect resends under the same requestId. */
  readonly url: string;
}

/**
 * What one page session must remember between events.
 *
 * `mainFrames` holds the ids of frames seen committing without a parent, and
 * `documents` the document requests in flight. A page target's main frame id
 * is stable across its navigations, so in practice `mainFrames` holds exactly
 * one id — the set is a set because "every top-level frame" is what the
 * protocol says, not "the one we remember".
 */
export interface NavPairingState {
  readonly mainFrames: Set<string>;
  readonly documents: Map<string, TrackedDocument>;
}

export function createNavPairingState(): NavPairingState {
  return { mainFrames: new Set(), documents: new Map() };
}

/**
 * `Page.frameNavigated` → the `navigate` row it earns, or null.
 *
 * Null for a subframe (`parentId` present) and for a commit that carried no
 * address at all — a row the compiler could not pair with its load, or act
 * on, is not evidence. The main frame id is remembered whether or not the
 * row is emitted, because it is the key this session's later completions are
 * judged against — and the commit always precedes its own completion on the
 * wire (probe: `frameNavigated` then `loadingFinished`), so it is remembered
 * in time.
 */
export function noteFrameNavigated(
  state: NavPairingState,
  params: Record<string, unknown>,
): CapturedCdpEvent | null {
  const frame = asRecord(params['frame']);
  if (frame === null) return null;
  if (readToken(frame['parentId']) !== null) return null;
  const frameId = readToken(frame['id']);
  if (frameId === null) return null;

  // An error page commits with an empty `url` and the address that failed in
  // `unreachableUrl`; the address is what the compiler can read and pair, and
  // a navigation is a thing the operator did whether or not it landed.
  const url = readUrl(frame['url']) ?? readUrl(frame['unreachableUrl']);
  if (url === null) return null;

  // Remembered only now: a commit that earns no row is not evidence of which
  // frame is the page's, either — and the commit always precedes its own
  // completion on the wire (probe: `frameNavigated` then `loadingFinished`),
  // so it is remembered in time for the pair.
  state.mainFrames.add(frameId);
  return { type: 'navigate', payload: { url } };
}

/**
 * `Network.requestWillBeSent` → the pairing map, or nothing.
 *
 * No row: this event is the pairing mechanism, not evidence the compiler
 * reads. Only `type: 'Document'` requests are remembered — every other
 * request's completion could never become a row — and both halves of the
 * filter are needed, neither sufficient alone. This side says which
 * requestId carries a document; `takeDocumentLoadFinished` says which frames
 * are the page's. A subframe's document passes through here and is dropped
 * there, which is exactly what keeps an iframe's navigation out of the trace.
 */
export function noteDocumentRequest(state: NavPairingState, params: Record<string, unknown>): void {
  if (params['type'] !== 'Document') return;
  const requestId = readToken(params['requestId']);
  const frameId = readToken(params['frameId']);
  const request = asRecord(params['request']);
  const url = request === null ? null : readUrl(request['url']);
  if (requestId === null || frameId === null || url === null) return;

  // A redirect resends the same requestId with the next hop's URL; the hop
  // that lands is the one the completion belongs to. Re-setting also keeps
  // the entry newest for the eviction below.
  state.documents.delete(requestId);
  state.documents.set(requestId, { frameId, url });

  // Oldest first: the newest entries are the ones a completion can still
  // arrive for, and a page that opens document loads it never finishes must
  // not grow this map without bound.
  while (state.documents.size > MAX_TRACKED_DOCUMENT_REQUESTS) {
    const oldest = state.documents.keys().next().value;
    if (oldest === undefined) break;
    state.documents.delete(oldest);
  }
}

/**
 * `Network.loadingFinished` → the `load` row it earns, or null.
 *
 * The lookup consumes the tracked request — a completion is the last event a
 * request ever produces — so the same id cannot earn two rows. A completion
 * whose request was never seen as a document, or whose document belongs to a
 * subframe, earns nothing: the event alone cannot tell the page's own load
 * from the hundredth image, and guessing would put wait conditions in the
 * trace that the recording never performed.
 */
export function takeDocumentLoadFinished(
  state: NavPairingState,
  params: Record<string, unknown>,
): CapturedCdpEvent | null {
  const requestId = readToken(params['requestId']);
  if (requestId === null) return null;
  const document = state.documents.get(requestId);
  if (document === undefined) return null;
  state.documents.delete(requestId);
  if (!state.mainFrames.has(document.frameId)) return null;
  return { type: 'load', payload: { url: document.url } };
}

/** A URL fact, clamped to the trace's shared ceiling. */
function readUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > CDP_PAYLOAD_LIMITS.url ? value.slice(0, CDP_PAYLOAD_LIMITS.url) : value;
}

/** A protocol string fit to be a lookup key, or null. */
function readToken(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOKEN_CHARS)
    return null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
