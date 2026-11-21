import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Queue, QueueEvents, Worker } from 'bullmq';

import { redisConnection } from '../src/common/queue-config.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AttachmentReaperService } from '../src/attachments/reaper.service.js';
import { ArtifactReapProcessor } from '../src/attachments/artifact-reap.processor.js';
import {
  ARTIFACT_REAP_JOB,
  ARTIFACT_REAP_SCHEDULER_ID,
  ArtifactReapScheduler,
  describeReapScheduling,
} from '../src/attachments/artifact-reap.queue.js';

/**
 * M8-BE-07 — D-031's attachment reaper, triggered by BullMQ.
 *
 * What moved is the trigger; what a pass does did not. So this suite asks two
 * questions: does the schedule land in Redis the way the routine schedules do
 * (one scheduler, one pending pass, removed when disabled), and does a pass
 * that ARRIVES THROUGH THE QUEUE keep D-031's guarantees — expired unclaimed
 * uploads gone from disk and database, young and claimed ones untouched. The
 * lock-level races are `artifact-reaper.integration.test.ts`'s, over the same
 * `sweep`, and are not repeated.
 *
 * Every queue here has a name of its own, because the production name is
 * shared with anything that ever pointed at this Redis.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';
const HOUR = 60 * 60 * 1000;

describe('describeReapScheduling', () => {
  it('reads the queue from REDIS_URL and the cadence from ARTIFACT_REAP_INTERVAL_MS', () => {
    expect(describeReapScheduling({})).toEqual({ redisUrl: null, intervalMs: 3_600_000 });
    expect(
      describeReapScheduling({ REDIS_URL: 'redis://h:1', ARTIFACT_REAP_INTERVAL_MS: '0' }),
    ).toEqual({ redisUrl: 'redis://h:1', intervalMs: 0 });
  });
});

describe.skipIf(!DATABASE_URL || !REDIS_URL)('the reaper on BullMQ (real db, real redis)', () => {
  let prisma: PrismaService;
  let artifactDir: string;
  let claimMessageId = '';
  let botId = '';
  const attachmentIds: string[] = [];
  const closeables: Array<{ close: () => Promise<unknown> }> = [];
  const queues: Queue[] = [];

  beforeAll(async () => {
    artifactDir = await mkdtemp(path.join(tmpdir(), 'crewaid-reap-bullmq-'));
    process.env['ARTIFACT_DIR'] = artifactDir;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.user.upsert({
      where: { id: USER_ID },
      create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
      update: {},
    });
    const bot = await prisma.bot.create({
      data: {
        userId: USER_ID,
        name: `reap-bullmq-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: '',
      },
    });
    botId = bot.id;
    const conversation = await prisma.conversation.create({ data: { botId } });
    claimMessageId = (
      await prisma.message.create({
        data: { conversationId: conversation.id, author: 'USER', content: 'anchor' },
      })
    ).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const closeable of closeables) await closeable.close().catch(() => undefined);
    for (const queue of queues) await queue.obliterate({ force: true }).catch(() => undefined);
    await prisma.attachment
      .deleteMany({ where: { id: { in: attachmentIds } } })
      .catch(() => undefined);
    await prisma.bot.deleteMany({ where: { id: botId } }).catch(() => undefined);
    await prisma.$disconnect();
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
    delete process.env['ARTIFACT_DIR'];
  });

  function isolatedQueue(): Queue {
    const queue = new Queue(`${ARTIFACT_REAP_JOB}.test-${randomUUID().slice(0, 8)}`, {
      connection: redisConnection(REDIS_URL!),
    });
    queues.push(queue);
    closeables.push(queue);
    return queue;
  }

  /** A reaper as the module builds it: queue-driven, interval as configured. */
  function reaper(intervalMs: number): AttachmentReaperService {
    process.env['ARTIFACT_REAP_INTERVAL_MS'] = String(intervalMs);
    process.env['ARTIFACT_REAP_ON_BOOT'] = 'false';
    process.env['ARTIFACT_MAX_TOTAL_MB'] = '1000000';
    process.env['ARTIFACT_MIN_FREE_MB'] = '0';
    return new AttachmentReaperService(prisma, true);
  }

  async function seed(ageHours: number, claimed = false) {
    const storageKey = path.posix.join('reap-bullmq', `${randomUUID()}.bin`);
    const absolutePath = path.join(artifactDir, storageKey);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, Buffer.alloc(64, 1));
    const row = await prisma.attachment.create({
      data: {
        ownerId: USER_ID,
        messageId: claimed ? claimMessageId : null,
        filename: 'seed.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 64,
        storageKey,
        createdAt: new Date(Date.now() - ageHours * HOUR),
      },
    });
    attachmentIds.push(row.id);
    return { id: row.id, absolutePath };
  }

  /** Passes queued and not yet run: the first `every` pass waits, later ones are delayed. */
  const pending = async (queue: Queue) => {
    const counts = await queue.getJobCounts('waiting', 'delayed');
    return (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0);
  };

  it('writes one scheduler with the configured interval, and one pending pass', async () => {
    const queue = isolatedQueue();
    const scheduler = new ArtifactReapScheduler(queue, 3_600_000);

    await scheduler.apply();
    await scheduler.apply(); // every process does this at boot

    expect(await queue.getJobScheduler(ARTIFACT_REAP_SCHEDULER_ID)).toMatchObject({
      every: 3_600_000,
    });
    expect(await queue.getJobSchedulersCount()).toBe(1);
    // Written twice, still ONE pass pending: re-upserting names the same job.
    expect(await pending(queue)).toBe(1);
  });

  it('removes the scheduler when the interval is 0, so reaping actually stops', async () => {
    const queue = isolatedQueue();
    await new ArtifactReapScheduler(queue, 3_600_000).apply();
    expect(await queue.getJobScheduler(ARTIFACT_REAP_SCHEDULER_ID)).toBeDefined();

    await new ArtifactReapScheduler(queue, 0).apply();

    expect(await queue.getJobScheduler(ARTIFACT_REAP_SCHEDULER_ID)).toBeUndefined();
    expect(await pending(queue)).toBe(0);
  });

  it('a scheduled pass, run by the worker, keeps D-031: expired goes, young and claimed stay', async () => {
    const queue = isolatedQueue();
    await new ArtifactReapScheduler(queue, 3_600_000).apply();
    const expired = await seed(25);
    const young = await seed(1);
    const claimed = await seed(25, true);

    const processor = new ArtifactReapProcessor(reaper(3_600_000));
    const events = new QueueEvents(queue.name, { connection: redisConnection(REDIS_URL!) });
    closeables.push(events);
    await events.waitUntilReady();
    const worker = new Worker(queue.name, () => processor.process(), {
      connection: redisConnection(REDIS_URL!),
    });
    closeables.push(worker);

    const completed = new Promise<unknown>((resolve) => {
      events.on('completed', ({ returnvalue }) => resolve(returnvalue));
    });
    // An `every` scheduler's first pass is queued at once, so the worker
    // takes it as soon as it starts; later passes are an interval apart.
    const result = (await completed) as { deleted: number; failed: number } | string;
    const parsed = typeof result === 'string' ? (JSON.parse(result) as { failed: number }) : result;
    expect(parsed.failed).toBe(0);

    expect(await prisma.attachment.findUnique({ where: { id: expired.id } })).toBeNull();
    await expect(access(expired.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await prisma.attachment.findUnique({ where: { id: young.id } })).not.toBeNull();
    expect(await prisma.attachment.findUnique({ where: { id: claimed.id } })).not.toBeNull();
    await expect(access(young.absolutePath)).resolves.toBeUndefined();
    await expect(access(claimed.absolutePath)).resolves.toBeUndefined();
    // And the next pass is already scheduled behind it, an interval out.
    expect(await queue.getDelayedCount()).toBe(1);
    expect(await queue.getWaitingCount()).toBe(0);
  });

  it('keeps no in-process timer when the queue owns the cadence', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const queued = reaper(3_600_000);
    await queued.onApplicationBootstrap();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    queued.onModuleDestroy();
  });

  it('still keeps M2’s timer without a queue, so retention never depends on Redis', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    process.env['ARTIFACT_REAP_INTERVAL_MS'] = '3600000';
    process.env['ARTIFACT_REAP_ON_BOOT'] = 'false';
    const timed = new AttachmentReaperService(prisma);
    await timed.onApplicationBootstrap();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    timed.onModuleDestroy();
  });
});
