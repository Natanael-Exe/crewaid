/**
 * X11 keysyms → the vocabulary the `SkillContext` replays with.
 *
 * This is the one place in the recorder that stops describing what RFB
 * delivered and starts describing what a skill will do. §6 fixes the target:
 * `type(text)` for typed text and `key(combo)` for everything else, with
 * `"ctrl+c"` and `"Return"` given as the two worked examples — so the names
 * here are X11's own keysym names rather than a vocabulary of our invention,
 * and a reader can check any of them against `keysymdef.h` or `xev`.
 *
 * Pure tables and pure functions: no clock, no state, no service.
 */

/**
 * Modifiers that COMBINE with another key, in the order a combo names them.
 *
 * Left and right map to one name because a skill that only replays on the
 * right Ctrl is a skill with a bug, not a feature.
 */
const COMBINING_MODIFIERS = new Map<number, string>([
  [0xffe3, 'ctrl'],
  [0xffe4, 'ctrl'],
  [0xffe9, 'alt'],
  [0xffea, 'alt'],
  [0xffeb, 'super'],
  [0xffec, 'super'],
  [0xffe7, 'meta'],
  [0xffe8, 'meta'],
  [0xffed, 'hyper'],
  [0xffee, 'hyper'],
]);

/** Canonical order, so `Ctrl+Alt+Delete` names itself the same however it was pressed. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'super', 'meta', 'hyper'] as const;

/**
 * Modifiers the client has ALREADY applied to the keysym it sent.
 *
 * RFC 6143 §7.5.4: the keysym is "the one that would be produced by the key
 * press, taking modifiers into account". Shift+a therefore arrives as `A`
 * (0x41), not as `a` plus a shift flag — so naming a combo `shift+A` would
 * both double the shift and produce a combo no runtime could replay. The same
 * holds for Caps Lock and for AltGr, which is how most of Latin-1 is typed.
 */
const APPLIED_MODIFIERS = new Set<number>([
  0xffe1, // Shift_L
  0xffe2, // Shift_R
  0xffe5, // Caps_Lock
  0xffe6, // Shift_Lock
  0xfe03, // ISO_Level3_Shift (AltGr)
  0xff7e, // Mode_switch
]);

/** Keys with an X11 name and no text of their own. */
const NAMED_KEYS = new Map<number, string>([
  [0xff08, 'BackSpace'],
  [0xff09, 'Tab'],
  [0xff0a, 'Linefeed'],
  [0xff0b, 'Clear'],
  [0xff0d, 'Return'],
  [0xff13, 'Pause'],
  [0xff14, 'Scroll_Lock'],
  [0xff15, 'Sys_Req'],
  [0xff1b, 'Escape'],
  [0xff50, 'Home'],
  [0xff51, 'Left'],
  [0xff52, 'Up'],
  [0xff53, 'Right'],
  [0xff54, 'Down'],
  [0xff55, 'Page_Up'],
  [0xff56, 'Page_Down'],
  [0xff57, 'End'],
  [0xff58, 'Begin'],
  [0xff63, 'Insert'],
  [0xff67, 'Menu'],
  [0xff7f, 'Num_Lock'],
  [0xff8d, 'KP_Enter'],
  [0xff95, 'KP_Home'],
  [0xff96, 'KP_Left'],
  [0xff97, 'KP_Up'],
  [0xff98, 'KP_Right'],
  [0xff99, 'KP_Down'],
  [0xff9a, 'KP_Page_Up'],
  [0xff9b, 'KP_Page_Down'],
  [0xff9c, 'KP_End'],
  [0xff9e, 'KP_Insert'],
  [0xff9f, 'KP_Delete'],
  [0xffaa, 'KP_Multiply'],
  [0xffab, 'KP_Add'],
  [0xffac, 'KP_Separator'],
  [0xffad, 'KP_Subtract'],
  [0xffae, 'KP_Decimal'],
  [0xffaf, 'KP_Divide'],
  [0xffbd, 'KP_Equal'],
  [0xffff, 'Delete'],
]);

