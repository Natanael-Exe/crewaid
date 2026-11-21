import { describe, expect, it } from 'vitest';

import {
  capturePointer,
  coalesceInput,
  createInputCoalescer,
  drainHeld,
  nextOffsetMs,
  POINTER_COALESCE_MS,
  type CapturedTiming,
} from '../src/recordings/recording-events.js';
import type { RfbInputEvent } from '../src/screen/rfb-input.js';

/**
 * M3-BE-01 — the X11 capture vocabulary and its ordering rule (§6/M3).
 *
 * Pure, so these are the fixtures the M3-BE-02/03 coalescers will extend
 * rather than replace.
 */
describe('capturePointer', () => {
  it('keeps the RFB field names a pointer event arrived with', () => {
    const event = { kind: 'pointer', buttonMask: 1, x: 640, y: 400 } as const;

    // `buttonMask` is searchable against RFC 6143; a renamed `buttons` would
    // leave the compiler prompt (M3-BE-07) reading a field with no referent.
    expect(capturePointer(event)).toEqual({
      type: 'pointer',
      payload: { x: 640, y: 400, buttonMask: 1 },
    });
  });

  it('does not decide that a button-down was a click', () => {
    // The raw stream cannot know: the NEXT event decides whether a press was a
    // click or the start of a drag. Naming it here would commit the trace to a
    // guess only M3-BE-06 has enough of the trace to make.
    expect(capturePointer({ kind: 'pointer', buttonMask: 1, x: 1, y: 1 }).type).toBe('pointer');
    expect(capturePointer({ kind: 'pointer', buttonMask: 0, x: 1, y: 1 }).type).toBe('pointer');
  });
});

describe('nextOffsetMs', () => {
  it('starts at the elapsed time of the first event', () => {
    expect(nextOffsetMs(0, null)).toBe(0);
    expect(nextOffsetMs(1_500, null)).toBe(1_500);
  });

  it('follows the clock while events are more than a millisecond apart', () => {
    expect(nextOffsetMs(120, 40)).toBe(120);
  });

  it('breaks a same-millisecond tie rather than letting the trace lose its order', () => {
    // §3 indexes RecordingEvent on [recordingId, tsOffsetMs] and gives no
    // tiebreaker column, so equal offsets make the order of two adjacent
    // events a property of how Postgres returned them — and the pair that
    // collides most is a move and the click it aimed.
    expect(nextOffsetMs(40, 40)).toBe(41);
    expect(nextOffsetMs(40, 41)).toBe(42);
  });

  it('never moves backwards when the clock does', () => {
    // A clock adjustment mid-recording must not reorder the trace.
    expect(nextOffsetMs(10, 900)).toBe(901);
  });

  it('never emits a negative offset, which §3 forbids', () => {
    expect(nextOffsetMs(-5, null)).toBe(0);
  });

  it('truncates rather than rounding, so an offset never claims time that has not passed', () => {
    expect(nextOffsetMs(40.9, null)).toBe(40);
  });
});

/**
 * M3-BE-02 — "Coalesce pointer moves: at most one per 100 ms, and always emit
 * the move immediately preceding a button press" (PRD §6/M3).
 *
 * Fixtures rather than a live tee: the rule is decided per event from an
 * arrival time the caller supplies, so a burst that would take three real
 * seconds is a loop here.
 */
