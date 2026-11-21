import { ModelSetupError } from './model-setup-error.js';

/** The share of a model's context window the history may fill; the rest is prompt, tools and reply. */
const HISTORY_SHARE = 0.5;

export class ContextBudgetError extends ModelSetupError {
  readonly code = 'CONTEXT_BUDGET_UNKNOWN' as const;

  constructor(readonly contextWindow: number) {
    super({ key: 'contextBudgetUnknown' });
    this.name = 'ContextBudgetError';
  }
}

/**
 * The history budget for one call: half the model's window, and never more
 * than the operator's `AGENT_CONTEXT_TRIM_TOKENS` (D-048's number, which the
 * AI SDK path trims at).
 */
export function historyBudget(contextWindow: number, trimTokens: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
    throw new ContextBudgetError(contextWindow);
  return Math.min(trimTokens, Math.floor(contextWindow * HISTORY_SHARE));
}
