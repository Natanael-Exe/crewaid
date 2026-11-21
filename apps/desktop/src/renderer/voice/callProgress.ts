import { speakable } from '@crewaid/shared';
import type { TranscriptMessage } from '../state/viewTypes';
import { partField } from '../components/PartRenderer';
import { toolPresentation } from '../components/tools/toolPresentation';

/** What the voice is told of the bot's latest narration: its tail, not the whole reply. */
const NARRATION_CHARS = 400;

function action(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const name = 'toolName' in value ? value.toolName : undefined;
  const status = 'status' in value ? value.status : undefined;
  if (typeof name !== 'string' || typeof status !== 'string') return null;
  return `${toolPresentation(name).title} (${status})`;
}

/**
 * What the bot is visibly doing, as one line of plain text for the
 * call's work status. Only the live reply's narration and action labels: never
 * reasoning, and never a tool's arguments or results.
 *
 * Called while a call waits on the bot, so a long reply is cut before it is
 * rewritten — `speakable` over the whole reply on every streamed token is the
 * cost this avoids.
 */
export function liveBotProgress(messages: readonly TranscriptMessage[]): string | null {
  const message = messages.findLast((row) => row.author === 'BOT' && row.live && !row.fromBotId);
  if (message === undefined) return null;
  let narration: string | null = null;
  let activity: string | null = null;
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i];
    if (part === undefined) continue;
    if (narration === null && part.type === 'text' && typeof part.text === 'string') {
      narration = speakable(part.text.slice(-NARRATION_CHARS)).trim() || null;
    }
    if (activity !== null) continue;
    if (part.type === 'tool-call') activity = action(part);
    if (part.type === 'tool-activity') {
      const calls = partField(part, 'calls');
      if (Array.isArray(calls)) {
        const latest: unknown =
          calls.findLast(
            (call: unknown) =>
              typeof call === 'object' &&
              call !== null &&
              'status' in call &&
              call.status === 'running',
          ) ?? calls.at(-1);
        activity = action(latest);
      }
    }
  }
  const lines = [
    ...(activity === null ? [] : [`Doing: ${activity}.`]),
    ...(narration === null ? [] : [`Latest words: ${narration}`]),
  ];
  return lines.length === 0 ? null : lines.join(' ');
}
