import type { RecordingWarning } from '@crewaid/shared';

/**
 * §6/M3's hard limits, verbatim: "Hard limits: 20 minutes, 5000
 * events. Exceeding either auto-stops and marks the recording `READY` with a
 * warning."
 *
 * What the ceilings actually protect
 *
 * Not disk. §8's idle sweep asks whether the bot has a row in state
 * `RECORDING` and refuses to stop its sandbox while one exists, so before
 * these ceilings a recording nobody stopped kept a container running for as
 * long as the orchestrator did — the one way a desktop could stay up
 * indefinitely with nobody asking it to. The time ceiling is what ends that,
 * and it is why the deadline has to hold with no input arriving at all: the
 * recording that runs away is precisely the one the user walked away from.
 *
 * The event ceiling bounds a different cost. The compiler sends
 * the whole ordered trace to a model, so every captured event is tokens in
 * one request; a trace that grew without bound would fail at compile time,
 * after the recording, where the user can no longer do anything about it.
 * Refusing to capture the 5001st event fails at the only moment the user is
 * still there to start again.
 *
 * Why these are constants
 *
 * §0 rule 2 forbids inventing config keys, and the PRD fixes both numbers.
 * They are exported so tests can state the boundary in terms of the limit
 * rather than restating 5000 in two places, which is how a limit and its test
 * drift apart.
 */

/** 20 minutes. */
export const MAX_RECORDING_MS = 20 * 60 * 1000;

/** 5000 events. */
export const MAX_RECORDING_EVENTS = 5000;

/**
 * The ceiling this recording has reached, or null while it is within both.
 *
 * Inclusive on purpose. The time ceiling is checked before a newly arriving
 * frame is captured. The event ceiling is checked after the whole frame is
 * appended, so an input that releases multiple coalesced rows can leave the
 * trace a few rows over 5000 rather than split one gesture in the middle.
 *
 * `elapsedMs` is the caller's arrival time, not a clock read here — the same
 * reason the coalescers take one (`recording-events.ts`): a twenty-minute
 * deadline should be expressible as a fixture rather than a twenty-minute
 * test.
 *
 * Both can be true in the same instant, and then the event ceiling is the one
 * reported: it is a fact about the trace the user is left holding, while the
 * clock is a fact about the session that produced it.
 */
export function breachedLimit(elapsedMs: number, events: number): RecordingWarning | null {
  if (events >= MAX_RECORDING_EVENTS) return 'EVENT_LIMIT';
  if (elapsedMs >= MAX_RECORDING_MS) return 'TIME_LIMIT';
  return null;
}
