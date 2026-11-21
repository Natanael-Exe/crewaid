import type { RfbInputEvent } from '../screen/rfb-input.js';
import { combiningModifier, isAppliedModifier, keyCombo, typedText } from './keysyms.js';

/** The half of `RfbInputEvent` that carries a cursor position. */
type RfbPointerEvent = Extract<RfbInputEvent, { kind: 'pointer' }>;

/**
 * The X11 capture vocabulary, its ordering rule, and the two coalescers
 * PRD §6/M3 defines over it.
 *
 * Pure on purpose: everything here is decided per event from an arrival time
 * the caller supplies, with no clock, no database and no service — which is
 * what lets a burst that would take three real seconds, or a modifier combo
 * that needs four events to express, be a fixture rather than a live tee.
 */

/** What one validated §4.3 input event becomes in `RecordingEvent`. */
export interface CapturedX11Event {
  /** `RecordingEvent.type` — open by design. */
  readonly type: X11EventType;
  readonly payload: Readonly<Record<string, number | boolean | string>>;
}

/**
 * What a captured event is called.
 *
 * `pointer` stays deliberately raw. §4.3 forwards exactly two client message
 * types, and naming a button-down a `click` here would mean guessing at a
 * boundary the raw stream does not contain: the NEXT event decides whether it
 * was a click or the start of a drag. M3-BE-06 is what reads a press-and-
 * release pair as a click.
 *
 * `key` and `type` are not raw, and that is the whole job. §6 fixes
 * their meaning by fixing what replays them — `SkillContext.type(text)` and
 * `SkillContext.key(combo)` — and a keydown cannot be sorted into one or the
 * other without knowing which modifiers are down, which is state the raw
 * stream carries in separate events. So the vocabulary changes exactly where
 * the state exists to change it.
 */
export type X11EventType = 'pointer' | 'key' | 'type';

export function capturePointer(event: RfbPointerEvent): CapturedX11Event {
  return {
    type: 'pointer',
    // Field names are the RFB ones. The compiler prompt reads
    // this trace as JSON, and `buttonMask` is searchable against RFC 6143
    // in a way that a renamed `buttons` would not be.
    payload: { x: event.x, y: event.y, buttonMask: event.buttonMask },
  };
}

/**
 * The offset this event gets, given the one before it.
 *
 * §3 indexes `RecordingEvent` on `[recordingId, tsOffsetMs]` and nothing else,
 * so that pair IS the trace's order — there is no tiebreaker column, and §3's
 * field list is contractual (`test/schema-contract.test.ts`), so adding one is
 * a PRD revision rather than a fix. Millisecond resolution ties constantly:
 * a drag delivers several pointer events per millisecond, and a tie makes the
 * order of two adjacent events a property of how Postgres happened to return
 * them. The compiler would then read a click before the move that aimed it.
 *
 * So the offset is nudged forward to stay strictly increasing. The cost is
 * that a burst runs at most one millisecond ahead of the wall clock per event
 * — which changes no decision downstream, because M3-BE-07 forbids turning
 * trace gaps into `sleep(n)` at all: gaps say a wait is needed, never how
 * long. An order that is wrong, by contrast, produces a skill that clicks
 * before it aims.
 */
export function nextOffsetMs(elapsedMs: number, previousOffsetMs: number | null): number {
  const floor = Math.max(0, Math.trunc(elapsedMs));
  if (previousOffsetMs === null) return floor;
  return Math.max(floor, previousOffsetMs + 1);
}

/**
 * At most one pointer position per 100 ms (PRD §6/M3 capture rules).
 *
 * The rate is the PRD's, and the reason it can be this coarse is that a
 * position between two positions is interpolation, not information: nothing
 * downstream replays the path. M3-BE-06 compiles clicks and drags, and both
 * are defined by their endpoints.
 */
export const POINTER_COALESCE_MS = 100;

/** One captured event and when it arrived, so offsets stay in arrival order. */
export interface CapturedTiming {
  readonly elapsedMs: number;
  readonly event: CapturedX11Event;
}

/**
 * What the coalescer has to remember between events.
 *
 * Carried by the caller rather than held in the module, so one recording's
 * suppression cannot leak into another's — the tee runs one of these per
 * active recording, and a module-level cursor would silently share state
 * between two bots recording at once.
 */
export interface InputCoalescer {
  /** The newest move not yet emitted; see `coalesceInput`. */
  held: CapturedTiming | null;
  /** When a pointer position last reached the trace, or null before the first. */
  lastPointerMs: number | null;
  /** Buttons start released, so the first press reads as a transition. */
  lastButtonMask: number;
  /** Keysyms of combining modifiers currently held down. */
  readonly modifiers: Set<number>;
  /**
   * The run of typed text not yet emitted, and when the user started it.
   * `secret` once the page said the run went into a password field.
   */
  typing: { startedMs: number; text: string; secret: boolean } | null;
}

