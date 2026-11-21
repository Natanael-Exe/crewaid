import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  currentTurn,
  MockLanguageModelV4,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';

import { startChainHarness, USER_ID, type ChainHarness } from './m7-qa-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];

/**
 * M7-QA-03 — two bots told to converse indefinitely stop.
 *
 * §6/M7: "Two bots told to converse indefinitely terminate at the hop limit
 * within 60 s with the explanatory system message." D-047 amends only where
 * the limit comes from: "the acceptance criterion … is met by a configured
 * limit, so the test sets the limit it asserts."
 *
 * ── THE STUB REALLY IS A LOOP ───────────────────────────────────────────────
 *
 * Every turn it is given, it messages the other bot. No counter, no
 * give-up: if the ceiling does not stop this, nothing does, and the case
 * fails by running until the timeout rather than by asserting a number that
 * was never reached.
 *
 * ── ONE SEND PER TURN, WHICH IS THE SCENARIO §6/M7 DESCRIBES ────────────────
 *
 * The first version of this stub sent on EVERY step, including the step
 * carrying its own tool result, and it enqueued 3,238 jobs before the case
 * gave up. That is worth writing down because it is not a bug in the hop
 * limit: a hop counts a DELIVERY, so all 25 sends a turn can make sit at the
 * same hop, and depth-first bounding does nothing about width. The ceilings
 * that bound width are the step ceiling (25 per turn) and M7-BE-04's
 * per-pair cap — which is off by default, and per PAIR, so a bot with many
 * peers is bounded only by the step ceiling. Recorded for M7-RV-01.
 *
 * "Two bots told to converse indefinitely" is a conversation: one message
 * each way per turn. The terminator is the tool RESULT — once "Message
 * queued for" is in the prompt this turn has sent, so it answers with text
 * and the NEXT turn, triggered by the peer's message, sends again.
 */

const CAP = 6;

function loopingModel(names: () => string[]): MockLanguageModelV4 {
  const usage = { inputTokens: { total: 4 }, outputTokens: { total: 2 } };
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'looping-model',
    doStream: async (options: { prompt?: unknown }) => {
      const text = JSON.stringify(currentTurn(options.prompt));
      const [alpha, bravo] = names();
      // Reply to whoever is NOT named in this prompt's attribution line, so
      // the two bots bounce the chain between them forever.
      const target = text.includes(`from ${alpha ?? ''}`) ? alpha : bravo;
      // Stop on the tool RESULT, either kind. "Message queued for" means
      // this turn has sent; "reached its limit" means the chain is over and
      // the result says so in words ("Finish the work yourself"). A stub
      // that ignored the refusal would keep calling for 25 steps and then
      // through M5-BE-19's continuations, which turns a case about the HOP
      // ceiling into a slow case about the step ceiling.
      const stop = text.includes('Message queued for') || text.includes('reached its limit');
      const chunks: LanguageModelV4StreamPart[] = stop
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'sent' },
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: `call-${randomUUID()}`,
              toolName: 'send_message',
              input: JSON.stringify({ toBot: target, content: 'PING' }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
          ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
    },
  });
}

describe.skipIf(
  DATABASE_URL === undefined || DATABASE_URL === '' || REDIS_URL === undefined || REDIS_URL === '',
)('M7-QA-03 an endless conversation terminates (real db, real queue)', () => {
  let harness: ChainHarness;
  let alpha = '';
  let bravo = '';

  beforeAll(async () => {
    harness = await startChainHarness({
      redisUrl: REDIS_URL!,
      prefix: 'qa03',
      model: () => loopingModel(() => [alpha, bravo]),
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  }, 60_000);

  it(`stops at exactly ${CAP} hops and tells both bots why`, async () => {
    harness.limits.maxHops = CAP;
    const a = await harness.makeBot(`LoopA-${randomUUID().slice(0, 8)}`);
    const b = await harness.makeBot(`LoopB-${randomUUID().slice(0, 8)}`);
    alpha = a.name;
    bravo = b.name;

    const trigger = await harness.messages.createUserMessage(USER_ID, a.id, {
      content: 'talk to the other bot forever',
    });
    const startedAt = Date.now();
    await harness.turns.startStored(USER_ID, a.id, {
      id: trigger.id,
      content: trigger.content,
      chainId: trigger.chainId,
      hopCount: 0,
    });

    // The chain is over when somebody has been told it is over. Any SYSTEM
    // row is not enough: every delivered hop now leaves its receipt in the
    // sender's transcript, so the row that ends the chain is the one naming
    // the ceiling, not the first system row in either conversation.
    await vi.waitFor(
      async () => {
        const rows = [...(await harness.messagesOf(a.id)), ...(await harness.messagesOf(b.id))];
        expect(
          rows.some((row) => row.author === 'SYSTEM' && row.content.includes('CHAIN_MAX_HOPS')),
        ).toBe(true);
      },
      { timeout: 60_000, interval: 250 },
    );

    // §6/M7 says "within 60 s". Measured rather than assumed — a chain that
    // only stops because a test timed out is not a chain that terminates.
    expect(Date.now() - startedAt).toBeLessThan(60_000);

    // Let any job still in flight settle, so the count below is the final
    // one. The diagnostic stays: this is the assertion most likely to flake
    // on a slow runner, and "expected 1 to be 0" says nothing about WHICH
    // job — while the hop and chain of a stuck one says everything.
    try {
      await vi.waitFor(
        async () => {
          const counts = await harness.queue.getJobCounts('waiting', 'active', 'delayed');
          expect(counts.waiting + counts.active + counts.delayed).toBe(0);
        },
        { timeout: 30_000, interval: 250 },
      );
    } catch (error) {
      const counts = await harness.queue.getJobCounts();
      const jobs = await harness.queue.getJobs(['waiting', 'active', 'delayed']);
      console.error('DRAIN DIAGNOSTIC', JSON.stringify(counts));
      for (const job of jobs) {
        console.error('STUCK JOB', job.id, await job.getState(), JSON.stringify(job.data));
      }
      throw error;
    }

    const aRows = await harness.messagesOf(a.id);
    const bRows = await harness.messagesOf(b.id);
    const delivered = [...aRows, ...bRows].filter(
      (row) => row.author === 'BOT' && row.fromBotId !== null && row.chainId === trigger.id,
    );

    // EXACTLY the cap. Deliveries are the BOT rows whose sender is not the
    // conversation's own bot; the replies each recipient composes carry the
    // same chain and are excluded by that test.
    const hops = delivered
      .filter((row) => row.content === 'PING')
      .map((row) => row.hopCount)
      .sort((x, y) => x - y);
    expect(hops).toEqual(Array.from({ length: CAP }, (_, index) => index + 1));

    // "with the explanatory system message" — and to BOTH bots, which is the
    // half a one-sided notice would silently drop. Found by content: the
    // delivered hops also leave their receipts in these transcripts, and a
    // receipt is not the sentence that ends the chain.
    for (const rows of [aRows, bRows]) {
      const note = rows.find(
        (row) => row.author === 'SYSTEM' && row.content.includes('CHAIN_MAX_HOPS'),
      );
      expect(note?.content).toContain('CHAIN_MAX_HOPS');
      expect(note?.content).toContain(String(CAP));
    }

    // "and no further jobs enqueued".
    const counts = await harness.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    expect(counts).toMatchObject({ waiting: 0, active: 0, delayed: 0, failed: 0 });
  }, 180_000);
});
