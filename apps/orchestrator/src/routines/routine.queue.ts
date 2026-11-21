import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { queueRedisUrl, readWorkerEnabled } from '../common/queue-config.js';
import { parseRoutineSchedule, routineEndDate } from './routine-schedule.js';

/**
 * "BullMQ repeatable jobs from cron with per-routine timezones."
 *
 * One job scheduler per routine, keyed by the routine's id
 *
 * BullMQ's job scheduler is the current form of a repeatable job: one hash in
 * Redis holding the pattern and zone, one entry in the queue's `repeat` set,
 * and one delayed job for the next firing, whose id is derived from the
 * scheduler id and that firing's timestamp. Keying the scheduler on
 * `Routine.id` is what makes the two properties §6/M8 asks for fall out of
 * Redis rather than out of bookkeeping here:
 *
 * - an upsert with an unchanged schedule names the same next job, so writing
 * it again — on every edit, on every boot — cannot produce a second firing;
 * - the schedule lives in Redis, not in this process, so an orchestrator that
 * is down across a firing finds that firing's job waiting when it returns,
 * rather than a gap.
 *
 * The port is the same shape the other two queues use
 *
 * Routine CRUD needs to say "this routine's schedule is now X" and "this
 * routine no longer fires", and nothing more. Handing it a `Queue` would put
 * bullmq's types on a REST service and leave "no Redis configured" with
 * nowhere to live; `UNCONFIGURED_SCHEDULER` is where it lives.
 */
export interface RoutineScheduler {
  /**
   * Make `routine` fire on its schedule, replacing whatever it had.
   *
   * Throws `RoutineScheduleError` for a schedule that cannot be used, before
   * anything reaches Redis.
   */
  readonly schedule: (routine: SchedulableRoutine) => Promise<void>;
  /** Stop `routineId` firing. Resolves whether or not it was scheduled. */
  readonly unschedule: (routineId: string) => Promise<void>;
  /** What Redis currently holds, for the boot reconciliation. */
  readonly scheduled: () => Promise<ScheduledRoutine[]>;
  /**
   * Fire `routineId` once, now, outside its schedule (REST run-now).
   *
   * Through the same queue and worker as a scheduled firing rather than by
   * calling the runner from the request: a run-now is then subject to exactly
   * what a scheduled firing is — the worker's concurrency, overlap
   * suppression — and the HTTP caller is not held open for a whole turn.
   */
  readonly runNow: (routineId: string) => Promise<void>;
}

/**
 * The refusal a deployment without Redis gives, as a type of its own so the
 * REST layer can answer 503 for it — the request was fine, the install is
 * missing a piece — without matching on a sentence.
 */
export class RoutineQueueUnavailableError extends Error {
  override readonly name = 'RoutineQueueUnavailableError';
  constructor() {
    super('routines need a job queue, and REDIS_URL is not set (see infra/compose/.env.example)');
  }
}

/** The three `Routine` columns a schedule is made of. */
export interface SchedulableRoutine {
  readonly id: string;
  readonly cron: string;
  readonly timezone: string;
  readonly endsOn?: string | null;
}

/** One scheduler as Redis holds it. */
export interface ScheduledRoutine {
  readonly routineId: string;
  readonly pattern: string | null;
  readonly tz: string | null;
  readonly endDate?: number | null;
}

/**
 * One firing.
 *
 * Only the id. Everything else — the prompt, the bot, whether the routine is
 * still enabled, who owns it — is read from the row when the job runs,
 * because a firing is a reminder to look, not a capability: a routine edited
 * or deleted since it was scheduled must run as it is now or not at all.
 */
export interface RoutineJobData {
  readonly routineId: string;
}

export const ROUTINE_SCHEDULER = 'ROUTINE_SCHEDULER';

/**
 * The job name, and so the queue's name and its Redis key prefix.
 *
 * §6/M8 does not name it. `routine.run` follows `skill.compile` and
 * `bot.message`: the noun the job is about, then what happens to it.
 */
export const ROUTINE_JOB = 'routine.run';