/**
 * What a run typed into a password field is stored as, instead of its keys.
 *
 * The CDP layer already withholds a password field's value, but the same
 * keystrokes arrive here as X11 key events, and those were coalesced into the
 * literal text — stored, shown to the operator, sent to the compiling model
 * and written into the skill. The run keeps its place in the trace, so the
 * compiler can still see that something was typed there and make it a
 * parameter, and loses the one thing that must not be kept.
 */
export const SECRET_TYPING_TEXT = '[typed into a password field: not recorded]';

/**
 * Mark the run of typing still being coalesced as a secret, because the page
 * reported input into a password field while it was open. Returns whether
 * there was a run to mark.
 */
export function markTypingSecret(state: InputCoalescer): boolean {
  if (state.typing === null) return false;
  state.typing.secret = true;
  return true;
}

export function createInputCoalescer(): InputCoalescer {
  return {
    held: null,
    lastPointerMs: null,
    lastButtonMask: 0,
    modifiers: new Set<number>(),
    typing: null,
  };
}

/**
 * Which mask bits count as a click for M3-BE-04.
 *
 * RFC 6143 §7.5.5 numbers the bits from button 1, and X11 spends buttons 4
 * and 5 on the wheel — a scroll is delivered as a press and a release of a
 * button that has no position of its own. §6/M3 asks for a screenshot on
 * "every button-down", and §3 says `screenshotKey` is "set on X11 clicks
 * only"; a wheel notch is the case where those two readings differ, so the
 * narrower one governs.
 *
 * It is also the only reading that survives contact with a real desktop.
 * Scrolling one long page delivers dozens of notches a second, each of which
 * would otherwise mean a screenshot round trip to the container and a PNG on
 * disk — turning the one gesture that produces the most events per second
 * into the one that costs the most, to photograph a target that does not
 * exist. The crop's whole job is to show WHERE a click landed.
 */
const CLICK_BUTTONS = 0b111;

/**
 * Whether this event presses a click button that was not already down.
 *
 * Read from the coalescer's own `lastButtonMask` rather than from a second
 * copy kept by the caller. There is exactly one answer to "was this button
 * already down", and two places tracking it is two places to disagree — the
 * tee would then take a screenshot for an event the trace records as a move,
 * or miss one for the press it records as a click.
 *
 * Must be asked BEFORE `coalesceInput`, which advances that mask.
 */
export function isClickPress(state: InputCoalescer, event: RfbInputEvent): boolean {
  if (event.kind !== 'pointer') return false;
  // Bits that are set now and were not before: a press, never a release, and
  // never a move that merely keeps a button held.
  return (event.buttonMask & ~state.lastButtonMask & CLICK_BUTTONS) !== 0;
}

const NOTHING: readonly CapturedTiming[] = Object.freeze([]);

/**
 * The pointer-move coalescer: "at most one per 100 ms, and always
 * emit the move immediately preceding a button press".
 *
 * Why a move is held rather than dropped
 *
 * RFB has no move message: a PointerEvent carries a position and a button
 * mask together, so a move is simply a pointer event whose mask did not
 * change (RFC 6143 §7.5.5), and a press is one whose mask did. Dropping the
 * suppressed moves outright would lose nothing about WHERE a click landed —
 * the press carries its own coordinates — but it would lose that the cursor
 * ARRIVED there first, and a large class of desktop UI answers the arrival:
 * menus open on hover, tooltips and drop targets appear on hover. A skill
 * replayed as a bare press at those coordinates clicks a submenu that the
 * missing hover never opened. So the newest suppressed move is kept in hand
 * and released ahead of whatever ends the run.
 *
 * Why only the newest
 *
 * A held move is superseded by any later move: it exists to be the position
 * the cursor was at when the run ended, and only the last one is. Keeping
 * more would also break the rate — PRD §11 pins the arithmetic at ≤ 31 move
 * events for a 500-event burst over 3 s, which is one per window plus the
 * one still in hand when the burst stops, and emitting a backlog when a
 * window opens would double it.
 *
 * Returns what this event contributes to the trace, in order, each carrying
 * the time it actually arrived — a released move is older than the event that
 * released it, and `nextOffsetMs` keeps that order when it assigns offsets.
 */
export function coalesceInput(
  state: InputCoalescer,
  event: RfbInputEvent,
  elapsedMs: number,
): readonly CapturedTiming[] {
  return event.kind === 'key'
    ? coalesceKey(state, event.keysym, event.down, elapsedMs)
    : coalescePointer(state, event, elapsedMs);
}

