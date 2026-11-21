import { describe, expect, it } from 'vitest';

import { BotMessageProcessor } from '../src/interbot/bot-message.processor.js';
import {
  BullBotMessageQueue,
  DELIVERY_ATTEMPTS,
  type BotMessageJobData,
} from '../src/interbot/bot-message.queue.js';

/**
 * The worker's failure handler is the last place a dead delivery can say
 * anything, so the two things it decides get cases of their own: WHICH
 * attempt is the ending worth telling the sender about, and WHO gets told.
 *
 * Instantiated by hand rather than through Nest: what is under test is the
 * handler's own logic, and the constructor's `@Inject`s are only there for
 * the module graph.
 */

const JOB_DATA: BotMessageJobData = {
  userId: 'usr_1',
  fromBotId: 'bot_sender',
  toBotId: 'bot_quill',
  toBotName: 'Quill',
  content: 'please check the invoice',
  chainId: 'chain_x',
  hopCount: 1,
};

function harness() {
  const notices: Array<{ botId: string; chainId: string; content: string }> = [];
  const processor = new BotMessageProcessor(
    { deliver: async () => ({ kind: 'delivered', messageId: 'm1' }) } as never,
    { post: async (botId, chainId, content) => notices.push({ botId, chainId, content }) } as never,
  );
  return { notices, processor };
}

function job(attemptsMade: number, data: BotMessageJobData = JOB_DATA) {
  return { id: 'job1', data, attemptsMade } as never;
}

describe('a dead delivery reaches the sender, once, on the last attempt', () => {
  it('stays quiet while retries remain, because the job may still land', () => {
    // `failed` fires on EVERY attempt, and BullMQ counts them in
    // `attemptsMade` as they happen: after the first two failures of a
    // three-attempt job it reads 1 and 2. Telling the sender at either would
    // report a failure a retry then walks back, and two notices — "failed",
    // then a receipt — read as a system that cannot keep its story straight.
    const { notices, processor } = harness();
    for (let attemptsMade = 1; attemptsMade < DELIVERY_ATTEMPTS; attemptsMade++) {
      void processor.onFailed(job(attemptsMade), new Error('database is away'));
    }
    expect(notices).toEqual([]);
  });

  it('tells the sender which bot never got the message, on the attempt that used up the retries', async () => {
    const { notices, processor } = harness();

    await processor.onFailed(job(DELIVERY_ATTEMPTS), new Error('database is away'));

    expect(notices).toHaveLength(1);
    expect(notices[0]?.botId).toBe('bot_sender');
    expect(notices[0]?.content).toContain('Quill');
    expect(notices[0]?.content).toContain('could not be delivered');
    expect(notices[0]?.content).toContain('database is away');
  });

  it('says nothing when there is no job to say it about', async () => {
    // A worker-level error with no job attached has no sender to inform.
    const { notices, processor } = harness();

    await processor.onFailed(undefined, new Error('connection lost'));

    expect(notices).toEqual([]);
  });
});

describe('the delivery queue retries the machinery, not the refusals', () => {
  it('bounds attempts so a blip recovers and a real failure still ends', async () => {
    // `attempts: 1` made every transient failure a vanished message; an
    // unbounded queue would make every real failure a message that lands
    // twice. The bound is the whole design.
    const options: Array<Record<string, unknown>> = [];
    const queue = new BullBotMessageQueue({
      add: async (_name: string, _data: unknown, opts: Record<string, unknown>) => {
        options.push(opts);
      },
    } as never);

    await queue.enqueue(JOB_DATA);

    expect(options).toHaveLength(1);
    expect(options[0]?.attempts).toBe(DELIVERY_ATTEMPTS);
    expect(DELIVERY_ATTEMPTS).toBeGreaterThan(1);
  });
});
