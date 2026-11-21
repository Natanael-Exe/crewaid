#!/usr/bin/env node
/**
 * Periodic local-development cleanup — the targeted counterpart to `db:reset`.
 *
 * `db:reset` drops every row and re-seeds; running it means signing in again
 * and re-entering provider keys. This script instead removes exactly what the
 * integration suites and a crashed orchestrator leave behind, and keeps every
 * real (signed-in) account's data intact:
 *
 *   1. Integration-test users — every `@test.invalid` account and, by cascade,
 *      whatever its suites created (bots, conversations, turns, recordings,
 *      attachments, sessions).
 *   2. The seeded singleton account's data — `usr_crewaid_singleton_v1`'s bots,
 *      sandboxes, skills, attachments, memories and provider rows. The USER row
 *      itself is kept: `prisma/seed.ts` creates it as the fresh-checkout fixture
 *      and tests look it up.
 *   3. Skills orphaned by the above, plus every previously-orphaned global
 *      skill (`botId IS NULL`). ⚠️ This reads the CURRENT product honestly:
 *      skills are compiled from a bot's recording, so a global skill only
 *      exists after its bot was deleted. If a "share with all bots" feature
 *      ever ships, this query needs an owner column to key off before it
 *      deletes anything.
 *   4. Stale Sandbox rows of ANY account that are provably dead: a state of
 *      STARTING/UNHEALTHY/ERROR with no container and no start in the last ten
 *      minutes (the start lease is 60 s, so ten minutes is ten budgets). These
 *      are the rows that answer "host is full" on admission while owning no
 *      machine. STOPPED rows and rows with a container are never touched.
 *   5. Docker leftovers — workspace volumes whose Sandbox row is gone, and
 *      sandbox containers that are not running.
 *   6. Artifact files no remaining row references (attachments and recording
 *      screenshots).
 *
 * ⚠️ THE GUARD, inherited from db-reset.mjs: this refuses any DATABASE_URL that
 * does not look local. The deletions are scoped to fixture data, but scoped
 * SQL run against the wrong database is still scoped SQL against the wrong
 * database.
 *
 * If the orchestrator is running, its live reconciliation can recreate test
 * rows mid-clean (a partial result, not a wrong one) — stop it for a full
 * pass.
 *
 * Run: pnpm db:clean
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORCHESTRATOR = join(ROOT, 'apps', 'orchestrator');
const COMPOSE_ENV = join(ROOT, 'infra', 'compose', '.env');

/** Hosts a development database is allowed to live on (as in db-reset.mjs). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'host.docker.internal']);

/** The seeded development fixture account; its row survives, its data does not. */
const SINGLETON_USER_ID = 'usr_crewaid_singleton_v1';

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** KEY=VALUE lines, for the variables the orchestrator gets via --env-file. */
function readComposeEnv() {
  if (!existsSync(COMPOSE_ENV)) return {};
  const vars = {};
  for (const line of readFileSync(COMPOSE_ENV, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && match[1] !== undefined) vars[match[1]] = match[2];
  }
  return vars;
}

function parseDatabaseUrl() {
  const raw = process.env['DATABASE_URL'] ?? readComposeEnv()['DATABASE_URL'];
  if (!raw) fail('DATABASE_URL is not set (env or infra/compose/.env).');
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('DATABASE_URL is not a URL.');
  }
  const database = url.pathname.replace(/^\//, '');
  if (database === '') fail('DATABASE_URL names no database.');
  return { host: url.hostname, database };
}

function assertLooksLocal({ host, database }) {
  if (process.env['NODE_ENV'] === 'production') {
    fail('NODE_ENV=production. This script will not run against a production process.');
  }
  if (!LOCAL_HOSTS.has(host)) {
    fail(
      `DATABASE_URL points at "${host}", which is not a local host.\n` +
        '  Clean it by hand if you really meant to — this refuses rather than asking.',
    );
  }
  if (/prod|live|staging/i.test(database)) {
    fail(`The database is named "${database}". Rename it or clean it by hand.`);
  }
}

/** `pg` lives in the orchestrator's dependencies; resolve through its tree. */
function loadPg() {
  try {
    return createRequire(join(ORCHESTRATOR, 'package.json'))('pg');
  } catch {
    return fail('Could not load `pg` from apps/orchestrator. Run pnpm install first.');
  }
}

