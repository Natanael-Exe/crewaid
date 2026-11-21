/**
 * D-192 §2: a hydrate reads a thread for the OPERATOR, and the difference
 * between that and the model's reading is most of what a person sees.
 *
 * `GET /bots/:id/chat?threadId=` goes through the same message store a turn
 * reads, and that store's default view answers for a provider: it drops the
 * SYSTEM notices and `/new` boundaries the model must not be told about, reads
 * a teammate's message as a plain `user` turn, and carries none of the product
 * facts a transcript renders. Served to the renderer unchanged, a thread would
 * come back missing its limit stops, its dividers, its teammate attribution,
 * its unfinished-reply reasons and its attachments — each of which looks like a
 * renderer defect rather than a read of the wrong view.
 *
 * Driven through the real application, because the thing under test is what the
 * route answers: the guard, the ownership marker and the library's
 * reconstruction all sit between the store and the body.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from '@tanstack/ai';
import { toTranscriptRow } from '../src/agent/persistence/transcript.js';
import type { INestApplication } from '@nestjs/common';
import { CrewaidMessageMetadataSchema } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];

type HydratedMessage = {
  readonly id: string;
  readonly role: string;
  readonly metadata?: { readonly crewaid?: unknown };
};

/** The §3.4 projection on one hydrated message, parsed by its own schema. */
function crewaidOf(message: HydratedMessage | undefined) {
  const parsed = CrewaidMessageMetadataSchema.safeParse(message?.metadata?.crewaid);
  if (!parsed.success) expect.unreachable(`no crewaid metadata on ${message?.id ?? 'nothing'}`);
  return parsed.data;
}

