/**
 * Composer send/stop state machine.
 *
 * The composer has exactly two modes, driven by whether the bot is generating:
 *
 * idle: [＋] [ textarea ] [▶ send] — send enabled iff draft non-empty
 * OR a ready attachment exists
 * active: [＋] [ textarea ] [■ stop] — stop always enabled
 *
 * Rules straight from the PRD (M1 acceptance):
 * - `bot.cancel` must abort an in-flight generation within 500 ms and KEEP
 * the partial text — so stopping never clears the transcript, it ends it.
 * - The draft is preserved across send/stop; clearing on send is the
 * composer's only draft mutation.
 *
 * A message needs text OR at least one attachment.
 * Attachment-only sends are valid; the empty-nothing case (no text AND no
 * ready attachment) never reaches the network — the send gate rejects it.
 *
 * Pure functions so the transition table is unit-testable without React.
 */

export type ComposerMode = 'idle' | 'active';

export interface ComposerState {
  mode: ComposerMode;
  draft: string;
}

/**
 * Send gate. `hasReadyAttachment` is supplied by the caller (App owns the
 * pending-upload map): true when at least one staged upload has a server id.
 */
export function canSend(state: ComposerState, hasReadyAttachment = false): boolean {
  if (state.mode !== 'idle') return false;
  return state.draft.trim().length > 0 || hasReadyAttachment;
}

export function draftChanged(state: ComposerState, draft: string): ComposerState {
  return { ...state, draft };
}

/** Sending transitions idle → active and clears the (already-consumed) draft. */
export function send(state: ComposerState, hasReadyAttachment = false): ComposerState | null {
  if (!canSend(state, hasReadyAttachment)) return null;
  return { mode: 'active', draft: '' };
}

/** Stopping returns to idle; the partial reply stays in the transcript. */
export function stop(state: ComposerState): ComposerState {
  if (state.mode !== 'active') return state;
  return { ...state, mode: 'idle' };
}

/** The bot finished on its own — mirror the UI back to idle. */
export function completed(state: ComposerState): ComposerState {
  if (state.mode !== 'active') return state;
  return { ...state, mode: 'idle' };
}

/** Switching bots keeps the mode honest: a busy bot stays active, idle stays idle. */
export function botSwitched(state: ComposerState, newBotIsGenerating: boolean): ComposerState {
  if (newBotIsGenerating && state.mode === 'idle') return { ...state, mode: 'active' };
  if (!newBotIsGenerating && state.mode === 'active') return { ...state, mode: 'idle' };
  return state;
}

/**
 * Apply seeded composer text (e.g., a welcome starter or a `Review then send`
 * handoff decision option). `mode: 'append'` preserves any unsent draft text
 * separated by a blank line and never sends automatically.
 */
export function applyComposerSeed(
  state: ComposerState,
  seed: { readonly text: string; readonly mode?: 'replace' | 'append' | undefined },
): ComposerState {
  if (seed.text === '') return state;
  if (seed.mode === 'append' && state.draft.trim() !== '') {
    return draftChanged(state, `${state.draft.trimEnd()}\n\n${seed.text}`);
  }
  return draftChanged(state, seed.text);
}
