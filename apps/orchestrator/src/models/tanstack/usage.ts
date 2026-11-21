import { fromSpecTokenUsage, type SpecTokenUsage, type TokenUsage } from '@tanstack/ai';
import type { BuiltTextAdapter } from './text-adapter.js';

/**
 * A TanStack adapter's usage in the counters Crewaid bills and
 * reports: input is ALL input, with the cached read and the cache
 * write as parts of it, never instead of it.
 *
 * The providers disagree about what "prompt tokens" means, and the adapters
 * pass their figure through:
 *
 * - OpenAI-compatible APIs (OpenAI, OpenRouter, a custom endpoint) count a
 * cached read inside `prompt_tokens`, so the prompt figure is the total.
 * - Anthropic's `input_tokens` is only the fresh part. A call with 100 fresh,
 * 200 written to the cache and 300 read from it is 600 input tokens, of
 * which 300 were cached and 200 created a cache entry. Reading its 100 as
 * the input would bill a cached conversation as nearly free.
 */
export type NormalizedUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
};

/**
 * `null` when the provider reported no usage at all. Unknown is not zero: a
 * zero would price the call as free, and the reservation it settles
 * would release money that was spent.
 */
export function normalizeUsage(
  kind: BuiltTextAdapter['kind'],
  reported: TokenUsage | ReadonlyArray<SpecTokenUsage> | undefined,
): NormalizedUsage | null {
  // A run event carries the library's figure on the server, or the AG-UI
  // spec's `usage[]` once it has crossed a wire; both read the same way.
  const usage =
    reported !== undefined && isSpecUsage(reported) ? fromSpecTokenUsage(reported) : reported;
  if (usage === undefined) return null;
  const cached = usage.promptTokensDetails?.cachedTokens ?? 0;
  const written = usage.promptTokensDetails?.cacheWriteTokens ?? 0;
  const inputTokens =
    kind === 'anthropic' ? usage.promptTokens + cached + written : usage.promptTokens;
  return {
    inputTokens,
    outputTokens: usage.completionTokens,
    cachedInputTokens: cached,
    cacheCreationTokens: written,
  };
}

export function isSpecUsage(
  usage: TokenUsage | ReadonlyArray<SpecTokenUsage>,
): usage is ReadonlyArray<SpecTokenUsage> {
  return Array.isArray(usage);
}
