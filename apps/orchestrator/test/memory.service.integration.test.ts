import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryService } from '../src/memory/memory.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'usr_crewaid_singleton_v1';

/**
 * CC-30 — the half `memory-select.test.ts` deliberately cannot assert.
 *
 * The selector is pure and is graded against the CC-27 corpus with no
 * database. What it CANNOT prove is that another user's memory never reaches
 * it, because R7 is enforced in the WHERE clause rather than by filtering
 * afterwards — and a corpus that handed the selector a foreign row and
 * watched it drop one would be testing a post-filter that must not exist.
 *
 * So the boundary is asserted here, against a real database, with a real
 * second user present. An absence is only evidence when the thing is present
 * somewhere to be found.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')('CC-30 MemoryService', () => {
  let prisma: PrismaService;
  let memories: MemoryService;
  let botId: string;
  let otherBotId: string;
  let outsiderId: string;
  let outsiderBotId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    memories = new MemoryService(prisma);

    const bot = await prisma.bot.create({
      data: {
        userId: OWNER,
        name: 'CC-30 subject',
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
        modelId: 'default',
      },
    });
    botId = bot.id;

    const sibling = await prisma.bot.create({
      data: {
        userId: OWNER,
        name: 'CC-30 sibling',
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
        modelId: 'default',
      },
    });
    otherBotId = sibling.id;

    // A genuinely separate account, created and removed by this suite. It has
    // to EXIST while the boundary is checked, or the check passes because
    // there was nothing to leak.
    // V1-02: `email` is non-null and unique now, so the outsider needs a real
    // address rather than the null §3 allowed. Derived from the id so two runs
    // against one database cannot collide on it.
    const outsiderKey = `usr_cc30_outsider_${Date.now()}`;
    const outsider = await prisma.user.create({
      data: { id: outsiderKey, name: 'Outsider', email: `${outsiderKey}@test.invalid` },
    });
    outsiderId = outsider.id;

    // CC-34: the outsider needs a CONVERSATION too, not just a memory row.
    // searchTranscript joins Message -> Conversation -> Bot and filters on
    // the bot's userId; without a foreign transcript to find, a mutation
    // deleting that filter would break nothing and the R7 case would be an
    // absence asserted against nothing.
    const outsiderBot = await prisma.bot.create({
      data: {
        userId: outsiderId,
        name: 'CC-30 outsider bot',
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
        modelId: 'default',
      },
    });
    outsiderBotId = outsiderBot.id;
    const outsiderConversation = await prisma.conversation.create({
      data: { botId: outsiderBotId },
    });
    await prisma.message.create({
      data: {
        conversationId: outsiderConversation.id,
        author: 'USER',
        content: 'Another account discussing pelicans at length.',
      },
    });

    await prisma.memory.createMany({
      data: [
        {
          userId: OWNER,
          botId: null,
          kind: 'PREFERENCE',
          source: 'TOLD',
          text: 'The user prefers short replies.',
        },
        {
          userId: OWNER,
          botId,
          kind: 'CONVENTION',
          source: 'TOLD',
          text: 'Deploys run from the repo root.',
        },
        {
          userId: OWNER,
          botId: otherBotId,
          kind: 'CONVENTION',
          source: 'TOLD',
          text: 'The sibling cites sources inline.',
        },
        {
          userId: OWNER,
          botId: null,
          kind: 'FACT',
          source: 'DISTILLED',
          status: 'CANDIDATE',
          text: 'A guess nobody confirmed about deploys.',
        },
        {
          userId: outsiderId,
          botId: null,
          kind: 'FACT',
          source: 'TOLD',
          text: 'Another account deploys from a branch.',
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.memory.deleteMany({ where: { userId: outsiderId } });
    await prisma.bot.deleteMany({ where: { id: outsiderBotId } });
    await prisma.user.delete({ where: { id: outsiderId } });
    await prisma.memory.deleteMany({ where: { userId: OWNER } });
    await prisma.bot.deleteMany({ where: { id: { in: [botId, otherBotId] } } });
    await prisma.$disconnect();
  });

  describe('candidatesForInjection', () => {
    it('returns the global memory and this bot’s own', async () => {
      const rows = await memories.candidatesForInjection(OWNER, botId);
      const texts = rows.map((r) => r.text);
      expect(texts).toContain('The user prefers short replies.');
      expect(texts).toContain('Deploys run from the repo root.');
    });

    it('never returns a sibling bot’s private memory', async () => {
      const rows = await memories.candidatesForInjection(OWNER, botId);
      expect(rows.map((r) => r.text)).not.toContain('The sibling cites sources inline.');
    });

    it('never returns another user’s memory — R7', async () => {
      // The outsider's row exists (asserted below), so this absence means
      // something.
      const planted = await prisma.memory.findMany({ where: { userId: outsiderId } });
      expect(planted, 'the fixture never wrote the outsider row').toHaveLength(1);

      const rows = await memories.candidatesForInjection(OWNER, botId);
      expect(rows.map((r) => r.text)).not.toContain('Another account deploys from a branch.');
    });

    it('excludes a CANDIDATE from what may be injected', async () => {
      const rows = await memories.candidatesForInjection(OWNER, botId);
      expect(rows.map((r) => r.text)).not.toContain('A guess nobody confirmed about deploys.');
    });
  });

  describe('search', () => {
    it('finds a memory by a stemmed word it does not contain literally', async () => {
      // "deploying" stems to "deploy", which is the point of using a text
      // search configuration rather than LIKE.
      const hits = await memories.search(OWNER, botId, 'deploying');
      expect(hits.map((h) => h.text)).toContain('Deploys run from the repo root.');
    });

    it('includes CANDIDATE rows, which injection excludes', async () => {
      // The asymmetry is the design: an unpromoted inference is findable so
      // it can be confirmed, and unstatable so it cannot become fact by
      // default.
      const hits = await memories.search(OWNER, botId, 'guess confirmed deploys');
      expect(hits.map((h) => h.text)).toContain('A guess nobody confirmed about deploys.');
    });

    it('never returns another user’s memory — R7', async () => {
      const hits = await memories.search(OWNER, botId, 'deploys branch');
      expect(hits.map((h) => h.text)).not.toContain('Another account deploys from a branch.');
    });

    it('never returns a sibling bot’s private memory', async () => {
      const hits = await memories.search(OWNER, botId, 'cites sources inline');
      expect(hits.map((h) => h.text)).not.toContain('The sibling cites sources inline.');
    });

    it('does not raise on operator-shaped input', async () => {
      // websearch_to_tsquery, not to_tsquery: this text comes from a model or
      // a user, and a search for "a && b" must return nothing useful rather
      // than throw.
      await expect(memories.search(OWNER, botId, 'a && b || !c')).resolves.toBeInstanceOf(Array);
      await expect(memories.search(OWNER, botId, '"unterminated')).resolves.toBeInstanceOf(Array);
    });

    it('answers an empty query with nothing rather than everything', async () => {
      expect(await memories.search(OWNER, botId, '   ')).toEqual([]);
    });
  });

  describe('searchTranscript', () => {
    it('finds this bot’s own past messages', async () => {
      const conversation = await prisma.conversation.create({ data: { botId } });
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          author: 'USER',
          content: 'We settled on pnpm because npm corrupted the lockfile twice.',
        },
      });
      const hits = await memories.searchTranscript(OWNER, botId, 'lockfile');
      expect(hits.map((h) => h.excerpt).join(' ')).toContain('lockfile');
    });

    it('never returns another user’s conversation — R7', async () => {
      // The outsider's message exists (asserted first), so the absence below
      // means something.
      const planted = await prisma.message.findMany({
        where: { conversation: { bot: { userId: outsiderId } } },
      });
      expect(planted, 'the fixture never wrote the outsider message').toHaveLength(1);

      const hits = await memories.searchTranscript(OWNER, botId, 'pelicans');
      expect(hits).toHaveLength(0);
    });

    it('never returns a sibling bot’s conversation — D-077', async () => {
      const siblingConversation = await prisma.conversation.create({ data: { botId: otherBotId } });
      await prisma.message.create({
        data: {
          conversationId: siblingConversation.id,
          author: 'USER',
          content: 'A sibling discussing armadillos in confidence.',
        },
      });
      // Present for its owner...
      expect(await memories.searchTranscript(OWNER, otherBotId, 'armadillos')).not.toHaveLength(0);
      // ...and absent for the subject bot.
      expect(await memories.searchTranscript(OWNER, botId, 'armadillos')).toHaveLength(0);
    });

    it('leaves SYSTEM notes and empty rows out, like the seed does', async () => {
      const conversation = await prisma.conversation.findFirst({ where: { botId } });
      await prisma.message.create({
        data: {
          conversationId: conversation!.id,
          author: 'SYSTEM',
          content: 'Turn stopped: step limit reached while discussing capybaras.',
        },
      });
      // A SYSTEM row is an operator-facing note. Surfacing one as something
      // "you said earlier" would have the bot quoting a wall it did not hit.
      expect(await memories.searchTranscript(OWNER, botId, 'capybaras')).toHaveLength(0);
    });

    it('returns excerpts, not whole messages', async () => {
      const conversation = await prisma.conversation.findFirst({ where: { botId } });
      const long = `${'filler sentence about nothing. '.repeat(80)}The wombat decision was final.`;
      await prisma.message.create({
        data: { conversationId: conversation!.id, author: 'USER', content: long },
      });
      const hits = await memories.searchTranscript(OWNER, botId, 'wombat decision');
      expect(hits).not.toHaveLength(0);
      // A transcript search that returns five full messages has spent the
      // context budget the answer needed.
      expect(hits[0]!.excerpt.length).toBeLessThan(long.length);
      expect(hits[0]!.excerpt).toContain('wombat');
    });

    it('answers an empty query with nothing rather than everything', async () => {
      expect(await memories.searchTranscript(OWNER, botId, '   ')).toEqual([]);
    });
  });

  describe('isTombstoned', () => {
    it('is false for a claim nobody erased', async () => {
      expect(await memories.isTombstoned(OWNER, botId, 'never-seen')).toBe(false);
    });

    it('is true for a claim erased globally, even when asked about one bot', async () => {
      const claimHash = `global-erasure-${Date.now()}`;
      await prisma.memoryTombstone.create({ data: { userId: OWNER, claimHash } });
      expect(await memories.isTombstoned(OWNER, botId, claimHash)).toBe(true);
      await prisma.memoryTombstone.deleteMany({ where: { userId: OWNER, claimHash } });
    });

    it('does not leak one user’s erasure to another', async () => {
      const claimHash = `outsider-erasure-${Date.now()}`;
      await prisma.memoryTombstone.create({ data: { userId: outsiderId, claimHash } });
      expect(await memories.isTombstoned(OWNER, botId, claimHash)).toBe(false);
      await prisma.memoryTombstone.deleteMany({ where: { userId: outsiderId, claimHash } });
    });
  });
});