function warnIfOrchestratorRunning() {
  const port = process.env['PORT'] ?? readComposeEnv()['PORT'] ?? '3000';
  try {
    execFileSync('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'pipe' });
    console.log(
      `⚠️  Something is listening on :${port} — the orchestrator, most likely.\n` +
        '   It can recreate test rows mid-clean, so the result may be partial.\n' +
        '   Stop it and re-run for a full pass.\n',
    );
  } catch {
    // Nothing listening — the good case.
  }
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8' });
}

// ── Database ──────────────────────────────────────────────────────────────────

async function cleanDatabase(pool) {
  const deleted = {};
  try {
    await pool.query('BEGIN');

    // Test users first: they own nothing today, but if a future suite gives
    // them bots or keys, the cascades below would not cover them.
    deleted.testUsers = (
      await pool.query(`DELETE FROM "User" WHERE email LIKE '%@test.invalid'`)
    ).rowCount;

    // See the header for why `botId IS NULL` is currently equivalent to
    // "orphaned by a deleted test bot".
    deleted.skills = (
      await pool.query(
        `DELETE FROM "Skill"
          WHERE "botId" IS NULL
             OR "botId" IN (SELECT id FROM "Bot" WHERE "userId" = $1)`,
        [SINGLETON_USER_ID],
      )
    ).rowCount;

    deleted.attachments = (
      await pool.query(`DELETE FROM "Attachment" WHERE "ownerId" = $1`, [SINGLETON_USER_ID])
    ).rowCount;
    deleted.memories = (
      await pool.query(`DELETE FROM "Memory" WHERE "userId" = $1`, [SINGLETON_USER_ID])
    ).rowCount;
    deleted.tombstones = (
      await pool.query(`DELETE FROM "MemoryTombstone" WHERE "userId" = $1`, [SINGLETON_USER_ID])
    ).rowCount;
    deleted.mcpServers = (
      await pool.query(`DELETE FROM "McpServer" WHERE "userId" = $1`, [SINGLETON_USER_ID])
    ).rowCount;
    deleted.providerConnections = (
      await pool.query(`DELETE FROM "ProviderConnection" WHERE "userId" = $1`, [SINGLETON_USER_ID])
    ).rowCount;
    deleted.userSettings = (
      await pool.query(`DELETE FROM "UserSettings" WHERE "userId" = $1`, [SINGLETON_USER_ID])
    ).rowCount;
    deleted.testBots = (
      await pool.query(`DELETE FROM "Bot" WHERE "userId" = $1`, [SINGLETON_USER_ID])
    ).rowCount;
    deleted.testSandboxes = (
      await pool.query(`DELETE FROM "Sandbox" WHERE "userId" = $1`, [SINGLETON_USER_ID])
    ).rowCount;

    // Stale rows for REAL accounts: wedging the machine's row in a
    // slot-occupying state with no container behind it. The claim always
    // writes `lastStartedAt`, so a NULL one in a non-STOPPED state is a row
    // wedged before that mechanism existed. STOPPED rows and rows with a
    // container are a machine someone still owns — never touched.
    deleted.staleSandboxes = (
      await pool.query(
        `DELETE FROM "Sandbox"
          WHERE state IN ('STARTING', 'UNHEALTHY', 'ERROR')
            AND "containerId" IS NULL
            AND ("lastStartedAt" IS NULL OR "lastStartedAt" < now() - interval '10 minutes')`,
      )
    ).rowCount;

    await pool.query('COMMIT');
  } catch (error) {
    // A failed ROLLBACK must not replace the error that caused it.
    await pool.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return deleted;
}

// ── Docker ────────────────────────────────────────────────────────────────────

async function cleanVolumesAndContainers(pool) {
  const removed = { volumes: 0, containers: 0, aliveContainers: 0, zombieContainers: 0 };

  const { rows } = await pool.query(`SELECT id FROM "Sandbox"`);
  const liveIds = new Set(rows.map((r) => r.id));

  let volumes;
  try {
    volumes = docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n').filter(Boolean);
  } catch {
    volumes = [];
  }
  for (const name of volumes) {
    const id = name.replace(/^crewaid-workspace-/, '');
    if (!name.startsWith('crewaid-workspace-') || liveIds.has(id)) continue;
    try {
      docker(['volume', 'rm', name]);
      removed.volumes++;
    } catch (error) {
      console.log(`  ⚠️  could not remove volume ${name}: ${error.message.split('\n')[0]}`);
    }
  }

  // ⚠️ Sandbox containers are matched by IMAGE, not by label: they carry
  // `crewaid.identity` / `crewaid.managedBy` (the workspace VOLUMES carry
  // `crewaid.botId`), so a label filter named after bots matches none of them.
  let containers = [];
  try {
    containers = docker(['ps', '-a', '--format', '{{.ID}} {{.State}} {{.Image}} {{.Names}}'])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '))
      .filter(([, , image]) => image.startsWith('crewaid/sandbox:'))
      .map(([id, state, , name]) => ({
        id,
        state,
        sandboxId: name.replace(/^crewaid-sandbox-/, ''),
      }));
  } catch {
    containers = [];
  }
  for (const { id, state, sandboxId } of containers) {
    if (state === 'running') {
      if (liveIds.has(sandboxId)) removed.aliveContainers++;
      else removed.zombieContainers++;
      continue;
    }
    try {
      docker(['rm', id]);
      removed.containers++;
    } catch (error) {
      console.log(`  ⚠️  could not remove container ${id}: ${error.message.split('\n')[0]}`);
    }
  }

  return removed;
}

// ── Artifact files ────────────────────────────────────────────────────────────

function artifactDirs() {
  const dirs = new Set([join(ROOT, '.artifacts'), join(ORCHESTRATOR, '.artifacts')]);
  const configured = process.env['ARTIFACT_DIR'] ?? readComposeEnv()['ARTIFACT_DIR'];
  if (configured) dirs.add(resolve(ROOT, configured));
  return [...dirs].filter((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory());
}

/** Depth-first sweep: unlink every file whose path relative to the artifacts
 *  root is not referenced, then prune the directories this emptied. Storage
 *  keys are always `<day>/<uuid>-<filename>`, so anything else is test output
 *  by definition. */
function sweepDir(dir, referenced, relBase = '') {
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    const rel = relBase === '' ? entry : `${relBase}/${entry}`;
    const stat = statSync(entryPath, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      removed += sweepDir(entryPath, referenced, rel);
      if (readdirSync(entryPath).length === 0) rmSync(entryPath, { recursive: true });
    } else if (stat?.isFile() && !referenced.has(rel)) {
      rmSync(entryPath);
      removed++;
    }
  }
  return removed;
}

async function cleanArtifacts(pool) {
  const { rows: attachmentKeys } = await pool.query(`SELECT "storageKey" FROM "Attachment"`);
  const { rows: screenshotKeys } = await pool.query(
    `SELECT "screenshotKey" FROM "RecordingEvent" WHERE "screenshotKey" IS NOT NULL`,
  );
  const referenced = new Set([...attachmentKeys, ...screenshotKeys].map((r) => r.storageKey));

  let removed = 0;
  for (const dir of artifactDirs()) removed += sweepDir(dir, referenced);
  return removed;
}

// ── Report ────────────────────────────────────────────────────────────────────

async function summarize(pool, deleted, dockerRemoved, artifactsRemoved) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM "Sandbox") AS sandboxes,
       (SELECT count(*) FROM "Sandbox" WHERE state IN ('STARTING','RUNNING','UNHEALTHY')) AS occupied_slots,
       (SELECT count(*) FROM "Bot") AS bots`,
  );
  const { sandboxes, occupied_slots, bots } = rows[0];

  console.log('\n── removed ──');
  const labels = {
    testUsers: 'test users (@test.invalid)',
    testBots: "singleton's test bots",
    testSandboxes: "singleton's sandbox rows",
    staleSandboxes: 'stale slot-occupying sandbox rows',
    skills: 'orphaned skills',
    attachments: 'attachment rows',
    memories: 'memory rows',
    tombstones: 'memory tombstones',
    mcpServers: 'MCP server rows',
    providerConnections: 'provider connections',
    userSettings: 'user settings rows',
  };
  for (const [key, label] of Object.entries(labels)) {
    if (deleted[key]) console.log(`  ${deleted[key]}  ${label}`);
  }
  if (dockerRemoved.volumes) console.log(`  ${dockerRemoved.volumes}  workspace volumes`);
  if (dockerRemoved.containers)
    console.log(`  ${dockerRemoved.containers}  stopped sandbox containers`);
  if (dockerRemoved.zombieContainers) {
    console.log(
      `  ⚠️  ${dockerRemoved.zombieContainers} RUNNING container(s) with no sandbox row — ` +
        'stop the orchestrator, then re-run to have them reported again',
    );
  }
  if (dockerRemoved.aliveContainers) {
    console.log(
      `  ${dockerRemoved.aliveContainers}  running sandbox container(s) left running (their row is live)`,
    );
  }
  if (artifactsRemoved) console.log(`  ${artifactsRemoved}  orphaned artifact files`);

  console.log('\n── remaining ──');
  console.log(`  ${bots} bot(s), ${sandboxes} sandbox row(s), ${occupied_slots} slot(s) occupied`);
  if (Number(occupied_slots) === 0)
    console.log('  ✓ capacity unblocked — new sandboxes can start\n');
}

async function main() {
  const target = parseDatabaseUrl();
  assertLooksLocal(target);
  warnIfOrchestratorRunning();

  const { Pool } = loadPg();
  const pool = new Pool({
    connectionString: process.env['DATABASE_URL'] ?? readComposeEnv()['DATABASE_URL'],
  });

  try {
    console.log(`── cleaning ${target.database} on ${target.host} ──`);
    const deleted = await cleanDatabase(pool);
    const dockerRemoved = await cleanVolumesAndContainers(pool);
    const artifactsRemoved = await cleanArtifacts(pool);
    await summarize(pool, deleted, dockerRemoved, artifactsRemoved);
  } catch (error) {
    fail(error.message);
  } finally {
    await pool.end();
  }
}

await main();
