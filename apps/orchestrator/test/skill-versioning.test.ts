/**
 * Regression proof for multi-version skills.
 *
 * `Skill.sourceRecordingId @unique` would contradict "editing and saving a
 * script bumps `version` and keeps the previous version queryable". Two
 * versions of a skill both reference the same source
 * recording, so the second insert violates the constraint — a guaranteed M3
 * gate failure.
 *
 * The schema-contract test asserts the `@unique` is absent from the source
 * file. This asserts the behaviour it was blocking actually works against a
 * real Postgres, which is the thing M3 depends on.
 *
 * Requires a live database (the compose stack). Skipped when DATABASE_URL is
 * unset so unit runs stay hermetic.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

const connectionString = process.env['DATABASE_URL'];
const describeIfDb =
  connectionString === undefined || connectionString === '' ? describe.skip : describe;

describeIfDb('D-009(2) — a recording can source multiple skill versions', () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString ?? '' }),
  });

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const created: { userId?: string } = {};

  afterAll(async () => {
    // Cascades clean up bot, recording, and skills.
    if (created.userId !== undefined) {
      await prisma.user.delete({ where: { id: created.userId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it('persists v1 and v2 of a skill against one source recording', async () => {
    const user = await prisma.user.create({
      data: { id: `u_${suffix}`, name: 'Test User', email: `u_${suffix}@test.invalid` },
    });
    created.userId = user.id;

    const bot = await prisma.bot.create({
      data: {
        userId: user.id,
        name: 'Quill',
        role: 'Outbound Writer',
        avatarColor: '#8B6F47',
        systemPrompt: 'test',
      },
    });

    const recording = await prisma.recording.create({ data: { botId: bot.id } });

    const base = {
      botId: bot.id,
      name: 'open_example_site',
      description: 'Opens example.com.',
      paramsSchema: {},
      sourceRecordingId: recording.id,
    };

    const v1 = await prisma.skill.create({
      data: { ...base, script: 'export default async () => {};', version: 1 },
    });

    // This is the insert that threw under §3's `@unique`.
    const v2 = await prisma.skill.create({
      data: { ...base, script: 'export default async () => { /* edited */ };', version: 2 },
    });

    expect(v1.sourceRecordingId).toBe(recording.id);
    expect(v2.sourceRecordingId).toBe(recording.id);

    // M3: "keeps the previous version queryable".
    const versions = await prisma.skill.findMany({
      where: { sourceRecordingId: recording.id },
      orderBy: { version: 'asc' },
      select: { version: true },
    });
    expect(versions.map((s) => s.version)).toEqual([1, 2]);
  });
});
