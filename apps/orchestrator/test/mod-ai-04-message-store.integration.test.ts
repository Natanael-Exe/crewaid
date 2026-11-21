/**
 * MOD-AI-04 (D-166) — the library's MessageStore over Conversation and
 * Message, against real Postgres.
 *
 * The library's own conformance cases for messages do not apply, and the
 * reason is the contract rather than the code: they save id-less user
 * messages to threads nobody owns and expect a short save to delete the rest.
 * Crewaid's store refuses the first (D-010) and keeps the rest (D-159 §3.4).
 * These cases pin what it does instead.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelMessage } from '@tanstack/ai';
import {
  createPrismaMessageStore,
  TranscriptStoreError,
} from '../src/agent/persistence/prisma-message-store.js';
import { toTranscriptRow } from '../src/agent/persistence/transcript.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'MOD-AI-04 Prisma message store (real db)',
  () => {
    const prisma = new PrismaService();
    let owner: SignedInUser;
    let stranger: SignedInUser;

    beforeAll(async () => {
      await prisma.$connect();
      owner = await signIn(prisma, { label: 'modai04' });
      stranger = await signIn(prisma, { label: 'modai04x' });
    });

    afterAll(async () => {
      await signOutAndDelete(prisma, owner.userId);
      await signOutAndDelete(prisma, stranger.userId);
      await prisma.$disconnect();
    });

    const id = (label: string) => `${label}_${randomUUID()}`;

    async function thread() {
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: id('bot'),
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      const conversation = await prisma.conversation.create({
        data: { botId: bot.id },
        select: { id: true },
      });
      return { botId: bot.id, threadId: conversation.id };
    }

    async function startRun(t: { botId: string; threadId: string }) {
      return (
        await prisma.agentTurn.create({
          data: {
            botId: t.botId,
            conversationId: t.threadId,
            triggerMessageId: id('trigger'),
            status: 'running',
          },
        })
      ).id;
    }

    /** What the admitting route does: the user's message is stored before the run. */
    async function admit(t: { botId: string; threadId: string }, text: string, columns = {}) {
      const row = toTranscriptRow(
        { id: id('u'), role: 'user', content: text },
        { threadBotId: t.botId, runId: null },
      );
      if (!row.ok) throw new Error('fixture');
      return prisma.message.create({
        data: { conversationId: t.threadId, ...row.value, ...columns },
      });
    }

    const reader = () => createPrismaMessageStore(prisma, { userId: owner.userId, runId: null });
    const writer = (runId: string) =>
      createPrismaMessageStore(prisma, { userId: owner.userId, runId });

    const strip = (messages: ModelMessage[]) =>
      messages.map(({ createdAt: _createdAt, ...message }) => message);

    it('loads an unknown thread, and one the principal does not own, as empty', async () => {
      const t = await thread();
      await admit(t, 'hello');
      await expect(reader().loadThread(id('nothing'))).resolves.toEqual([]);
      await expect(
        createPrismaMessageStore(prisma, { userId: stranger.userId, runId: null }).loadThread(
          t.threadId,
        ),
      ).resolves.toEqual([]);
      await expect(reader().loadThread(t.threadId)).resolves.toHaveLength(1);
    });

    it('saves a run onto a thread and reads it back with stable ids', async () => {
      const t = await thread();
      const user = await admit(t, 'What is the staging host?');
      const run = await startRun(t);
      const store = writer(run);

      const history = await store.loadThread(t.threadId);
      const reply: ModelMessage[] = [
        ...history,
        {
          id: id('a'),
          role: 'assistant',
          content: null,
          metadata: { tanstack: { run: { id: run } } },
          toolCalls: [
            {
              id: 'call_0',
              type: 'function',
              function: { name: 'memory_search', arguments: '{}' },
            },
          ],
        },
        // The engine gives a tool result no id.
        { role: 'tool', toolCallId: 'call_0', content: '{"host":"staging-7"}' },
        {
          id: id('a'),
          role: 'assistant',
          content: 'staging-7',
          metadata: { tanstack: { run: { id: run } } },
        },
      ];
      await store.saveThread(t.threadId, reply);
      // The library saves the same list again at the end of the run.
      await store.saveThread(t.threadId, reply);

      const loaded = await reader().loadThread(t.threadId);
      expect(loaded).toHaveLength(4);
      expect(loaded[0]?.id).toBe(user.id);
      expect(loaded[2]).toMatchObject({ role: 'tool', toolCallId: 'call_0' });
      expect(loaded[2]?.id).toMatch(/^tr_/);
      const rows = await prisma.message.findMany({
        where: { conversationId: t.threadId },
        orderBy: { sequence: 'asc' },
        select: { author: true, runId: true },
      });
      expect(rows).toEqual([
        { author: 'USER', runId: null },
        { author: 'BOT', runId: run },
        { author: 'TOOL', runId: run },
        { author: 'BOT', runId: run },
      ]);
    });

    it('adds only what a later run wrote, and leaves product columns alone', async () => {
      const t = await thread();
      const task = await prisma.task.create({
        data: { userId: owner.userId, title: 'note', rank: 'a' },
      });
      const first = await admit(t, 'first', { taskId: task.id });
      await prisma.attachment.create({
        data: {
          messageId: first.id,
          ownerId: owner.userId,
          filename: 'a.txt',
          mimeType: 'text/plain',
          sizeBytes: 1,
          storageKey: id('blob'),
        },
      });
      const r1 = await startRun(t);
      const h1 = await writer(r1).loadThread(t.threadId);
      await writer(r1).saveThread(t.threadId, [
        ...h1,
        { id: id('a'), role: 'assistant', content: 'one' },
      ]);
      await prisma.agentTurn.update({ where: { id: r1 }, data: { status: 'completed' } });

      await admit(t, 'second');
      const r2 = await startRun(t);
      const h2 = await writer(r2).loadThread(t.threadId);
      await writer(r2).saveThread(t.threadId, [
        ...h2,
        { id: id('a'), role: 'assistant', content: 'two' },
      ]);

      const rows = await prisma.message.findMany({
        where: { conversationId: t.threadId },
        orderBy: { sequence: 'asc' },
        include: { attachments: { select: { id: true } } },
      });
      expect(rows.map((row) => row.content)).toEqual(['first', 'one', 'second', 'two']);
      expect(rows[0]?.taskId).toBe(task.id);
      expect(rows[0]?.attachments).toHaveLength(1);
      expect(rows.map((row) => row.runId)).toEqual([null, r1, null, r2]);
    });

    it('never deletes: an empty save and a short save keep the thread', async () => {
      const t = await thread();
      await admit(t, 'one');
      await admit(t, 'two');
      const run = await startRun(t);
      const store = writer(run);
      const before = await store.loadThread(t.threadId);

      await store.saveThread(t.threadId, []);
      await store.saveThread(t.threadId, before.slice(0, 1));

      expect(strip(await reader().loadThread(t.threadId))).toEqual(strip(before));
    });

    it('serializes concurrent saves: the same new message is written once', async () => {
      const t = await thread();
      await admit(t, 'go');
      const run = await startRun(t);
      const store = writer(run);
      const history = await store.loadThread(t.threadId);
      const save = [
        ...history,
        { id: id('a'), role: 'assistant' as const, content: 'done' },
        { role: 'tool' as const, toolCallId: 'call_x', content: '{}' },
      ];

      await Promise.all([store.saveThread(t.threadId, save), store.saveThread(t.threadId, save)]);
      await expect(prisma.message.count({ where: { conversationId: t.threadId } })).resolves.toBe(
        3,
      );
    });

    it('writes all of a save or none of it', async () => {
      const t = await thread();
      const other = await thread();
      const foreign = await admit(other, 'not yours');
      await admit(t, 'go');
      const run = await startRun(t);
      const store = writer(run);
      const history = await store.loadThread(t.threadId);

      await expect(
        store.saveThread(t.threadId, [
          ...history,
          { id: id('a'), role: 'assistant', content: 'written first' },
          { id: foreign.id, role: 'user', content: 'not yours' },
        ]),
      ).rejects.toMatchObject({ code: 'CONTRACT_VIOLATION' });
      await expect(prisma.message.count({ where: { conversationId: t.threadId } })).resolves.toBe(
        1,
      );
      await expect(prisma.message.findUnique({ where: { id: foreign.id } })).resolves.toMatchObject(
        {
          conversationId: other.threadId,
        },
      );
    });

    it('refuses to write a thread the principal does not own', async () => {
      const t = await thread();
      await admit(t, 'mine');
      const run = await startRun(t);
      const intruder = createPrismaMessageStore(prisma, { userId: stranger.userId, runId: run });

      await expect(
        intruder.saveThread(t.threadId, [{ id: id('a'), role: 'assistant', content: 'injected' }]),
      ).rejects.toBeInstanceOf(TranscriptStoreError);
      await expect(
        intruder.reserve(t.threadId, { role: 'assistant', id: id('a') }),
      ).rejects.toMatchObject({ code: 'THREAD_NOT_OWNED' });
      await expect(prisma.message.count({ where: { conversationId: t.threadId } })).resolves.toBe(
        1,
      );
    });

    it('refuses a stale writer: a run that is no longer its thread’s newest', async () => {
      const t = await thread();
      await admit(t, 'go');
      const stale = await startRun(t);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await startRun(t);

      await expect(
        writer(stale).saveThread(t.threadId, [{ id: id('a'), role: 'assistant', content: 'late' }]),
      ).rejects.toMatchObject({ code: 'STALE_WRITER' });
    });

    it('a hydration store cannot save or reserve even for its own thread', async () => {
      const t = await thread();
      await startRun(t);
      await expect(
        reader().saveThread(t.threadId, [{ id: id('a'), role: 'assistant', content: 'unbound' }]),
      ).rejects.toMatchObject({ code: 'STALE_WRITER' });
      await expect(
        reader().reserve(t.threadId, { id: id('a'), role: 'assistant' }),
      ).rejects.toMatchObject({ code: 'STALE_WRITER' });
    });

    it('refuses role replacement and reservations that collide with another message', async () => {
      const t = await thread();
      const user = await admit(t, 'keep me');
      const store = writer(await startRun(t));
      await expect(
        store.saveThread(t.threadId, [{ id: user.id, role: 'assistant', content: 'changed role' }]),
      ).rejects.toMatchObject({ code: 'CONTRACT_VIOLATION' });
      await expect(
        store.reserve(t.threadId, { id: user.id, role: 'assistant' }),
      ).rejects.toMatchObject({ code: 'CONTRACT_VIOLATION' });
      const other = await thread();
      const foreign = await admit(other, 'other');
      await expect(
        store.reserve(t.threadId, { id: foreign.id, role: 'assistant' }),
      ).rejects.toMatchObject({ code: 'CONTRACT_VIOLATION' });
      expect(await store.loadThread(t.threadId)).toMatchObject([
        { role: 'user', content: 'keep me' },
      ]);
    });

    it('uses insertion order when client ids and timestamps would choose the older writer', async () => {
      const t = await thread();
      const at = new Date('2026-10-03T00:00:00Z');
      const old = await prisma.agentTurn.create({
        data: {
          id: id('z'),
          botId: t.botId,
          conversationId: t.threadId,
          triggerMessageId: id('trigger'),
          status: 'running',
          startedAt: at,
        },
      });
      const fresh = await prisma.agentTurn.create({
        data: {
          id: id('a'),
          botId: t.botId,
          conversationId: t.threadId,
          triggerMessageId: id('trigger'),
          status: 'running',
          startedAt: at,
        },
      });
      await expect(writer(old.id).saveThread(t.threadId, [])).rejects.toMatchObject({
        code: 'STALE_WRITER',
      });
      await expect(writer(fresh.id).saveThread(t.threadId, [])).resolves.toBeUndefined();
    });

    it('updates a changed body and nothing else about the row', async () => {
      const t = await thread();
      await admit(t, 'go');
      const run = await startRun(t);
      const store = writer(run);
      const history = await store.loadThread(t.threadId);
      const replyId = id('a');
      await store.saveThread(t.threadId, [
        ...history,
        { id: replyId, role: 'assistant', content: 'draft' },
      ]);
      await store.saveThread(t.threadId, [
        ...history,
        { id: replyId, role: 'assistant', content: 'final' },
      ]);

      await expect(prisma.message.findUnique({ where: { id: replyId } })).resolves.toMatchObject({
        author: 'BOT',
        runId: run,
        content: 'final',
        parts: { role: 'assistant', content: 'final' },
      });
    });

    it('keeps the order things happened in: a reservation sorts before a message admitted mid-run', async () => {
      const t = await thread();
      await admit(t, 'go');
      const run = await startRun(t);
      const store = writer(run);
      const history = await store.loadThread(t.threadId);
      const replyId = id('a');

      // The reply's stream starts and its call starts; then the user speaks.
      await store.reserve(t.threadId, { role: 'assistant', id: replyId });
      await store.reserve(t.threadId, { role: 'tool', toolCallId: 'call_1' });
      await store.reserve(t.threadId, { role: 'assistant', id: replyId });
      const midRun = await admit(t, 'also check prod');

      await store.saveThread(t.threadId, [
        ...history,
        {
          id: replyId,
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'ok' },
      ]);
      // A reservation after the save never clobbers what the save wrote.
      await store.reserve(t.threadId, { role: 'tool', toolCallId: 'call_1' });

      const loaded = await reader().loadThread(t.threadId);
      expect(loaded.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
      expect(loaded[2]).toMatchObject({ content: 'ok' });
      expect(loaded[3]?.id).toBe(midRun.id);
    });
    it('omits reservations from model history but retains a genuinely empty saved tool result', async () => {
      const t = await thread();
      await admit(t, 'go');
      const run = await startRun(t);
      const store = writer(run);
      const replyId = id('a');
      await store.reserve(t.threadId, { role: 'assistant', id: replyId });
      await store.reserve(t.threadId, { role: 'tool', toolCallId: 'call_empty' });
      expect(await reader().loadThread(t.threadId)).toHaveLength(1);
      const history = await store.loadThread(t.threadId);
      await store.saveThread(t.threadId, [
        ...history,
        {
          id: replyId,
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'call_empty', type: 'function', function: { name: 'fixture', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'call_empty', content: '' },
      ]);
      const loaded = await reader().loadThread(t.threadId);
      expect(loaded).toHaveLength(3);
      expect(loaded[2]).toMatchObject({ role: 'tool', content: '', toolCallId: 'call_empty' });
      expect(loaded[1]?.metadata).toEqual({ tanstack: { run: { id: run } } });
      await store.reserve(t.threadId, { role: 'tool', toolCallId: 'call_empty' });
      expect(await reader().loadThread(t.threadId)).toEqual(loaded);
    });
    it('a malformed null-body row cannot masquerade as a server reservation', async () => {
      const t = await thread();
      const run = await startRun(t);
      await prisma.message.create({
        data: {
          conversationId: t.threadId,
          author: 'TOOL',
          fromBotId: t.botId,
          runId: run,
          content: 'corrupt non-empty body',
        },
      });
      await expect(reader().loadThread(t.threadId)).rejects.toMatchObject({
        code: 'CONTRACT_VIOLATION',
      });
    });
  },
);