describe('coalesceInput', () => {
  const move = (x: number, y = 0): RfbInputEvent => ({ kind: 'pointer', buttonMask: 0, x, y });
  const press = (x: number, y = 0): RfbInputEvent => ({ kind: 'pointer', buttonMask: 1, x, y });
  /** A sample taken while button 1 is held: the mask is unchanged, so it is a move. */
  const drag = (x: number, y = 0): RfbInputEvent => ({ kind: 'pointer', buttonMask: 1, x, y });
  const key = (keysym: number): RfbInputEvent => ({ kind: 'key', down: true, keysym });

  /** The x of each emitted event, which is what identifies a sample here. */
  const xs = (out: readonly CapturedTiming[]): unknown[] => out.map((e) => e.event.payload.x);

  it('emits the first move, having no window to measure it against', () => {
    const state = createInputCoalescer();

    expect(xs(coalesceInput(state, move(10), 0))).toEqual([10]);
  });

  it('holds a move that arrives inside the window', () => {
    const state = createInputCoalescer();
    coalesceInput(state, move(10), 0);

    expect(coalesceInput(state, move(11), POINTER_COALESCE_MS - 1)).toEqual([]);
  });

  it('emits the newest move when the window opens and drops the one it held', () => {
    const state = createInputCoalescer();
    coalesceInput(state, move(10), 0);
    coalesceInput(state, move(11), 40);
    coalesceInput(state, move(12), 80);

    // One per window, not a backlog: the held move is only ever a stand-in for
    // the newest position, and emitting both would double the rate the PRD
    // pins at ≤ 31 events for a 500-sample burst.
    expect(xs(coalesceInput(state, move(13), POINTER_COALESCE_MS))).toEqual([13]);
  });

  it('releases the held move immediately before a press, in that order', () => {
    const state = createInputCoalescer();
    coalesceInput(state, move(10), 0);
    coalesceInput(state, move(640), 40);

    // Menus open on hover and drop targets appear on hover, so a press with no
    // preceding move replays as a click on a submenu that never opened.
    const out = coalesceInput(state, press(640), 45);
    expect(xs(out)).toEqual([640, 640]);
    expect(out.map((e) => e.event.payload.buttonMask)).toEqual([0, 1]);
  });

  it('gives the released move the time it arrived, not the time it was released', () => {
    const state = createInputCoalescer();
    coalesceInput(state, move(10), 0);
    coalesceInput(state, move(640), 40);

    // `nextOffsetMs` orders the trace by these, so a released move carrying
    // the press's timestamp would collapse the pair into one instant.
    expect(coalesceInput(state, press(640), 45).map((e) => e.elapsedMs)).toEqual([40, 45]);
  });

  it('releases the held move on a button release too', () => {
    const state = createInputCoalescer();
    coalesceInput(state, press(10), 0);
    expect(coalesceInput(state, drag(60), 20)).toEqual([]);
    expect(coalesceInput(state, drag(99), 40)).toEqual([]);

    // Where a drag ended is the half of it that a skill has to reproduce, and
    // the release is the only event that says where that was.
    const out = coalesceInput(state, move(99), 50);
    expect(xs(out)).toEqual([99, 99]);
    expect(out.map((e) => e.event.payload.buttonMask)).toEqual([1, 0]);
  });

  it('releases the held move on a key, so a run of keys is not falsely continuous', () => {
    const state = createInputCoalescer();
    coalesceInput(state, move(10), 0);
    coalesceInput(state, move(20), 40);

    // §6/M3 merges keydowns "with no intervening pointer event". A move still
    // in hand across a keystroke would make an interrupted run look
    // continuous, and it would surface later, out of order. The key itself
    // starts a run of typing and so contributes nothing yet.
    const out = coalesceInput(state, key(0x68), 45);
    expect(out.map((e) => e.event.type)).toEqual(['pointer']);
    expect(out.map((e) => e.event.payload.x)).toEqual([20]);
  });

  it('does not restart the move window on a key, which records no position', () => {
    const state = createInputCoalescer();
    coalesceInput(state, move(10), 0);
    coalesceInput(state, key(0x68), 10);

    // The move is emitted on the rate rule; the run of typing the key started
    // is ended by that same pointer event, and sorts at the time it began.
    const out = coalesceInput(state, move(20), 100);
    expect(out.map((e) => [e.event.type, e.elapsedMs])).toEqual([
      ['type', 10],
      ['pointer', 100],
    ]);
  });

  it('restarts the window on a press, which records a position of its own', () => {
    const state = createInputCoalescer();
    coalesceInput(state, press(10), 50);

    // Measured from the press at 50, not from the last move before it.
    expect(coalesceInput(state, drag(11), 100)).toEqual([]);
    expect(xs(coalesceInput(state, drag(12), 150))).toEqual([12]);
  });

  it('reads the first press as a transition, because buttons start released', () => {
    const state = createInputCoalescer();

    // Not a move that happens to carry a mask: nothing may suppress a press.
    expect(xs(coalesceInput(state, press(10), 0))).toEqual([10]);
    expect(xs(coalesceInput(state, press(11), 1))).toEqual([]);
  });

  it('coalesces a drag, whose samples never change the mask', () => {
    const state = createInputCoalescer();
    coalesceInput(state, press(0), 0);

    let emitted = 0;
    for (let i = 1; i <= 30; i += 1) emitted += coalesceInput(state, drag(i, i), i * 10).length;

    // 300 ms of samples at 10 ms is three windows, not thirty rows.
    expect(emitted).toBe(3);
  });
});

describe('drainHeld', () => {
  it('releases the move the recording ended on', () => {
    const state = createInputCoalescer();
    coalesceInput(state, { kind: 'pointer', buttonMask: 0, x: 10, y: 0 }, 0);
    coalesceInput(state, { kind: 'pointer', buttonMask: 0, x: 700, y: 400 }, 40);

    // Nothing else will release it: the run ended because the user stopped.
    expect(drainHeld(state).map((e) => e.event.payload.x)).toEqual([700]);
    expect(drainHeld(state)).toEqual([]);
  });

  it('releases nothing when the last move was already emitted', () => {
    const state = createInputCoalescer();
    coalesceInput(state, { kind: 'pointer', buttonMask: 0, x: 10, y: 0 }, 0);

    expect(drainHeld(state)).toEqual([]);
  });
});

