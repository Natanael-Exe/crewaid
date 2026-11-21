import { Inject, Logger } from '@nestjs/common';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';

import { StructuredLogger } from '../logging/structured-logger.js';
import { ROUTINE_JOB, type RoutineJobData } from './routine.queue.js';
import { heldBy } from './routine-overlap.js';
import { RoutineRunnerService, type RoutineRunOutcome } from './routine-runner.service.js';

/**
 * How many firings this process works on at once.
 *
 * Not one, as `bot-message.processor.ts` is: that queue is serialised for
 * ORDER within a conversation, and routines have no order to keep across
 * each other — one bot's 09:00 report has nothing to wait for from another's.
 * A single slot would make every routine on the install queue behind the
 * slowest one, and a firing is a whole turn. Not unbounded either: each is a
 * model call and possibly a computer waking, and the install's sandbox
 * capacity is a handful. Four keeps a busy morning moving without
 * letting a schedule alone saturate the machine.
 */
export const ROUTINE_CONCURRENCY = 4;

/**
 * The worker for §6/M8's routines.
 *
 * Registered only when `ROUTINE_WORKER` is on, for the reason every
 * `@Processor` here is: it starts a real worker in every Nest context that
 * includes it, and the integration suites share one Redis.
 *
 * A firing that throws is NOT retried — the job is added with BullMQ's
 * default of one attempt. A retry would be a second firing of the same
 * schedule slot minutes late, and for a turn that already posted its prompt
 * it would post the prompt twice. The next slot is the retry.
 */
@Processor(ROUTINE_JOB, { concurrency: ROUTINE_CONCURRENCY })
export class RoutineProcessor extends WorkerHost {
  private readonly logger = new Logger(RoutineProcessor.name);

  constructor(
    @Inject(RoutineRunnerService) private readonly runner: RoutineRunnerService,
    @InjectQueue(ROUTINE_JOB) private readonly queue: Queue<RoutineJobData>,
    @Inject(StructuredLogger) private readonly structured: StructuredLogger,
  ) {
    super();
  }

  /**
   * One firing — unless the routine's previous one is still running, in
   * which case this one is skipped and logged, and nothing is queued in its
   * place (§6/M8; see `routine-overlap.ts` for what "still running" means).
   *
   * The job COMPLETES with a `skipped` outcome rather than failing: nothing
   * went wrong, and a failure would read as one in every place that counts
   * them. The row is not written either — `lastStatus` belongs to the run
   * that is actually happening, and overwriting it would report the skip as
   * that run's result.
   */
  async process(job: Job<RoutineJobData>): Promise<RoutineRunOutcome> {
    const routineId = job.data.routineId;
    const active = await this.queue.getActive();
    const holder = heldBy(
      { id: job.id, timestamp: job.timestamp, routineId },
      active.map((other) => ({
        id: other.id,
        timestamp: other.timestamp,
        routineId: routineIdOf(other.data),
      })),
    );
    if (holder !== null) {
      this.structured.info('routine.run.skipped', {
        routineId,
        reason: 'overlap',
        jobId: job.id ?? null,
        heldByJobId: holder.id ?? null,
      });
      return { kind: 'skipped', heldByJobId: holder.id ?? null };
    }
    return this.runner.run(routineId);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<RoutineJobData> | undefined, error: Error): void {
    // The runner has already written FAILED to the row, which is what the
    // operator reads; this line is for whoever reads the worker's log.
    this.logger.error(
      `${ROUTINE_JOB} job ${job?.id ?? 'unknown'} (routine ${job?.data.routineId ?? 'unknown'}) ` +
        `failed: ${error.message}`,
    );
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`${ROUTINE_JOB} worker error: ${error.message}`);
  }
}

/**
 * An active job's routine id, read defensively: the active set is the whole
 * queue's, and a job whose data is not a firing names no routine to hold.
 */
function routineIdOf(data: unknown): string {
  if (data !== null && typeof data === 'object' && 'routineId' in data) {
    const { routineId } = data;
    if (typeof routineId === 'string') return routineId;
  }
  return '';
}
