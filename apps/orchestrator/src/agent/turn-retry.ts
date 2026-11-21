import type { ModelErrorCode } from '@crewaid/shared';

/**
 * Carrying a run across a TRANSIENT provider failure.
 *
 * The saved thread carries completed tool results into the next attempt.
 * The model and the operator need different explanations of the handoff.
 */

/** The model's half: why the previous attempt died, and that nothing was lost. */
export function retryContinuationInstruction(code: ModelErrorCode): string {
  return (
    `Your previous attempt failed partway with a transient model-provider error (${code}). ` +
    'The work above is saved. Continue from where it stopped and finish the task — do not start ' +
    'over and do not repeat what is already done above.'
  );
}

/** The operator's half: what happened, and that the bot is retrying without requiring an action. */
export function retryOperatorCopy(): string {
  return 'The connection to the model was interrupted. Retrying automatically.';
}
