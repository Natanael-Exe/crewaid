import { isPartOutput, type AnyPart } from '../components/PartRenderer';
import { isBotWorkPart } from './transcriptPrefs';
import { incompleteReason, type TranscriptMessage } from './viewTypes';

/**
 * How one message's parts become rows on screen.
 *
 * ⚠️ The rule this file exists for: **a bubble is something the bot SAID.**
 * Everything else a turn produces — the thinking between two sentences, the
 * twenty actions it took, a part this build does not know about — is work, and
 * work sits outside the bubble as a quiet row.
 *
 * Before this, every part of a turn went inside one bubble, so a long agentic
 * turn rendered as a single grey slab holding four paragraphs, eleven thinking
 * blocks and an action log, with a timestamp at the bottom. The reference
 * (ref-01, and the Grok transcript it was drawn from) is the opposite: short
 * bubbles, one per thing said, with the machinery between them.
 *
 * A pure function over parts, tested on its own, because the alternative is
 * this logic living as nested ternaries inside JSX where nothing can reach it.
 */

export type TranscriptRow =
  /** Speech. Gets a bubble. */
  | { readonly kind: 'bubble'; readonly key: string; readonly part: AnyPart }
  /** Work. Gets a quiet row in the bot's lane, no bubble. */
  | { readonly kind: 'aside'; readonly key: string; readonly part: AnyPart };

/**
 * The part types that are speech. Deliberately a closed list rather than
 * "anything the registry can render": a part type added in a later milestone
 * is work until somebody decides otherwise, and the failure mode of guessing
 * wrong in this direction is a quiet row instead of a bubble — recoverable,
 * unlike a tool-call log rendered as something the bot told you.
 */
const SPEECH_TYPES: ReadonlySet<string> = new Set(['text']);

/** A part's text, or '' for a part that carries none. Also what Copy copies. */
export function textOfPart(part: AnyPart): string {
  const text = (part as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

export function toTranscriptRows(parts: readonly AnyPart[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  parts.forEach((part, index) => {
    // An empty text part is not a silence the operator should see — the SDK
    // emits one for a step that only called a tool, and a bubble with nothing
    // in it reads as a message that failed to load.
    if (SPEECH_TYPES.has(part.type)) {
      if (textOfPart(part).trim() === '') return;
      rows.push({ kind: 'bubble', key: `p${index}`, part });
      return;
    }
    rows.push({ kind: 'aside', key: `p${index}`, part });
  });
  return rows;
}

/** Whether anything in this message is spoken, for the callers that care. */
export function hasBubble(rows: readonly TranscriptRow[]): boolean {
  return rows.some((row) => row.kind === 'bubble');
}

export function isRowVisible(row: TranscriptRow, showWork: boolean): boolean {
  return (
    showWork || row.kind === 'bubble' || !isBotWorkPart(row.part.type) || isPartOutput(row.part)
  );
}

/** Hidden work must not leave an empty message box or a virtual height behind. */
export function hasVisibleTranscriptContent(
  message: TranscriptMessage,
  showWork: boolean,
): boolean {
  if (message.startsTopic === true || (message.author === 'USER' && message.taskId !== undefined))
    return true;
  if ((message.attachments?.length ?? 0) > 0 || incompleteReason(message.stopReason) !== null)
    return true;
  return toTranscriptRows(message.parts).some((row) => isRowVisible(row, showWork));
}
