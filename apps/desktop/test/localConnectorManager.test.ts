import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalConnectorStore } from '../src/localConnectorStore';
import {
  createLocalConnectorManager,
  registerLocalConnectorIpc,
  type ConnectorWorkerHandle,
} from '../src/localConnectorManager';
import {
  detectLocalHarnesses,
  mergePathEntries,
  parseNullDelimitedEnv,
  resolveShellEnvironment,
} from '../src/shellEnvironment';
import type { SafeStorageLike } from '../src/tokenStore';

const SAMPLE_TOKEN = 'crw_conn_desktop_manager_secret_0123456789abcdef';
const ROTATED_TOKEN = 'crw_conn_desktop_rotated_secret_fedcba9876543210';

class FakeSafeStorage implements SafeStorageLike {
  available = true;
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(value: string): Buffer {
    return Buffer.from([...Buffer.from(value, 'utf8')].map((byte) => byte ^ 0x5a));
  }
  decryptString(value: Buffer): string {
    return Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString('utf8');
  }
}

interface MockWorker {
  readonly handle: ConnectorWorkerHandle;
  readonly sent: unknown[];
  killed: boolean;
  readonly emitMessage: (msg: unknown) => void;
  readonly emitExit: (code: number) => void;
}

function createMockWorker(): MockWorker {
  const sent: unknown[] = [];
  const messageListeners: Array<(msg: unknown) => void> = [];
  const exitListeners: Array<(code: number) => void> = [];
  const mock: MockWorker = {
    sent,
    killed: false,
    handle: {
      postMessage: (msg) => sent.push(msg),
      onMessage: (listener) => {
        messageListeners.push(listener);
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
      kill: () => {
        mock.killed = true;
        return true;
      },
    },
    emitMessage: (msg) => {
      for (const fn of messageListeners) fn(msg);
    },
    emitExit: (code) => {
      for (const fn of exitListeners) fn(code);
    },
  };
  return mock;
}

describe('shellEnvironment', () => {
  it('parses marker-delimited null env output ignoring shell profile banners', () => {
    const raw =
      'Welcome to zsh!\n__CREWAID_SHELL_ENV_START__PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/dev\0__CREWAID_SHELL_ENV_END__\n';
    expect(parseNullDelimitedEnv(raw)).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/dev',
    });
    expect(parseNullDelimitedEnv('no markers here')).toBeNull();
  });

  it('merges PATH without duplicates and strips CREWAID_CONNECTOR_TOKEN', () => {
    expect(
      mergePathEntries(
        '/usr/bin:/opt/homebrew/bin',
        ['/opt/homebrew/bin', '/usr/local/bin'],
        'darwin',
      ),
    ).toBe('/usr/bin:/opt/homebrew/bin:/usr/local/bin');
    const resolved = resolveShellEnvironment({
      platform: 'darwin',
      baseEnv: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
        CREWAID_CONNECTOR_TOKEN: SAMPLE_TOKEN,
      },
      runLoginShell: () =>
        '__CREWAID_SHELL_ENV_START__PATH=/custom/tools:/usr/bin\0__CREWAID_SHELL_ENV_END__',
    });
    expect(resolved['PATH']).toContain('/custom/tools');
    expect(resolved['CREWAID_CONNECTOR_TOKEN']).toBeUndefined();
  });

  it('detects installed harnesses from resolved PATH and returns OS-specific install commands', () => {
    const posix = detectLocalHarnesses({
      platform: 'darwin',
      env: { PATH: '/opt/homebrew/bin:/usr/bin' },
      isExecutable: (candidate) =>
        candidate === '/opt/homebrew/bin/claude-agent-acp' ||
        candidate === '/opt/homebrew/bin/opencode',
    });
    expect(posix.find((h) => h.id === 'claude-code')?.available).toBe(true);
    expect(posix.find((h) => h.id === 'opencode')?.available).toBe(true);
    expect(posix.find((h) => h.id === 'codex')).toMatchObject({
      available: false,
      installCommand: 'npm install -g @agentclientprotocol/codex-acp',
    });
    expect(posix.find((h) => h.id === 'antigravity')).toMatchObject({
      available: false,
      installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    });

    const win = detectLocalHarnesses({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32' },
      isExecutable: () => false,
    });
    expect(win.find((h) => h.id === 'antigravity')?.installCommand).toBe(
      'irm https://antigravity.google/cli/install.ps1 | iex',
    );
    expect(win.find((h) => h.id === 'opencode')?.installCommand).toBe('npm install -g opencode-ai');
  });
});

