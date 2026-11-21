import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * V1-17 — the reset refuses, and says which signal refused it.
 *
 * ── WHY THE GUARDS ARE THE TESTED HALF ──────────────────────────────────────
 *
 * The happy path drops every row in a database, so a test that exercised it
 * would need its own database and would be the most destructive thing in the
 * suite. The REFUSALS need nothing: each one must reject before the script
 * touches Postgres at all, which is both the property worth having and the
 * only one that is cheap to assert.
 *
 * Every case checks the exit code AND the sentence. A guard that refuses for
 * the wrong reason passes an exit-code check perfectly — and the reason is
 * what the operator acts on.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'db-reset.mjs');

/** Run the script with a controlled environment, never inheriting a real one. */
function reset(env) {
  try {
    execFileSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A bare environment: inheriting the developer's DATABASE_URL is how a
      // test like this ends up asserting against their own database.
      env: { PATH: process.env.PATH, ...env },
    });
    return { code: 0, output: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

const LOCAL = 'postgresql://crewaid:crewaid@localhost:5433/crewaid_dev';

test('refuses when DATABASE_URL is unset', () => {
  const { code, output } = reset({});
  assert.equal(code, 1);
  assert.match(output, /DATABASE_URL is not set/);
});

test('refuses a host that is not local', () => {
  const { code, output } = reset({ DATABASE_URL: 'postgresql://u:p@db.example.com:5432/crewaid' });
  assert.equal(code, 1);
  assert.match(output, /not a local host/);
  // It refuses rather than prompting on purpose: a prompt somebody is already
  // typing "yes" into is not a guard.
  assert.doesNotMatch(output, /Type the database name/);
});

test('refuses a database whose name looks like production', () => {
  for (const name of ['crewaid_production', 'crewaid-live', 'staging_crewaid']) {
    const { code, output } = reset({ DATABASE_URL: `postgresql://u:p@localhost:5433/${name}` });
    assert.equal(code, 1, name);
    assert.match(output, new RegExp(`named "${name}"`), name);
  }
});

test('refuses under NODE_ENV=production', () => {
  const { code, output } = reset({ DATABASE_URL: LOCAL, NODE_ENV: 'production' });
  assert.equal(code, 1);
  assert.match(output, /NODE_ENV=production/);
});

test('refuses with nothing confirmed, and names the variable that would', () => {
  const { code, output } = reset({ DATABASE_URL: LOCAL });
  assert.equal(code, 1);
  assert.match(output, /Not a terminal, and nothing confirmed/);
  // The remedy names THIS database, which is the whole mechanism.
  assert.match(output, /CREWAID_DB_RESET_YES=crewaid_dev/);
});

test('refuses a confirmation naming a different database', () => {
  // The case the variable exists for. A `CREWAID_DB_RESET_YES` left in a shell
  // profile or a CI environment must not authorise whatever DATABASE_URL
  // happens to point at today.
  const { code, output } = reset({ DATABASE_URL: LOCAL, CREWAID_DB_RESET_YES: 'some_other_db' });
  assert.equal(code, 1);
  assert.match(output, /nothing confirmed/);
});

test('never prints the password', () => {
  const { output } = reset({
    DATABASE_URL: 'postgresql://crewaid:hunter2-should-not-appear@db.example.com:5432/crewaid',
  });
  // This script's subject is credentials. One that echoed a password into a
  // terminal has leaked it to every shell-history reader on the machine.
  assert.doesNotMatch(output, /hunter2/);
});
