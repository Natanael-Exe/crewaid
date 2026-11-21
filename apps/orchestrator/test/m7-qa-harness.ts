import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type { INestApplication } from '@nestjs/common';
import { scriptModel, type MockLanguageModelV4 as LanguageModel } from './model-resolution-fake.js';

import { DEFAULT_AUTO_REVIEW_RULES } from '@crewaid/shared';
import { TanStackTurns } from '../src/agent/tanstack-turns.js';
import { BotsService } from '../src/bots/bots.service.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { redisConnection } from '../src/common/queue-config.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import {
  BOT_MESSAGE_QUEUE,
  BullBotMessageQueue,
  type BotMessageJobData,
} from '../src/interbot/bot-message.queue.js';
import { BotMessageDeliveryService } from '../src/interbot/bot-message.delivery.service.js';
import { CHAIN_LIMITS, type ChainLimits } from '../src/interbot/chain.config.js';
import { FakeProvider } from './sandbox-fakes.js';

/**
 * The live chain the M7 QA suites drive: a real queue, a real worker, the
 * real delivery service, real turns, real rows. Only the model is faked.
 *
 * Extracted at the SECOND user, not the first. M7-QA-02 wrote this setup
 * inline because one copy is not a pattern; M7-QA-03/04/05 need the same
 * three moving parts with different limits and different model behaviour,
 * and four copies of a BullMQ worker lifecycle is four places to leak a
 * connection from.
 *
 * ── THE QUEUE NAME IS UNIQUE PER HARNESS ────────────────────────────────────
 *
 * `vitest.config.mts` keeps a `@Processor` out of every test context, but a
 * developer's own orchestrator may be running against the same Redis — and
 * it would happily consume these jobs and start turns on ITS bots. An
 * isolated name makes that impossible rather than unlikely, and it also
 * keeps two M7 suites in one run from draining each other's chains.
 */
export type ChainHarness = {
  readonly app: INestApplication;
  readonly bots: BotsService;
  readonly messages: MessagesService;
  readonly prisma: PrismaService;
  readonly turns: TanStackTurns;
  /** The real queue the tool enqueues onto, for asserting on what is left. */
  readonly queue: Queue;
  /**
   * The worker, exposed so a case can stop it consuming.
   *
   * M7-QA-05 needs a job that is ENQUEUED for a bot which then stops
   * existing, and that window is a few milliseconds wide if the worker is
   * running. Pausing is what turns "delete at the right moment" from a race
   * into a step.
   */
  readonly worker: Worker<BotMessageJobData>;
  /** Mutable: D-047 ships every ceiling off, so a case sets what it asserts. */
  readonly limits: ChainLimits & { maxHops: number; maxTokens: number; maxRepeatSends: number };
  makeBot(name: string): Promise<{ id: string; name: string }>;
  messagesOf(botId: string): Promise<
    Array<{
      author: string;
      content: string;
      fromBotId: string | null;
      chainId: string | null;
      hopCount: number;
    }>
  >;
  close(): Promise<void>;
};

const USER_ID = 'usr_crewaid_singleton_v1';

/**
 * Bots created here may delegate without a human.
 *
 * MEASURED, and the reason it has to be said: `send_message` is not in
 * D-064's seeded rules, so it falls through to the default `ask` and a turn
 * that calls it SUSPENDS waiting for an operator (found in M7-QA-02). That
 * is the shipped default and none of these tasks is the place to change it —
 * it is a product decision about autonomy and spend. So the harness
 * configures the one rule §6/M7's acceptance criteria need, which is D-047's
 * own instruction: the test sets what it asserts.
 */
export const DELEGATION_ALLOWED = [
  { toolPattern: 'send_message', decision: 'allow' as const },
  ...DEFAULT_AUTO_REVIEW_RULES,
];

export async function startChainHarness(options: {
  redisUrl: string;
  /** Names the harness must know before the model is built (peers by name). */
  model: () => LanguageModel;
  prefix: string;
}): Promise<ChainHarness> {
  const queueName = `bot.message.test.${options.prefix}.${Date.now()}.${randomUUID().slice(0, 8)}`;
  const queue = new Queue(queueName, { connection: redisConnection(options.redisUrl) });
  const limits = { maxHops: 0, maxTokens: 0, maxRepeatSends: 0 };

  const { Test } = await import('@nestjs/testing');
  const moduleRef = await Test.createTestingModule({
    imports: [
      (await import('../src/interbot/interbot.module.js')).InterbotModule,
      // The producer a delivered message's run is handed to (D-199).
      (await import('../src/chat/chat-delivery.module.js')).ChatDeliveryModule,
    ],
  })
    .overrideProvider(SANDBOX_PROVIDER)
    .useValue(new FakeProvider())
    .overrideProvider(CHAIN_LIMITS)
    .useValue(limits)
    .overrideProvider(BOT_MESSAGE_QUEUE)
    .useValue(new BullBotMessageQueue(queue))
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  scriptModel(app, options.model);

  const prisma = app.get(PrismaService);
  const delivery = app.get(BotMessageDeliveryService);
  const worker = new Worker<BotMessageJobData>(
    queueName,
    async (job) => {
      await delivery.deliver(job.data);
    },
    { connection: redisConnection(options.redisUrl), concurrency: 1 },
  );

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
    update: {},
  });

  const created: string[] = [];

  return {
    app,
    bots: app.get(BotsService),
    messages: app.get(MessagesService),
    prisma,
    turns: app.get(TanStackTurns),
    queue,
    worker,
    limits,
    async makeBot(name: string) {
      const bot = await app.get(BotsService).create(USER_ID, {
        name,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'you are a test bot',
        autoReviewRules: DELEGATION_ALLOWED,
      });
      created.push(bot.id);
      return { id: bot.id, name: bot.name };
    },
    async messagesOf(botId: string) {
      return prisma.message.findMany({
        where: { conversation: { botId } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { author: true, content: true, fromBotId: true, chainId: true, hopCount: true },
      });
    },
    async close() {
      // The worker first: closing the queue under a live worker leaves the
      // worker's blocking connection reconnecting to keys that are gone.
      await worker.close().catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
      for (const id of created) {
        await prisma.bot.delete({ where: { id } }).catch(() => undefined);
      }
      await app.close();
    },
  };
}

export { USER_ID };
