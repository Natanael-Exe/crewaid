import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';

import { ARTIFACT_REAP_JOB } from './artifact-reap.queue.js';
import { AttachmentReaperService } from './reaper.service.js';

/**
 * Runs one reap pass per scheduled job.
 *
 * Concurrency one: a pass is a scan plus a row-locked transaction per
 * candidate, and two of them at once in one process would only coalesce onto
 * the same pass anyway (`sweep` shares the in-flight one). The pass logs and
 * counts its own per-row failures rather than throwing, so a job fails only
 * when the machinery does — and the next slot is the retry.
 */
@Processor(ARTIFACT_REAP_JOB, { concurrency: 1 })
export class ArtifactReapProcessor extends WorkerHost {
  private readonly logger = new Logger(ArtifactReapProcessor.name);

  constructor(@Inject(AttachmentReaperService) private readonly reaper: AttachmentReaperService) {
    super();
  }

  process(): Promise<{ deleted: number; failed: number }> {
    return this.reaper.sweep();
  }

  @OnWorkerEvent('failed')
  onFailed(_job: unknown, error: Error): void {
    this.logger.error(`${ARTIFACT_REAP_JOB} failed: ${error.message}`);
  }
}
