import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { queueRedisUrl, readWorkerEnabled } from '../common/queue-config.js';

/**
 * "A BullMQ job `skill.compile` runs on stop."
 *
 * WHY THERE IS STILL A PORT IN FRONT OF `@nestjs/bullmq`
 *
 * `RecordingsService` needs to say "compile this", and nothing more. Injecting
 * a `Queue` there would make the recording lifecycle depend on bullmq's type
 * for one method call, and would leave the "no Redis configured" case with
 * nowhere to live — `UNCONFIGURED_QUEUE` below is what turns that into the
 * readable error §6 asks for rather than a boot failure. It is also what lets
 * the thirty test suites that reach this module fake the queue in three lines.
 *
 * The library owns everything below the port: the connection, the queue's
 * construction, and closing it on shutdown.
 */
export interface SkillCompileQueue {
  /** Ask for `recordingId` to be compiled. Rejects if it cannot be queued. */
  readonly enqueue: (recordingId: string) => Promise<void>;
}

export const SKILL_COMPILE_QUEUE = 'SKILL_COMPILE_QUEUE';

/** WebSocket and §6 both name it; the string is the contract with the worker. */
export const SKILL_COMPILE_JOB = 'skill.compile';

/**
 * The queue a deployment without Redis gets.
 *
 * It refuses rather than silently dropping the job, and the refusal is the
 * sentence that lands in `Recording.error`. The alternative — settling
 * `READY` with no skill — reports success for work that never happened, and
 * The acceptance criteria are explicit that the other outcome is "a FAILED
 * recording with a readable error".
 *
 * Not a boot-time throw, unlike `auth.guard.ts`: chat, the desktop, sandboxes
 * and recording capture all work without Redis, and refusing to start the
 * orchestrator over the one feature that needs it would take the other five
 * down with it.
 */
export const UNCONFIGURED_QUEUE: SkillCompileQueue = {
  enqueue: () =>
    Promise.reject(
      new Error(
        'skill compilation needs a job queue, and REDIS_URL is not set ' +
          '(see infra/compose/.env.example)',
      ),
    ),
};

/** The real queue, over the `Queue` `BullModule.registerQueue` provides. */
@Injectable()
export class BullSkillCompileQueue implements SkillCompileQueue {
  // `InjectQueue` resolves by an explicit token, which is what makes it work
  // under vitest/esbuild — no design:paramtypes is emitted there, so a
  // type-based injection would silently resolve to undefined.
  constructor(@InjectQueue(SKILL_COMPILE_JOB) private readonly queue: Queue) {}

  enqueue = async (recordingId: string): Promise<void> => {
    // The recording id IS the job id, so two stops racing each other cannot
    // queue the same compile twice: BullMQ answers an add for an id that
    // already exists with the existing job and writes nothing.
    // That dedupe must last exactly as long as the job does, which is why both
    // retentions are on. BullMQ's default is to KEEP a job hash after it
    // completes or fails, and a kept hash means every later add for that id is
    // silently dropped — permanently. `recoverStrandedCompilations` re-queues
    // by recording id, so with the default this milestone's own recovery path
    // (D-044: a `COMPILING` row "remains a candidate for … a restart's
    // recovery") could never run for a recording whose job had already
    // finished: the add resolves, the pass counts it as re-queued, and the row
    // stays `COMPILING` with no error, across every restart. It also grew
    // Redis by one hash per recording ever compiled, with nothing evicting it.
    // Dropping the hash at the end of the job cannot resurrect a double
    // compile, because the fence that matters is the row, not the key: `stop`
    // reaches `enqueue` only through a compare-and-set into `COMPILING`, and
    // every write the job makes is pinned to that same state.
    await this.queue.add(
      SKILL_COMPILE_JOB,
      { recordingId },
      { jobId: recordingId, removeOnComplete: true, removeOnFail: true },
    );
  };
}

/**
 * The shared queue helpers, re-exported rather than redefined.
 *
 * M7 added a second queue (`bot.message`) and M8's routines make a third
 * certain, so the parsing moved to `common/queue-config.ts`. They stay
 * exported from here because `main.ts`, `skills.module.ts` and
 * `skill-compile-queue.test.ts` all import them by this path, and relocating
 * a shared helper is not a reason to relocate everyone's import of it.
 *
 * `readWorkerEnabled` gained a `key` parameter in the move, so its error
 * names the variable the operator actually set rather than always naming
 * `SKILL_COMPILE_WORKER`.
 */
export { queueRedisUrl, readWorkerEnabled, redisConnection } from '../common/queue-config.js';

/** Re-exported so `main.ts` can say at boot what this process will do. */
export function describeQueueConfig(env: NodeJS.ProcessEnv = process.env): {
  redisUrl: string | null;
  workerEnabled: boolean;
} {
  return {
    redisUrl: queueRedisUrl(env['REDIS_URL']),
    workerEnabled: readWorkerEnabled('SKILL_COMPILE_WORKER', env['SKILL_COMPILE_WORKER']),
  };
}