describe('coalesceInput — the PRD §11 burst', () => {
  it('thins 500 samples over 3 s to at most 31 moves and keeps the pre-click move', () => {
    const state = createInputCoalescer();
    const emitted: CapturedTiming[] = [];
    // One click partway through: press, then release on the next sample.
    const PRESS_AT = 250;

    for (let i = 0; i < 500; i += 1) {
      const at = (i * 3_000) / 499;
      const mask = i === PRESS_AT ? 1 : 0;
      emitted.push(...coalesceInput(state, { kind: 'pointer', buttonMask: mask, x: i, y: i }, at));
    }
    // The trailing move is part of the trace; the tee drains it at stop.
    emitted.push(...drainHeld(state));

    // The press and the release after it are transitions, not moves — and the
    // release carries mask 0 exactly as a move does, so it has to be excluded
    // by identity rather than by its mask.
    const moves = emitted.filter(
      (e) => e.event.payload.x !== PRESS_AT && e.event.payload.x !== PRESS_AT + 1,
    );
    expect(moves.length).toBeLessThanOrEqual(31);
    // A bound alone is not evidence — a coalescer that emitted nothing would
    // satisfy it. 3 s at one per 100 ms is thirty windows plus the trailing
    // move, so anything below this band means samples are being lost.
    expect(moves.length).toBeGreaterThanOrEqual(30);

    const pressIndex = emitted.findIndex((e) => e.event.payload.x === PRESS_AT);
    expect(pressIndex).toBeGreaterThan(0);
    // Sample 249 falls inside a window and would be suppressed on the rate
    // rule alone. It is the move that aimed the click.
    expect(emitted[pressIndex - 1]?.event.payload.x).toBe(PRESS_AT - 1);
  });
});

/**
 * M3-BE-03 — "Coalesce consecutive `keydown` events with no intervening
 * pointer event into a single `type` event. Modifier combinations (`Ctrl+C`)
 * stay discrete." (PRD §6/M3)
 */