function coalescePointer(
  state: InputCoalescer,
  event: RfbPointerEvent,
  elapsedMs: number,
): readonly CapturedTiming[] {
  // §6/M3 merges keydowns "with no intervening pointer event", so ANY pointer
  // event ends a run of typing — including one this window is about to
  // suppress. What broke the run is that the user reached for the mouse, not
  // whether the position they reached was worth storing.
  const typed = takeTyping(state);
  const captured: CapturedTiming = { elapsedMs, event: capturePointer(event) };

  if (event.buttonMask === state.lastButtonMask) {
    const since = state.lastPointerMs;
    if (since !== null && elapsedMs - since < POINTER_COALESCE_MS) {
      state.held = captured;
      return typed;
    }
    // The window is open, so this move goes in as itself — and supersedes the
    // one being held, which was only ever a stand-in for the newest position.
    state.held = null;
    state.lastPointerMs = elapsedMs;
    return [...typed, captured];
  }

  const released = takeHeld(state);
  state.lastButtonMask = event.buttonMask;
  // A press records a position too, so the next move is measured from here.
  state.lastPointerMs = elapsedMs;
  return [...released, ...typed, captured];
}

/**
 * The keystroke coalescer: "Coalesce consecutive `keydown` events
 * with no intervening pointer event into a single `type` event. Modifier
 * combinations (`Ctrl+C`) stay discrete."
 *
 * Why key-ups vanish
 *
 * RFB reports both directions, and `SkillContext` can replay neither on its
 * own: it offers `type(text)` and `key(combo)`, both of which are whole
 * keystrokes. A key-up therefore carries nothing a skill could act on — with
 * one exception, which is why they are read rather than ignored: the release
 * of a modifier is the only evidence that the modifier stopped applying.
 *
 * Why shift is not a modifier here
 *
 * RFC 6143 §7.5.4 sends "the keysym that would be produced by the key press,
 * taking modifiers into account", so Shift+a arrives as `A`. Treating Shift as
 * combining would name that keystroke `shift+A` — the shift applied twice, and
 * a combo no runtime could replay. `isAppliedModifier` is that list, and it
 * covers Caps Lock and AltGr for the same reason.
 *
 * Why a run is held
 *
 * A run cannot be emitted until something ends it, because until then the next
 * keystroke may still belong to it. Like a held move, it carries the time it
 * STARTED: the run occupies a span, and the moment the user began typing is
 * the one that orders correctly against the click before it.
 */
function coalesceKey(
  state: InputCoalescer,
  keysym: number,
  down: boolean,
  elapsedMs: number,
): readonly CapturedTiming[] {
  const modifier = combiningModifier(keysym);
  if (modifier !== null) {
    // Held rather than emitted: a modifier pressed and released alone types
    // nothing, and must not split "hello" into "he" and "llo".
    if (down) state.modifiers.add(keysym);
    else state.modifiers.delete(keysym);
    return NOTHING;
  }
  if (!down || isAppliedModifier(keysym)) return NOTHING;

  const text = typedText(keysym);
  if (text !== null && state.modifiers.size === 0) {
    // A key is not a move, so it ends the pointer run whether or not it ends
    // up extending a run of typing.
    const released = takeHeld(state);
    const typing = state.typing;
    if (typing === null) state.typing = { startedMs: elapsedMs, text, secret: false };
    else typing.text += text;
    return released;
  }

  // Either a key with no text of its own (Return, F5) or one under a
  // combining modifier: discrete, and it ends whatever run was open.
  const released = takeHeld(state);
  const typed = takeTyping(state);
  const combo = keyCombo(keysym, state.modifiers);
  return [...released, ...typed, { elapsedMs, event: { type: 'key', payload: { combo } } }];
}

function takeHeld(state: InputCoalescer): readonly CapturedTiming[] {
  const released = state.held;
  if (released === null) return NOTHING;
  state.held = null;
  return [released];
}

function takeTyping(state: InputCoalescer): readonly CapturedTiming[] {
  const typing = state.typing;
  if (typing === null) return NOTHING;
  state.typing = null;
  const payload = typing.secret
    ? { text: SECRET_TYPING_TEXT, secret: true }
    : { text: typing.text };
  return [{ elapsedMs: typing.startedMs, event: { type: 'type', payload } }];
}

/**
 * Release whatever is still in hand because nothing else will — the recording
 * is stopping.
 *
 * Without this the last move before a pause, and the last thing the user
 * typed, are the two events a recording can silently drop, and both are
 * likely to matter: where the cursor was left, and the text that was never
 * followed by a click.
 *
 * A held move and an open run of typing are mutually exclusive in practice —
 * a key releases the move, a pointer event ends the run — but both are
 * drained, oldest first, rather than relying on that staying true.
 */
export function drainHeld(state: InputCoalescer): readonly CapturedTiming[] {
  return [...takeHeld(state), ...takeTyping(state)];
}
