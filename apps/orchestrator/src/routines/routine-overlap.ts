/**
 * "Overlapping runs are prevented: if the previous run is still
 * active, the new one is skipped and logged, not queued."
 *
 * What "still active" is measured against
 *
 * BullMQ's active set, not `Routine.lastStatus`. The row says RUNNING from
 * the moment a firing starts, but it is written by the process doing the
 * work — and a process killed mid-turn never writes the ending. A check on
 * the row would then skip every later firing of that routine forever, which
 * is the one failure worse than an overlap. An active job is held by a
 * worker's lock; a worker that dies stops renewing it, BullMQ's stall check
 * takes the job out of the active set, and the next firing runs. The signal
 * heals itself, which is what makes it safe to refuse on.
 *
 * A firing's job stays active for as long as its work does (D-119: the
 * runner awaits the turn or the skill run), so "another active firing of
 * this routine" is "the previous run is still going".
 *
 * Why the older firing wins a tie
 *
 * Two firings of one routine can become active in the same instant — a
 * run-now pressed as the schedule comes due, or two workers. Each sees the
 * other. If each deferred to any other it would see, both would skip and the
 * slot would run zero times; so exactly one must yield, and it is the newer:
 * the older job was due first and is the one the operator was waiting for.
 * Ordered by enqueue time, then by id, so the answer is the same from both
 * sides.
 */

/** The fields of a job this decision reads. */
export interface FiringRef {
  readonly id: string | undefined;
  readonly timestamp: number;
  readonly routineId: string;
}

/**
 * The active firing that holds `me`'s routine, or `null` if `me` may run.
 *
 * `active` is the queue's active set as the worker sees it, which includes
 * `me` itself.
 */
export function heldBy(me: FiringRef, active: readonly FiringRef[]): FiringRef | null {
  for (const other of active) {
    if (other.routineId !== me.routineId || other.id === me.id) continue;
    if (isOlder(other, me)) return other;
  }
  return null;
}

function isOlder(a: FiringRef, b: FiringRef): boolean {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp;
  return (a.id ?? '') < (b.id ?? '');
}