/**
 * What a deployment without Redis gets.
 *
 * It REFUSES rather than storing a routine that would silently never fire.
 * An operator who saves a schedule and waits for a morning report that never
 * comes has been told nothing; a refusal naming the missing variable tells
 * them what to fix. `unschedule` and `scheduled` do not refuse — there is
 * nothing to remove from a queue that does not exist, and a routine must
 * stay deletable on an install that cannot run it.
 */
export const UNCONFIGURED_SCHEDULER: RoutineScheduler = {
  // `async` so a bad schedule arrives as a rejection like every other
  // failure of this method, rather than as a synchronous throw only here.
  // eslint-disable-next-line @typescript-eslint/require-await
  schedule: async (routine) => {
    // Validate first, so a bad schedule is reported as bad even here: the
    // operator fixing their cron should not be told about Redis instead.
    parseRoutineSchedule(routine.cron, routine.timezone);
    if (routine.endsOn !== null && routine.endsOn !== undefined) {
      routineEndDate(routine.endsOn, routine.timezone);
    }
    throw new RoutineQueueUnavailableError();
  },
  unschedule: () => Promise.resolve(),
  scheduled: () => Promise.resolve([]),
  runNow: () => Promise.reject(new RoutineQueueUnavailableError()),
};

/** The real scheduler, over the `Queue` `BullModule.registerQueue` provides. */
@Injectable()
export class BullRoutineScheduler implements RoutineScheduler {
  // `InjectQueue` resolves by an explicit token, which is what makes it work
  // under vitest/esbuild — no design:paramtypes is emitted there.
  constructor(@InjectQueue(ROUTINE_JOB) private readonly queue: Queue<RoutineJobData>) {}

  schedule = async (routine: SchedulableRoutine): Promise<void> => {
    const { pattern, tz } = parseRoutineSchedule(routine.cron, routine.timezone);
    const endDate = routine.endsOn ? routineEndDate(routine.endsOn, tz) : null;
    if (endDate !== null && endDate.getTime() < Date.now()) {
      await this.unschedule(routine.id);
      return;
    }
    await this.queue.upsertJobScheduler(
      routine.id,
      { pattern, tz, ...(endDate !== null && { endDate }) },
      {
        name: ROUTINE_JOB,
        data: { routineId: routine.id },
        // BullMQ keeps a finished job's hash by default and nothing evicts
        // it; a routine every five minutes would add 288 a day, forever. The
        // row's `lastRunAt`/`lastStatus` is the record, not the job.
        opts: { removeOnComplete: true, removeOnFail: true },
      },
    );
  };

  unschedule = async (routineId: string): Promise<void> => {
    await this.queue.removeJobScheduler(routineId);
  };

  runNow = async (routineId: string): Promise<void> => {
    // No `jobId`: two presses of run-now are two requests, and deduping them
    // here would hide the second rather than let overlap suppression decide
    // about it with a log line. Kept out of Redis once finished, as above.
    await this.queue.add(
      ROUTINE_JOB,
      { routineId },
      { removeOnComplete: true, removeOnFail: true },
    );
  };

  scheduled = async (): Promise<ScheduledRoutine[]> => {
    const schedulers = await this.queue.getJobSchedulers();
    return schedulers.map((scheduler) => ({
      routineId: scheduler.key,
      pattern: scheduler.pattern ?? null,
      tz: scheduler.tz ?? null,
      endDate: scheduler.endDate ?? null,
    }));
  };
}

/**
 * `ROUTINE_WORKER` / `REDIS_URL` — what this process does with routines.
 *
 * A key of its own rather than a shared switch, for the reason
 * `BOT_MESSAGE_WORKER` is one: a firing starts a bot's turn, which is a
 * different cost from a compile or a delivery, and a deployment that wants
 * one without the others has no other way to say so. It decides two things
 * together — whether this process consumes firings, and whether it
 * reconciles the schedule on boot — because both are the work of the process
 * that OWNS routines, and the integration suites, which share one Redis, must
 * do neither. `vitest.config.mts` turns it off.
 */
export function describeRoutineConfig(env: NodeJS.ProcessEnv = process.env): {
  redisUrl: string | null;
  workerEnabled: boolean;
} {
  return {
    redisUrl: queueRedisUrl(env['REDIS_URL']),
    workerEnabled: readWorkerEnabled('ROUTINE_WORKER', env['ROUTINE_WORKER']),
  };
}
