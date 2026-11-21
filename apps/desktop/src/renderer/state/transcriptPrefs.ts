import { useSyncExternalStore } from 'react';

/**
 * Whether the transcript shows a bot's work — its thinking and the actions it
 * took — or only what it said. Off by default: the reply already says what
 * was done, and a stack of "Thought about this" and "Completed 1 action" rows
 * between every exchange is furniture most people never open. Anyone who wants
 * to check the work turns it on in Settings.
 *
 * A display preference for this device, so it lives in the renderer's own
 * storage beside the pane widths, not on the orchestrator. One store for the
 * window, so the Settings switch and every open transcript agree at once.
 */
const KEY = 'crewaid.transcript.showBotWork';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Hardened profiles can refuse storage; the default then holds.
    return null;
  }
}

export function readShowBotWork(store: StorageLike | null): boolean {
  try {
    return store?.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
let current: boolean | null = null;

function snapshot(): boolean {
  current ??= readShowBotWork(storage());
  return current;
}

export function setShowBotWork(value: boolean): void {
  current = value;
  try {
    storage()?.setItem(KEY, String(value));
  } catch {
    // Kept for this session even when it cannot be kept for the next.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The preference, and a re-render wherever it is read when it changes. */
export function useShowBotWork(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** The part types that are a bot's work rather than its speech. */
const WORK_PART_TYPES: ReadonlySet<string> = new Set([
  'reasoning',
  'reasoning-block',
  'tool-call',
  'tool-result',
  'tool-error',
  'tool-output-denied',
  'tool-activity',
]);

export function isBotWorkPart(type: string): boolean {
  return WORK_PART_TYPES.has(type);
}
