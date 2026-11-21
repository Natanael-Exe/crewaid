import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { queueRedisUrl } from '../common/queue-config.js';
import { readReapIntervalMs } from './attachments.config.js';

/**
 * D-031's reaper on M8's scheduler.
 *
 * D-019 always meant the unclaimed-upload reaper to be "a small BullMQ job",
 * deferred to M8 because that is where the scheduling infrastructure landed;
 * M2 shipped the cleanup itself on an in-process timer so retention did not
 * wait on it. This moves the TRIGGER, and only the trigger. What a pass does —
 * lock each candidate row, re-check the expiry fence, unlink, then delete in
 * the same transaction — stays in `AttachmentReaperService.sweep`, untouched,
 * so every ownership and retention guarantee D-031 made still holds.
 *
 * What the queue buys over the timer
 *
 * - One pass per interval for the whole deployment. Every orchestrator
 * process ran its own `setInterval`; the sweep is safe under concurrency
 * (row locks), but N processes meant N scans. A job scheduler fires one job
 * per slot, taken by whichever worker is free.
 * - The cadence survives a restart. A timer restarts its interval at boot, so
 * a process that restarts more often than hourly never swept at all
 * between boots; the scheduler's next slot is in Redis.
 *
 * What does not change
 *
 * No new configuration. `ARTIFACT_REAP_INTERVAL_MS` is the job's `every`, and
 * `0` still disables periodic reaping — which now also REMOVES the scheduler
 * from Redis, because leaving one behind would keep sweeping on a deployment
 * that asked for it to stop. `ARTIFACT_REAP_ON_BOOT` still runs one pass at
 * startup in-process. A deployment without Redis keeps the timer exactly as
 * M2 shipped it; retention must not depend on a queue being configured.
 *
 * The worker is registered only when the interval is non-zero, which is also
 * what keeps it out of the integration suites (`vitest.config.mts` sets `0`).
 */
export const ARTIFACT_REAP_JOB = 'artifact.reap';

/** The one scheduler this queue holds. */
export const ARTIFACT_REAP_SCHEDULER_ID = 'artifact-reap';

/** Whether reaping is triggered by the queue in this process (resolved once). */
export const ARTIFACT_REAP_ON_QUEUE = 'ARTIFACT_REAP_ON_QUEUE';

/** `ARTIFACT_REAP_INTERVAL_MS`, resolved once, as the scheduler's `every`. */
export const ARTIFACT_REAP_INTERVAL = 'ARTIFACT_REAP_INTERVAL';

export function describeReapScheduling(env: NodeJS.ProcessEnv = process.env): {
  redisUrl: string | null;
  intervalMs: number;
} {
  return {
    redisUrl: queueRedisUrl(env['REDIS_URL']),
    intervalMs: readReapIntervalMs(env['ARTIFACT_REAP_INTERVAL_MS']),
  };
}

/** Writes (or removes) the reap schedule in Redis at boot. */
@Injectable()
export class ArtifactReapScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ArtifactReapScheduler.name);

  constructor(
    @InjectQueue(ARTIFACT_REAP_JOB) private readonly queue: Queue,
    @Inject(ARTIFACT_REAP_INTERVAL) private readonly intervalMs: number,
  ) {}

  /**
   * A failure is logged, not thrown: uploads, chat and every other feature
   * work without this schedule, and a Redis that is briefly away at boot is
   * not a reason to refuse to start. The schedule already in Redis, if any,
   * keeps firing.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.apply();
    } catch (error: unknown) {
      this.logger.warn(
        `artifact reap schedule could not be written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async apply(): Promise<void> {
    if (this.intervalMs === 0) {
      await this.queue.removeJobScheduler(ARTIFACT_REAP_SCHEDULER_ID);
      // Removing a scheduler takes its DELAYED pass with it, but not one that
      // has already moved to waiting — an `every` scheduler's first pass is
      // queued at once. This queue holds nothing but reap passes, so draining
      // it is what makes "0 disables" true from this moment rather than after
      // one more pass.
      await this.queue.drain(true);
      this.logger.log('periodic artifact reaping disabled');
      return;
    }
    // Upserting an unchanged `every` names the same next job, so every
    // process writing this at boot cannot add a second pass per interval.
    await this.queue.upsertJobScheduler(
      ARTIFACT_REAP_SCHEDULER_ID,
      { every: this.intervalMs },
      { name: ARTIFACT_REAP_JOB, opts: { removeOnComplete: true, removeOnFail: true } },
    );
    this.logger.log(`artifact reaper scheduled on BullMQ every ${this.intervalMs}ms`);
  }
}
