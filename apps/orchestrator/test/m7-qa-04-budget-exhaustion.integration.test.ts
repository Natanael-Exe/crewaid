import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  currentTurn,
  MockLanguageModelV4,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';

import { SPECIFIED_MAX_CHAIN_TOKENS } from '../src/interbot/chain.config.js';
import { startChainHarness, USER_ID, type ChainHarness } from './m7-qa-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];

/**
 * M7-QA-04 — §6/M7's budget criterion, with an inflated-usage stub.
 *
 * "A chain exhausting its token budget terminates and reports actual tokens
 * spent."
 *
 * ── WHY THE USAGE IS INFLATED RATHER THAN THE BUDGET TINY ───────────────────
 *
 * A budget of 1 would terminate the chain on any spend at all, which passes
 * whether or not the meter reads the four D-009(3) counters, whether or not
 * it is scoped to this chain, and whether or not it counts anything. Setting
 * §6/M7's real 200,000 and making one turn cost more than that means the
 * number in the notice has to be a real measurement of a real turn — and the
 * assertions below check it against what the stub actually reported.
 */

const PER_CALL_INPUT = 150_000;
const PER_CALL_OUTPUT = 60_000;

/**
 * Only the two counters a stub can actually move.
 *
 * MEASURED: a `cachedInputTokens` in the mock's usage does NOT reach
 * `AgentTurn` — the recorded row comes back with 0 in both cache columns,
 * which is what a deployment without CC-11's prompt caching looks like
 * anyway. Setting it here and asserting on it would have looked like
 * coverage of the cache half of D-009(3) and been worth nothing; the
 * four-counter sum is pinned by M7-QA-01, which needs no provider to do it.
 */
function expensiveModel(names: () => string[]): MockLanguageModelV4 {
  const usage = {
    inputTokens: { total: PER_CALL_INPUT },
    outputTokens: { total: PER_CALL_OUTPUT },
  };
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'expensive-model',
    doStream: async (options: { prompt?: unknown }) => {
      const text = JSON.stringify(currentTurn(options.prompt));
      const [alpha, bravo] = names();
      const target = text.includes(`from ${alpha ?? ''}`) ? alpha : bravo;
      const stop =
        text.includes('Message queued for') ||
        text.includes('spent its token budget') ||
        text.includes('reached its limit');
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
              input: JSON.stringify({ toBot: target, content: 'KEEP_GOING' }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
          ];
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) };
    },
  });
}

describe.skipIf(
  DATABASE_URL === undefined || DATABASE_URL === '' || REDIS_URL === undefined || REDIS_URL === '',
)('M7-QA-04 a chain that spends its budget (real db, real queue)', () => {
  let harness: ChainHarness;
  let alpha = '';
  let bravo = '';

  beforeAll(async () => {
    harness = await startChainHarness({
      redisUrl: REDIS_URL!,
      prefix: 'qa04',
      model: () => expensiveModel(() => [alpha, bravo]),
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  }, 60_000);

  it('terminates and reports what it actually spent', async () => {
    harness.limits.maxTokens = SPECIFIED_MAX_CHAIN_TOKENS;
    const a = await harness.makeBot(`Spend-${randomUUID().slice(0, 8)}`);
    const b = await harness.makeBot(`Thrift-${randomUUID().slice(0, 8)}`);
    alpha = a.name;
    bravo = b.name;

    const trigger = await harness.messages.createUserMessage(USER_ID, a.id, {
      content: 'work with the other bot until the money runs out',
    });
    await harness.turns.startStored(USER_ID, a.id, {
      id: trigger.id,
      content: trigger.content,
      chainId: trigger.chainId,
      hopCount: 0,
    });

    // Wait for the sentence that ENDS the chain, not for any system row:
    // delivered hops now leave receipts in the sender's transcript, and a
    // receipt is not a termination.
    await vi.waitFor(
      async () => {
        const rows = [...(await harness.messagesOf(a.id)), ...(await harness.messagesOf(b.id))];
        expect(
          rows.some((row) => row.author === 'SYSTEM' && row.content.includes('CHAIN_MAX_TOKENS')),
        ).toBe(true);
      },
      { timeout: 60_000, interval: 250 },
    );

    await vi.waitFor(
      async () => {
        const counts = await harness.queue.getJobCounts('waiting', 'active', 'delayed');
        expect(counts.waiting + counts.active + counts.delayed).toBe(0);
      },
      { timeout: 30_000, interval: 250 },
    );

    const aRows = await harness.messagesOf(a.id);
    const bRows = await harness.messagesOf(b.id);
    const note = [...aRows, ...bRows].find(
      (row) => row.author === 'SYSTEM' && row.content.includes('CHAIN_MAX_TOKENS'),
    );
    expect(note?.content).toContain('CHAIN_MAX_TOKENS');
    expect(note?.content).toContain(SPECIFIED_MAX_CHAIN_TOKENS.toLocaleString('en-US'));

    // §6/M7: "reports ACTUAL tokens spent". Checked against the turns that
    // actually ran, summed the way `/usage` sums them — not against a
    // constant this test chose, which would pass even if the meter counted
    // the wrong turns or none of them.
    // The chain's runs are the ones its messages triggered.
    const inChain = await harness.prisma.message.findMany({
      where: { OR: [{ id: trigger.id }, { chainId: trigger.id }] },
      select: { id: true },
    });
    const turns = await harness.prisma.agentTurn.findMany({
      where: { triggerMessageId: { in: inChain.map((row) => row.id) } },
      select: {
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheCreationTokens: true,
      },
    });
    expect(turns.length).toBeGreaterThan(0);
    const spent = turns.reduce(
      (total, turn) =>
        total +
        turn.inputTokens +
        turn.outputTokens +
        turn.cachedInputTokens +
        turn.cacheCreationTokens,
      0,
    );
    expect(spent).toBeGreaterThanOrEqual(SPECIFIED_MAX_CHAIN_TOKENS);
    // The measurement is of real work: every model call this stub serves costs
    // exactly PER_CALL_INPUT + PER_CALL_OUTPUT, so a sum over real calls is a
    // whole number of them — a meter that dropped or invented a call fails
    // this.
    expect(spent % (PER_CALL_INPUT + PER_CALL_OUTPUT)).toBe(0);
    // The number in the notice is a measurement of this chain too, read at
    // the moment the ceiling tripped: the run's tokens are durable before its
    // tool runs (D-197), which is the instant a chain can be stopped. That
    // figure is at or above the ceiling — it is what stopped the chain — and
    // never above the chain's final total, because the run that tripped the
    // ceiling still finishes and reports the rest.
    const reported = Number(
      note?.content.match(/spending ([\d,]+) tokens/)?.[1]?.replaceAll(',', ''),
    );
    expect(reported).toBeGreaterThanOrEqual(SPECIFIED_MAX_CHAIN_TOKENS);
    expect(reported).toBeLessThanOrEqual(spent);

    // And the chain really stopped: no further deliveries after the note.
    const counts = await harness.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    expect(counts).toMatchObject({ waiting: 0, active: 0, delayed: 0, failed: 0 });
  }, 180_000);
});
