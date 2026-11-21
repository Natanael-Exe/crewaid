import type { Logger } from '@nestjs/common';

import { normalizeModelError } from '../models/normalize-error.js';
import { CompileRefused } from './skill-compile.contract.js';

/**
 * The two things every bounded model call in the skill machinery does the same
 * way: a deadline that settles a wedged provider, and a provider failure
 * turned into an operator sentence.
 *
 * Shared rather than copied because the compile job and the D-098 revise route
 * ask models the same way and fail the same way, and a second copy is how the
 * two drift: one of them gaining a missing `unref`, or losing D-006's
 * conversion, is invisible until a provider misbehaves.
 */

/**
 * Hold one model call to `deadlineMs` (the bounded attempt budget).
 *
 * Both halves of an overrun are wanted: the race settles the attempt promptly
 * with a readable sentence, and the abort tears the provider request down
 * instead of leaving it connected to work nobody is waiting for. The losing
 * attempt keeps a handler so a rejection that arrives after the deadline — an
 * abort, a late provider error — is never an unhandled one.
 */
export async function withDeadline<T>(
  deadlineMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const expired = (): CompileRefused =>
    new CompileRefused(`the compiler did not finish within ${deadlineMs / 1000} seconds`);
  // Assigned synchronously by the executor below, so it is always a timer by
  // the time anything can clear it.
  let timer!: NodeJS.Timeout;
  const expiry = new Promise<never>((_resolve, reject) => {
    // `unref`, like every other background timer here: an in-flight model call
    // must never be the thing holding a shutdown open.
    timer = setTimeout(() => {
      controller.abort();
      reject(expired());
    }, deadlineMs).unref();
  });
  let attempt: Promise<T> | undefined;
  try {
    // Inside the try: a `work` that threw synchronously would otherwise skip
    // the `finally`, leaving the timer armed to reject `expiry` a minute later
    // with nothing attached to it — an unhandled rejection, which Node ends
    // the process on.
    attempt = work(controller.signal);
    // The `await` is load-bearing, not noise: without it the `finally` below
    // runs the moment the race is BUILT, clearing the deadline timer before it
    // can ever fire — a compile whose model never answers would then wait
    // forever instead of failing at the bound.
    return await Promise.race([attempt, expiry]);
  } catch (error: unknown) {
    // Whatever the abort produced — a fetch's AbortError, a provider error
    // that landed in the same tick — a settled deadline is reported as the
    // deadline, not as whatever the teardown happened to raise.
    if (controller.signal.aborted) throw expired();
    throw error;
  } finally {
    clearTimeout(timer);
    // Never left unhandled, whether or not `work` got far enough to make it.
    void expiry.catch(() => undefined);
    if (attempt !== undefined) void attempt.catch(() => undefined);
  }
}

/**
 * A provider failure, turned into a refusal where the caller still knows a
 * model was involved — and its vendor text logged on the way past.
 *
 * D-006 bars that text from a user-visible surface, not from the log, and the
 * operator sentence replacing it says to check the log. Dropping `detail`
 * therefore makes its own instruction a dead end: the row and the log would
 * both read "The model provider returned an unexpected error. Check logs for
 * detail." and the detail would exist nowhere.
 * `tanstack-execution-backend.ts` logs it for the same reason.
 */
export function refuseModelFailure(error: unknown, phase: string, logger: Logger): CompileRefused {
  if (error instanceof CompileRefused) return error;
  const normalized = normalizeModelError(error);
  logger.error(
    `skill ${phase} failed: ${normalized.code}` +
      (normalized.detail === undefined ? '' : ` — ${normalized.detail}`),
  );
  return new CompileRefused(`${normalized.message} (${normalized.code})`);
}

/**
 * The corrective message: the retry the validator's verdict buys.
 *
 * The retry is a fresh request — a model has no memory of the answer that was
 * rejected — so the message names each defect and asks for the whole answer
 * again. Nothing refers to something the model cannot see: whatever task
 * produced the rejected answer (a trace, or a skill being revised) is still in
 * front of it.
 */
export function correctedTask(task: string, defects: readonly string[]): string {
  return `${task}

---

The previous answer to this task was rejected by the output validator:
${defects.map((defect) => `  - ${defect}`).join('\n')}

Return the whole corrected answer — the same task, with every problem above fixed.`;
}
