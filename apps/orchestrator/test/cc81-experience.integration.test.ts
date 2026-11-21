import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { OnboardingService } from '../src/experience/onboarding.service.js';
import { fromTranscriptRow } from '../src/agent/persistence/transcript.js';
import { welcomeCopy } from '@crewaid/shared';
import { TemplateService } from '../src/experience/template.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { BotsService } from '../src/bots/bots.service.js';
import { MemoryService, claimHashOf } from '../src/memory/memory.service.js';
import { ExperienceModule } from '../src/experience/experience.module.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';

const WELCOME_COPY = welcomeCopy('en');

// Owner: CC-81. These exercise real transactions; CI/local DATABASE_URL supplies Postgres.
describe.skipIf(!process.env['DATABASE_URL'])(
  'CC-81 permanent assistant and Templates (real database)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let onboarding: OnboardingService;
    let templates: TemplateService;
    let bots: BotsService;
    let memories: MemoryService;
    let userId: string;
    let foreignId: string;
    const provider = new FakeProvider();
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const module = await Test.createTestingModule({ imports: [ExperienceModule] })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .compile();
      app = module.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      onboarding = app.get(OnboardingService);
      templates = app.get(TemplateService);
      bots = app.get(BotsService);
      memories = app.get(MemoryService);
      userId = (
        await prisma.user.create({
          data: { name: 'Founder', email: `cc81-${randomUUID()}@test.invalid` },
        })
      ).id;
      foreignId = (
        await prisma.user.create({
          data: { name: 'Other founder', email: `cc81-${randomUUID()}@test.invalid` },
        })
      ).id;
    });
    afterAll(async () => {
      if (prisma) await prisma.user.deleteMany({ where: { id: { in: [userId, foreignId] } } });
      await app?.close();
    });
    it('bootstraps one protected main assistant across simultaneous windows without provisioning a computer', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => onboarding.bootstrap(userId)),
      );
      expect(new Set(results.map((result) => result.bot.id)).size).toBe(1);
      expect(results[0]?.bot).toMatchObject({
        kind: 'MAIN',
        name: 'Crewaid',
        pinned: true,
        sandboxId: null,
      });
      expect(await prisma.bot.count({ where: { userId, kind: 'MAIN' } })).toBe(1);
      expect(await prisma.sandbox.count({ where: { userId } })).toBe(0);
      const id = results[0]!.bot.id;
      for (const patch of [
        { name: 'Other' },
        { role: 'Other' },
        { pinned: false },
        { hiddenFromSidebar: true },
        { groupId: null },
        { sortOrder: 10 },
      ])
        await expect(bots.update(userId, id, patch)).rejects.toThrow('permanent');
      await expect(bots.duplicate(userId, id)).rejects.toThrow('cannot be duplicated');
      await expect(bots.remove(userId, id)).rejects.toThrow('cannot be deleted');
      expect(await bots.update(userId, id, { systemPrompt: 'Be brief.' })).toMatchObject({
        systemPrompt: 'Be brief.',
        kind: 'MAIN',
      });
    });
    it('persists skipped discovery independently of messages and isolates account progress', async () => {
      await onboarding.update(userId, { welcomeSeen: true, discovery: 'SKIPPED' });
      expect((await onboarding.bootstrap(userId)).onboarding).toMatchObject({
        welcomeSeen: true,
        discovery: 'SKIPPED',
      });
      expect((await onboarding.bootstrap(foreignId)).onboarding).toMatchObject({
        welcomeSeen: false,
        discovery: 'NEW',
      });
    });
    it('greets once, answers the tour once, then asks for the task and closes the welcome (D-232)', async () => {
      const askerId = (
        await prisma.user.create({
          data: { name: 'Ada Lovelace', email: `cc81-${randomUUID()}@test.invalid` },
        })
      ).id;
      try {
        // Two windows opening at once greet once.
        const [first] = await Promise.all([
          onboarding.bootstrap(askerId),
          onboarding.bootstrap(askerId),
        ]);
        const main = first.bot;
        const thread = async () =>
          prisma.message.findMany({
            where: { conversation: { botId: main.id } },
            orderBy: { sequence: 'asc' },
          });
        expect((await thread()).map((row) => [row.author, row.content])).toEqual(
          WELCOME_COPY.greeting('Ada').map((line) => ['BOT', line]),
        );
        await onboarding.bootstrap(askerId);
        expect(await thread()).toHaveLength(3);

        // A double click on the tour answers once, and the welcome stays open.
        const toured = await Promise.all([
          onboarding.update(askerId, { reply: 'TOUR' }),
          onboarding.update(askerId, { reply: 'TOUR' }),
        ]);
        expect(toured.every((state) => !state.welcomeSeen)).toBe(true);
        expect((await thread()).slice(3).map((row) => [row.author, row.content])).toEqual([
          ['USER', WELCOME_COPY.replies.TOUR],
          ['BOT', WELCOME_COPY.guide],
          ['BOT', WELCOME_COPY.afterGuide],
        ]);

        // The task closes it; a retry asks nothing more.
        expect((await onboarding.update(askerId, { reply: 'TASK' })).welcomeSeen).toBe(true);
        await onboarding.update(askerId, { reply: 'TASK' });
        await onboarding.update(askerId, { reply: 'TOUR' });
        const rows = await thread();
        expect(rows.slice(6).map((row) => [row.author, row.content])).toEqual([
          ['USER', WELCOME_COPY.replies.TASK],
          ['BOT', WELCOME_COPY.taskQuestion],
        ]);
        expect(rows.every((row) => row.runId === null)).toBe(true);
        // The same mapper the hydrate and the model read them through.
        const read = fromTranscriptRow(rows.at(-1)!, main.id);
        expect(read.ok && read.value).toMatchObject({
          role: 'assistant',
          content: WELCOME_COPY.taskQuestion,
        });
        const user = fromTranscriptRow(rows.at(-2)!, main.id);
        expect(user.ok && user.value).toMatchObject({
          role: 'user',
          content: WELCOME_COPY.replies.TASK,
        });
        expect((await bots.list(askerId)).find((bot) => bot.id === main.id)).toMatchObject({
          unreadCount: 0,
          thread: { preview: expect.objectContaining({ text: WELCOME_COPY.taskQuestion }) },
        });
        // A closed welcome is never greeted again.
        await onboarding.bootstrap(askerId);
        expect(await thread()).toHaveLength(8);
      } finally {
        await prisma.user.delete({ where: { id: askerId } });
      }
    });
    it('does not greet an account that already has a crew', async () => {
      const crewed = (
        await prisma.user.create({
          data: { name: 'Crewed', email: `cc81-${randomUUID()}@test.invalid` },
        })
      ).id;
      try {
        await prisma.bot.create({
          data: {
            userId: crewed,
            name: 'Scout',
            role: 'Researcher',
            avatarColor: '#2fa59a',
            systemPrompt: '',
            modelId: 'default',
          },
        });
        const { bot, onboarding: state } = await onboarding.bootstrap(crewed);
        expect(state.welcomeSeen).toBe(true);
        expect(await prisma.message.count({ where: { conversation: { botId: bot.id } } })).toBe(0);
      } finally {
        await prisma.user.delete({ where: { id: crewed } });
      }
    });
    it('lists five crews whose members are the same definitions as the standalone bots', () => {
      const entries = templates.list('', null);
      const crews = entries.filter((entry) => entry.kind === 'crew');
      expect(crews).toHaveLength(5);
      expect(entries.filter((entry) => entry.kind === 'bot')).toHaveLength(20);
      for (const crew of crews)
        for (const member of crew.bots) {
          const alone = templates.read(`bot-${member.key}`, null);
          expect(alone.bots[0]).toEqual(member);
          expect(alone.memberOf).toContain(crew.title);
        }
      const names = entries.flatMap((entry) => entry.bots.map((bot) => bot.name));
      for (const entry of entries)
        for (const bot of entry.bots) {
          // A description a person edits must not carry what a crew depends on,
          // and a bot added alone has no teammates to name.
          expect(bot.systemPrompt).not.toContain('send_message');
          for (const other of names.filter((name) => name !== bot.name))
            expect(bot.systemPrompt).not.toContain(other);
          // Blue egg is Crewaid's.
          expect(bot.avatarShape === 'egg' && bot.avatarColor === '#4c6ef5').toBe(false);
        }
    });

    it('searches what a person reads, not the prompts behind it', () => {
      expect(templates.list('outreach', null).map((entry) => entry.id)).toContain('sales-outreach');
      expect(templates.list('social writer', null).map((entry) => entry.id)).toEqual([
        'content-publishing',
        'bot-hannah',
      ]);
      // Only in Tariq's prompt, which nobody browsing reads.
      expect(templates.read('bot-tariq', null).bots[0]?.systemPrompt).toContain('frustrated');
      expect(templates.list('frustrated', null)).toEqual([]);
    });
    it('installs a whole crew atomically and deduplicates concurrent retries while allowing another intentional copy', async () => {
      const input = {
        templateId: 'content-publishing',
        revision: '2',
        idempotencyKey: randomUUID(),
        goal: 'Publish weekly',
        context: 'For solo founders',
        serverIds: [],
      };
      const results = await Promise.all([
        templates.install(userId, input, null),
        templates.install(userId, input, null),
      ]);
      expect(results[0]?.id).toBe(results[1]?.id);
      expect(results[0]?.botIds).toHaveLength(4);
      const groupId = results[0]!.groupId!;
      const group = await prisma.botGroup.findFirstOrThrow({ where: { id: groupId, userId } });
      for (const id of results[0]!.botIds) expect(group.instructions).toContain(id);
      expect(group.instructions).toContain('Publish weekly');
      expect(group.instructions).toContain('For solo founders');
      expect(group.instructions).toContain('send_message');
      expect(await prisma.conversation.count({ where: { bot: { userId, groupId } } })).toBe(4);
      expect(await prisma.routine.count({ where: { bot: { userId, groupId } } })).toBe(0);
      expect(await prisma.agentTurn.count({ where: { bot: { userId, groupId } } })).toBe(0);
      await expect(templates.install(userId, { ...input, goal: 'Changed' }, null)).rejects.toThrow(
        'different configuration',
      );
      const copy = await templates.install(
        userId,
        { ...input, idempotencyKey: randomUUID() },
        null,
      );
      expect(copy.id).not.toBe(results[0]?.id);
      expect(copy.botIds.every((id) => !results[0]!.botIds.includes(id))).toBe(true);
      // A second copy stays addressable by name.
      const copyBots = await prisma.bot.findMany({
        where: { userId, id: { in: copy.botIds } },
        select: { name: true },
      });
      expect(copyBots.map((bot) => bot.name).sort()).toEqual([
        'Chloe 2',
        'Hannah 2',
        'Lucas 2',
        'Tariq 2',
      ]);
      expect(
        (await prisma.botGroup.findFirstOrThrow({ where: { userId, id: copy.groupId! } })).name,
      ).toBe('Content & Publishing 2');
      await bots.update(userId, copy.botIds[0]!, { name: 'Renamed researcher' });
      expect(
        (await prisma.botGroup.findFirstOrThrow({ where: { userId, id: copy.groupId! } }))
          .instructions,
      ).toContain(copy.botIds[0]);
    });
    it('rejects stale template versions and foreign tools without creating anything', async () => {
      const input = {
        templateId: 'content-publishing',
        revision: '2',
        idempotencyKey: randomUUID(),
        goal: '',
        context: '',
        serverIds: [],
      };
      const before = await prisma.bot.count({ where: { userId } });
      await expect(templates.install(userId, { ...input, revision: 'old' }, null)).rejects.toThrow(
        'changed',
      );
      await expect(
        templates.install(userId, { ...input, serverIds: ['foreign-server'] }, null),
      ).rejects.toThrow('no longer available');
      expect(await prisma.bot.count({ where: { userId } })).toBe(before);
    });
    it('corrects a private memory with provenance and suppression, and refuses foreign edits', async () => {
      const main = (await onboarding.bootstrap(userId)).bot;
      const memory = await prisma.memory.create({
        data: {
          userId,
          botId: main.id,
          authorBotId: main.id,
          kind: 'FACT',
          source: 'TOLD',
          text: 'I run an agency.',
        },
      });
      await expect(memories.editOwned(foreignId, memory.id, 'Wrong account')).rejects.toThrow(
        'not found',
      );
      await memories.editOwned(userId, memory.id, 'I run a product studio.');
      const old = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
      expect(old.status).toBe('SUPERSEDED');
      const replacement = await prisma.memory.findUniqueOrThrow({
        where: { id: old.supersededById! },
      });
      expect(replacement).toMatchObject({
        userId,
        botId: main.id,
        authorBotId: main.id,
        source: 'TOLD',
        text: 'I run a product studio.',
      });
      expect(
        await prisma.memoryTombstone.count({
          where: { userId, botId: main.id, claimHash: claimHashOf(memory.text) },
        }),
      ).toBe(1);
      await memories.forgetOwned(userId, replacement.id);
      await memories.forgetOwned(userId, replacement.id);
      expect(
        (await prisma.memory.findUniqueOrThrow({ where: { id: replacement.id } })).status,
      ).toBe('FORGOTTEN');
      expect(
        await prisma.memoryTombstone.count({
          where: { userId, claimHash: claimHashOf(replacement.text) },
        }),
      ).toBe(1);
    });
  },
);
