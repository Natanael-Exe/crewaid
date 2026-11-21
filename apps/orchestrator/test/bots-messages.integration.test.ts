import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_REVIEW_RULES } from '@crewaid/shared';
import type { INestApplication } from '@nestjs/common';
import { BotsService } from '../src/bots/bots.service.js';
import { MessagesService } from '../src/messages/messages.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * M1-BE-02/03 integration tests (§4.1) against the real Postgres.
 *
 * Skipped when DATABASE_URL is unset — CI provides a Postgres service and
 * runs with it set (M1-BE-05 required test convention: model stubbed, DB real).
 * Locally: `docker compose up`, then export DATABASE_URL.
 *
 * These drive the services directly with the caller's userId as a parameter —
 * the same value AuthGuard resolves from the authenticated session. The
 * scoping assertions here cover the allowlist entries on these call sites.
 */
const DATABASE_URL = process.env['DATABASE_URL'];

const USER_ID = 'usr_crewaid_singleton_v1';
const INTRUDER_ID = 'usr_someone_else';

let app: INestApplication;
let bots: BotsService;
let messages: MessagesService;
let prisma: PrismaService;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'bots + messages (real db)',
  () => {
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        imports: [(await import('../src/bots/bots.module.js')).BotsModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .compile();

      app = moduleRef.createNestApplication();
      await app.init();

      bots = app.get(BotsService);
      messages = app.get(MessagesService);
      prisma = app.get(PrismaService);

      // CI seeds AFTER the test step, and these tests FK against the singleton
      // user — so ensure it exists here. Idempotent; the later CI seed check
      // still counts exactly one row.
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: 'ops@example.com' },
        update: {},
      });
    });

    afterAll(async () => {
      await app?.close();
    });

    it('creates a bot with its conversation and defaults', async () => {
      const bot = await bots.create(USER_ID, {
        name: `quill-${randomUUID().slice(0, 8)}`,
        role: 'Outbound Writer',
        avatarColor: '#8B6F47',
        systemPrompt: 'You write outbound email.',
      });

      expect(bot.modelId).toBe('default');
      // D-064: a bot created without rules gets the shipped policy, not `[]`.
      // The column default is still `[]`; this is the service supplying one.
      expect(bot.autoReviewRules).toEqual(DEFAULT_AUTO_REVIEW_RULES);

      // §3: the conversation exists from birth.
      const conversation = await prisma.conversation.findUnique({ where: { botId: bot.id } });
      expect(conversation).not.toBeNull();
    });

    it('keeps an explicitly empty rule list empty', async () => {
      // Absent and empty are different requests (D-064). `??` is what keeps
      // them apart, and an operator who sends `[]` is asking to be consulted
      // about every call — seeding over that would take away the only way to
      // ask for it.
      const bot = await bots.create(USER_ID, {
        name: `norules-${randomUUID().slice(0, 8)}`,
        role: 'Cautious Researcher',
        avatarColor: '#8B6F47',
        systemPrompt: 'You check before acting.',
        autoReviewRules: [],
      });

      expect(bot.autoReviewRules).toEqual([]);
    });

    it('claims an unclaimed D-019 upload on send and rejects re-attachment', async () => {
      const bot = await bots.create(USER_ID, {
        name: `attach-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#111111',
        systemPrompt: 'x',
      });
      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { botId: bot.id },
      });

      // An upload before any message exists (D-019 lifecycle: unclaimed row).
      // D-021: created by USER_A — ownership binds at creation.
      const upload = await prisma.attachment.create({
        data: {
          ownerId: USER_ID,
          filename: 'leads.csv',
          mimeType: 'text/csv',
          sizeBytes: 10,
          storageKey: 'test/leads.csv',
        },
      });

      const sent = await messages.createUserMessage(USER_ID, bot.id, {
        content: 'with attachment',
        attachmentIds: [upload.id],
      });
      expect(sent.attachments).toHaveLength(1);
      expect(sent.attachments[0]!.id).toBe(upload.id);

      // Claiming it again is a 404, never a double-bind.
      await expect(
        messages.createUserMessage(USER_ID, bot.id, {
          content: 're-attach attempt',
          attachmentIds: [upload.id],
        }),
      ).rejects.toThrow('Unknown, foreign, or already-attached attachment id');

      void conversation;
    });

    // Attachment-only sends are valid (no text required when attachments are present).
    it('D-023: sends with attachments and NO content (absent and empty)', async () => {
      const bot = await bots.create(USER_ID, {
        name: `d022-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#222222',
        systemPrompt: 'x',
      });

      // Absent content.
      const uploadA = await prisma.attachment.create({
        data: {
          ownerId: USER_ID,
          filename: 'screenshot.png',
          mimeType: 'image/png',
          sizeBytes: 42,
          storageKey: 'test/screenshot.png',
        },
      });
      const absent = await messages.createUserMessage(USER_ID, bot.id, {
        attachmentIds: [uploadA.id],
      });
      expect(absent.content).toBe('');
      expect(absent.attachments).toHaveLength(1);

      // Empty-string content.
      const uploadB = await prisma.attachment.create({
        data: {
          ownerId: USER_ID,
          filename: 'notes.md',
          mimeType: 'text/markdown',
          sizeBytes: 7,
          storageKey: 'test/notes.md',
        },
      });
      const empty = await messages.createUserMessage(USER_ID, bot.id, {
        content: '',
        attachmentIds: [uploadB.id],
      });
      expect(empty.content).toBe('');
      expect(empty.attachments).toHaveLength(1);
    });

    it('refuses cross-user access with a 404 that leaks nothing', async () => {
      const bot = await bots.create(USER_ID, {
        name: `private-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#000000',
        systemPrompt: 'x',
      });

      await expect(bots.update(INTRUDER_ID, bot.id, { pinned: true })).rejects.toThrow(
        'Bot not found',
      );
      await expect(
        messages.createUserMessage(INTRUDER_ID, bot.id, { content: 'x' }),
      ).rejects.toThrow('Bot not found');
      await expect(bots.remove(INTRUDER_ID, bot.id)).rejects.toThrow('Bot not found');
    });

    it('duplicate clones profile + skills, not history, and 409s on name collision', async () => {
      const bot = await bots.create(USER_ID, {
        name: `orig-${randomUUID().slice(0, 8)}`,
        role: 'Writer',
        avatarColor: '#222222',
        systemPrompt: 'original',
      });
      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { botId: bot.id },
      });
      await prisma.message.create({
        data: { conversationId: conversation.id, author: 'USER', content: 'history stays' },
      });
      await prisma.skill.create({
        data: {
          botId: bot.id,
          name: 'send_follow_up',
          description: 'd',
          paramsSchema: { type: 'object' },
          script: 'export default async () => {};',
        },
      });

      const clone = await bots.duplicate(USER_ID, bot.id);
      expect(clone.name).toBe(`${bot.name} copy`);
      expect(clone.systemPrompt).toBe('original');

      const cloneConversation = await prisma.conversation.findUniqueOrThrow({
        where: { botId: clone.id },
      });
      const cloneMessages = await prisma.message.count({
        where: { conversationId: cloneConversation.id },
      });
      expect(cloneMessages).toBe(0);

      const cloneSkills = await prisma.skill.count({ where: { botId: clone.id } });
      expect(cloneSkills).toBe(1);

      // Same name again → 409 (ConflictException).
      await expect(bots.duplicate(USER_ID, bot.id)).rejects.toThrow('already exists');
    });
  },
);
