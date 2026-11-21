import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { StructuredLogger } from '../src/logging/structured-logger.js';
import type { TelegramMessagingService } from '../src/telegram/telegram-messaging.service.js';
import type { TelegramAccountsService } from '../src/telegram/telegram-accounts.service.js';
import type { TelegramBotsService } from '../src/telegram/telegram-bots.service.js';
import {
  TelegramQueueService,
  TELEGRAM_SCAN_QUEUE,
  telegramLaneQueue,
  TELEGRAM_LANES,
  telegramLane,
} from '../src/telegram/telegram-queue.service.js';
import type { TelegramConfig } from '../src/telegram/telegram.config.js';
import type { TelegramJob } from '../src/telegram/telegram.protocol.js';

// Owner: V2-TG-01. Requires a dedicated test Redis: this suite clears only its Telegram queues.
const url = process.env['TELEGRAM_TEST_REDIS_URL'];
describe.skipIf(!url)('Telegram durable queue (real Redis)', () => {
  const config: TelegramConfig = {
    publicUrl: 'https://crew.example',
    manager: null,
    worker: true,
    connection: { url: url ?? 'redis://127.0.0.1:1', maxRetriesPerRequest: null },
  };
  const handle = vi.fn(async (_job: TelegramJob) => {});
  const messaging = {
    handle,
    deliver: async () => {},
    targetFor: async (connection: { selectedBotId: string | null }) => connection.selectedBotId,
  } as unknown as TelegramMessagingService;
  const resolve = vi.fn(async () => ({ selectedBotId: 'first-bot' }));
  const accounts = {
    disconnect: async () => {},
    resolve,
  } as unknown as TelegramAccountsService;
  const reconcile = vi.fn(async () => {});
  const cleanup = vi.fn(async () => {});
  const bots = { reconcile, cleanup } as unknown as TelegramBotsService;
  const prisma = { $queryRaw: async () => [] } as unknown as PrismaService;
  const logger = { warn: () => {} } as unknown as StructuredLogger;
  const connections: TelegramQueueService[] = [];
  let queues: Queue[] = [];
  const job = (id: number, chat = 42, telegramBotId = '7001'): TelegramJob => ({
    telegramBotId,
    connectionId: 'connection',
    update: {
      update_id: id,
      message: {
        message_id: id,
        text: 'hello',
        chat: { id: chat, type: 'private' },
        from: { id: chat, is_bot: false, first_name: 'Me' },
      },
    },
  });
  async function start(worker = true) {
    const service = new TelegramQueueService(
      { ...config, worker },
      messaging,
      accounts,
      bots,
      prisma,
      logger,
    );
    await service.onModuleInit();
    connections.push(service);
    return service;
  }
  beforeAll(async () => {
    queues = [
      ...Array.from({ length: TELEGRAM_LANES }, (_, lane) => telegramLaneQueue(lane)),
      TELEGRAM_SCAN_QUEUE,
    ].map((name) => new Queue(name, { connection: config.connection }));
    for (const queue of queues) await queue.obliterate({ force: true });
  });
  afterAll(async () => {
    for (const service of connections) await service.onModuleDestroy();
    for (const queue of queues) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
  it('preserves a queued update while no consumer is running', async () => {
    const producer = await start(false);
    await producer.enqueue(job(1001));
    expect(handle).not.toHaveBeenCalled();
    await start();
    await vi.waitFor(
      () =>
        expect(handle).toHaveBeenCalledWith(
          expect.objectContaining(job(1001)),
          expect.any(Function),
        ),
      { timeout: 5000 },
    );
  });
  it('deduplicates completed updates and serializes one chat across replicas', async () => {
    handle.mockClear();
    let active = 0;
    let maximum = 0;
    handle.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
    });
    const replica = await start();
    await replica.enqueue(job(1002));
    await replica.enqueue(job(1002));
    await replica.enqueue(job(1003));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(() => expect(active).toBe(0));
    await replica.enqueue(job(1002));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(handle).toHaveBeenCalledTimes(2);
    expect(maximum).toBe(1);
  });
  it('runs different chats side by side, so one slow chat holds back only its lane', async () => {
    handle.mockClear();
    const other = Array.from({ length: 100 }, (_, n) => 1000 + n).find(
      (chat) => telegramLane(`7001:${chat}`) !== telegramLane('7001:42'),
    )!;
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    handle.mockImplementation(async (data: TelegramJob) => {
      if (data.update.message?.chat.id === 42) await blocked;
    });
    await connections[0]!.enqueue(job(1010));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await connections[0]!.enqueue(job(1011, other));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2), { timeout: 5000 });
    release();
    handle.mockImplementation(async () => {});
  });
  it('keys an update by its bot, since Telegram numbers updates per bot', async () => {
    handle.mockClear();
    await connections[0]!.enqueue(job(1020, 42, '7001'));
    await connections[0]!.enqueue(job(1020, 42, '7002'));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(handle.mock.calls.map(([data]) => data.telegramBotId).sort()).toEqual(['7001', '7002']);
  });
  it('retries a failed handler without losing the accepted update', async () => {
    handle.mockClear();
    handle.mockRejectedValueOnce(new Error('transient failure')).mockResolvedValue(undefined);
    await connections[0]!.enqueue(job(1004));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1), { timeout: 5000 });
    resolve.mockResolvedValue({ selectedBotId: 'different-bot' });
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2), { timeout: 7000 });
    expect(handle.mock.calls[0]?.[0]).toEqual(handle.mock.calls[1]?.[0]);
    expect(handle.mock.calls[1]?.[0].targetBotId).toBe('first-bot');
  });
  it('serializes boot reconciliation across replicas and repeats it after cleanup', async () => {
    let active = 0;
    let maximum = 0;
    reconcile.mockClear();
    reconcile.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
    });
    await start();
    await start();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalled());
    await vi.waitFor(() => expect(active).toBe(0));
    const before = reconcile.mock.calls.length;
    cleanup.mockClear();
    await queues.at(-1)!.add('cleanup', {});
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reconcile.mock.calls.length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(active).toBe(0));
    expect(maximum).toBe(1);
    reconcile.mockImplementation(async () => {});
  });
});
