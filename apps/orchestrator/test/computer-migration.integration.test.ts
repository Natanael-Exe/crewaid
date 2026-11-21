import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';

const migration = readFileSync(
  new URL(
    '../prisma/migrations/20260912160000_d046_computer_cardinality/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

// Requires PostgreSQL; each case uses and removes its own schema.
describe.skipIf(!process.env['DATABASE_URL'])('computer cardinality migration', () => {
  let client: pg.Client;
  let schema: string;
  async function seed(orphan = false) {
    client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await client.connect();
    schema = `migration_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE "User" (id TEXT PRIMARY KEY);
      CREATE TABLE "Bot" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"(id));
      CREATE TABLE "Sandbox" (id TEXT PRIMARY KEY, "botId" TEXT, "sessionId" TEXT, "containerId" TEXT);
      CREATE UNIQUE INDEX "Sandbox_botId_key" ON "Sandbox"("botId");
      INSERT INTO "User" VALUES ('owner');
      INSERT INTO "Bot" VALUES ('bot-a', 'owner'), ('bot-b', 'owner'), ('detached', 'owner');
      INSERT INTO "Sandbox" VALUES ('old-row-a', 'bot-a', 'session-a', 'container-a'), ('old-row-b', 'bot-b', NULL, NULL);
    `);
    if (orphan)
      await client.query(`INSERT INTO "Sandbox" VALUES ('lost-row', 'missing-bot', NULL, NULL)`);
  }
  afterEach(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });
  it('preserves workspace keys and runtime identity while attaching each old bot', async () => {
    await seed();
    await client.query(migration);
    const rows = await client.query('SELECT * FROM "Sandbox" ORDER BY id');
    expect(rows.rows).toEqual([
      { id: 'bot-a', userId: 'owner', sessionId: 'session-a', containerId: 'container-a' },
      { id: 'bot-b', userId: 'owner', sessionId: null, containerId: null },
    ]);
    expect((await client.query('SELECT id, "sandboxId" FROM "Bot" ORDER BY id')).rows).toEqual([
      { id: 'bot-a', sandboxId: 'bot-a' },
      { id: 'bot-b', sandboxId: 'bot-b' },
      { id: 'detached', sandboxId: null },
    ]);
    await client.query(`UPDATE "Bot" SET "sandboxId" = 'bot-a' WHERE id = 'bot-b'`);
    await client.query(`DELETE FROM "Bot" WHERE id = 'bot-a'`);
    expect((await client.query(`SELECT id FROM "Sandbox" WHERE id = 'bot-a'`)).rowCount).toBe(1);
    await client.query(`DELETE FROM "Sandbox" WHERE id = 'bot-a'`);
    expect((await client.query(`SELECT "sandboxId" FROM "Bot" WHERE id = 'bot-b'`)).rows).toEqual([
      { sandboxId: null },
    ]);
  });
  it('fails atomically on unattributable storage instead of discarding it', async () => {
    await seed(true);
    await expect(client.query(migration)).rejects.toThrow('have no owning Bot');
    await client.query('ROLLBACK');
    expect((await client.query('SELECT id FROM "Sandbox" ORDER BY id')).rows).toEqual([
      { id: 'lost-row' },
      { id: 'old-row-a' },
      { id: 'old-row-b' },
    ]);
    expect(
      (
        await client.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Sandbox' AND column_name = 'userId'`,
          [schema],
        )
      ).rowCount,
    ).toBe(0);
  });
});
