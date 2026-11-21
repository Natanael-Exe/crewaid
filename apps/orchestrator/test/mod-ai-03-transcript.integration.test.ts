/**
 * MOD-AI-03 (D-165) — the canonical transcript and the run tables, round-tripped.
 *
 * A TANSTACK thread stores one `Message` row per `ModelMessage`. These cases
 * write a thread through the one mapper, read it back in sequence order, and
 * require the same messages: the same ids, the same order, the same bodies,
 * and the provenance the product keeps in columns. Runs and interrupts cross
 * the same way. The unit half runs everywhere; the database half needs
 * `DATABASE_URL` and a deployed schema.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelMessage } from '@tanstack/ai';
import { ApprovalBindingSchema } from '@crewaid/shared';
import {
  assignTranscriptIds,
  crewaidMetadataOf,
  fromTranscriptRow,
  toInterruptRecord,
  toRunRecord,
  toTranscriptRow,
} from '../src/agent/persistence/transcript.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const BOT = 'bot_thread_owner';

describe('MOD-AI-03 transcript mapper (no database)', () => {
  it('refuses a message without a stable id', () => {
    const result = toTranscriptRow(
      { role: 'user', content: 'hi' },
      { threadBotId: BOT, runId: null },
    );
    expect(result).toEqual({ ok: false, violation: { kind: 'missing-id' } });
  });

  it('never stores client metadata', () => {
    const result = toTranscriptRow(
      { id: 'm1', role: 'user', content: 'hi', metadata: { crewaid: { taskId: 'forged' } } },
      { threadBotId: BOT, runId: null },
    );
    expect(result.ok && result.value.parts).toEqual({ role: 'user', content: 'hi' });
  });

  it("keeps the library's own metadata, and takes the run from its tag", () => {
    const result = toTranscriptRow(
      {
        id: 'm1',
        role: 'assistant',
        content: 'done',
        metadata: { tanstack: { run: { id: 'run_a' } }, crewaid: { taskId: 'forged' } },
      },
      { threadBotId: BOT, runId: null },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        runId: 'run_a',
        parts: {
          role: 'assistant',
          content: 'done',
          metadata: { tanstack: { run: { id: 'run_a' } } },
        },
      },
    });
  });

  it('refuses a message tagged with a different run than the one saving it', () => {
    const result = toTranscriptRow(
      {
        id: 'm1',
        role: 'assistant',
        content: 'done',
        metadata: { tanstack: { run: { id: 'run_a' } } },
      },
      { threadBotId: BOT, runId: 'run_b' },
    );
    expect(result).toMatchObject({ ok: false, violation: { kind: 'run-mismatch' } });
  });

  it('names an id-less tool result and assistant message the same way on every save', () => {
    const save: ModelMessage[] = [
      { id: 'u1', role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', toolCallId: 'call_0', content: '{}' },
    ];
    const first = assignTranscriptIds(save, { threadId: 'thread', runId: 'run_a' });
    const again = assignTranscriptIds(save, { threadId: 'thread', runId: 'run_a' });
    expect(first).toEqual(again);
    const ids = first.ok ? first.value.map((message) => message.id) : [];
    expect(ids[0]).toBe('u1');
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id?.length).toBeLessThanOrEqual(64);
    // The same call id in another run is another result.
    const later = assignTranscriptIds([{ role: 'tool', toolCallId: 'call_0', content: '{}' }], {
      threadId: 'thread',
      runId: 'run_b',
    });
    expect(later.ok && later.value[0]?.id).not.toBe(ids[3]);
  });

  it('refuses an id-less user message: the route that admits one names it', () => {
    expect(
      assignTranscriptIds([{ role: 'user', content: 'hi' }], { threadId: 't', runId: 'r' }),
    ).toEqual({ ok: false, violation: { kind: 'missing-id' } });
  });

  it('refuses a body field it does not know, rather than dropping it', () => {
    const result = toTranscriptRow(
      {
        id: 'm1',
        role: 'assistant',
        content: '{}',
        structuredOutput: { type: 'structured-output', status: 'complete', raw: '{}' },
      },
      { threadBotId: BOT, runId: 'run' },
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a teammate message that is not a user turn', () => {
    const result = toTranscriptRow(
      { id: 'm1', role: 'assistant', content: 'hi' },
      { threadBotId: BOT, runId: null, senderBotId: 'other_bot' },
    );
    expect(result).toMatchObject({ ok: false, violation: { kind: 'author-mismatch' } });
  });

  it('reads a SYSTEM row as a product row the model never sees', () => {
    const result = fromTranscriptRow(
      {
        id: 's1',
        author: 'SYSTEM',
        fromBotId: null,
        runId: null,
        parts: null,
        createdAt: new Date(),
      },
      BOT,
    );
    expect(result).toEqual({ ok: true, value: null });
  });

  it('refuses a row whose author cannot carry its role', () => {
    const result = fromTranscriptRow(
      {
        id: 'm1',
        author: 'USER',
        fromBotId: null,
        runId: null,
        parts: { role: 'assistant', content: 'hi' },
        createdAt: new Date(),
      },
      BOT,
    );
    expect(result).toMatchObject({ ok: false, violation: { kind: 'author-mismatch' } });
  });

  it('refuses an unreadable body instead of guessing at it', () => {
    const result = fromTranscriptRow(
      {
        id: 'm1',
        author: 'BOT',
        fromBotId: BOT,
        runId: null,
        parts: [{ type: 'text' }],
        createdAt: new Date(),
      },
      BOT,
    );
    expect(result).toMatchObject({ ok: false, violation: { kind: 'unreadable-body' } });
  });
});

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'MOD-AI-03 canonical transcript round trip (real db)',
  () => {
    const prisma = new PrismaService();
    let user: SignedInUser;
    let botId: string;
    let senderId: string;
    let conversationId: string;

    beforeAll(async () => {
      await prisma.$connect();
      user = await signIn(prisma, { label: 'modai03' });
      const make = (name: string) =>
        prisma.bot.create({
          data: {
            userId: user.userId,
            name,
            role: 'fixture',
            avatarColor: '#8B6F47',
            systemPrompt: '',
          },
        });
      botId = (await make('Quill')).id;
      senderId = (await make('Ledger')).id;
      conversationId = (
        await prisma.conversation.create({
          data: { botId },
          select: { id: true },
        })
      ).id;
      await prisma.conversation.create({ data: { botId: senderId } });
    });

    afterAll(async () => {
      await signOutAndDelete(prisma, user.userId);
      await prisma.$disconnect();
    });

    const id = (label: string) => `${label}_${randomUUID()}`;

    async function run(status: 'completed' | 'interrupted' | 'failed', extra: object = {}) {
      return prisma.agentTurn.create({
        data: { botId, conversationId, triggerMessageId: id('trigger'), status, ...extra },
      });
    }

    async function write(
      message: ModelMessage,
      provenance: { runId: string | null; senderBotId?: string },
      columns: object = {},
    ) {
      const row = toTranscriptRow(message, { threadBotId: botId, ...provenance });
      if (!row.ok) throw new Error(`fixture did not map: ${JSON.stringify(row.violation)}`);
      return prisma.message.create({ data: { conversationId, ...row.value, ...columns } });
    }

    async function readThread() {
      const rows = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { sequence: 'asc' },
        include: {
          attachments: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } },
        },
      });
      const messages: ModelMessage[] = [];
      for (const row of rows) {
        const read = fromTranscriptRow(row, botId);
        if (!read.ok)
          throw new Error(`row ${row.id} did not map: ${JSON.stringify(read.violation)}`);
        if (read.value === null) continue;
        const { createdAt, ...message } = read.value;
        expect(createdAt).toEqual(row.createdAt);
        messages.push(message);
      }
      return { rows, messages };
    }

    it('round-trips text, reasoning, tool pairs, a teammate, a topic boundary, an approval and a failure', async () => {
      const r1 = await run('completed', { endedAt: new Date(), stopReason: 'stop' });
      const r2 = await run('interrupted', { driverEpoch: 0, cancelRequested: false });
      const r3 = await run('failed', { endedAt: new Date(), errorCode: 'RATE_LIMITED' });
      const task = await prisma.task.create({
        data: { userId: user.userId, title: 'Freeze note', rank: 'a' },
      });
      const routine = await prisma.routine.create({
        data: { botId, name: 'Morning check', cron: '0 9 * * 1', prompt: 'Check the board' },
      });

      const thread: ModelMessage[] = [
        { id: id('u1'), role: 'user', content: 'Find the deploy freeze dates and draft a note.' },
        {
          id: id('a1'),
          role: 'assistant',
          content: null,
          metadata: { tanstack: { run: { id: r1.id } } },
          thinking: [{ content: 'The calendar is in the workspace.', signature: 'sig-1' }],
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'fs_read', arguments: '{"path":"freeze.md"}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'memory_search', arguments: '{"query":"freeze"}' },
              metadata: { thoughtSignature: 'ts-2' },
            },
          ],
        },
        { id: id('t1'), role: 'tool', toolCallId: 'call_1', content: '{"text":"Dec 20 to Jan 3"}' },
        {
          id: id('t2'),
          role: 'tool',
          toolCallId: 'call_2',
          content: '[]',
          error: 'nothing matched',
          metadata: { tanstack: { toolResultOutcome: 'error' } },
        },
        { id: id('a2'), role: 'assistant', content: 'The freeze runs Dec 20 to Jan 3.' },
        { id: id('ib'), role: 'user', content: 'Legal wants the note by Friday.' },
        { id: id('u2'), role: 'user', content: 'Post it to #eng when it is ready.' },
        {
          id: id('a3'),
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call_3',
              type: 'function',
              function: { name: 'send_message', arguments: '{"to":"Ledger","text":"note"}' },
            },
          ],
        },
        { id: id('a4'), role: 'assistant', content: 'I could not reach the' },
      ];
      const [u1, a1, t1, t2, a2, ib, u2, a3, a4] = thread as [
        ModelMessage,
        ModelMessage,
        ModelMessage,
        ModelMessage,
        ModelMessage,
        ModelMessage,
        ModelMessage,
        ModelMessage,
        ModelMessage,
      ];

      const u1Row = await write(u1, { runId: null });
      const attachment = await prisma.attachment.create({
        data: {
          messageId: u1Row.id,
          ownerId: user.userId,
          filename: 'calendar.png',
          mimeType: 'image/png',
          sizeBytes: 10,
          storageKey: id('blob'),
        },
      });
      await write(a1, { runId: r1.id });
      await write(t1, { runId: r1.id });
      await write(t2, { runId: r1.id });
      const a2Row = await write(a2, { runId: r1.id }, { stopReason: 'stop' });
      const ibRow = await write(
        ib,
        { runId: null, senderBotId: senderId },
        { taskId: task.id, chainId: 'chain', hopCount: 1 },
      );
      await prisma.message.create({
        data: { conversationId, author: 'SYSTEM', content: '', startsTopic: true },
      });
      const u2Row = await write(u2, { runId: null }, { routineId: routine.id });
      await write(a3, { runId: r2.id });
      const a4Row = await write(a4, { runId: r3.id }, { stopReason: 'RATE_LIMITED' });

      const { rows, messages } = await readThread();
      // Owned run annotations are reconstructed even at untagged interrupt
      // boundaries; content and message order remain canonical.
      expect(messages).toEqual(
        thread.map((message) => {
          if (message.role !== 'assistant' || message.metadata?.tanstack) return message;
          const row = rows.find((row) => row.id === message.id)!;
          return { ...message, metadata: { tanstack: { run: { id: row.runId } } } };
        }),
      );
      expect(rows).toHaveLength(thread.length + 1);
      expect(rows.find((row) => row.author === 'SYSTEM')?.startsTopic).toBe(true);
      expect(rows.map((row) => row.sequence)).toEqual(
        [...rows.map((row) => row.sequence)].sort((a, b) => a - b),
      );

      // Provenance lives in columns and is projected on read.
      const meta = (rowId: string) => {
        const row = rows.find((candidate) => candidate.id === rowId);
        if (row === undefined) throw new Error(`no row ${rowId}`);
        return crewaidMetadataOf(row, row.attachments);
      };
      expect(meta(u1Row.id)).toMatchObject({
        author: 'USER',
        attachments: [
          {
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        ],
      });
      expect(meta(a2Row.id)).toMatchObject({
        author: 'BOT',
        fromBotId: botId,
        runId: r1.id,
        stopReason: 'stop',
      });
      expect(meta(ibRow.id)).toMatchObject({
        author: 'BOT',
        fromBotId: senderId,
        runId: null,
        taskId: task.id,
        chainId: 'chain',
        hopCount: 1,
      });
      expect(meta(u2Row.id)).toMatchObject({ author: 'USER', routineId: routine.id });
      expect(meta(a4Row.id)).toMatchObject({ runId: r3.id, stopReason: 'RATE_LIMITED' });
      // Tool rows are the run's, and nobody's words.
      expect(rows.filter((row) => row.author === 'TOOL').map((row) => row.runId)).toEqual([
        r1.id,
        r1.id,
      ]);

      // Runs: "never set" stays absent, distinct from false and 0.
      const runs = await prisma.agentTurn.findMany({
        where: { conversationId },
        orderBy: { startedAt: 'asc' },
      });
      const records = new Map(runs.map((row) => [row.id, toRunRecord(row)]));
      expect(records.get(r1.id)).toMatchObject({
        runId: r1.id,
        threadId: conversationId,
        status: 'completed',
      });
      expect(records.get(r1.id)).not.toHaveProperty('driverEpoch');
      expect(records.get(r1.id)).not.toHaveProperty('cancelRequested');
      expect(records.get(r1.id)).not.toHaveProperty('error');
      expect(records.get(r2.id)).toMatchObject({
        status: 'interrupted',
        driverEpoch: 0,
        cancelRequested: false,
      });
      expect(records.get(r2.id)).not.toHaveProperty('finishedAt');
      expect(records.get(r3.id)?.error).toEqual({
        code: 'RATE_LIMITED',
        message: 'the run failed: RATE_LIMITED',
      });

      // An approval: durable, ordered by insertion, bound to its call (D-164).
      const binding = ApprovalBindingSchema.parse({
        toolName: 'send_message',
        effect: 'draft',
        scope: 'call',
        argsHash: 'a'.repeat(64),
        grantRevision: 'b'.repeat(64),
        resourceRevision: null,
        seat: null,
        commit: null,
      });
      const requestedAt = new Date();
      const [first, second] = await prisma.$transaction([
        prisma.runInterrupt.create({
          data: {
            runId: r2.id,
            conversationId,
            userId: user.userId,
            requestedAt,
            payload: { kind: 'crewaid.tool-approval', toolCallId: 'call_3', binding },
          },
        }),
        prisma.runInterrupt.create({
          data: {
            runId: r2.id,
            conversationId,
            userId: user.userId,
            requestedAt,
            payload: { kind: 'crewaid.tool-approval', toolCallId: 'call_4', binding },
          },
        }),
      ]);
      const pending = await prisma.runInterrupt.findMany({
        where: { conversationId, status: 'pending' },
        orderBy: { sequence: 'asc' },
      });
      expect(pending.map((row) => row.id)).toEqual([first.id, second.id]);
      const record = toInterruptRecord(first);
      // Private proposals are not native protocol records until explicitly attached.
      expect(record).toMatchObject({ ok: false });

      const resolved = await prisma.runInterrupt.update({
        where: { id: first.id },
        data: { status: 'resolved', resolvedAt: new Date(), response: { approved: true } },
      });
      const answered = toInterruptRecord(resolved);
      expect(answered).toMatchObject({ ok: false });
      // The binding comes back as it was stored, so the dispatch re-check can
      // compare against it (D-164).
      expect(resolved.payload).toMatchObject({ binding });
    });

    it('orders by the sequence a message took when it began, not by when it was saved', async () => {
      const r = await run('completed');
      const started = new Date();
      // The reply's first step begins, a user message is admitted mid-stream,
      // then the reply's next step: the user message sorts between them even
      // though the reply's first row is saved last.
      const late = await write(
        { id: id('s1'), role: 'assistant', content: 'first step' },
        { runId: r.id },
      );
      const between = await write(
        { id: id('s2'), role: 'user', content: 'also this' },
        { runId: null },
      );
      const after = await write(
        { id: id('s3'), role: 'assistant', content: 'second step' },
        { runId: r.id },
      );
      await prisma.message.update({
        where: { id: late.id },
        data: { createdAt: new Date(started.getTime() + 60_000) },
      });

      const ordered = await prisma.message.findMany({
        where: { id: { in: [late.id, between.id, after.id] } },
        orderBy: { sequence: 'asc' },
        select: { id: true },
      });
      expect(ordered.map((row) => row.id)).toEqual([late.id, between.id, after.id]);
    });

    it('keeps what a message established when the message is deleted (D-073, D-147)', async () => {
      const r = await run('completed');
      const said = await write(
        { id: id('kept'), role: 'assistant', content: 'The staging host is staging-7.' },
        { runId: r.id },
      );
      const memory = await prisma.memory.create({
        data: {
          userId: user.userId,
          botId,
          kind: 'FACT',
          source: 'TOLD',
          text: 'The staging host is staging-7.',
          messageId: said.id,
        },
      });
      const deliverable = await prisma.deliverable.create({
        data: { userId: user.userId, kind: 'MESSAGE', title: 'Staging host', messageId: said.id },
      });
      await prisma.message.delete({ where: { id: said.id } });

      await expect(prisma.memory.findUnique({ where: { id: memory.id } })).resolves.toMatchObject({
        messageId: null,
      });
      await expect(
        prisma.deliverable.findUnique({ where: { id: deliverable.id } }),
      ).resolves.toMatchObject({ messageId: null });
    });

    it('removes a run’s interrupts and events with the run, and a thread’s with the thread', async () => {
      const r = await run('interrupted');
      await prisma.runInterrupt.create({
        data: { runId: r.id, conversationId, userId: user.userId, payload: { kind: 'x' } },
      });
      const events = await prisma.runEvent.createManyAndReturn({
        data: [1, 2, 3].map((n) => ({
          runId: r.id,
          conversationId,
          userId: user.userId,
          chunk: { type: 'TEXT_MESSAGE_CONTENT', delta: `${n}` },
        })),
      });
      // The id is the offset: monotonic in insertion order.
      expect(events.map((event) => event.id)).toEqual(
        [...events.map((event) => event.id)].sort((a, b) => (a < b ? -1 : 1)),
      );

      await prisma.agentTurn.delete({ where: { id: r.id } });
      await expect(prisma.runInterrupt.count({ where: { runId: r.id } })).resolves.toBe(0);
      await expect(prisma.runEvent.count({ where: { runId: r.id } })).resolves.toBe(0);
    });
  },
);
