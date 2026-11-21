import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { TelegramMessagingService } from './telegram-messaging.service.js';
import { TelegramAccountsService } from './telegram-accounts.service.js';
import { TelegramBotsService } from './telegram-bots.service.js';
import { TelegramApiError } from './telegram-api.js';
import { TELEGRAM_CONFIG, telegramDigest, type TelegramConfig } from './telegram.config.js';
import {
  TELEGRAM_MANAGER,
  TelegramUpdateSchema,
  privateSender,
  type TelegramJob,
} from './telegram.protocol.js';

export const TELEGRAM_QUEUE = 'telegram.channel';
/**
 * One chat's updates and deliveries run in order, on one lane; different chats
 * run in parallel. A lane is a queue with a global concurrency of one, so the
 * order holds across replicas, and a slow download or a rate limit on one chat
 * holds back only the chats that hash to its lane.
 */
export const TELEGRAM_LANES = 8;
export const telegramLaneQueue = (lane: number): string => `${TELEGRAM_QUEUE}.${lane}`;
export const TELEGRAM_SCAN_QUEUE = `${TELEGRAM_QUEUE}.scan`;
export const telegramLane = (key: string): number =>
  Number.parseInt(telegramDigest(key).slice(0, 8), 16) % TELEGRAM_LANES;
/**
 * One person's chat with one bot is ordered. A manager update has no private
 * chat, so its creator's id orders it instead.
 */
export function telegramLaneKey(job: Pick<TelegramJob, 'telegramBotId' | 'update'>): string | null {
  if (job.telegramBotId === TELEGRAM_MANAGER) {
    const creator = job.update.managed_bot?.user.id ?? privateSender(job.update)?.telegramUserId;
    return creator === undefined ? null : `manager:${creator}`;
  }
  const sender = privateSender(job.update);
  return sender ? `${job.telegramBotId}:${sender.chatId}` : null;
}

const IncomingSchema = z.object({ text: z.string(), attachmentIds: z.array(z.string()) });
const JobSchema = z.object({
  telegramBotId: z.string(),
  update: TelegramUpdateSchema,
  connectionId: z.string().nullable(),
  targetBotId: z.string().nullable().optional(),
  codeHash: z.string().optional(),
  incoming: IncomingSchema.optional(),
});
const DeliverySchema = z.object({ userId: z.string(), connectionId: z.string() });
type QueueData = Partial<TelegramJob> & { userId?: string };

