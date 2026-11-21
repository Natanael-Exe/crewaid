/** Real PostgreSQL transcript/reservation; controlled model and fixture run/interrupt stores. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventType } from '@tanstack/ai';
import { z } from 'zod';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createPrismaMessageStore } from '../src/agent/persistence/prisma-message-store.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { prismaExecutionFixture } from './mod-ai05-prisma-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('D-176 backend with owned Prisma transcript (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  let stranger: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'modai05' });
    stranger = await signIn(prisma, { label: 'modai05x' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await signOutAndDelete(prisma, stranger.userId);
    await prisma.$disconnect();
  });
  const setup = (write = false) => prismaExecutionFixture(prisma, owner, { write });
  it('admitted user, reserved assistant and full tool rows survive native chat exactly once', async () => {
    const h = await setup();
    const result = await h.backend.execute(h.request, h.ports);
    expect(result.status).toBe('completed');
    const rows = await prisma.message.findMany({
      where: { conversationId: h.thread.id },
      orderBy: { sequence: 'asc' },
    });
    expect(rows.map((row) => row.author)).toEqual(['USER', 'BOT', 'TOOL', 'BOT']);
    expect(rows.filter((row) => row.id === h.request.triggerMessageId)).toHaveLength(1);
    expect(rows.filter((row) => row.runId === h.run.id)).toHaveLength(3);
    expect(rows.find((row) => row.author === 'TOOL')?.content.length).toBeGreaterThan(180000);
    expect(
      h.adapter.observed[1]?.find((message) => message.role === 'tool')?.content.length,
    ).toBeLessThan(180000);
    expect(h.checkpoints.map((step) => step.stepIndex)).toEqual([0, 1]);
    expect(
      h.events.filter(
        (event) => z.object({ type: z.string() }).parse(event).type === EventType.RUN_FINISHED,
      ),
    ).toHaveLength(1);
  });
  it('another principal or bot/run/trigger binding cannot call a provider or tool', async () => {
    const h = await setup();
    for (const changed of [
      { ...h.request, model: { ...h.request.model, userId: stranger.userId } },
      { ...h.request, botId: 'foreign-bot' },
      { ...h.request, triggerMessageId: 'foreign-trigger' },
      { ...h.request, runId: 'unknown-run' },
    ]) {
      expect((await h.backend.execute(changed, h.ports)).status).toBe('failed');
    }
    expect(h.effects).not.toHaveBeenCalled();
    expect(h.adapter.observed).toHaveLength(0);
    expect(await prisma.message.count({ where: { conversationId: h.thread.id } })).toBe(1);
  });
  it('a paused assistant is retained without dispatching or requiring a connected client', async () => {
    const h = await setup(true);
    expect((await h.backend.execute(h.request, h.ports)).status).toBe('interrupted');
    expect(h.effects).not.toHaveBeenCalled();
    const stored = await createPrismaMessageStore(prisma, {
      userId: owner.userId,
      runId: null,
    }).loadThread(h.thread.id);
    expect(stored.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(stored.find((message) => message.role === 'assistant')?.toolCalls?.[0]?.id).toBe(
      'call-1',
    );
    expect(stored.some((message) => message.role === 'tool')).toBe(false);
  });
  it.each([
    ['approved', true, false],
    ['declined', false, false],
    ['edited', true, true],
  ] as const)(
    'a %s Prisma approval resumes the outstanding call, not its empty reservation',
    async (_shape, approved, edit) => {
      const h = await setup(true);
      expect((await h.backend.execute(h.request, h.ports)).status).toBe('interrupted');
      const reserved = await prisma.message.findFirst({
        where: { conversationId: h.thread.id, author: 'TOOL' },
      });
      expect(reserved?.parts).toBeNull();
      const pending = await h.f.persistence.stores.interrupts.listPending(h.thread.id);
      await prisma.agentTurn.update({ where: { id: h.run.id }, data: { status: 'interrupted' } });
      const continuation = await prisma.agentTurn.create({
        data: {
          botId: h.bot.id,
          conversationId: h.thread.id,
          triggerMessageId: h.request.triggerMessageId,
        },
      });
      const result = await h.backend.execute(
        {
          ...h.request,
          runId: continuation.id,
          parentRunId: h.run.id,
          resume: pending.map((record) => ({
            interruptId: record.interruptId,
            status: 'resolved',
            payload: { approved, ...(edit ? { editedArgs: { value: 'reviewed edit' } } : {}) },
          })),
        },
        h.ports,
      );
      expect(result.status).toBe('completed');
      expect(h.effects).toHaveBeenCalledTimes(approved ? 1 : 0);
      if (edit) expect(h.effects.mock.calls[0]?.[0]).toEqual({ value: 'reviewed edit' });
      const filled = await prisma.message.findUnique({ where: { id: reserved!.id } });
      expect(filled?.parts).not.toBeNull();
      expect(filled?.sequence).toBe(reserved?.sequence);
      expect(filled?.runId).toBe(h.run.id);
      expect(
        await prisma.message.count({ where: { conversationId: h.thread.id, author: 'USER' } }),
      ).toBe(1);
    },
  );
});
