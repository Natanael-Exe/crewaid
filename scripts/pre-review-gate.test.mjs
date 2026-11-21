import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CRITICAL_FREE_GIB,
  HARD_MIN_FREE_GIB,
  buildSteps,
  executeGate,
  needsVirtualDisplay,
  parseMinimumFreeGib,
} from './pre-review-gate.mjs';

const lines = [];
const capture = {
  error(message) {
    lines.push(`ERR ${message}`);
  },
  log(message) {
    lines.push(`LOG ${message}`);
  },
  warn(message) {
    lines.push(`WARN ${message}`);
  },
};

function fakeGate({
  minimum,
  freeGib,
  databaseUrl = 'postgresql://example.invalid/db',
  platform = 'darwin',
  spawnError,
} = {}) {
  lines.length = 0;
  const env = {};
  if (minimum !== undefined) env.CREWAID_MIN_FREE_GIB = minimum;
  if (databaseUrl !== null) env.DATABASE_URL = databaseUrl;
  const code = executeGate({
    cwd: process.cwd(),
    env,
    freeGib,
    platform,
    output: capture,
    spawn(command, args) {
      lines.push(`SPAWN ${command} ${args.join(' ')}`);
      if (spawnError && command === spawnError)
        return { error: new Error(`spawnSync ${command} ENOENT`) };
      return { status: 0 };
    },
  });
  return { code, lines };
}

test('threshold constants reflect the product ruling', () => {
  assert.equal(CRITICAL_FREE_GIB, 5);
  assert.equal(HARD_MIN_FREE_GIB, 15);
});

test('minimum defaults to the 5 GiB danger floor', () => {
  assert.equal(parseMinimumFreeGib(undefined), 5);
  assert.equal(parseMinimumFreeGib(''), 5);
});

for (const invalid of ['0', '-1', '4.99', 'NaN', 'Infinity', '-Infinity']) {
  test(`invalid minimum ${invalid} fails before any child process starts`, () => {
    const result = fakeGate({ minimum: invalid, freeGib: 1000 });
    assert.equal(result.code, 2);
    assert.ok(result.lines.every((line) => !line.startsWith('SPAWN')));
  });
}

test('below the danger floor refuses before any child process starts', () => {
  const result = fakeGate({ freeGib: 4.99 });
  assert.equal(result.code, 2);
  assert.ok(result.lines.every((line) => !line.startsWith('SPAWN')));
});

test('exactly at the danger floor still runs (strictly below refuses)', () => {
  const result = fakeGate({ freeGib: 5 });
  assert.equal(result.code, 0);
  assert.ok(result.lines.some((line) => line.startsWith('SPAWN')));
});

test('between danger and comfort thresholds runs with a warning', () => {
  const result = fakeGate({ freeGib: 12 });
  assert.equal(result.code, 0);
  assert.ok(result.lines.some((line) => line.startsWith('SPAWN')));
  assert.ok(
    result.lines.some((line) => line.startsWith('WARN') && line.includes('comfort threshold')),
  );
});

test('at or above the comfort threshold runs with no disk warning', () => {
  for (const freeGib of [15, 16]) {
    const result = fakeGate({ freeGib });
    assert.equal(result.code, 0);
    assert.ok(result.lines.some((line) => line.startsWith('SPAWN')));
    assert.ok(
      result.lines.every(
        (line) => !(line.startsWith('WARN') && line.includes('comfort threshold')),
      ),
    );
  }
});

test('a valid stricter override is accepted', () => {
  const result = fakeGate({ minimum: '20', freeGib: 20 });
  assert.equal(result.code, 0);
  assert.ok(result.lines.some((line) => line.startsWith('SPAWN')));
});

test('database mode orders generate, deploy, then tests', () => {
  const labels = buildSteps({ DATABASE_URL: 'postgresql://example.invalid/db' }).map(
    ([label]) => label,
  );
  assert.ok(labels.indexOf('Generate Prisma client') < labels.indexOf('Deploy migrations'));
  assert.ok(labels.indexOf('Deploy migrations') < labels.indexOf('Tests'));
});

test('no-database mode generates then tests without deploying', () => {
  const labels = buildSteps({}).map(([label]) => label);
  assert.ok(labels.indexOf('Generate Prisma client') < labels.indexOf('Tests'));
  assert.equal(labels.includes('Deploy migrations'), false);
});

test('without a database the gate refuses before any child process starts', () => {
  const result = fakeGate({ freeGib: 100, databaseUrl: null });
  assert.equal(result.code, 2);
  assert.ok(result.lines.every((line) => !line.startsWith('SPAWN')));
  assert.ok(result.lines.some((line) => line.startsWith('ERR') && line.includes('DATABASE_URL')));
});

test('e2e runs last, through the root script that rebuilds first', () => {
  const steps = buildSteps({ DATABASE_URL: 'postgresql://example.invalid/db' }, 'darwin');
  const last = steps.at(-1);
  assert.deepEqual(last.slice(0, 3), ['Electron e2e', 'pnpm', ['test:e2e']]);
  assert.ok(steps.findIndex(([label]) => label === 'Tests') < steps.length - 1);

  const result = fakeGate({ freeGib: 100 });
  assert.equal(result.code, 0);
  assert.equal(
    result.lines.filter((line) => line.startsWith('SPAWN')).at(-1),
    'SPAWN pnpm test:e2e',
  );
});

test('only a headless Linux box wraps e2e in Xvfb', () => {
  assert.equal(needsVirtualDisplay({}, 'linux'), true);
  assert.equal(needsVirtualDisplay({ DISPLAY: ':0' }, 'linux'), false);
  assert.equal(needsVirtualDisplay({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), false);
  assert.equal(needsVirtualDisplay({}, 'darwin'), false);

  const [, command, args] = buildSteps({}, 'linux').at(-1);
  assert.equal(command, 'xvfb-run');
  assert.deepEqual(args, ['--auto-servernum', 'pnpm', 'test:e2e']);
});

test('a missing xvfb-run fails the gate and says why', () => {
  const result = fakeGate({ freeGib: 100, platform: 'linux', spawnError: 'xvfb-run' });
  assert.equal(result.code, 1);
  assert.ok(
    result.lines.some(
      (line) => line.startsWith('ERR') && line.includes('Electron e2e') && line.includes('Xvfb'),
    ),
  );
});
