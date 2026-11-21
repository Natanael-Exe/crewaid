import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  currentTurn,
  MockLanguageModelV4,
  scriptModel,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import type { INestApplication } from '@nestjs/common';
import { TanStackTurns } from '../src/agent/tanstack-turns.js';
import { DEFAULT_AUTO_REVIEW_RULES } from '@crewaid/shared';
import { BotsService } from '../src/bots/bots.service.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { redisConnection } from '../src/common/queue-config.js';
import {
  BOT_MESSAGE_QUEUE,
  BullBotMessageQueue,
  type BotMessageJobData,
} from '../src/interbot/bot-message.queue.js';
import { BotMessageDeliveryService } from '../src/interbot/bot-message.delivery.service.js';
import { CHAIN_LIMITS } from '../src/interbot/chain.config.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';

/**
 * M7-QA-02 — §6/M7's round trip, through a real queue.
 *
 * "Bot A asks Bot B a question and receives an answer appearing in both
 * conversations." The acceptance criterion is about the WHOLE path, so
 * nothing on it is faked but the model: a real BullMQ queue, a real worker,
 * the real delivery service, real turns, real rows.
 *
 * The queue name is unique per run. A `@Processor` is kept out of every test
 * context by `vitest.config.mts`, but a developer's own orchestrator may be
 * running against the same Redis — and it would happily consume these jobs
 * and start turns on ITS bots. An isolated name is what makes that
 * impossible rather than unlikely.
 *
 * ── HOW THE MODEL DECIDES WHAT TO DO ────────────────────────────────────────
 *
 * By reading its prompt, not by counting calls. A call counter would pass
 * whether or not the right bot was asked the right thing, which is most of
 * what this case is checking; switching on the words in the prompt means a
 * message delivered to the wrong bot produces the wrong behaviour and fails.
 *
 * The terminator is the tool RESULT: once "Message queued for" is in the
 * prompt, this turn has already sent, so the model answers with text. Without
 * it the agent loop would send again on every step until the step ceiling.
 */

const ASK = 'NEED_THE_NUMBER';
const ANSWER = 'THE_NUMBER_IS_42';

/** This turn's part of the prompt: a run is sent the thread's whole history. */
function promptText(prompt: unknown): string {
  return JSON.stringify(currentTurn(prompt));
}

function delegatingModel(peerNames: { alpha: string; bravo: string }): MockLanguageModelV4 {
  const usage = { inputTokens: { total: 5 }, outputTokens: { total: 3 } };
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'round-trip-model',
    doStream: async (options: { prompt?: unknown }) => {
      const text = promptText(options.prompt);
      const alreadySent = text.includes('Message queued for');

      let chunks: LanguageModelV4StreamPart[];
      if (alreadySent) {
        // This turn has done its sending. Answer, so the loop ends.
        chunks = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'done' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ];
      } else if (text.includes(ANSWER)) {
        // Alpha, reading Bravo's reply. The round trip is complete; say so
        // in the transcript rather than sending a third message.
        chunks = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: `Bravo says ${ANSWER}` },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ];
      } else if (text.includes(ASK)) {
        // Bravo, reading Alpha's question: answer it back down the chain.
        chunks = [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: `call-${randomUUID()}`,
            toolName: 'send_message',
            input: JSON.stringify({ toBot: peerNames.alpha, content: ANSWER }),
          },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
        ];
      } else {
        // Alpha, reading the operator: delegate.
        chunks = [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: `call-${randomUUID()}`,
            toolName: 'send_message',
            input: JSON.stringify({ toBot: peerNames.bravo, content: ASK }),
          },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
        ];
      }
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
    },
  });
}

