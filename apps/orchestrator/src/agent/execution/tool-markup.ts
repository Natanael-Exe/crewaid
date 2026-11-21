import type { ModelMessage } from '@tanstack/ai';

/**
 * openers a provider's tool-call syntax starts with, when a model
 * writes the call as text instead of making it. Matched only at the start of
 * a reply, so prose that explains the syntax is not caught.
 */
const OPENERS = [
  '<tool_call>',
  '<tool_use>',
  '<function_calls>',
  '<invoke ',
  '<function=',
  '<|tool_call|>',
  '<|python_tag|>',
  '<｜tool▁calls▁begin｜>',
  '<|tool_calls_begin|>',
  '[TOOL_CALLS]',
];

function textOf(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content === null) return '';
  return message.content
    .map((part) => ('content' in part && typeof part.content === 'string' ? part.content : ''))
    .join('');
}

/** The final reply, when it is a tool call written as text rather than made. */
export function leakedToolMarkup(messages: readonly ModelMessage[]): ModelMessage | undefined {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || (last.toolCalls?.length ?? 0) > 0) return undefined;
  const text = textOf(last).trimStart();
  return OPENERS.some((opener) => text.startsWith(opener)) ? last : undefined;
}
