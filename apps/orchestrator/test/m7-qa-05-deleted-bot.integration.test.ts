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
 * M7-QA-05 — §6/M7's deletion criterion, through the real queue.
 *
 * "Deleting a bot mid-chain terminates the chain cleanly rather than
 * dead-lettering forever", and the required test is "delete a participating
 * bot mid-chain; assert no stuck jobs after 30 s".
 *
 * ── WHAT "NO STUCK JOBS" HAS TO MEAN TO BE WORTH ASSERTING ──────────────────
 *
 * Not just an empty `waiting` list. A job that THREW is not stuck in the
 * queue and is still a failure an operator has to find, so `failed` is
 * counted too — and BullMQ keeps a failed job's hash by default, which is
 * exactly the dead-lettering §6/M7 names. `active` is counted because a
 * worker wedged inside `deliver` leaves a job that is neither waiting nor
 * finished, which is the shape that looks healthiest and is worst.
 *
 * ── THE DELETION IS STAGED, NOT RACED ──────────────────────────────────────
 *
 * The interesting job is the one already ENQUEUED for a bot that stops
 * existing before the worker reaches it, and with the worker running that
 * window is a few milliseconds wide. Deleting "somewhere in the middle"
 * measured something else entirely: the first version of this case killed
 * the bot while its own turn was running, the chain stopped because that
 * turn died rather than because a delivery was refused, and nobody was told
 * anything — a clean termination, but not the one §6/M7 describes.
 *
 * So the worker is paused, the send that lands in the queue is waited for,
 * the bot is deleted, and the worker is resumed. Every step is observed.
 */

function pingPongModel(names: () => string[]): MockLanguageModelV4 {
  const usage = { inputTokens: { total: 4 }, outputTokens: { total: 2 } };
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'ping-pong-model',
    doStream: async (options: { prompt?: unknown }) => {
      const text = JSON.stringify(currentTurn(options.prompt));
      const [alpha, bravo] = names();
      const target = text.includes(`from ${alpha ?? ''}`) ? alpha : bravo;
      const stop =
        text.includes('Message queued for') ||
        text.includes('no longer on this team') ||
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
)('M7-QA-05 a bot deleted mid-chain (real db, real queue)', () => {
  let harness: ChainHarness;
  let alpha = '';
  let bravo = '';

  beforeAll(async () => {
    harness = await startChainHarness({
      redisUrl: REDIS_URL!,
      prefix: 'qa05',
      model: () => pingPongModel(() => [alpha, bravo]),
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  }, 60_000);

  it('leaves no stuck job, and tells the survivor the chain is over', async () => {
    // A ceiling well past where the deletion lands, so what ends this chain
    // is the deletion and not a limit. Without it the case would pass on a
    // hop limit and prove nothing about deletion at all.
    harness.limits.maxHops = 40;
    const a = await harness.makeBot(`Stayer-${randomUUID().slice(0, 8)}`);
    const b = await harness.makeBot(`Goner-${randomUUID().slice(0, 8)}`);
    alpha = a.name;
    bravo = b.name;

    const trigger = await harness.messages.createUserMessage(USER_ID, a.id, {
      content: 'start talking to the other bot',
    });
    void harness.turns
      .startStored(USER_ID, a.id, {
        id: trigger.id,
        content: trigger.content,
        chainId: trigger.chainId,
        hopCount: 0,
      })
      .catch(() => undefined);

    // Wait until the chain is genuinely under way — a deletion before the
    // first delivery would test nothing, and B has to be a participant for
    // its removal to be a removal "mid-chain".
    await vi.waitFor(
      async () => {
        const rows = await harness.messagesOf(b.id);
        expect(rows.some((row) => row.fromBotId === a.id)).toBe(true);
      },
      { timeout: 60_000, interval: 100 },
    );

    // Stop delivering. The chain advances only through deliveries, so with
    // the worker paused it comes to rest and the queue stays as it is —
    // which is what makes the next step observable instead of a race.
    await harness.worker.pause();

    // Now put exactly one job in the queue, addressed to B. This is the job
    // §6/M7 is about: enqueued for a bot that is about to stop existing.
    const second = await harness.messages.createUserMessage(USER_ID, a.id, {
      content: 'ask them again',
    });
    await harness.turns.startStored(USER_ID, a.id, {
      id: second.id,
      content: second.content,
      chainId: second.chainId,
      hopCount: 0,
    });
    const pending = await harness.queue.getJobs(['waiting', 'delayed']);
    expect(pending.some((job) => job.data.toBotId === b.id)).toBe(true);

    await harness.prisma.bot.delete({ where: { id: b.id } });
    const deletedAt = Date.now();
    harness.worker.resume();

    // §6/M7's "no stuck jobs after 30 s", counted across every state a job
    // can be left in rather than only the obvious one.
    await vi.waitFor(
      async () => {
        const counts = await harness.queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'paused',
        );
        expect(
          counts.waiting + counts.active + counts.delayed + counts.failed + counts.paused,
        ).toBe(0);
      },
      { timeout: 30_000, interval: 250 },
    );
    expect(Date.now() - deletedAt).toBeLessThan(30_000);

    // M7-BE-05: clean is not silent. The surviving bot is holding a plan
    // whose next step can never arrive, and it is the one bot still here.
    // Found by content rather than as "the first SYSTEM row": the hop that
    // DID land earlier left its delivery receipt in this same transcript.
    await vi.waitFor(
      async () => {
        const rows = await harness.messagesOf(a.id);
        expect(
          rows.some(
            (row) => row.author === 'SYSTEM' && row.content.includes('no longer on this team'),
          ),
        ).toBe(true);
      },
      { timeout: 30_000, interval: 250 },
    );

    const note = (await harness.messagesOf(a.id)).find(
      (row) => row.author === 'SYSTEM' && row.content.includes('no longer on this team'),
    );
    // Named from the job's own snapshot, which is the only place the name
    // still exists once the row is gone.
    expect(note?.content).toContain(b.name);
  }, 180_000);
});
