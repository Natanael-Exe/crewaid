#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HARD_MIN_FREE_GIB = 15;
// Hard block only below 5 GiB; warn between 5 and HARD_MIN_FREE_GIB.
export const CRITICAL_FREE_GIB = 5;

export function parseMinimumFreeGib(raw) {
  if (raw === undefined || raw === '') return CRITICAL_FREE_GIB;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < CRITICAL_FREE_GIB) {
    throw new Error(`CREWAID_MIN_FREE_GIB must be a finite number at least ${CRITICAL_FREE_GIB}`);
  }
  return parsed;
}

// Chromium needs a display. macOS and a Linux desktop session have one; a
// headless Linux box does not, and CI supplies Xvfb for exactly that reason.
export function needsVirtualDisplay(env, platform) {
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export function buildSteps(env, platform = process.platform) {
  const steps = [
    ['Diff hygiene', 'git', ['diff', '--check']],
    ['Pre-review gate regressions', 'node', ['--test', 'scripts/pre-review-gate.test.mjs']],
    [
      'Generate Prisma client',
      'pnpm',
      ['db:generate'],
      {
        DATABASE_URL:
          env.DATABASE_URL ??
          'postgresql://crewaid:placeholder@localhost:5432/crewaid?schema=public',
      },
    ],
    ['Exact dependency pins', 'node', ['scripts/check-pins.mjs']],
    ['Lint', 'pnpm', ['lint']],
    ['Architectural guard probes', 'node', ['tools/guard-probes/run-probes.mjs']],
    ['Typecheck', 'pnpm', ['typecheck']],
    ['Build', 'pnpm', ['build']],
  ];

  if (env.DATABASE_URL) {
    steps.push(['Deploy migrations', 'pnpm', ['db:deploy']]);
  }
  steps.push(['Tests', 'pnpm', ['test']]);
  // The ROOT script, never `--filter @crewaid/desktop test:e2e`: the filtered one
  // drives whatever renderer was last built, so it passes on stale output. The
  // root script rebuilds first, which turbo answers from the build above.
  steps.push(
    needsVirtualDisplay(env, platform)
      ? ['Electron e2e', 'xvfb-run', ['--auto-servernum', 'pnpm', 'test:e2e']]
      : ['Electron e2e', 'pnpm', ['test:e2e']],
  );
  return steps;
}

function currentFreeGib(cwd) {
  const stats = statfsSync(cwd);
  return (stats.bavail * stats.bsize) / 1024 ** 3;
}

export function executeGate({
  cwd = process.cwd(),
  env = process.env,
  freeGib = currentFreeGib(cwd),
  spawn = spawnSync,
  output = console,
  platform = process.platform,
} = {}) {
  let minimum;
  try {
    minimum = parseMinimumFreeGib(env.CREWAID_MIN_FREE_GIB);
  } catch (error) {
    output.error(`pre-review: ${error.message}; no checks were started.`);
    return 2;
  }

  if (freeGib < minimum) {
    output.error(
      `pre-review: refusing to start with ${freeGib.toFixed(1)} GiB free; ` +
        `minimum is ${minimum} GiB. Clean merged worktrees/caches first.`,
    );
    return 2;
  }

  if (freeGib < HARD_MIN_FREE_GIB) {
    output.warn(
      `pre-review: ${freeGib.toFixed(1)} GiB free is below the ${HARD_MIN_FREE_GIB} GiB ` +
        'comfort threshold; continuing, but clean merged worktrees/caches when convenient.',
    );
  }

  // Two e2e specs boot a real orchestrator, so without a database the e2e step
  // cannot pass. Refusing here costs nothing; letting it fail at the end costs
  // the whole run and reads as a chat or skills regression. There is no
  // skip: a gate that quietly leaves out a check passes branches CI rejects.
  if (!env.DATABASE_URL) {
    output.error(
      'pre-review: DATABASE_URL is required — the Electron e2e step boots a real ' +
        'orchestrator. Start infra/compose, export DATABASE_URL and re-run; no checks were started.',
    );
    return 2;
  }

  for (const [label, command, args, stepEnv = {}] of buildSteps(env, platform)) {
    output.log(`\n==> ${label}`);
    const result = spawn(command, args, {
      cwd,
      env: { ...env, ...stepEnv },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.error) {
      const hint =
        command === 'xvfb-run'
          ? ' (no display is set; install Xvfb, or run from a desktop session)'
          : '';
      output.error(`pre-review: ${label} could not start: ${result.error.message}${hint}`);
      return 1;
    }
    if (result.status !== 0) {
      output.error(`pre-review: ${label} failed with exit code ${result.status}`);
      return result.status ?? 1;
    }
  }

  output.log(`\npre-review: PASS (${freeGib.toFixed(1)} GiB free at start)`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = executeGate();
}