// KP_0..KP_9 and F1..F35 are contiguous ranges; spelling them out by hand is
// forty more chances to typo a hex literal.
for (let i = 0; i <= 9; i += 1) NAMED_KEYS.set(0xffb0 + i, `KP_${i}`);
for (let i = 1; i <= 35; i += 1) NAMED_KEYS.set(0xffbd + i, `F${i}`);
// The modifier keys themselves. Spelled out rather than derived from
// `COMBINING_MODIFIERS`, because that map deliberately collapses left and
// right onto ONE combo name (`ctrl`) and a key NAME cannot be collapsed the
// same way: deriving it gave both 0xffe3 and 0xffe4 the name `Control_L`,
// which is not what `xev` prints for either half and not what a runtime
// parsing the combo back would send.
NAMED_KEYS.set(0xffe1, 'Shift_L');
NAMED_KEYS.set(0xffe2, 'Shift_R');
NAMED_KEYS.set(0xffe3, 'Control_L');
NAMED_KEYS.set(0xffe4, 'Control_R');
NAMED_KEYS.set(0xffe5, 'Caps_Lock');
NAMED_KEYS.set(0xffe6, 'Shift_Lock');
NAMED_KEYS.set(0xffe7, 'Meta_L');
NAMED_KEYS.set(0xffe8, 'Meta_R');
NAMED_KEYS.set(0xffe9, 'Alt_L');
NAMED_KEYS.set(0xffea, 'Alt_R');
NAMED_KEYS.set(0xffeb, 'Super_L');
NAMED_KEYS.set(0xffec, 'Super_R');
NAMED_KEYS.set(0xffed, 'Hyper_L');
NAMED_KEYS.set(0xffee, 'Hyper_R');
NAMED_KEYS.set(0xfe03, 'ISO_Level3_Shift');
NAMED_KEYS.set(0xff7e, 'Mode_switch');

/** The name of a modifier this keysym holds down, or null if it is not one. */
export function combiningModifier(keysym: number): string | null {
  return COMBINING_MODIFIERS.get(keysym) ?? null;
}

/** Whether this keysym is a modifier the client already folded into other keysyms. */
export function isAppliedModifier(keysym: number): boolean {
  return APPLIED_MODIFIERS.has(keysym);
}

/**
 * The text this keysym types, or null when it types nothing.
 *
 * Three ranges, all from the X11 protocol rather than from taste: Latin-1
 * keysyms ARE their code points, and anything else printable arrives as a
 * Unicode keysym (0x01000000 + code point). A keysym that is neither is a key
 * with a name, not text.
 */
export function typedText(keysym: number): string | null {
  if (keysym >= 0x20 && keysym <= 0x7e) return String.fromCodePoint(keysym);
  if (keysym >= 0xa0 && keysym <= 0xff) return String.fromCodePoint(keysym);
  if (keysym >= 0x01000020 && keysym <= 0x0110ffff) {
    const codePoint = keysym - 0x01000000;
    // A lone surrogate is not a character; String.fromCodePoint would happily
    // produce one and it would corrupt the JSON payload downstream.
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
    if (codePoint === 0x7f) return null;
    return String.fromCodePoint(codePoint);
  }
  return null;
}

/**
 * What `key(combo)` should be handed for this keysym under these modifiers.
 *
 * An unnamed keysym renders as its hex value, which is how `xev` and
 * `xmodmap` print one and is what makes the combo round-trippable: the skill
 * runtime can parse it back to the number it has to send.
 */
export function keyCombo(keysym: number, modifiers: Iterable<number>): string {
  const names = new Set<string>();
  for (const held of modifiers) {
    const name = COMBINING_MODIFIERS.get(held);
    if (name !== undefined) names.add(name);
  }
  const prefix = MODIFIER_ORDER.filter((name) => names.has(name));
  return [...prefix, keyName(keysym)].join('+');
}

/** The X11 name for a keysym, falling back to the hex form X11 tools print. */
function keyName(keysym: number): string {
  const named = NAMED_KEYS.get(keysym);
  if (named !== undefined) return named;
  const text = typedText(keysym);
  if (text !== null) return text;
  return `0x${keysym.toString(16)}`;
}