@Injectable()
export class TelegramQueueService implements OnModuleInit, OnModuleDestroy {
  private lanes: Array<Queue<QueueData>> = [];
  private scanQueue: Queue<QueueData> | undefined;
  private workers: Array<Worker<QueueData>> = [];
  constructor(
    @Inject(TELEGRAM_CONFIG) private readonly config: TelegramConfig | null,
    @Inject(TelegramMessagingService) private readonly messaging: TelegramMessagingService,
    @Inject(TelegramAccountsService) private readonly accounts: TelegramAccountsService,
    @Inject(TelegramBotsService) private readonly bots: TelegramBotsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config) return;
    const config = this.config;
    const open = (name: string) => {
      const queue = new Queue<QueueData>(name, {
        connection: { ...config.connection, maxRetriesPerRequest: 1, enableOfflineQueue: false },
        defaultJobOptions: {
          attempts: 10,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 7 * 24 * 3600 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      });
      queue.on('error', () => this.logger.warn('telegram.queue.unavailable'));
      return queue;
    };
    this.lanes = Array.from({ length: TELEGRAM_LANES }, (_, lane) => open(telegramLaneQueue(lane)));
    this.scanQueue = open(TELEGRAM_SCAN_QUEUE);
    if (!config.worker) return;
    for (const queue of [...this.lanes, this.scanQueue]) await queue.setGlobalConcurrency(1);
    await this.scanQueue.upsertJobScheduler(
      'telegram-delivery-scan',
      { every: 2000 },
      { name: 'scan', data: {}, opts: { removeOnComplete: true, removeOnFail: true } },
    );
    await this.scanQueue.upsertJobScheduler(
      'telegram-cleanup',
      { every: 60_000 },
      { name: 'cleanup', data: {}, opts: { removeOnComplete: true, removeOnFail: true } },
    );
    // The scan queue serializes secret rotations across replicas. Enqueueing
    // at boot waits only on Redis; failed registrations are retried each minute.
    await this.scanQueue.add(
      'reconcile',
      {},
      {
        jobId: 'telegram-reconcile',
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    const watch = (worker: Worker<QueueData>) => {
      worker.on('error', () => this.logger.warn('telegram.worker.unavailable'));
      worker.on('failed', (job) =>
        this.logger.warn('telegram.job.failed', {
          kind: job?.name,
          attempts: job?.attemptsMade,
        }),
      );
      this.workers.push(worker);
    };
    for (const lane of this.lanes)
      watch(
        new Worker<QueueData>(lane.name, (job) => this.run(job), {
          connection: config.connection,
          concurrency: 1,
        }),
      );
    watch(
      new Worker<QueueData>(
        TELEGRAM_SCAN_QUEUE,
        async (job) => {
          if (job.name === 'cleanup') await this.bots.cleanup();
          if (job.name === 'cleanup' || job.name === 'reconcile') await this.bots.reconcile();
          else await this.scan();
        },
        {
          connection: config.connection,
          concurrency: 1,
        },
      ),
    );
  }

  private async run(job: Job<QueueData>): Promise<void> {
    if (job.name === 'update') {
      const data = JobSchema.parse(job.data);
      if (
        data.targetBotId === undefined &&
        data.update.message &&
        data.telegramBotId !== TELEGRAM_MANAGER
      ) {
        const sender = privateSender(data.update);
        const connection =
          sender && data.connectionId
            ? await this.accounts.resolve(
                data.telegramBotId,
                sender.telegramUserId,
                sender.chatId,
                data.connectionId,
              )
            : null;
        const target = connection
          ? await this.messaging.targetFor(connection, data.update.message.text)
          : null;
        if (target !== undefined) {
          data.targetBotId = target;
          await job.updateData(data);
        }
      }
      await this.messaging.handle(data, async (incoming) => {
        data.incoming = incoming;
        await job.updateData(data);
      });
    } else if (job.name === 'delivery') {
      const data = DeliverySchema.parse(job.data);
      try {
        await this.messaging.deliver(data.userId, data.connectionId);
      } catch (error) {
        if (error instanceof TelegramApiError && error.status === 403)
          await this.accounts.disconnect(data.userId, data.connectionId);
        else throw error;
      }
    }
  }

  async enqueue(job: TelegramJob): Promise<void> {
    if (this.lanes.length === 0 || !this.config)
      throw new ServiceUnavailableException('Telegram is not configured.');
    const key = telegramLaneKey(job);
    // `prepare` drops every update without a private sender before it gets here.
    if (key === null) return;
    // Telegram numbers updates per bot, so the bot is part of what makes one unique.
    const bot =
      job.telegramBotId === TELEGRAM_MANAGER
        ? `manager-${this.config.manager?.token.split(':')[0] ?? ''}`
        : job.telegramBotId;
    try {
      await this.lanes[telegramLane(key)]?.add('update', job, {
        jobId: telegramDigest(`${bot}:${job.update.update_id}`),
        priority: 1,
      });
    } catch {
      throw new ServiceUnavailableException('Telegram could not queue this update.');
    }
  }

  /**
   * Queues delivery only for connections with something to deliver: a reply or
   * a run past its watermark, an unreceipted file, or an approval batch not yet
   * announced (the same batch `approvalPrompt` shows: the oldest run's). An idle connection costs nothing but its index probes,
   * and one whose selected bot was deleted is never selected again.
   */
  private async scan(): Promise<void> {
    let cursor = '';
    while (true) {
      const rows = await this.prisma.$queryRaw<
        Array<{ id: string; userId: string; chatId: string; telegramBotId: string }>
      >`
        SELECT c."id", c."userId", c."chatId", c."telegramBotId"
        FROM "TelegramConnection" c
        JOIN "Bot" b ON b."id" = c."selectedBotId" AND b."userId" = c."userId"
        JOIN "Conversation" v ON v."botId" = b."id"
        WHERE c."id" > ${cursor} AND (
          EXISTS (
            SELECT 1 FROM "Message" m
            WHERE m."conversationId" = v."id" AND m."sequence" > c."lastMessageSequence"
              AND m."author" = 'BOT' AND m."fromBotId" = b."id"
          )
          OR EXISTS (
            SELECT 1 FROM "AgentTurn" t
            WHERE t."botId" = b."id" AND t."sequence" > c."lastRunSequence"
          )
          OR EXISTS (
            SELECT 1 FROM "Attachment" a
            JOIN "Message" m ON m."id" = a."messageId"
            WHERE m."conversationId" = v."id" AND m."author" = 'BOT' AND m."fromBotId" = b."id"
              AND a."ownerId" = c."userId" AND a."createdAt" >= c."selectedAt"
              AND NOT EXISTS (
                SELECT 1 FROM "TelegramAttachmentDelivery" d
                WHERE d."connectionId" = c."id" AND d."attachmentId" = a."id"
              )
          )
          OR EXISTS (
            SELECT 1 FROM "RunInterrupt" i
            WHERE i."runId" = (
              SELECT p."runId" FROM "RunInterrupt" p
              JOIN "AgentTurn" t ON t."id" = p."runId"
              WHERE t."botId" = b."id" AND t."status" = 'interrupted'
                AND p."userId" = c."userId" AND p."status" = 'pending'
                AND p."nativeStatus" = 'pending' AND p."nativeInterruptId" IS NOT NULL
              ORDER BY p."sequence"
              LIMIT 1
            )
              AND i."userId" = c."userId" AND i."status" = 'pending'
              AND i."nativeStatus" = 'pending' AND i."nativeInterruptId" IS NOT NULL
              AND NOT (i."id" = ANY(COALESCE(c."notifiedInterruptIds", '{}')))
          )
        )
        ORDER BY c."id"
        LIMIT 100`;
      for (const row of rows)
        await this.lanes[telegramLane(`${row.telegramBotId}:${row.chatId}`)]?.add(
          'delivery',
          { userId: row.userId, connectionId: row.id },
          { jobId: `delivery-${row.id}`, priority: 10, removeOnComplete: true, removeOnFail: true },
        );
      const last = rows.at(-1);
      if (rows.length < 100 || !last) return;
      cursor = last.id;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all(
      [...this.lanes, ...(this.scanQueue ? [this.scanQueue] : [])].map((queue) => queue.close()),
    );
  }
}
