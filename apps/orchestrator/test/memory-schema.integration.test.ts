import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];

/**
 * CC-29 / D-073 — the assertions the CI drift guard cannot make.
 *
 * `prisma migrate diff --exit-code` compares the migration history against
 * `schema.prisma`, so it only sees things `schema.prisma` can express. Spike
 * 002 measured the consequence: a bare expression GIN index is INVISIBLE to
 * it. That is what lets `Memory_text_fts_idx` ship in a hand-written migration
 * without reading as permanent drift — and it is equally why nothing would
 * notice if the index were dropped, or never created in a fresh database.
 * Search would keep returning correct rows by sequential scan, and get slower
 * with every row added. That is the failure nobody reports.
 *
 * So the guard for this index is here rather than in the drift check.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')('CC-29 memory schema', () => {
  // PrismaService rather than a bare PrismaClient: Prisma 7 needs a driver
  // adapter, and this is the one place that builds it correctly (including
  // the `?schema=` handling that isolated runs depend on).
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('has the full-text index the drift guard cannot see', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'Memory' AND indexname = 'Memory_text_fts_idx'
    `;
    expect(
      rows,
      'Memory_text_fts_idx is missing — search still works, silently by seq scan',
    ).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('gin');
    // The exact expression, because that is the part the query has to repeat.
    expect(rows[0]?.indexdef).toContain("to_tsvector('english'::regconfig, text)");
  });

  it('has no full-text index over the transcript, whose text is sealed', async () => {
    // `content` holds ciphertext, so an index over it would be maintained on
    // every insert and could match nothing a person searched for.
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'Message' AND indexname = 'Message_content_fts_idx'
    `;
    expect(rows).toHaveLength(0);
  });

  it('indexes the scope lookup the turn-start read performs', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'Memory'
    `;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('Memory_userId_botId_status_idx');
  });

  it('has the COALESCE uniqueness a plain constraint could not provide', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'MemoryTombstone' AND indexname = 'MemoryTombstone_scope_claim_key'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('UNIQUE');
    expect(rows[0]?.indexdef).toContain('COALESCE');
  });

  it('refuses a duplicate USER-GLOBAL tombstone — the case NULL would have let through', async () => {
    // The one that matters. Postgres treats NULLs as distinct in a unique
    // index, so `@@unique([userId, botId, claimHash])` enforces nothing when
    // botId IS NULL — and user-global is the common scope. This case was
    // written first, it FAILED against the plain constraint, and that is why
    // the migration carries a COALESCE expression index instead.
    const userId = 'usr_crewaid_singleton_v1';
    const claimHash = `global-${Date.now()}`;
    const first = await prisma.memoryTombstone.create({ data: { userId, claimHash } });
    await expect(prisma.memoryTombstone.create({ data: { userId, claimHash } })).rejects.toThrow();
    await prisma.memoryTombstone.delete({ where: { id: first.id } });
  });

  it('refuses a duplicate bot-scoped tombstone', async () => {
    const userId = 'usr_crewaid_singleton_v1';
    const claimHash = `scoped-${Date.now()}`;
    const bot = await prisma.bot.create({
      data: {
        userId,
        name: 'CC-29 tomb fixture',
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
        modelId: 'default',
      },
    });
    await prisma.memoryTombstone.create({ data: { userId, botId: bot.id, claimHash } });
    await expect(
      prisma.memoryTombstone.create({ data: { userId, botId: bot.id, claimHash } }),
    ).rejects.toThrow();
    await prisma.bot.delete({ where: { id: bot.id } });
    await prisma.memoryTombstone.deleteMany({ where: { userId, claimHash } });
  });

  it('keeps tombstones in different scopes apart', async () => {
    // COALESCE must not collapse two genuinely different scopes into one:
    // erasing a bot's private note should not suppress the user-global fact
    // it happened to resemble.
    const userId = 'usr_crewaid_singleton_v1';
    const claimHash = `shared-${Date.now()}`;
    const bot = await prisma.bot.create({
      data: {
        userId,
        name: 'CC-29 scope-apart',
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
        modelId: 'default',
      },
    });
    await prisma.memoryTombstone.create({ data: { userId, claimHash } });
    await prisma.memoryTombstone.create({ data: { userId, botId: bot.id, claimHash } });
    expect(await prisma.memoryTombstone.count({ where: { userId, claimHash } })).toBe(2);
    await prisma.bot.delete({ where: { id: bot.id } });
    await prisma.memoryTombstone.deleteMany({ where: { userId, claimHash } });
  });

  it('keeps a memory when the message that established it is deleted', async () => {
    // SetNull, not Cascade. Deleting a transcript must not delete what was
    // learned from it — the claim outlives its evidence, and says so by
    // carrying a null messageId rather than by vanishing.
    const userId = 'usr_crewaid_singleton_v1';
    const bot = await prisma.bot.create({
      data: {
        userId,
        name: 'CC-29 fixture',
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
        modelId: 'default',
        conversation: { create: {} },
      },
      include: { conversation: true },
    });
    const message = await prisma.message.create({
      data: {
        conversationId: bot.conversation!.id,
        author: 'USER',
        content: 'Staging is crewaid-staging.example.com.',
      },
    });
    const memory = await prisma.memory.create({
      data: {
        userId,
        botId: bot.id,
        kind: 'FACT',
        source: 'TOLD',
        text: 'Staging is crewaid-staging.example.com.',
        messageId: message.id,
      },
    });

    await prisma.message.delete({ where: { id: message.id } });

    const survivor = await prisma.memory.findUnique({ where: { id: memory.id } });
    expect(survivor, 'the fact was deleted with its evidence').not.toBeNull();
    expect(survivor?.messageId).toBeNull();

    await prisma.bot.delete({ where: { id: bot.id } });
  });

  it("deletes a bot's private memory with the bot, and never promotes it", async () => {
    // Cascade, not SetNull. SetNull would turn a dead bot's private note into
    // a fact every other bot is told — the one wrong answer available here.
    const userId = 'usr_crewaid_singleton_v1';
    const bot = await prisma.bot.create({
      data: {
        userId,
        name: 'CC-29 scope fixture',
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
        modelId: 'default',
      },
    });
    const own = await prisma.memory.create({
      data: {
        userId,
        botId: bot.id,
        kind: 'CONVENTION',
        source: 'TOLD',
        text: 'Private to this bot.',
      },
    });
    const global = await prisma.memory.create({
      data: { userId, kind: 'PREFERENCE', source: 'TOLD', text: 'Global to the user.' },
    });

    await prisma.bot.delete({ where: { id: bot.id } });

    expect(await prisma.memory.findUnique({ where: { id: own.id } })).toBeNull();
    const survivor = await prisma.memory.findUnique({ where: { id: global.id } });
    expect(survivor, 'the user-global memory went with the bot').not.toBeNull();

    await prisma.memory.delete({ where: { id: global.id } });
  });
});
