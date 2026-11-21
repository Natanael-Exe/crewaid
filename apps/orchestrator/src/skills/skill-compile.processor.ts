import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { SkillCompileService } from './skill-compile.service.js';
import { SKILL_COMPILE_JOB } from './skill-compile.queue.js';

/** What `RecordingsService` puts on the queue. */
export interface SkillCompileJobData {
  readonly recordingId: string;
}

/**
 * The worker for §6/M3's `skill.compile` job.
 *
 * Why concurrency is one
 *
 * A compile is a model call over a trace of up to 5000 events.
 * Running several at once is how one operator teaching three tasks in a row
 * hits a provider rate limit that then fails all three — and a recording is
 * expensive to produce, so the failure costs a person's time rather than a
 * retry.
 *
 * Why this class is only registered sometimes
 *
 * A `@Processor` starts a real worker in every Nest context that includes it,
 * and thirteen integration suites boot the whole application against one
 * shared Redis. `SkillsModule` therefore registers this only when
 * `SKILL_COMPILE_WORKER` allows it, which `vitest.config.mts` turns off for
 * the whole run — the same shape as `SANDBOX_RECONCILE_ON_BOOT`. Without that,
 * every suite would consume every other suite's compile jobs.
 */
@Processor(SKILL_COMPILE_JOB, { concurrency: 1 })
export class SkillCompileProcessor extends WorkerHost {
  private readonly logger = new Logger(SkillCompileProcessor.name);

  constructor(@Inject(SkillCompileService) private readonly compiler: SkillCompileService) {
    super();
  }

  /**
   * One job.
   *
   * `SkillCompileService.run` writes its own failures to the recording and
   * resolves, so this rarely rejects. That is deliberate: a job gets a single
   * attempt — a rejection would not be retried — and the readable reason §6
   * asks for is run's to write, onto the row.
   */
  async process(job: Job<SkillCompileJobData>): Promise<void> {
    await this.compiler.run(job.data.recordingId);
  }

  /**
   * Anything reaching here is the job machinery itself — a stall past its
   * allowance, a lost Redis connection, a malformed payload — rather than a
   * compile that went wrong, and `run` never saw an error to write to the
   * row. Settling it FAILED with the machinery's reason is the only way the
   * operator learns anything (§6: "or a FAILED recording with a readable
   * error"); the compare-and-set in the service leaves a row that already
   * moved on untouched.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<SkillCompileJobData> | undefined, error: Error): Promise<void> {
    this.logger.error(`skill.compile job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    const recordingId = job?.data.recordingId;
    if (recordingId === undefined) return;
    await this.compiler.settleAbandoned(recordingId, error.message);
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`skill.compile worker error: ${error.message}`);
  }
}