describe.skipIf(
  DATABASE_URL === undefined || DATABASE_URL === '' || REDIS_URL === undefined || REDIS_URL === '',
)('M7-QA-02 a round trip between two bots (real db, real queue)', () => {
  let app: INestApplication;
  let bots: BotsService;
  let messages: MessagesService;
  let prisma: PrismaService;
  let turns: TanStackTurns;
  let queue: Queue;
  let worker: Worker<BotMessageJobData>;
  const created: string[] = [];
  const names = {
    alpha: `Alpha-${randomUUID().slice(0, 8)}`,
    bravo: `Bravo-${randomUUID().slice(0, 8)}`,
  };

  beforeAll(async () => {
    const queueName = `bot.message.test.qa02.${Date.now()}.${randomUUID().slice(0, 8)}`;
    queue = new Queue(queueName, { connection: redisConnection(REDIS_URL!) });

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
      .useValue({ maxHops: 0, maxTokens: 0, maxRepeatSends: 0 })
      .overrideProvider(BOT_MESSAGE_QUEUE)
      .useValue(new BullBotMessageQueue(queue))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    bots = app.get(BotsService);
    messages = app.get(MessagesService);
    prisma = app.get(PrismaService);
    turns = app.get(TanStackTurns);
    scriptModel(app, () => delegatingModel(names));

    const delivery = app.get(BotMessageDeliveryService);
    worker = new Worker<BotMessageJobData>(
      queueName,
      async (job) => {
        await delivery.deliver(job.data);
      },
      { connection: redisConnection(REDIS_URL!), concurrency: 1 },
    );

    await prisma.user.upsert({
      where: { id: USER_ID },
      create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
      update: {},
    });
  }, 60_000);

  afterAll(async () => {
    await worker?.close().catch(() => undefined);
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close().catch(() => undefined);
    for (const id of created) {
      await prisma.bot.delete({ where: { id } }).catch(() => undefined);
    }
    await app?.close();
  }, 60_000);

  /**
   * A bot allowed to use `send_message` without a human.
   *
   * MEASURED, NOT ASSUMED, and worth writing down: `send_message` is not in
   * D-064's seeded rules, so it falls through to the default `ask` and a
   * turn that calls it SUSPENDS waiting for an operator. That is the shipped
   * default and this task is not the place to change it — it is a product
   * decision about autonomy and spend, and D-064 states the principle it
   * follows ("what ACTS is asked about").
   *
   * So the test configures what it asserts, which is D-047's own instruction
   * for the §6/M7 acceptance criteria. An operator who wants unattended
   * delegation adds exactly this one rule.
   */
  async function makeBot(name: string) {
    const bot = await bots.create(USER_ID, {
      name,
      role: 'R',
      avatarColor: '#123456',
      systemPrompt: 'you are a test bot',
      autoReviewRules: [
        { toolPattern: 'send_message', decision: 'allow' },
        ...DEFAULT_AUTO_REVIEW_RULES,
      ],
    });
    created.push(bot.id);
    return bot;
  }

  async function messagesOf(botId: string) {
    return prisma.message.findMany({
      where: { conversation: { botId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { author: true, content: true, fromBotId: true, chainId: true, hopCount: true },
    });
  }

  it('carries a question to B and its answer back to A, in both conversations', async () => {
    const alpha = await makeBot(names.alpha);
    const bravo = await makeBot(names.bravo);

    const trigger = await messages.createUserMessage(USER_ID, alpha.id, {
      content: 'ask the other bot for the number',
    });
    await turns.startStored(USER_ID, alpha.id, {
      id: trigger.id,
      content: trigger.content,
      chainId: trigger.chainId,
      hopCount: 0,
    });

    // The whole round trip runs through the queue, so it settles after the
    // call that started it has already returned.
    //
    // Wait for the state this test is about to ASSERT, not a weaker one. TWO
    // rows in Alpha's transcript contain ANSWER — Bravo's delivery, whose
    // content IS the answer, and Alpha's own reply about it ("Bravo says …") —
    // so `some(includes(ANSWER))` is satisfied by the delivery alone, and the
    // run continued while Alpha's closing turn was still being written. The
    // last row was then Bravo's and the final assertion failed. It wins that
    // race on a fast machine and loses it on a loaded CI runner, which is the
    // shape of every flake that only ever fails in CI.
    await vi.waitFor(
      async () => {
        const rows = await messagesOf(alpha.id);
        expect(rows.at(-1)).toMatchObject({ author: 'BOT', fromBotId: alpha.id });
        expect(rows.at(-1)?.content).toContain(ANSWER);
      },
      { timeout: 30_000, interval: 200 },
    );

    const alphaRows = await messagesOf(alpha.id);
    const bravoRows = await messagesOf(bravo.id);

    // §6/M7's criterion: the answer appears in BOTH conversations. In
    // Bravo's it is what Bravo said; in Alpha's it is what arrived.
    const inbound = alphaRows.find((row) => row.content === ANSWER);
    expect(inbound).toMatchObject({
      author: 'BOT',
      fromBotId: bravo.id,
      chainId: trigger.id,
      hopCount: 2,
    });

    const question = bravoRows.find((row) => row.content === ASK);
    expect(question).toMatchObject({
      author: 'BOT',
      fromBotId: alpha.id,
      chainId: trigger.id,
      hopCount: 1,
    });

    // The chain is ONE chain across both conversations, named for the
    // message the operator sent — which is what makes an operator able to
    // read the whole exchange out of two transcripts.
    const chainIds = new Set(
      [...alphaRows, ...bravoRows]
        .map((row) => row.chainId)
        .filter((id): id is string => id !== null),
    );
    expect(chainIds).toEqual(new Set([trigger.id]));

    // And Alpha answered its operator at the end, rather than stopping on
    // the delivery.
    expect(alphaRows.at(-1)).toMatchObject({ author: 'BOT', fromBotId: alpha.id });
    expect(alphaRows.at(-1)?.content).toContain(ANSWER);
  }, 90_000);
});