describe('createLocalConnectorStore + createLocalConnectorManager', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('encrypts connector tokens at rest with 0600 mode and never exposes them to renderer views', () => {
    const userDataPath = makeTempDir('crewaid-lc-store-');
    const repoDir = makeTempDir('crewaid-lc-repo-');
    const safeStorage = new FakeSafeStorage();
    const store = createLocalConnectorStore({ safeStorage, userDataPath });
    const workers: MockWorker[] = [];
    const prompts: unknown[] = [];

    const manager = createLocalConnectorManager({
      store,
      workerPath: '/fake/localConnectorWorker.cjs',
      appVersion: '0.1.6',
      forkWorker: () => {
        const w = createMockWorker();
        workers.push(w);
        return w.handle;
      },
      resolveEnv: () => ({ PATH: '/usr/bin' }),
      onPromptChanged: (p) => prompts.push(p),
    });

    const paired = manager.pair({
      connectorId: 'clconn000000000000000001',
      name: 'my-repo',
      directory: repoDir,
      serverUrl: 'https://crewaid.example',
      token: SAMPLE_TOKEN,
      reportMode: 'summary',
      confirmInApp: true,
    });
    expect(paired.status).toBe('ok');
    expect(JSON.stringify(paired)).not.toContain(SAMPLE_TOKEN);

    // Raw ciphertext on disk must not contain plaintext token
    const rawDisk = readFileSync(path.join(userDataPath, 'local-connectors.encrypted'), 'utf8');
    expect(rawDisk).not.toContain(SAMPLE_TOKEN);
    expect(statSync(path.join(userDataPath, 'local-connectors.encrypted')).mode & 0o777).toBe(
      0o600,
    );

    // Worker received start config with token over MessagePort
    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent[0]).toMatchObject({
      type: 'start',
      config: {
        connectorId: 'clconn000000000000000001',
        token: SAMPLE_TOKEN,
        reportMode: 'summary',
        confirmInApp: true,
      },
    });

    // Worker online + prompt roundtrip
    workers[0]!.emitMessage({ type: 'state', state: 'online', harnesses: ['claude-code'] });
    const listed = manager.list();
    expect(listed.status).toBe('ok');
    if (listed.status === 'ok') {
      expect(listed.connectors[0]?.state).toBe('online');
      expect(listed.connectors[0]?.harnesses).toEqual(['claude-code']);
      expect(JSON.stringify(listed)).not.toContain(SAMPLE_TOKEN);
    }

    workers[0]!.emitMessage({
      type: 'confirm_task',
      requestId: 'req-1',
      request: {
        botName: 'Atlas',
        workspaceName: 'my-repo',
        relativeCwd: '.',
        harness: 'claude-code',
        reportMode: 'summary',
        prompt: 'Fix tests',
      },
    });
    expect(manager.currentPrompt()?.requestId).toBe('req-1');
    // An answer of the wrong kind is refused and leaves the prompt waiting,
    // rather than dropping it and stranding the worker.
    expect(
      manager.respondPrompt({
        kind: 'request_permission',
        requestId: 'req-1',
        outcome: 'cancelled',
      }),
    ).toBe(false);
    expect(manager.currentPrompt()?.requestId).toBe('req-1');
    expect(
      manager.respondPrompt({ kind: 'confirm_task', requestId: 'req-1', approved: true }),
    ).toBe(true);
    expect(manager.currentPrompt()).toBeNull();
    expect(workers[0]!.sent.at(-1)).toEqual({
      type: 'confirm_response',
      requestId: 'req-1',
      approved: true,
    });

    // Rotate token seamlessly restarts worker with new token
    const rotated = manager.update({
      connectorId: 'clconn000000000000000001',
      token: ROTATED_TOKEN,
    });
    expect(rotated.status).toBe('ok');
    expect(workers).toHaveLength(2);
    expect(workers[0]!.killed).toBe(true);
    expect(workers[1]!.sent[0]).toMatchObject({
      type: 'start',
      config: { token: ROTATED_TOKEN },
    });

    // Pause stops worker and sets autoStart=false
    const paused = manager.pause('clconn000000000000000001');
    expect(paused.status).toBe('ok');
    expect(workers[1]!.killed).toBe(true);
    expect(manager.list()).toMatchObject({
      status: 'ok',
      connectors: [{ state: 'paused', autoStart: false }],
    });

    // Unpair removes encrypted entry cleanly
    expect(manager.unpair('clconn000000000000000001')).toEqual({ status: 'ok' });
    expect(manager.list()).toEqual({ status: 'ok', connectors: [] });
  });

  it('guards every local-connector IPC channel behind isTrustedSender', async () => {
    const userDataPath = makeTempDir('crewaid-lc-ipc-');
    const store = createLocalConnectorStore({
      safeStorage: new FakeSafeStorage(),
      userDataPath,
    });
    const manager = createLocalConnectorManager({
      store,
      workerPath: '/fake/localConnectorWorker.cjs',
      appVersion: '0.1.6',
      forkWorker: () => createMockWorker().handle,
      resolveEnv: () => ({ PATH: '/usr/bin' }),
    });

    const handlers = new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>();
    const pickFolder = vi.fn(() => Promise.resolve({ status: 'cancelled' as const }));
    registerLocalConnectorIpc({
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
      isTrustedSender: (evt) => evt === 'trusted',
      manager,
      pickFolder,
    });

    await expect(
      handlers.get('crewaid:local-connector:pick-folder')!('untrusted'),
    ).resolves.toEqual({
      status: 'error',
      code: 'UNAUTHORIZED',
    });
    expect(pickFolder).not.toHaveBeenCalled();

    await expect(handlers.get('crewaid:local-connector:list')!('untrusted')).resolves.toEqual({
      status: 'error',
      code: 'UNAUTHORIZED',
    });
    await expect(handlers.get('crewaid:local-connector:list')!('trusted')).resolves.toEqual({
      status: 'ok',
      connectors: [],
    });
  });
});
