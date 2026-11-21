import type { ChatMiddleware, ModelMessage } from '@tanstack/ai';
import {
  clearToolResults,
  composeStrategies,
  evictOldest,
  withCompaction,
  type CompactionInfo,
} from '@tanstack/ai-compaction';

/**
 * what one model call is sent of a TanStack thread's history.
 *
 * A TanStack run loads the whole canonical thread; this bounds the PROVIDER's
 * copy (`providerMessages`) and never the canonical one, so the transcript,
 * replay and every later run still read everything that was said. System
 * prompts are not messages, so the identity prefix and the memory-last order
 * are untouched. It is not a spending cap: it decides how much
 * history one call carries, never whether a run may continue.
 *
 * Strategy: old tool output is cleared first (it is usually the bulk, and
 * clearing keeps every call/result pair in place), then the oldest messages are
 * dropped behind a marker, at a message boundary, so no tool result is ever
 * separated from its call. The newest messages — a resumed run's pending calls
 * among them — are always kept.
 */

/** Tool results kept verbatim before older ones are cleared. */
const KEEP_TOOL_RESULTS = 6;

/**
 * An image's cost, roughly what providers charge for one at their default
 * resolution. Counting its base64 bytes instead would price a photo at
 * hundreds of thousands of tokens and evict it the moment it arrived.
 */
const IMAGE_TOKENS = 1_600;

/** Characters / 4 for text, a fixed price per image. */
export function estimateTokens(message: ModelMessage): number {
  let chars = 0;
  let images = 0;
  if (typeof message.content === 'string') chars += message.content.length;
  else if (Array.isArray(message.content))
    for (const part of message.content) {
      if (part.type === 'image') images += 1;
      else if (part.type === 'text') chars += part.content.length;
      else chars += JSON.stringify(part).length;
    }
  if (message.toolCalls !== undefined) chars += JSON.stringify(message.toolCalls).length;
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS;
}

export function providerCompaction(input: {
  readonly maxTokens: number;
  readonly onCompact?: (info: CompactionInfo) => void;
}): ChatMiddleware {
  return withCompaction({
    maxTokens: input.maxTokens,
    estimateTokens,
    strategy: composeStrategies(
      clearToolResults({
        keepRecentToolResults: KEEP_TOOL_RESULTS,
        stub: '[earlier tool output cleared to save context]',
      }),
      evictOldest({
        marker: (count) => `[${String(count)} earlier message(s) omitted to save context.]`,
      }),
    ),
    strategyKey: `crewaid-v1:${String(KEEP_TOOL_RESULTS)}`,
    ...(input.onCompact === undefined ? {} : { onCompact: input.onCompact }),
  });
}
