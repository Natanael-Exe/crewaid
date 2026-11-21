import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKSPACE_TRANSFER_SERVER, transferWorkspaceArchive } from './workspace-transfer.js';

let root: string;
let processes: ChildProcess[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crewaid-transfer-test-'));
  processes = [];
});
afterEach(async () => {
  for (const process of processes) process.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
});

async function server(mode: 'send' | 'receive', path: string, token = 'test-capability') {
  const ready = join(root, `${mode}-${processes.length}.port`);
  const process = spawn(
    'python3',
    ['-u', '-c', WORKSPACE_TRANSFER_SERVER, mode, token, ready, path],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  processes.push(process);
  let errors = '';
  process.stderr?.on('data', (chunk) => {
    errors += String(chunk);
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Transfer helper exited: ${errors}`);
    try {
      const port = Number(await readFile(ready, 'utf8'));
      if (port > 0) return { host: '127.0.0.1', port };
    } catch {
      /* The helper has not published its listening port yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Transfer helper did not listen: ${errors}`);
}

/**
 * Larger than two of the protocol's 256 KiB frames, so the copy only passes
 * if a file split across several frames is put back together whole.
 */
const SPANNING_FILE = Buffer.alloc(600 * 1024, 0xad);

async function fixture() {
  const source = join(root, 'source');
  await mkdir(join(source, 'home/bot/.chrome/Profile'), { recursive: true });
  await mkdir(join(source, 'workspace/.crewaid-home'), { recursive: true });
  await writeFile(join(source, 'home/bot/.chrome/Profile/Cookies'), 'browser-session', {
    mode: 0o600,
  });
  await writeFile(join(source, 'workspace/.crewaid-home/duplicate'), 'must-not-copy-twice');
  await writeFile(join(source, 'workspace/work ü.bin'), SPANNING_FILE);
  await symlink('/outside/the/workspace', join(source, 'home/bot/external-link'));
  return source;
}

describe('the real guest archive protocol', () => {
  it('streams binary files, hidden profiles, modes and symlinks, excluding the duplicated bound home', async () => {
    const source = await fixture();
    const destination = join(root, 'destination');
    const [from, to] = await Promise.all([server('send', source), server('receive', destination)]);
    await transferWorkspaceArchive(from, to, 'test-capability', AbortSignal.timeout(10_000));
    expect(await readFile(join(destination, 'home/bot/.chrome/Profile/Cookies'), 'utf8')).toBe(
      'browser-session',
    );
    expect((await stat(join(destination, 'home/bot/.chrome/Profile/Cookies'))).mode & 0o777).toBe(
      0o600,
    );
    // `Buffer.equals`, not `toEqual`: a deep equality walks the file a byte at
    // a time, which at 2 MiB outlasted the test's timeout on a loaded runner.
    const copied = await readFile(join(destination, 'workspace/work ü.bin'));
    expect(copied.equals(SPANNING_FILE)).toBe(true);
    expect(await readlink(join(destination, 'home/bot/external-link'))).toBe(
      '/outside/the/workspace',
    );
    await expect(stat(join(destination, 'workspace/.crewaid-home'))).rejects.toThrow();
    // The source remains the backup, including data intentionally excluded from transfer.
    expect(await readFile(join(source, 'workspace/.crewaid-home/duplicate'), 'utf8')).toBe(
      'must-not-copy-twice',
    );
  });

  it('rejects a failed source archive even when extraction received some valid files', async () => {
    const source = await fixture();
    await rm(join(source, 'workspace'), { recursive: true });
    const [from, to] = await Promise.all([
      server('send', source),
      server('receive', join(root, 'destination')),
    ]);
    await expect(
      transferWorkspaceArchive(from, to, 'test-capability', AbortSignal.timeout(10_000)),
    ).rejects.toThrow('integrity or extraction');
  });

  it('refuses a transfer with the wrong capability and closes both connections', async () => {
    const source = await fixture();
    const [from, to] = await Promise.all([
      server('send', source),
      server('receive', join(root, 'destination')),
    ]);
    await expect(
      transferWorkspaceArchive(from, to, 'wrong-capability', AbortSignal.timeout(2000)),
    ).rejects.toThrow();
  });

  it('aborts an in-flight transfer without modifying its source', async () => {
    const source = await fixture();
    const [from, to] = await Promise.all([
      server('send', source),
      server('receive', join(root, 'destination')),
    ]);
    const controller = new AbortController();
    controller.abort(new Error('lifecycle lease lost'));
    await expect(
      transferWorkspaceArchive(from, to, 'test-capability', controller.signal),
    ).rejects.toThrow();
    expect(await readFile(join(source, 'home/bot/.chrome/Profile/Cookies'), 'utf8')).toBe(
      'browser-session',
    );
  });
});
