#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ORCHESTRATOR_ROOT = fileURLToPath(new URL('../', import.meta.url));
const APP_ENTRY = path.join(ORCHESTRATOR_ROOT, 'scripts/e2e-server-app.mjs');
const SCHEMA_PREFIX = 'crewaid_e2e_';
const baseDatabaseUrl = process.env.DATABASE_URL;

if (!baseDatabaseUrl) throw new Error('DATABASE_URL is required for the M1-QA-05 server');

const schemaName = `${SCHEMA_PREFIX}${process.pid}_${randomUUID().replaceAll('-', '')}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.searchParams.delete('schema');
const isolatedUrl = new URL(baseDatabaseUrl);
isolatedUrl.searchParams.set('schema', schemaName);

/**
 * The same schema, also as the connection's `search_path`.
 *
 * `?schema=` reaches Prisma's pg adapter, which qualifies the SQL it GENERATES
 * — and only that. A `$queryRaw` names its tables unqualified, so it resolves
 * against the session's `search_path`, which is `"$user", public` by default:
 * on an isolated schema every raw statement reads and locks the DEVELOPER's
 * `public` rows instead. That is not hypothetical here. `RunLeaseService.claim`
 * opens with a raw `SELECT id FROM "Bot" … FOR UPDATE`, so it found no bot and
 * refused every turn on a TanStack thread with `RUN_NOT_OWNED` — which reaches
 * the desktop as a bare 404 from `POST /bots/:id/chat` and looks exactly like a
 * renderer sending to the wrong route. `BotsService.previews` and the unread
 * counts read the same way.
 *
 * `options` is a libpq startup parameter that node-postgres passes through, so
 * one connection string makes both halves agree. Production never needs it:
 * there the schema IS `public`, which is already on the default path.
 */
const serverUrl = new URL(isolatedUrl);
serverUrl.searchParams.set('options', `-c search_path=${schemaName}`);

let activeChild;
let shutdownRequested = false;
let schemaCreated = false;
let exitCode = 0;

function runChild(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ORCHESTRATOR_ROOT,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    activeChild = child;
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      resolve({ code, signal });
    });
  });
}

async function createSchema() {
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function dropSchema() {
  if (!schemaCreated) return;
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function requestShutdown(signal) {
  shutdownRequested = true;
  if (activeChild && activeChild.exitCode === null) activeChild.kill(signal);
}

process.once('SIGINT', () => requestShutdown('SIGINT'));
process.once('SIGTERM', () => requestShutdown('SIGTERM'));

try {
  await createSchema();

  if (!shutdownRequested) {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const migration = await runChild(pnpm, ['db:deploy'], {
      ...process.env,
      DATABASE_URL: isolatedUrl.toString(),
      MIGRATION_DATABASE_URL: isolatedUrl.toString(),
    });
    if (!shutdownRequested && migration.code !== 0) {
      throw new Error(`Prisma migrations failed with exit code ${migration.code ?? 'unknown'}`);
    }
  }

  if (!shutdownRequested) {
    const server = await runChild(process.execPath, [APP_ENTRY], {
      ...process.env,
      DATABASE_URL: serverUrl.toString(),
      CREWAID_E2E_DATABASE_SCHEMA: schemaName,
    });
    if (!shutdownRequested && server.code !== 0) {
      throw new Error(
        `M1-QA-05 server exited with ${server.signal ?? `code ${server.code ?? 'unknown'}`}`,
      );
    }
  }
} catch (error) {
  if (!shutdownRequested) {
    exitCode = 1;
    console.error(
      `[crewaid-e2e] isolated server failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
} finally {
  try {
    await dropSchema();
  } catch (error) {
    exitCode = 1;
    console.error(
      `[crewaid-e2e] temporary schema cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

process.exitCode = exitCode;
