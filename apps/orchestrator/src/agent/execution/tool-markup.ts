import type { ModelMessage } from '@tanstack/ai';
import { detectCorruptPublicOutput } from '@crewaid/shared';

function textOf(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content === null) return '';
  return message.content
    .map((part) => ('content' in part && typeof part.content === 'string' ? part.content : ''))
    .join('');
}

/**
 * The final reply, when it contains leaked tool-call markup outside code or
 * high-confidence degenerate repetition rather than a valid spoken answer.
 */
export function leakedToolMarkup(messages: readonly ModelMessage[]): ModelMessage | undefined {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || (last.toolCalls?.length ?? 0) > 0) return undefined;
  return detectCorruptPublicOutput(textOf(last)) !== null ? last : undefined;
}
