import { describe, expect, it } from 'vitest';
import { HeldInput } from '../src/renderer/screen/heldInput';

/** RFC 6143 §7.5.4 — type, down-flag, 2 padding, keysym. */
const key = (down: number, keysym: number): Uint8Array => {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint8(0, 4);
  view.setUint8(1, down);
  view.setUint32(4, keysym);
  return message;
};

/** RFC 6143 §7.5.5 — type, button-mask, x, y. */
const pointer = (mask: number, x: number, y: number): Uint8Array => {
  const message = new Uint8Array(6);
  const view = new DataView(message.buffer);
  view.setUint8(0, 5);
  view.setUint8(1, mask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return message;
};

const bytes = (messages: readonly Uint8Array[]): number[][] => messages.map((m) => [...m]);

const XK_Control_L = 0xffe3;
const XK_Shift_L = 0xffe1;
const XK_c = 0x63;

describe('HeldInput (M2-FE-03)', () => {
  it('has nothing to release when every press was matched by a release', () => {
    const held = new HeldInput();
    held.observe(key(1, XK_c));
    held.observe(key(0, XK_c));
    held.observe(pointer(1, 10, 20));
    held.observe(pointer(0, 10, 20));

    expect(held.isHolding).toBe(false);
    expect(held.release()).toEqual([]);
  });

  it('releases a key the operator was still holding when capture ended', () => {
    // The case this exists for: noVNC generates these releases itself and then
    // drops them, because `set viewOnly` flips `_viewOnly` before `ungrab()`
    // and `sendKey` returns early on it. A Ctrl left down in the sandbox turns
    // every later click the agent makes into a ctrl-click, invisibly.
    const held = new HeldInput();
    held.observe(key(1, XK_Control_L));

    expect(held.isHolding).toBe(true);
    expect(bytes(held.release())).toEqual([[...key(0, XK_Control_L)]]);
  });

  it('unwinds a chord in reverse, so the modifier outlives what it modified', () => {
    const held = new HeldInput();
    held.observe(key(1, XK_Control_L));
    held.observe(key(1, XK_c));

    expect(bytes(held.release())).toEqual([[...key(0, XK_c)], [...key(0, XK_Control_L)]]);
  });

  it('drops the button first, while the modifiers that shaped the drag are down', () => {
    // A shift-drag ended by releasing shift first is a different gesture, and
    // the desktop on the other end acts on the difference.
    const held = new HeldInput();
    held.observe(key(1, XK_Shift_L));
    held.observe(pointer(1, 640, 400));
    held.observe(pointer(1, 700, 420));

    expect(bytes(held.release())).toEqual([
      // At the LAST position seen, not where the drag started.
      [...pointer(0, 700, 420)],
      [...key(0, XK_Shift_L)],
    ]);
  });

  it('ignores a plain mouse move, which holds nothing', () => {
    const held = new HeldInput();
    held.observe(pointer(0, 12, 34));

    expect(held.isHolding).toBe(false);
    expect(held.release()).toEqual([]);
  });

  it('forgets what it released, so a cleanup that runs twice sends nothing twice', () => {
    const held = new HeldInput();
    held.observe(key(1, XK_Shift_L));
    held.observe(pointer(2, 5, 6));

    expect(held.release()).toHaveLength(2);
    expect(held.release()).toEqual([]);
    expect(held.isHolding).toBe(false);
  });

  it('never treats a message the sandbox could not have received as held', () => {
    const held = new HeldInput();
    // D-036 forwards nothing but exact-length t4/t5, so a truncated KeyEvent,
    // one with trailing bytes, and a configuration message were all refused
    // upstream — recording them would release a key nobody ever pressed.
    held.observe(key(1, XK_c).subarray(0, 7));
    held.observe(new Uint8Array([...key(1, XK_c), 0]));
    held.observe(new Uint8Array([0, 0, 0, 0]));

    expect(held.isHolding).toBe(false);
  });

  it('reads a message that is a view into a larger buffer', () => {
    // `RfbChannel` slices its receive buffer, so the byte offset is not
    // guaranteed to be zero and a DataView built on `.buffer` alone would
    // read the neighbouring message's bytes.
    const backing = new Uint8Array([0xff, 0xff, ...key(1, XK_Shift_L), 0xff]);
    const held = new HeldInput();
    held.observe(backing.subarray(2, 10));

    expect(bytes(held.release())).toEqual([[...key(0, XK_Shift_L)]]);
  });
});
