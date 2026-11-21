#!/usr/bin/env node
/**
 * V1-17 — an explicit development database reset.
 *
 * ⚠️ THIS DROPS EVERY ROW. Bots, conversations, recordings, skills, accounts,
 * and every encrypted provider key. There is no undo and no export.
 *
 * ── WHY V1 NEEDS ONE AT ALL ─────────────────────────────────────────────────
 *
 * A database that predates V1 is not wrong so much as unreadable. `Bot.modelId`
 * held a composed `provider:model` key; D-082 made it a `ProviderModel` row id,
 * and no such rows exist. Provider keys lived in the orchestrator's
 * environment; D-083 made them per-user rows in a vault, and there is nobody to
 * own them. A migration could invent answers for both. It would be inventing
 * which user owns a key that was configured for a whole deployment — which is
 * the question V1 exists to stop guessing at.
 *
 * ── NO CREDENTIAL IMPORT, DELIBERATELY ──────────────────────────────────────
 *
 * Nothing here reads `OPENAI_API_KEY` or its siblings and writes them into the
 * vault. An imported key would be attributed to whichever account happened to
 * be seeded first, and every turn anyone ran would spend it — silently, and
 * correctly as far as any code could tell. Re-entering a key in Settings takes
 * a minute and says who it belongs to.
 *
 * ── THE GUARD ───────────────────────────────────────────────────────────────
 *
 * "Explicit" is the whole requirement, so this refuses by default and asks for
 * two independent signals before it drops anything: the database has to LOOK
 * local, and the operator has to name it back. A flag alone would be one
 * keystroke away from a shell-history accident against a staging URL.
 *
 * Run: pnpm db:reset
 */

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORCHESTRATOR = join(ROOT, 'apps', 'orchestrator');

/** Hosts a development database is allowed to live on. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'host.docker.internal']);

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function parseTarget(raw) {
  if (raw === undefined || raw === '') {
    fail('DATABASE_URL is not set. See infra/compose/.env.example.');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('DATABASE_URL is not a URL.');
  }
  const database = url.pathname.replace(/^\//, '');
  if (database === '') fail('DATABASE_URL names no database.');
  // The password is never printed, here or anywhere: this script's whole
  // subject is credentials, and a reset that echoes one into a terminal
  // scrollback has leaked it to every shell-history reader on the machine.
  return { host: url.hostname, port: url.port || '5432', database };
}

function assertLooksLocal({ host, database }) {
  if (process.env['NODE_ENV'] === 'production') {
    fail('NODE_ENV=production. This script will not run against a production process.');
  }
  if (!LOCAL_HOSTS.has(host)) {
    fail(
      `DATABASE_URL points at "${host}", which is not a local host.\n` +
        `  Reset it by hand if you meant to — this refuses rather than asking,\n` +
        `  because a prompt somebody is already typing "yes" into is not a guard.`,
    );
  }
  if (/prod|live|staging/i.test(database)) {
    fail(`The database is named "${database}". Rename it or reset it by hand.`);
  }
}

async function confirm({ host, port, database }) {
  if (process.env['CREWAID_DB_RESET_YES'] === database) return;

  console.log('');
  console.log('  This DROPS EVERY ROW in:');
  console.log('');
  console.log(`    ${database}  on  ${host}:${port}`);
  console.log('');
  console.log('  Including every encrypted provider key. Nothing is exported and');
  console.log('  nothing is imported back — you re-enter keys in Settings afterwards.');
  console.log('');

  if (!process.stdin.isTTY) {
    fail(
      'Not a terminal, and nothing confirmed.\n' +
        `  For a script, set CREWAID_DB_RESET_YES=${database} — naming the database\n` +
        '  is the point: an inherited variable cannot then wipe a different one.',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // The NAME, not "yes". Typing it back is what makes this a decision about
    // one specific database rather than a reflex.
    const answer = await rl.question(`  Type the database name to confirm: `);
    if (answer.trim() !== database) fail('That is not the database name. Nothing was changed.');
  } finally {
    rl.close();
  }
}

function run(command, args) {
  execFileSync(command, args, { cwd: ORCHESTRATOR, stdio: 'inherit', env: process.env });
}

async function main() {
  const target = parseTarget(process.env['DATABASE_URL']);
  assertLooksLocal(target);
  await confirm(target);

  console.log('\n── Dropping and re-applying every migration ──');
  // `--force` is safe HERE and only here: everything above is the confirmation
  // Prisma would otherwise ask for.
  //
  // No `--skip-generate`: Prisma 7 does not accept it, and rejects the whole
  // command rather than ignoring the flag.
  run('pnpm', ['exec', 'prisma', 'migrate', 'reset', '--force']);

  // ⚠️ SEEDED EXPLICITLY, because `migrate reset` did NOT run it.
  // `prisma.config.ts` declares `migrations.seed`, and on Prisma 7.10 the
  // reset completed without invoking it — leaving a database with no account
  // at all. That is not obviously wrong (V1 accounts come from signing in),
  // which is exactly why it is worth being deliberate about rather than
  // inheriting from whatever the CLI happens to do next release.
  console.log('\n── Seeding the development account ──');
  run('pnpm', ['run', 'db:seed']);

  // ⚠️ AFTER, NOT BEFORE. A reset that crosses the schema or the shared
  // boundary leaves stale generated artifacts, and they surface as about
  // thirty unrelated type errors in files nobody touched — which reads as a
  // broken checkout rather than as a missing `generate`.
  console.log('\n── Regenerating the Prisma client ──');
  run('pnpm', ['exec', 'prisma', 'generate']);

  console.log('\n✓ Reset. Next: sign in, then add a provider connection and its key in Settings.');
  console.log('  No key was imported from the environment — V1 attributes keys to an account.\n');
}

await main();
