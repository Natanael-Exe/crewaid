import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKSPACE_MARKER_PROGRAM, RUNTIME_MARKER_PROGRAM } from './workspace-marker.js';

/**
 * Every case starts Python several times over, synchronously. Each start costs
 * about 250 ms on a hosted CI runner, so the first-runtime case (sixteen starts)
 * takes about four seconds there when it passes: too close to Vitest's
 * five-second default to be anything but flaky under a loaded runner.
 */
const PYTHON_CASE_TIMEOUT_MS = 30_000;

/**
 * The refusals these cases expect print Python tracebacks on stderr. Captured
 * rather than inherited, so CI logs show only real failures; `execFileSync`
 * still throws on a non-zero exit, which is what the cases assert.
 */
const QUIET = ['ignore', 'pipe', 'pipe'] as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'crewaid-retention-marker-'));
  dirs.push(dir);
  const marker = join(dir, '.crewaid-orphaned-at');
  const program = WORKSPACE_MARKER_PROGRAM.replace('/home/bot/.crewaid-orphaned-at', marker);
  return {
    dir,
    marker,
    run: (now: number, clear = false) =>
      execFileSync('python3', ['-c', program, String(now), clear ? 'clear' : 'mark'], {
        encoding: 'utf8',
        stdio: [...QUIET],
      })
        .trim()
        .replace(/^crewaid-retention:/, ''),
  };
}

describe('durable orphan marker', { timeout: PYTHON_CASE_TIMEOUT_MS }, () => {
  it('keeps the first observation across processes and resets after restore', () => {
    const f = fixture();
    expect(f.run(1000)).toBe('1000');
    expect(f.run(2000)).toBe('1000');
    expect(f.run(3000, true)).toBe('clear');
    expect(f.run(4000)).toBe('4000');
  });
  it('treats corruption or a future timestamp as a fresh grace period', () => {
    const f = fixture();
    for (const bad of ['garbage', '-1', '99999999', '']) {
      writeFileSync(f.marker, bad);
      expect(f.run(1000)).toBe('1000');
    }
  });
  it('refuses symlinks without changing the target', () => {
    const f = fixture();
    const target = join(f.dir, 'important');
    writeFileSync(target, 'keep');
    symlinkSync(target, f.marker);
    expect(() => f.run(1000)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });
});

describe('first-runtime marker', { timeout: PYTHON_CASE_TIMEOUT_MS }, () => {
  it('observes absence, preserves first creation, and rejects corrupt or substituted history', () => {
    const f = fixture();
    const program = RUNTIME_MARKER_PROGRAM.replace(
      '/home/bot/.crewaid-runtime-created-at',
      f.marker,
    );
    const run = (mode: string) =>
      execFileSync('python3', ['-I', '-c', program, '2000', mode], {
        encoding: 'utf8',
        stdio: [...QUIET],
      }).trim();
    expect(run('read')).toBe('crewaid-runtime:none');
    expect(run('write')).toBe('crewaid-runtime:2000');
    expect(run('read')).toBe('crewaid-runtime:2000');
    writeFileSync(f.marker, '1000');
    expect(run('write')).toBe('crewaid-runtime:1000');
    for (const bad of ['', 'garbage', '0', '-1', '3000']) {
      writeFileSync(f.marker, bad);
      expect(() => run('read')).toThrow();
      expect(() => run('write')).toThrow();
    }
    rmSync(f.marker);
    const target = join(f.dir, 'private');
    writeFileSync(target, '1000');
    symlinkSync(target, f.marker);
    expect(() => run('read')).toThrow();
    expect(() => run('write')).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('1000');
  });
});
