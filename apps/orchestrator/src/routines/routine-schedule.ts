import { CronExpressionParser } from 'cron-parser';

/**
 * What a routine's `cron` and `timezone` mean, decided in one place.
 *
 * Why the parser bullmq uses, and not a second one
 *
 * BullMQ's job scheduler computes every next firing with `cron-parser`, and
 * this module imports the same pinned version. That is the whole point of it:
 * a validator or an expansion built on a different library would answer a
 * different question from the one Redis is asked, and the place they disagree
 * is exactly the DST edge §6/M8 names as an acceptance criterion. What this
 * file says a routine will do is what the queue does, because it is the same
 * code doing it.
 *
 * Why five fields is checked here
 *
 * `cron-parser` also accepts a six-field expression whose first field is
 * seconds. PRD §3 says a routine's cron is 5-field, and `* * * * * *` handed
 * to the scheduler would fire every SECOND — each firing a model turn. The
 * field count is not a formality; it is the difference between a routine and
 * a runaway bill.
 */

/** Why a routine's schedule cannot be used, phrased for the operator. */
export class RoutineScheduleError extends Error {
  override readonly name = 'RoutineScheduleError';
}

/** A schedule that has been checked, in the shape the scheduler is given. */
export interface RoutineSchedule {
  /** The cron expression, whitespace-normalised. */
  readonly pattern: string;
  /** The IANA zone its wall-clock fields are read in. */
  readonly tz: string;
}

/**
 * Check a routine's schedule, or throw a sentence saying what is wrong.
 *
 * The timezone is checked with `Intl` before the parser sees it, because
 * `cron-parser` does not reject an unknown zone — it fails later, on the first
 * `next`, with "unhandled timestamp: Invalid Date", which names neither the
 * field nor the value the operator typed.
 */
export function parseRoutineSchedule(cron: string, timezone: string): RoutineSchedule {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === '') {
    throw new RoutineScheduleError(
      `cron must have exactly 5 fields (minute hour day-of-month month day-of-week), ` +
        `got ${JSON.stringify(cron)}`,
    );
  }
  if (!isKnownTimezone(timezone)) {
    throw new RoutineScheduleError(
      `timezone must be an IANA zone such as "America/New_York", got ${JSON.stringify(timezone)}`,
    );
  }
  const pattern = fields.join(' ');
  try {
    CronExpressionParser.parse(pattern, { tz: timezone });
  } catch (error) {
    throw new RoutineScheduleError(
      `cron ${JSON.stringify(cron)} is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { pattern, tz: timezone };
}

/**
 * The next `count` firings of a schedule strictly after `after`.
 *
 * Exactly what the scheduler will do, for the reason given at the top of the
 * file. Two DST behaviours fall out of the parser rather than out of this
 * function, and they are the ones an operator would expect:
 *
 * - a wall-clock time that does not exist (02:30 on the spring-forward day in
 *   New York) fires once, an hour later in wall-clock terms, rather than
 *   being skipped;
 * - a wall-clock time that happens twice (01:30 on the fall-back day) fires
 *   once, at its first occurrence, while an interval such as `*\/30` keeps its
 *   spacing in real time across the repeated hour.
 */
export function nextFirings(schedule: RoutineSchedule, after: Date, count: number): Date[] {
  const expression = CronExpressionParser.parse(schedule.pattern, {
    tz: schedule.tz,
    currentDate: after,
  });
  const firings: Date[] = [];
  for (let i = 0; i < count; i += 1) firings.push(expression.next().toDate());
  return firings;
}

/** The last instant of an inclusive calendar day in the routine's timezone. */
export function routineEndDate(endsOn: string, timezone: string): Date {
  const candidate = new Date(`${endsOn}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(endsOn) ||
    !Number.isFinite(candidate.getTime()) ||
    candidate.toISOString().slice(0, 10) !== endsOn
  ) {
    throw new RoutineScheduleError('Choose a valid end date.');
  }
  if (!isKnownTimezone(timezone)) {
    throw new RoutineScheduleError(
      `timezone must be an IANA zone, got ${JSON.stringify(timezone)}`,
    );
  }

  // Ask the same timezone-aware parser the scheduler uses for each midnight.
  // Starting at UTC midnight may already be partway through the selected day
  // east of Greenwich, or still the previous day west of it.
  const midnights = CronExpressionParser.parse('0 0 * * *', {
    tz: timezone,
    currentDate: candidate,
  });
  for (let i = 0; i < 3; i += 1) {
    const next = midnights.next().toDate();
    if (dateInZone(next, timezone) > endsOn) return new Date(next.getTime() - 1);
  }
  throw new RoutineScheduleError('Could not calculate the end date for this timezone.');
}

export function dateInZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function isKnownTimezone(timezone: string): boolean {
  if (timezone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
