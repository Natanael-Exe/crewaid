import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { BotMessageDeliveryService } from './bot-message.delivery.service.js';
import { BOT_MESSAGE_JOB, DELIVERY_ATTEMPTS, type BotMessageJobData } from './bot-message.queue.js';
import { ChainNoticeService } from './chain-notice.service.js';
import { deliveryFailedNotice } from './chain.js';

/**
 * The worker for the inter-bot delivery.
 *
 * Why concurrency is one
 *
 * Not for rate limiting, as in `skill-compile.processor.ts`, but for
 * ORDERING. Two messages sent to the same bot are answered one turn at a
 * time regardless — `startTurn` defers while a turn is running — so
 * delivering them in parallel buys nothing and costs the guarantee that they
 * land in the transcript in the order they were sent. A conversation whose
 * messages arrive out of order is worse than a slow one.
 *
 * Why this class is only registered sometimes
 *
 * Same reason `SkillCompileProcessor` is: a `@Processor` starts a real worker
 * in every Nest context that includes it, and the integration suites boot the
 * whole application against one shared Redis. `InterbotModule` registers it
 * only when the worker is enabled, which `vitest.config.mts` turns off for
 * the run; the suites that need one drive a worker of their own.
 */
@Processor(BOT_MESSAGE_JOB, { concurrency: 1 })
export class BotMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(BotMessageProcessor.name);

  constructor(
    @Inject(BotMessageDeliveryService)
    private readonly delivery: BotMessageDeliveryService,
    @Inject(ChainNoticeService)
    private readonly notice: ChainNoticeService,
  ) {
    super();
  }

  /**
   * One delivery.
   *
   * `deliver` returns its refusals rather than throwing them, so this rarely
   * rejects: a hop over the ceiling and a deleted bot are both correct
   * endings. What reaches the rejection path is the machinery — a lost Redis
   * connection, a database that is away — after `DELIVERY_ATTEMPTS` tries,
   * and where that ends is the notice below.
   */
  async process(job: Job<BotMessageJobData>): Promise<void> {
    await this.delivery.deliver(job.data);
  }

  /**
   * A delivery that failed leaves the SENDER believing it delegated work.
   *
   * There is nothing useful to write to the receiving bot — no message
   * arrived, and starting a turn to explain that would be a turn nobody
   * asked for. The SENDER is the other reader, and it is the one who can act:
   * the tool result it holds said "queued", which was true when it was said,
   * and nothing since has corrected it. The notice is that correction, posted
   * to the sender's own transcript by the same service every refusal uses —
   * a failed notice must not fail the handler that is reporting the failure.
   *
   * Only attempted jobs are told. `job` can be undefined on a worker-level
   * error with no job attached, and the sender of nothing is told nothing.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<BotMessageJobData> | undefined, error: Error): Promise<void> {
    this.logger.error(
      `${BOT_MESSAGE_JOB} job ${job?.id ?? 'unknown'} failed ` +
        `(chain ${job?.data.chainId ?? 'unknown'}, hop ${job?.data.hopCount ?? '?'}): ` +
        error.message,
    );
    // This fires on EVERY failed attempt, and a transient failure that a
    // retry then delivers is not news: telling the sender "it failed" about a
    // message that is on its way, and "delivered" a moment later, is two
    // notices where one would have been true. Only the attempt that used up
    // the last retry is the ending.
    if (job === undefined || job.attemptsMade < DELIVERY_ATTEMPTS) return;
    await this.notice.post(
      job.data.fromBotId,
      job.data.chainId,
      deliveryFailedNotice(job.data.toBotName, error.message),
    );
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`${BOT_MESSAGE_JOB} worker error: ${error.message}`);
  }
}
