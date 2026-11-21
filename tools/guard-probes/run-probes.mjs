#!/usr/bin/env node
// D-013 probe runner — "a guard that cannot be demonstrated failing is not evidence."
//
// Runs every probe in tools/guard-probes/ and asserts that the EXACT rule id
// named in probes.json fires. Why not just check the exit code:
//   1. A probe outside every tsconfig used to fail with a PARSER error
//      ("not found by the project service"), eslint exits fatal, and any
//      exit-code-based check reads that as "rule fired". Nothing fired.
//   2. A rule that silently stops matching (see the flat-config merge note in
//      eslint.config.mjs) produces a clean file — exit 0, no messages.
// Both masquerade as success without this runner.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const manifest = JSON.parse(readFileSync(path.join(here, 'probes.json'), 'utf8'));

if (!manifest.probes?.length) {
  console.error(
    '::error::D-013 — probes.json lists no probes. A guard with no probe is not a guard.',
  );
  process.exit(1);
}

let failed = 0;
for (const probe of manifest.probes) {
  const file = path.join(repo, probe.file);
  let messages;
  try {
    const raw = execFileSync('pnpm', ['exec', 'eslint', '--no-ignore', '--format', 'json', file], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    messages = JSON.parse(raw).flatMap((r) => r.messages);
  } catch (err) {
    // eslint exits non-zero when it reports problems — that is the EXPECTED
    // path; stdout still carries the JSON we need to audit ruleIds.
    try {
      messages = JSON.parse(err.stdout).flatMap((r) => r.messages);
    } catch {
      console.error(`::error file=${probe.file}::eslint crashed before reporting (${err.message})`);
      failed++;
      continue;
    }
  }

  const ruleIds = messages.map((m) => m.ruleId).filter(Boolean);
  const parseErrors = messages.filter((m) => m.fatal || m.ruleId === null);

  if (parseErrors.length) {
    console.error(
      `::error file=${probe.file}::PARSER error, not a rule firing — the probe proves nothing`,
    );
    failed++;
  } else if (!ruleIds.includes(probe.rule)) {
    console.error(
      `::error file=${probe.file}::probe linted CLEAN or fired the wrong rule — expected "${probe.rule}", got ${JSON.stringify(ruleIds)}`,
    );
    failed++;
  } else {
    console.log(`ok — ${path.basename(probe.file)} rejected by ${probe.rule}`);
  }
}

if (failed) {
  console.error(
    `\n${failed}/${manifest.probes.length} probes did NOT demonstrate their guard. See docs/DECISIONS.md D-013.`,
  );
  process.exit(1);
}
console.log(`\nall ${manifest.probes.length} probes demonstrate their guards.`);
