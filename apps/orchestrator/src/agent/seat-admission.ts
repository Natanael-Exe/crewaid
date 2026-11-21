import type { ToolSet, ToolCallOptions } from './tool-contract.js';
import type { SeatActionKind, SeatAdmission } from '../screen/seat-control.js';

/**
 * The bot's side of seat control, at the one place a tool call is
 * dispatched.
 *
 * Every path that can change what is on a seat waits while a person drives
 * it and is refused if they keep it; a path that targets what is on screen is
 * also refused after a hand-back until the bot has looked. Reads run whenever,
 * and a read while the bot holds the seat is what lets it act again. Files,
 * memory, the board, Work, messages, routines and plugins are not the seat
 * and are never held back by it.
 */
export const SEAT_TOOL_KINDS: Readonly<Record<string, SeatActionKind | 'observation'>> = {
  // Acting on what is shown: a click, a field, a key, a pointer, a replay.
  browser_click: 'targeted',
  browser_type: 'targeted',
  mouse_move: 'targeted',
  mouse_click: 'targeted',
  mouse_scroll: 'targeted',
  keyboard: 'targeted',
  // Acting on the seat without aiming at what is shown.
  browser_navigate: 'untargeted',
  // A shell can reach the display.
  shell: 'untargeted',
  // It replaces the seat's browser.
  use_identity: 'exclusive',
  // Looking.
  browser_read: 'observation',
  screenshot: 'observation',
  capture_screen: 'observation',
};

/** What a turn's tools reach seat control through; absent where there is none. */
export type SeatPort = {
  readonly admit: (kind: SeatActionKind, signal?: AbortSignal) => Promise<SeatAdmission>;
  readonly beginObservation: () => () => void;
};

type Definition = ToolSet[string];
type Execute = (input: unknown, options: ToolCallOptions) => unknown;

export function withSeatAdmission(set: ToolSet, seat: SeatPort | undefined): ToolSet {
  if (seat === undefined) return set;
  const gated: ToolSet = {};
  for (const [name, definition] of Object.entries(set)) {
    const kind = SEAT_TOOL_KINDS[name];
    gated[name] =
      kind === undefined || kind === 'observation' ? definition : gate(definition, kind, seat);
  }
  return gated;
}

function gate(definition: Definition, kind: SeatActionKind, seat: SeatPort) {
  const execute = definition.execute;
  if (execute === undefined) return definition;

  const gatedExecute: Execute = async (input, options) => {
    const admission = await seat.admit(kind, options.abortSignal);
    // A refusal is the tool's RESULT, worded for the model to act on, never
    // an exception: the turn goes on and the model chooses what to do next.
    if (!admission.ok) return `${admission.refusal.message} (${admission.refusal.code})`;
    try {
      return await execute(input, options);
    } finally {
      admission.release();
    }
  };
  return { ...definition, execute: gatedExecute };
}