describe('coalesceInput — the keystroke coalescer', () => {
  const KEY = {
    h: 0x68,
    e: 0x65,
    l: 0x6c,
    o: 0x6f,
    a: 0x61,
    x: 0x78,
    A: 0x41,
    ctrl: 0xffe3,
    ctrlRight: 0xffe4,
    shift: 0xffe1,
    alt: 0xffe9,
    Return: 0xff0d,
    Delete: 0xffff,
    F5: 0xffc2,
    Left: 0xff51,
    euro: 0x010020ac,
    mute: 0x1008ff12,
  } as const;

  const down = (keysym: number): RfbInputEvent => ({ kind: 'key', down: true, keysym });
  const up = (keysym: number): RfbInputEvent => ({ kind: 'key', down: false, keysym });
  const at = (x: number, buttonMask = 0): RfbInputEvent => ({
    kind: 'pointer',
    buttonMask,
    x,
    y: 0,
  });

  /** Feed a whole interaction and take what the trace ends up holding. */
  function feed(steps: readonly (readonly [RfbInputEvent, number])[]): readonly CapturedTiming[] {
    const state = createInputCoalescer();
    const out: CapturedTiming[] = [];
    for (const [event, elapsedMs] of steps) out.push(...coalesceInput(state, event, elapsedMs));
    out.push(...drainHeld(state));
    return out;
  }

  const shape = (out: readonly CapturedTiming[]): unknown[] =>
    out.map((e) => [
      e.event.type,
      e.event.payload.text ?? e.event.payload.combo ?? e.event.payload.x,
    ]);

  it('merges h,e,l,l,o into one type("hello") — PRD §11', () => {
    const out = feed([
      [down(KEY.h), 0],
      [up(KEY.h), 5],
      [down(KEY.e), 10],
      [up(KEY.e), 15],
      [down(KEY.l), 20],
      [down(KEY.l), 30],
      [down(KEY.o), 40],
      [up(KEY.o), 45],
    ]);

    expect(shape(out)).toEqual([['type', 'hello']]);
    // The run sorts where the typing STARTED, which is what orders it against
    // the click before it rather than the one after.
    expect(out[0]?.elapsedMs).toBe(0);
  });

  it('splits h,e,Ctrl+a,x into type("he"), key("ctrl+a"), type("x") — PRD §11', () => {
    const out = feed([
      [down(KEY.h), 0],
      [down(KEY.e), 10],
      [down(KEY.ctrl), 20],
      [down(KEY.a), 30],
      [up(KEY.a), 35],
      [up(KEY.ctrl), 40],
      [down(KEY.x), 50],
    ]);

    expect(shape(out)).toEqual([
      ['type', 'he'],
      ['key', 'ctrl+a'],
      ['type', 'x'],
    ]);
    expect(out.map((e) => e.elapsedMs)).toEqual([0, 30, 50]);
  });

  it('does not split a run when a modifier is pressed and released alone', () => {
    // Ctrl on its own types nothing. Ending the run here would turn a stray
    // modifier tap into "he" + "llo" for no reason the user would recognise.
    const out = feed([
      [down(KEY.h), 0],
      [down(KEY.e), 10],
      [down(KEY.ctrl), 20],
      [up(KEY.ctrl), 25],
      [down(KEY.l), 30],
      [down(KEY.l), 40],
      [down(KEY.o), 50],
    ]);

    expect(shape(out)).toEqual([['type', 'hello']]);
  });

  it('keeps shift out of the combo, because RFB already applied it', () => {
    // RFC 6143 §7.5.4 sends the keysym the press WOULD produce, so Shift+a
    // arrives as `A`. Naming it `shift+A` would apply the shift twice.
    const out = feed([
      [down(KEY.shift), 0],
      [down(KEY.A), 10],
      [up(KEY.A), 15],
      [up(KEY.shift), 20],
      [down(KEY.h), 30],
    ]);

    expect(shape(out)).toEqual([['type', 'Ah']]);
  });

  it('emits a key with no text of its own discretely', () => {
    const out = feed([
      [down(KEY.h), 0],
      [down(KEY.e), 10],
      [down(KEY.Return), 20],
      [down(KEY.x), 30],
    ]);

    // `SkillContext` has no way to express Return inside `type(text)`, which
    // is why §6 gives it as the worked example for `key(combo)`.
    expect(shape(out)).toEqual([
      ['type', 'he'],
      ['key', 'Return'],
      ['type', 'x'],
    ]);
  });

  it('names function and navigation keys the way X11 does', () => {
    expect(shape(feed([[down(KEY.F5), 0]]))).toEqual([['key', 'F5']]);
    expect(shape(feed([[down(KEY.Left), 0]]))).toEqual([['key', 'Left']]);
    expect(shape(feed([[down(KEY.Delete), 0]]))).toEqual([['key', 'Delete']]);
  });

  it('orders a multi-modifier combo canonically, however it was pressed', () => {
    // Ctrl+Alt+Delete pressed alt-first must not read `alt+ctrl+Delete`, or
    // two recordings of the same gesture compile to two different skills.
    const out = feed([
      [down(KEY.alt), 0],
      [down(KEY.ctrl), 10],
      [down(KEY.Delete), 20],
    ]);

    expect(shape(out)).toEqual([['key', 'ctrl+alt+Delete']]);
  });

  it('treats left and right modifiers as the same modifier', () => {
    const out = feed([
      [down(KEY.ctrlRight), 0],
      [down(KEY.a), 10],
    ]);

    // A skill that only replays under the right Ctrl has a bug, not a feature.
    expect(shape(out)).toEqual([['key', 'ctrl+a']]);
  });

  it('types a Unicode keysym and names an unnamed one in hex', () => {
    expect(shape(feed([[down(KEY.euro), 0]]))).toEqual([['type', '€']]);
    // How `xev` prints a keysym it has no name for, and round-trippable back
    // to the number a runtime has to send.
    expect(shape(feed([[down(KEY.mute), 0]]))).toEqual([['key', '0x1008ff12']]);
  });

  it('drops key-ups, which SkillContext cannot replay on their own', () => {
    const out = feed([
      [up(KEY.h), 0],
      [up(KEY.Return), 10],
    ]);

    expect(out).toEqual([]);
  });

  it('ends a run at any pointer event, including one the window suppresses', () => {
    const out = feed([
      [at(5), 0], // opens the pointer window
      [down(KEY.h), 10],
      [down(KEY.e), 20],
      [at(6), 30], // inside the 100 ms window: held, never stored
      [down(KEY.x), 40],
    ]);

    // What broke the run is that the user reached for the mouse — not whether
    // the position they reached was worth storing.
    expect(shape(out)).toEqual([
      ['pointer', 5],
      ['type', 'he'],
      ['pointer', 6],
      ['type', 'x'],
    ]);
  });

  it('keeps a run that a click ends ahead of the click', () => {
    const out = feed([
      [down(KEY.h), 0],
      [down(KEY.e), 10],
      [at(640, 1), 20], // press
    ]);

    expect(shape(out)).toEqual([
      ['type', 'he'],
      ['pointer', 640],
    ]);
    expect(out.map((e) => e.elapsedMs)).toEqual([0, 20]);
  });

  it('releases a run that nothing ended, so the last thing typed is not dropped', () => {
    const state = createInputCoalescer();
    coalesceInput(state, down(KEY.h), 0);
    coalesceInput(state, down(KEY.e), 10);

    expect(shape(drainHeld(state))).toEqual([['type', 'he']]);
    expect(drainHeld(state)).toEqual([]);
  });
});
