import { describe, expect, it } from 'vitest';

import { keyCombo, typedText } from '../src/recordings/keysyms.js';

/**
 * The keysym → name table, checked against X11's own names.
 *
 * `keysyms.ts` says a reader "can check any of them against `keysymdef.h` or
 * `xev`", and that claim is the whole reason the file spells out names rather
 * than inventing a vocabulary — a combo is only round-trippable if the runtime
 * that parses it back arrives at the keysym that was pressed.
 *
 * The modifier names in particular had to be written out by hand: the combo
 * vocabulary collapses left and right onto one name (`ctrl`), and deriving the
 * key names from that map gave both halves the name of the left one.
 */
describe('keyCombo names keys the way X11 does', () => {
  it('distinguishes the left and right half of every combining modifier', () => {
    expect(keyCombo(0xffe3, [])).toBe('Control_L');
    expect(keyCombo(0xffe4, [])).toBe('Control_R');
    expect(keyCombo(0xffe7, [])).toBe('Meta_L');
    expect(keyCombo(0xffe8, [])).toBe('Meta_R');
    expect(keyCombo(0xffe9, [])).toBe('Alt_L');
    expect(keyCombo(0xffea, [])).toBe('Alt_R');
    expect(keyCombo(0xffeb, [])).toBe('Super_L');
    expect(keyCombo(0xffec, [])).toBe('Super_R');
    expect(keyCombo(0xffed, [])).toBe('Hyper_L');
    expect(keyCombo(0xffee, [])).toBe('Hyper_R');
  });

  it('still folds left and right into one PREFIX, which is what a skill replays', () => {
    expect(keyCombo(0x63, [0xffe3])).toBe('ctrl+c');
    expect(keyCombo(0x63, [0xffe4])).toBe('ctrl+c');
  });

  it('names the applied modifiers and the keys that carry no text', () => {
    expect(keyCombo(0xffe1, [])).toBe('Shift_L');
    expect(keyCombo(0xffe2, [])).toBe('Shift_R');
    expect(keyCombo(0xff0d, [])).toBe('Return');
    expect(keyCombo(0xffbe, [])).toBe('F1');
    expect(keyCombo(0xffe0, [])).toBe('F35');
    expect(keyCombo(0xffb0, [])).toBe('KP_0');
  });

  it('orders a multi-modifier combo canonically, however it was pressed', () => {
    expect(keyCombo(0xffff, [0xffe9, 0xffe3])).toBe('ctrl+alt+Delete');
    expect(keyCombo(0xffff, [0xffe3, 0xffe9])).toBe('ctrl+alt+Delete');
  });

  it('falls back to the hex form X11 tools print for a keysym with no name', () => {
    expect(keyCombo(0xff00, [])).toBe('0xff00');
  });

  it('does not name a key that types text — that is what type() replays', () => {
    expect(typedText(0x61)).toBe('a');
    expect(keyCombo(0x61, [0xffe3])).toBe('ctrl+a');
  });
});
