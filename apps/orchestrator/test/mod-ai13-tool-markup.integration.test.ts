/** D-198: a reply that is tool-call markup fails its run and is never stored as the bot's words. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelMessage } from '@tanstack/ai';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RunLeaseService } from '../src/agent/persistence/run-lease.js';
import { leakedToolMarkup } from '../src/agent/execution/tool-markup.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { produceOwned, userMessage } from './mod-ai06-owned-harness.js';

const reply = (content: string, extra: Partial<ModelMessage> = {}): ModelMessage =>
  ({ role: 'assistant', content, ...extra }) as ModelMessage;

describe('leakedToolMarkup', () => {
  it('catches a reply that opens with a provider’s tool-call syntax', () => {
    for (const text of [
      '<tool_call>capture_screen({})',
      '  <invoke name="memory_read"><parameter name="query">x</parameter></invoke>',
      '<function_calls><invoke name="a"></invoke></function_calls>',
      '[TOOL_CALLS][{"name":"a"}]',
    ])
      expect(leakedToolMarkup([reply(text)])).toBeDefined();
  });

  it('leaves prose about the syntax, a real call and a non-final message alone', () => {
    expect(leakedToolMarkup([reply('Models write <tool_call> when they mean a call.')])).toBe(
      undefined,
    );
    expect(
      leakedToolMarkup([
        reply('<tool_call>x', {
          toolCalls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }],
        }),
      ]),
    ).toBe(undefined);
    expect(leakedToolMarkup([reply('<tool_call>x'), { role: 'user', content: 'hi' }])).toBe(
      undefined,
    );
  });
});

describe.skipIf(!process.env['DATABASE_URL'])('a run whose reply is tool-call markup', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;

  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'd198' });
  }, 60_000);
  afterAll(async () => {
    if (owner) await signOutAndDelete(prisma, owner.userId);
    await prisma.$disconnect();
  }, 60_000);

  async function runOn(content: string) {
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `markup-${randomUUID()}`,
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
      },
    });
    const thread = await prisma.conversation.create({
      data: { botId: bot.id },
    });
    const triggerMessageId = await userMessage(prisma, bot.id, thread.id, content);
    const claim = await new RunLeaseService(prisma).claim({
      userId: owner.userId,
      botId: bot.id,
      threadId: thread.id,
      runId: randomUUID(),
      triggerMessageId,
    });
    if (claim.kind !== 'claimed') throw new Error('fixture');
    const t = { userId: owner.userId, botId: bot.id, threadId: thread.id, triggerMessageId };
    const outcome = await produceOwned(prisma, t, claim.lease, async () => 'unused');
    const rows = await prisma.message.findMany({
      where: { conversationId: thread.id, author: 'BOT' },
      select: { content: true, parts: true },
    });
    const run = await prisma.agentTurn.findUniqueOrThrow({ where: { id: claim.lease.runId } });
    const last = await prisma.runEvent.findFirst({
      where: { runId: claim.lease.runId },
      orderBy: { id: 'desc' },
      select: { chunk: true },
    });
    return { outcome, rows, run, last: last?.chunk as { type?: string; code?: string } };
  }

  it('fails with a retryable code and keeps no trace of the text in the transcript', async () => {
    const { outcome, rows, run, last } = await runOn('markup please');
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(run.status).toBe('failed');
    expect(run.workerId).toBe(null);
    expect(last).toMatchObject({ type: 'RUN_ERROR', code: 'PROVIDER_UNAVAILABLE' });
    // The streamed snapshot wrote the text; the close withdrew it to a reservation.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ content: '', parts: null });
  }, 60_000);

  it('completes an ordinary reply on the same path', async () => {
    const { outcome, rows } = await runOn('say hello');
    expect(outcome.status).toBe('completed');
    expect(rows.map((row) => row.content)).toEqual(['hello from the script']);
  }, 60_000);
});
