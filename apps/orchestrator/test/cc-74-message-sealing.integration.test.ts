import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEALED_PREFIX, messageKeyring, sealedVersion } from '../src/credentials/message-cipher.js';
import type { Keyring } from '../src/credentials/keyring.js';
import { sealStoredMessages } from '../src/messages/seal-stored-messages.js';
import { searchTranscripts } from '../src/messages/transcript-search.js';
import { openStoredMessageText } from '../src/prisma/message-sealing.js';
import { createPrismaClient } from '../src/prisma/prisma-client.factory.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const KEYRING_VAR = 'CREWAID_CREDENTIAL_KEYRING';
const ACTIVE_VAR = 'CREWAID_CREDENTIAL_KEY_ACTIVE';
const KEY_1 = '1'.repeat(64);
const KEY_2 = '2'.repeat(64);

/**
 * CC-74 / D-236 — the database holds ciphertext, and the application never
 * notices.
 *
 * Two clients, because the claim has two halves. `prisma` is the service every
 * module injects, and through it a message reads exactly as it was written.
 * `stored` is a plain client with no sealing, standing in for anyone holding a
 * copy of the database: what it sees is what a backup contains. A test that
 * read both halves through one client would prove a round trip and nothing
 * about what is at rest.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'CC-74 message text is sealed at rest',
  () => {
    let prisma: PrismaService;
    let stored: PrismaClient;
    let userId: string;
    let outsiderBotId: string;
    let botId: string;
    let threadId: string;
    const previous = { keyring: process.env[KEYRING_VAR], active: process.env[ACTIVE_VAR] };
    const SAID = 'The quarterly figures are in the harbour folder.';

    const useKeyring = (keys: Record<number, string>, active?: number): Keyring => {
      process.env[KEYRING_VAR] = JSON.stringify(keys);
      if (active === undefined) delete process.env[ACTIVE_VAR];
      else process.env[ACTIVE_VAR] = String(active);
      const keyring = messageKeyring();
      if (keyring === null) throw new Error('the suite needs a keyring');
      return keyring;
    };

    const storedMessage = async (id: string) => {
      const row = await stored.message.findUniqueOrThrow({ where: { id } });
      return { content: row.content, parts: row.parts };
    };

    beforeAll(async () => {
      useKeyring({ 1: KEY_1 });
      prisma = new PrismaService();
      await prisma.$connect();
      stored = createPrismaClient();

      const key = `usr_cc74_${randomUUID()}`;
      userId = (
        await prisma.user.create({ data: { id: key, name: 'CC-74', email: `${key}@test.invalid` } })
      ).id;
      const bot = await prisma.bot.create({
        data: {
          userId,
          name: 'CC-74 subject',
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
          modelId: 'default',
        },
      });
      botId = bot.id;
      threadId = (await prisma.conversation.create({ data: { botId } })).id;

      // Someone else's transcript, holding the word the search cases look for:
      // an absence is only evidence when the thing exists somewhere to be found.
      const outsiderKey = `usr_cc74_outsider_${randomUUID()}`;
      await prisma.user.create({
        data: { id: outsiderKey, name: 'Outsider', email: `${outsiderKey}@test.invalid` },
      });
      const outsiderBot = await prisma.bot.create({
        data: {
          userId: outsiderKey,
          name: 'CC-74 outsider',
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
          modelId: 'default',
        },
      });
      outsiderBotId = outsiderBot.id;
      const outsiderThread = await prisma.conversation.create({ data: { botId: outsiderBotId } });
      await prisma.message.create({
        data: {
          conversationId: outsiderThread.id,
          author: 'USER',
          content: 'Somebody else also mentions the harbour.',
        },
      });
    });

    afterAll(async () => {
      await stored.user.deleteMany({ where: { id: { startsWith: 'usr_cc74_' } } });
      await stored.$disconnect();
      await prisma.$disconnect();
      if (previous.keyring === undefined) delete process.env[KEYRING_VAR];
      else process.env[KEYRING_VAR] = previous.keyring;
      if (previous.active === undefined) delete process.env[ACTIVE_VAR];
      else process.env[ACTIVE_VAR] = previous.active;
    });

    it('stores ciphertext for the text and its parts, and reads back what was said', async () => {
      const parts = { role: 'user', content: SAID };
      const created = await prisma.message.create({
        data: { conversationId: threadId, author: 'USER', content: SAID, parts },
      });
      // The caller that wrote it is handed what it wrote, not what was stored.
      expect(created.content).toBe(SAID);
      expect(created.parts).toEqual(parts);

      const atRest = await storedMessage(created.id);
      expect(atRest.content.startsWith(SEALED_PREFIX)).toBe(true);
      expect(typeof atRest.parts).toBe('string');
      expect(JSON.stringify(atRest)).not.toContain('harbour');
      expect(JSON.stringify(atRest)).not.toContain('quarterly');

      const read = await prisma.message.findUniqueOrThrow({ where: { id: created.id } });
      expect(read.content).toBe(SAID);
      expect(read.parts).toEqual(parts);
      expect(openStoredMessageText(atRest.content)).toBe(SAID);
    });

    it('leaves a row with no text and no body exactly as it was', async () => {
      // `content <> ''` is how a dozen queries tell a spoken row from a tool call.
      const created = await prisma.message.create({
        data: { conversationId: threadId, author: 'BOT', fromBotId: botId, content: '' },
      });
      expect(await storedMessage(created.id)).toEqual({ content: '', parts: null });
      const spoken = await prisma.message.count({
        where: { conversationId: threadId, content: { not: '' } },
      });
      expect(spoken).toBeGreaterThan(0);
    });

    it('seals every write path: createMany, update, updateMany and a transaction', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await prisma.message.createMany({
        data: ids.slice(0, 2).map((id, index) => ({
          id,
          conversationId: threadId,
          author: 'USER' as const,
          content: `batch line ${String(index)} about lighthouses`,
        })),
      });
      await prisma.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            id: ids[2]!,
            conversationId: threadId,
            author: 'USER',
            content: 'inside a lighthouse',
          },
        });
      });
      await prisma.message.update({
        where: { id: ids[0]! },
        data: {
          content: 'rewritten about lighthouses',
          parts: { role: 'user', content: 'rewritten' },
        },
      });
      await prisma.message.updateMany({
        where: { id: ids[1]! },
        data: { content: 'bulk rewritten about lighthouses' },
      });

      for (const id of ids) {
        const atRest = await storedMessage(id);
        expect(atRest.content.startsWith(SEALED_PREFIX), id).toBe(true);
        expect(JSON.stringify(atRest)).not.toContain('lighthouse');
      }
      const read = await prisma.message.findMany({
        where: { id: { in: ids } },
        orderBy: { sequence: 'asc' },
        select: { content: true },
      });
      expect(read.map((row) => row.content)).toEqual([
        'rewritten about lighthouses',
        'bulk rewritten about lighthouses',
        'inside a lighthouse',
      ]);
    });

    it('does not seal the caller’s own object', async () => {
      // A retried write would otherwise seal its own ciphertext.
      const data = { conversationId: threadId, author: 'USER' as const, content: 'kept as typed' };
      await prisma.message.create({ data });
      expect(data.content).toBe('kept as typed');
    });

    it('opens a message that arrives as a relation of something else', async () => {
      const thread = await prisma.conversation.findUniqueOrThrow({
        where: { id: threadId },
        include: { messages: { where: { content: { not: '' } }, orderBy: { sequence: 'asc' } } },
      });
      expect(thread.messages[0]?.content).toBe(SAID);
      expect(thread.messages.every((row) => !row.content.startsWith(SEALED_PREFIX))).toBe(true);
    });

    it('seals the run’s delivery log, which carries the same words', async () => {
      const trigger = await prisma.message.create({
        data: { conversationId: threadId, author: 'USER', content: 'trigger' },
      });
      const run = await prisma.agentTurn.create({
        data: { botId, conversationId: threadId, triggerMessageId: trigger.id },
      });
      const chunk = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'the harbour at nine' };
      const [written] = await prisma.runEvent.createManyAndReturn({
        data: [{ runId: run.id, conversationId: threadId, userId, chunk }],
      });
      expect(written?.chunk).toEqual(chunk);

      const atRest = await stored.runEvent.findUniqueOrThrow({ where: { id: written!.id } });
      expect(typeof atRest.chunk).toBe('string');
      expect(JSON.stringify(atRest.chunk)).not.toContain('harbour');

      const read = await prisma.runEvent.findMany({ where: { runId: run.id } });
      expect(read.map((row) => row.chunk)).toEqual([chunk]);
    });

    it('refuses a query that compares sealed text, instead of matching nothing', async () => {
      await expect(
        prisma.message.count({ where: { conversationId: threadId, content: { in: [SAID] } } }),
      ).rejects.toThrow(/sealed at rest/);
      await expect(
        prisma.message.findMany({ where: { OR: [{ content: { contains: 'harbour' } }] } }),
      ).rejects.toThrow(/sealed at rest/);
    });

    it('refuses a message written as a nested write, which would not be sealed', async () => {
      await expect(
        prisma.conversation.update({
          where: { id: threadId },
          data: { messages: { create: { author: 'USER', content: 'slipped past' } } },
        }),
      ).rejects.toThrow(/sealed by their own model/);
      expect(
        await stored.message.count({
          where: { conversationId: threadId, content: 'slipped past' },
        }),
      ).toBe(0);
    });

    it('finds what was said by searching, for its owner only', async () => {
      const hits = await searchTranscripts(prisma, { userId }, 'harbour figures', 5);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.botId).toBe(botId);
      expect(hits[0]?.author).toBe('USER');
      // The same stemming and the same `<<…>>` excerpt the index's query gave.
      expect(hits[0]?.excerpt).toContain('<<harbour>>');
      expect(hits[0]?.excerpt).toContain('<<figures>>');

      const stemmed = await searchTranscripts(prisma, { userId, botId }, 'lighthouse', 10);
      expect(stemmed.length).toBeGreaterThanOrEqual(3);
      expect(
        await searchTranscripts(prisma, { userId, botId: outsiderBotId }, 'harbour', 5),
      ).toEqual([]);
      expect(await searchTranscripts(prisma, { userId }, 'zeppelin', 5)).toEqual([]);
    });

    it('reads a row from before sealing, then seals it and everything else in one pass', async () => {
      const legacy = await stored.message.create({
        data: {
          conversationId: threadId,
          author: 'USER',
          content: 'written before sealing existed',
          parts: { role: 'user', content: 'written before sealing existed' },
        },
      });
      expect((await prisma.message.findUniqueOrThrow({ where: { id: legacy.id } })).content).toBe(
        'written before sealing existed',
      );

      await sealStoredMessages(stored, useKeyring({ 1: KEY_1 }));
      const atRest = await storedMessage(legacy.id);
      expect(atRest.content.startsWith(SEALED_PREFIX)).toBe(true);
      expect(JSON.stringify(atRest)).not.toContain('before sealing');
      const read = await prisma.message.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(read.content).toBe('written before sealing existed');
      expect(read.parts).toEqual({ role: 'user', content: 'written before sealing existed' });

      // Nothing left to do: a second pass that changed a row would be one that
      // can never be finished.
      const again = await sealStoredMessages(stored, useKeyring({ 1: KEY_1 }));
      expect(again.messages).toBe(0);
      expect(again.runEvents).toBe(0);
    });

    it('moves every row to the new key on rotation, so the old one can be retired', async () => {
      const rotated = useKeyring({ 1: KEY_1, 2: KEY_2 }, 2);
      const moved = await sealStoredMessages(stored, rotated);
      expect(moved.messages).toBeGreaterThan(0);
      expect(moved.runEvents).toBeGreaterThan(0);

      const rows = await stored.message.findMany({
        where: { conversationId: threadId, content: { startsWith: SEALED_PREFIX } },
        select: { content: true, parts: true },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(sealedVersion(row.content)).toBe(2);
        if (row.parts !== null) expect(sealedVersion(row.parts)).toBe(2);
      }

      // The old key is gone and everything still reads.
      useKeyring({ 2: KEY_2 });
      const read = await prisma.message.findMany({
        where: { conversationId: threadId, content: { not: '' } },
        orderBy: { sequence: 'asc' },
        take: 1,
      });
      expect(read[0]?.content).toBe(SAID);
    });
  },
);
