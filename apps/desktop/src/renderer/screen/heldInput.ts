/**
 * What the sandbox still believes is pressed.
 *
 * Why the viewer has to track this
 *
 * Input capture ends abruptly. The operator collapses the viewer, switches
 * bot, or closes the rail — and whatever was held at that instant reached the
 * sandbox as a press with no matching release. X has no notion of "the client
 * went away" for a key it was told is down, so a modifier left down is both
 * permanent and invisible: every later click the agent makes becomes a
 * ctrl-click, and the desktop reads as broken for a reason nothing reports.
 *
 * noVNC knows about this failure and releases held keys when `viewOnly` goes
 * back on. It cannot help here, because of the order it does it in (1.7.0,
 * `core/rfb.js`):
 *
 * set viewOnly(viewOnly) {
 * this._viewOnly = viewOnly; // set first
 * ...
 * this._keyboard.ungrab(); // which calls _allKeysUp()
 *
 * and every release `_allKeysUp` produces reaches `sendKey`, whose first line
 * is `if (this._rfbConnectionState !== 'connected' || this._viewOnly) return;`.
 * So the releases are generated and immediately dropped, while
 * `Keyboard._keyDownList` is cleared on the way past — after which nothing on
 * either side knows the key is still down. `disconnect()` has the same shape:
 * it ungrabs after the connection state has already left `connected`.
 *
 * This reads the messages that are ALREADY going out, so it cannot disagree
 * with what the sandbox was actually told, and it stays a pure value: no
 * noVNC, no DOM, no socket. That is also what makes the stuck-key case
 * testable in a suite that can render neither.
 */

/** RFC 6143 §7.5.4 — type, down-flag, 2 padding, keysym. */
const KEY_EVENT = 4;
const KEY_EVENT_BYTES = 8;
/** RFC 6143 §7.5.5 — type, button-mask, x, y. */
const POINTER_EVENT = 5;
const POINTER_EVENT_BYTES = 6;

/** Where a held button was last seen, so its release lands in the same place. */
interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

export class HeldInput {
  /** Keysyms told to be down, in press order. */
  private readonly keys = new Set<number>();
  /** Set while any button is held; `null` once the mask goes back to zero. */
  private pointer: PointerPosition | null = null;

  /**
   * Record one message on its way to the sandbox.
   *
   * Silently ignores anything that is not an exact-length KeyEvent or
   * PointerEvent, because those are the only two the orchestrator forwards
   * — a message this cannot read is one the sandbox never saw either.
   */
  observe(message: Uint8Array): void {
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const type = view.getUint8(0);

    if (type === KEY_EVENT && message.length === KEY_EVENT_BYTES) {
      const keysym = view.getUint32(4);
      // RFC 6143: any non-zero down-flag means pressed.
      if (view.getUint8(1) !== 0) this.keys.add(keysym);
      else this.keys.delete(keysym);
      return;
    }

    if (type === POINTER_EVENT && message.length === POINTER_EVENT_BYTES) {
      // A move with no buttons down is the common case and clears nothing that
      // was not already clear; the position only matters while one is held.
      const buttonMask = view.getUint8(1);
      this.pointer = buttonMask === 0 ? null : { x: view.getUint16(2), y: view.getUint16(4) };
    }
  }

  /** True when the sandbox is holding something on this viewer's behalf. */
  get isHolding(): boolean {
    return this.keys.size > 0 || this.pointer !== null;
  }

  /**
   * The messages that put the sandbox back where it was found, and forget them.
   *
   * Ordering is deliberate on both counts. The button is released FIRST, while
   * the modifiers that gave the drag its meaning are still down — a shift-drag
   * ended by dropping shift first is a different gesture. The keys then go in
   * reverse press order, the way a hand unwinds a chord, so Ctrl outlives the
   * `c` it was modifying rather than the other way round.
   *
   * Idempotent: a second call with nothing held returns nothing, so a cleanup
   * that runs twice cannot inject phantom releases.
   */
  release(): Uint8Array[] {
    const messages: Uint8Array[] = [];

    if (this.pointer !== null) {
      messages.push(pointerEvent(0, this.pointer.x, this.pointer.y));
      this.pointer = null;
    }
    for (const keysym of [...this.keys].reverse()) messages.push(keyEvent(false, keysym));
    this.keys.clear();

    return messages;
  }
}

function keyEvent(down: boolean, keysym: number): Uint8Array {
  const message = new Uint8Array(KEY_EVENT_BYTES);
  const view = new DataView(message.buffer);
  view.setUint8(0, KEY_EVENT);
  view.setUint8(1, down ? 1 : 0);
  view.setUint32(4, keysym);
  return message;
}

function pointerEvent(buttonMask: number, x: number, y: number): Uint8Array {
  const message = new Uint8Array(POINTER_EVENT_BYTES);
  const view = new DataView(message.buffer);
  view.setUint8(0, POINTER_EVENT);
  view.setUint8(1, buttonMask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return message;
}
