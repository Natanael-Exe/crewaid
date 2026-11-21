import type { AnyTextAdapter } from '@tanstack/ai';
import { ModelSetupError } from './model-setup-error.js';

/**
 * The models a hosted plan includes, as the model layer sees them.
 *
 * Registered under `INCLUDED_MODELS` by the billing module on a cloud server
 * that bills and has Crewaid's own OpenRouter key; absent everywhere else, so
 * the model layer carries no notion of a plan and a self-hosted server never
 * has a model it does not pay for itself.
 */
export interface IncludedModels {
  /**
   * Make sure this account has its `crewaid` connection and the current list
   * of included models, and a default if it has no other way to answer. Cheap
   * when nothing is missing; called before anything lists models.
   */
  ensureFor(userId: string): Promise<void>;
  /**
   * A text adapter for one included upstream model, charged to this account's
   * allowance call by call: every chat, structured-output and
   * structured-stream call reserves before it runs and settles once after.
   * Throws `ModelAllowanceExhaustedError` when the allowance is already spent.
   */
  textAdapter(userId: string, upstreamModelId: string): Promise<AnyTextAdapter>;
}

export const INCLUDED_MODELS = Symbol('INCLUDED_MODELS');

/**
 * The plan's included model use for this period is spent.
 *
 * Thrown before a call is made, never after one — a call already under way
 * finishes and is charged, so a turn is not cut off mid-sentence, and the next
 * call is the one refused. Normalised to `ALLOWANCE_EXHAUSTED`, whose message
 * names both ways forward: the user's own key, or a larger plan.
 */
export class ModelAllowanceExhaustedError extends Error {
  readonly code = 'ALLOWANCE_EXHAUSTED' as const;
  constructor() {
    super('The included model allowance for this billing period is used up.');
    this.name = 'ModelAllowanceExhaustedError';
  }
}

/** The included models need a server that bills; this one does not, or no longer does. */
export class IncludedModelsUnavailableError extends ModelSetupError {
  readonly code = 'MODEL_NEEDS_CREDENTIAL' as const;
  constructor() {
    super({ key: 'includedModelsUnavailable' });
    this.name = 'IncludedModelsUnavailableError';
  }
}