describe.skipIf(!DATABASE_URL)('MOD-AI-08 operator hydrate (real app, real db)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  let owner: SignedInUser;

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}/api/v1`;
    prisma = app.get(PrismaService);
    owner = await signIn(prisma, { label: 'ophydrate' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await app.close();
  });

  /** A bot with a thread, created the way the app creates one. */
  async function thread() {
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `ophydrate-${randomUUID()}`,
        role: 'Outbound Writer',
        avatarColor: '#8B6F47',
        systemPrompt: '',
      },
    });
    const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
    return { bot, threadId: conversation.id };
  }

  async function hydrate(botId: string, threadId: string) {
    const response = await fetch(
      `${base}/bots/${botId}/chat?threadId=${encodeURIComponent(threadId)}`,
      { headers: owner.headers },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: HydratedMessage[] };
    return body.messages;
  }

  it('pages a long tool transcript with bounded reads, without gaps or split results', async () => {
    const t = await thread();
    const prefix = randomUUID();
    const stored: ModelMessage[] = [];
    for (let index = 0; index < 60; index++) {
      const call = `${prefix}-call-${index}`;
      stored.push(
        { id: `${prefix}-user-${index}`, role: 'user', content: `Question ${index}` },
        {
          id: `${prefix}-assistant-${index}`,
          role: 'assistant',
          content: 'Checking.',
          toolCalls: [
            { id: call, type: 'function', function: { name: 'memory_search', arguments: '{}' } },
          ],
        },
        {
          id: `${prefix}-tool-${index}`,
          role: 'tool',
          toolCallId: call,
          content: `Result ${index}`,
        },
        { id: `${prefix}-final-${index}`, role: 'assistant', content: `Answer ${index}` },
      );
    }
    await prisma.message.createMany({
      data: stored.map((message) => {
        const row = toTranscriptRow(message, { threadBotId: t.bot.id, runId: null });
        if (!row.ok) throw new Error('invalid transcript fixture');
        return { conversationId: t.threadId, ...row.value };
      }),
    });
    const run = await prisma.agentTurn.create({
      data: {
        botId: t.bot.id,
        conversationId: t.threadId,
        triggerMessageId: stored[0]!.id!,
        status: 'completed',
      },
    });
    await prisma.message.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        id: `${prefix}-reservation-${index}`,
        conversationId: t.threadId,
        author: 'BOT' as const,
        fromBotId: t.bot.id,
        runId: run.id,
        content: '',
      })),
    });
    const fullResponse = await fetch(`${base}/bots/${t.bot.id}/chat?threadId=${t.threadId}`, {
      headers: owner.headers,
    });
    const full = (await fullResponse.json()) as { messages: { id: string; role: string }[] };
    const reads = vi.spyOn(prisma.message, 'findMany');
    const collected: typeof full.messages = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 20; page++) {
        const response = await fetch(
          `${base}/bots/${t.bot.id}/chat?threadId=${t.threadId}&limit=17${cursor === undefined ? '' : `&before=${encodeURIComponent(cursor)}`}`,
          { headers: owner.headers },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as typeof full & {
          page: { truncated: boolean; cursor?: string };
        };
        expect(body.messages.length).toBeGreaterThan(0);
        // The limit counts canonical transcript anchors; AG-UI fans results out as tool messages.
        expect(
          body.messages.filter((message) => message.role !== 'tool' && message.role !== 'reasoning')
            .length,
        ).toBeLessThanOrEqual(17);
        collected.unshift(...body.messages);
        if (!body.page.truncated) break;
        expect(body.page.cursor).not.toBe(cursor);
        cursor = body.page.cursor;
      }
      expect(collected).toEqual(full.messages);
      expect(reads.mock.calls.length).toBeGreaterThan(1);
      for (const [query] of reads.mock.calls) {
        expect(query?.where?.conversationId).toBe(t.threadId);
        expect(query?.take).toBe(18);
      }
      const foreign = await thread();
      const forbiddenCursor = full.messages[0]!.id;
      const response = await fetch(
        `${base}/bots/${foreign.bot.id}/chat?threadId=${foreign.threadId}&limit=17&before=${forbiddenCursor}`,
        { headers: owner.headers },
      );
      expect(await response.json()).toMatchObject({ messages: [], page: { truncated: false } });
    } finally {
      reads.mockRestore();
    }
  });

  it('keeps the product rows the model is never shown', async () => {
    const t = await thread();
    const peer = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `peer-${randomUUID()}`,
        role: 'Researcher',
        avatarColor: '#2F6F4F',
        systemPrompt: '',
      },
    });
    await prisma.message.createMany({
      data: [
        {
          id: `tm_${randomUUID().replaceAll('-', '')}`,
          conversationId: t.threadId,
          author: 'USER',
          fromBotId: null,
          content: 'Draft a follow-up.',
          parts: { role: 'user', content: 'Draft a follow-up.' },
        },
        {
          id: `tm_${randomUUID().replaceAll('-', '')}`,
          conversationId: t.threadId,
          author: 'SYSTEM',
          fromBotId: null,
          content: 'The turn hit its ceiling and stopped.',
          startsTopic: false,
        },
        {
          id: `tm_${randomUUID().replaceAll('-', '')}`,
          conversationId: t.threadId,
          author: 'SYSTEM',
          fromBotId: null,
          content: '',
          startsTopic: true,
        },
        {
          id: `tm_${randomUUID().replaceAll('-', '')}`,
          conversationId: t.threadId,
          author: 'BOT',
          fromBotId: peer.id,
          content: 'Numbers are in the sheet.',
          parts: { role: 'user', content: 'Numbers are in the sheet.' },
        },
      ],
    });

    const messages = await hydrate(t.bot.id, t.threadId);
    const authors = messages.map((message) => crewaidOf(message).author);
    // Four rows, four authors. The model's reading answers two.
    expect(authors).toEqual(['USER', 'SYSTEM', 'SYSTEM', 'BOT']);

    // A SYSTEM row has no role of its own to travel in — `ModelMessage` has no
    // system role — so it rides as an assistant turn. The column is what the
    // renderer reads, which is why the role never reaches a reader's eye.
    expect(messages[1]?.role).toBe('assistant');

    // The `/new` divider is a stored row the model is not told about, and the
    // transcript draws it from this flag.
    expect(crewaidOf(messages[2]).startsTopic).toBe(true);
    expect(crewaidOf(messages[1]).startsTopic).toBe(false);

    // A teammate's message is stored so the model reads it as a `user` turn.
    // Only the sender's id tells it apart from the bot's own reply, so losing
    // the id loses the attribution entirely.
    expect(messages[3]?.role).toBe('user');
    expect(crewaidOf(messages[3]).fromBotId).toBe(peer.id);
  });

  it('carries the facts a reply is rendered with', async () => {
    const t = await thread();
    const task = await prisma.task.create({
      data: { userId: owner.userId, title: 'Follow up', status: 'IN_PROGRESS', rank: 'a0' },
    });
    const id = `tm_${randomUUID().replaceAll('-', '')}`;
    await prisma.message.create({
      data: {
        id,
        conversationId: t.threadId,
        author: 'BOT',
        fromBotId: t.bot.id,
        content: 'Half a',
        parts: { role: 'assistant', content: 'Half a' },
        stopReason: 'MODEL_LIMIT',
        taskId: task.id,
        hopCount: 2,
        chainId: 'chain-7',
      },
    });

    const crewaid = crewaidOf((await hydrate(t.bot.id, t.threadId))[0]);
    // A reply that did not finish must read as unfinished. The reason is the
    // one fact that says so, and the model's reading does not carry it.
    expect(crewaid.stopReason).toBe('MODEL_LIMIT');
    expect(crewaid.taskId).toBe(task.id);
    expect(crewaid.chainId).toBe('chain-7');
    expect(crewaid.hopCount).toBe(2);
    expect(crewaid.author).toBe('BOT');
  });

  it('carries a message’s attachments, without its storage key', async () => {
    const t = await thread();
    const id = `tm_${randomUUID().replaceAll('-', '')}`;
    await prisma.message.create({
      data: {
        id,
        conversationId: t.threadId,
        author: 'USER',
        fromBotId: null,
        content: 'Here are the notes.',
        parts: { role: 'user', content: 'Here are the notes.' },
      },
    });
    await prisma.attachment.create({
      data: {
        ownerId: owner.userId,
        messageId: id,
        filename: 'notes.md',
        mimeType: 'text/markdown',
        sizeBytes: 42,
        storageKey: `${owner.userId}/notes.md`,
      },
    });

    const crewaid = crewaidOf((await hydrate(t.bot.id, t.threadId))[0]);
    expect(crewaid.attachments).toHaveLength(1);
    expect(crewaid.attachments[0]).toMatchObject({
      filename: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 42,
    });
    // The storage key is where the bytes live on the server. The renderer
    // fetches by attachment id through `ApiClient.download()` (D-025), so the
    // key has no reader on the client and no business on the wire.
    expect(JSON.stringify(crewaid.attachments)).not.toContain('storageKey');
  });

  it('answers the sidebar’s preview from the roster, for every bot', async () => {
    const t = await thread();
    const quiet = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `quiet-${randomUUID()}`,
        role: 'Bookkeeper',
        avatarColor: '#2F6F4F',
        systemPrompt: '',
      },
    });
    await prisma.conversation.create({ data: { botId: quiet.id } });
    const say = (author: 'USER' | 'BOT' | 'SYSTEM' | 'TOOL', content: string, at: string) =>
      prisma.message.create({
        data: {
          id: `tm_${randomUUID().replaceAll('-', '')}`,
          conversationId: t.threadId,
          author,
          fromBotId: author === 'BOT' ? t.bot.id : null,
          content,
          createdAt: new Date(at),
        },
      });
    await say('USER', 'Draft a follow-up.', '2026-09-01T12:00:00.000Z');
    await say('BOT', 'Sent.\nTwo  lines.', '2026-09-01T12:01:00.000Z');
    // Neither of these is conversation, and neither should become the line
    // under the bot's name.
    await say('TOOL', 'exit 0', '2026-09-01T12:02:00.000Z');
    await say('SYSTEM', 'The turn hit its ceiling.', '2026-09-01T12:03:00.000Z');
    // A turn that only called tools leaves a blank row. Taken as the preview it
    // would wipe the line the operator was reading.
    await say('BOT', '', '2026-09-01T12:04:00.000Z');

    const response = await fetch(`${base}/bots`, { headers: owner.headers });
    expect(response.status).toBe(200);
    const rows = (await response.json()) as Array<{
      id: string;
      thread: { preview: { text: string } | null } | null;
    }>;
    const mine = rows.find((row) => row.id === t.bot.id);
    // Flattened server-side: every client wants the same one line, and a
    // newline in the middle of a sidebar row is the kind of thing each of them
    // would otherwise fix differently.
    expect(mine?.thread?.preview?.text).toBe('Sent. Two lines.');
    // The point of moving this to the server: a bot nobody has opened used to
    // fall back to its role, because the preview was read off a transcript the
    // window happened to be holding.
    expect(rows.find((row) => row.id === quiet.id)?.thread?.preview).toBeNull();
  });

  it('refuses a thread that is not this bot’s', async () => {
    const mine = await thread();
    const other = await thread();
    // Knowing a thread id grants nothing: the route derives the bot's own
    // thread and refuses any other, and the library's own authorize callback
    // refuses the same id behind it (D-191). Absent and foreign answer alike,
    // so a thread id cannot be probed for existence.
    const response = await fetch(
      `${base}/bots/${mine.bot.id}/chat?threadId=${encodeURIComponent(other.threadId)}`,
      { headers: owner.headers },
    );
    expect(response.status).toBe(404);
    const absent = await fetch(
      `${base}/bots/${mine.bot.id}/chat?threadId=cmdoesnotexist000000000`,
      {
        headers: owner.headers,
      },
    );
    expect(absent.status).toBe(404);
  });
});
