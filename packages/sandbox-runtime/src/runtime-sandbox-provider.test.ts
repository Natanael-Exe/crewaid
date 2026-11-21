import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HarnessError,
  HarnessSandboxAuthenticationError,
  SANDBOX_PORTS,
} from '@crewaid/sandbox-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeRuntime } from './fake-runtime-api.js';
import {
  COMPUTER_LABEL,
  FIRST_START_LABEL,
  IMAGE_LABEL,
  IMAGE_REFUSED_LABEL,
  ORPHANED_AT_LABEL,
  RUNTIME_START_COMMAND,
  SCREEN_ACCESS_TTL_SECONDS,
  RuntimeSandboxProvider,
  sandboxNameFor,
} from './runtime-sandbox-provider.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = resolve(HERE, '../../../infra/sandbox-image/agent-bridge');
const IMAGE_DIR = resolve(HERE, '../../../infra/sandbox-image');

/** The version `crewaid-sandbox:test` names in every test, unless one moves it. */
const CURRENT_IMAGE = 'img-current';
// skip-reason: the end-to-end case runs the real bridge under python3;
// owner: sandbox-runtime. Present on every CI runner and dev machine.
const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;

const DAY = 24 * 60 * 60_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let fake: FakeRuntime;
let healthy: boolean;
let probes: string[];
let logged: string[];

function provider(
  overrides: { relaunchMs?: number; readyTimeoutMs?: number } = {},
): RuntimeSandboxProvider {
  return new RuntimeSandboxProvider({
    api: fake,
    image: 'crewaid-sandbox:test',
    readyTimeoutMs: overrides.readyTimeoutMs ?? 2_000,
    relaunchMs: overrides.relaunchMs ?? 300,
    bridgeProbe: (url) => {
      probes.push(url);
      return Promise.resolve(healthy);
    },
    log: (message) => logged.push(message),
  });
}

/** A provisioned computer: paused, labelled, never started, on the current image. */
function computer(id: string, labels: Record<string, string> = {}) {
  return fake.addMachine(sandboxNameFor(id), {
    labels: {
      [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
      [ORPHANED_AT_LABEL]: 'none',
      [IMAGE_LABEL]: CURRENT_IMAGE,
      ...labels,
    },
  });
}

beforeEach(() => {
  fake = new FakeRuntime();
  fake.images.set('crewaid-sandbox:test', {
    id: CURRENT_IMAGE,
    startArgv: [RUNTIME_START_COMMAND],
  });
  healthy = true;
  probes = [];
  logged = [];
});

afterEach(async () => {
  await fake.close();
});

describe('RuntimeSandboxProvider — lifecycle', () => {
  it('provisions a paused, labelled sandbox that Runtime keeps while paused', async () => {
    const p = provider();
    await p.provisionWorkspace({ botId: 'cmp1' });
    await p.provisionWorkspace({ botId: 'cmp1' });
    await p.provisionWorkspace({ botId: 'cmp2' });

    const machines = [...fake.machines.values()];
    expect(machines.map((m) => m.name).sort()).toEqual(['crewaid-cmp1', 'crewaid-cmp2']);
    expect(machines.every((m) => m.state === 'paused')).toBe(true);
    expect(machines.every((m) => m.keptWhilePaused)).toBe(true);
    // By the version the reference names, and labelled with it.
    expect(machines[0]?.spec).toMatchObject({
      image: CURRENT_IMAGE,
      vcpu: 4,
      memoryMiB: 8192,
      diskMiB: 20_480,
    });
    expect(machines.every((m) => m.labels[IMAGE_LABEL] === CURRENT_IMAGE)).toBe(true);
    // Provisioned is not started: no first-start record yet.
    expect(machines.every((m) => m.labels[FIRST_START_LABEL] === undefined)).toBe(true);
  });

  it('refuses to create a computer from an image Runtime does not have', async () => {
    fake.images.clear();
    await expect(provider().createSession({ sessionId: 'cmp1' })).rejects.toThrow(
      /no image crewaid-sandbox:test/,
    );
    expect(fake.machines.size).toBe(0);
  });

  it('refuses to hand out a sandbox Runtime might delete while paused', async () => {
    fake.failKeepWhilePaused = true;
    await expect(provider().provisionWorkspace({ botId: 'cmp1' })).rejects.toBeInstanceOf(
      HarnessError,
    );
    expect(fake.machines.size).toBe(0);
  });

  it('names the fix when the account has no credit to keep a paused sandbox', async () => {
    fake.withoutCredit = true;
    await expect(provider().provisionWorkspace({ botId: 'cmp1' })).rejects.toThrow(
      /only seven days on an account without credit.*Add credit/,
    );
    await expect(provider().createSession({ sessionId: 'cmp2' })).rejects.toThrow(/Add credit/);
    expect(fake.machines.size).toBe(0);
  });

  it('creates a fresh computer with its first start recorded, and waits for the bridge', async () => {
    const before = Date.now();
    const session = await provider().createSession({ sessionId: 'cmp1' });
    expect(session.containerId).toMatch(/^sbx-/);
    const machine = [...fake.machines.values()][0];
    expect(Number(machine?.labels[FIRST_START_LABEL])).toBeGreaterThanOrEqual(before);
    expect(probes.length).toBeGreaterThan(0);
  });

  it('refuses to create over an existing computer, or without its workspace', async () => {
    computer('cmp1');
    const p = provider();
    await expect(p.createSession({ sessionId: 'cmp1' })).rejects.toThrow(/already exists/);
    await expect(
      p.createSession({ sessionId: 'cmp2', requireExistingWorkspace: true }),
    ).rejects.toThrow(/workspace is missing/);
    expect(fake.calls).not.toContain('create');
  });

  it('deletes a fresh sandbox whose desktop never comes up', async () => {
    healthy = false;
    await expect(
      provider({ readyTimeoutMs: 400, relaunchMs: 100 }).createSession({ sessionId: 'cmp1' }),
    ).rejects.toThrow(/did not report healthy/);
    expect(fake.machines.size).toBe(0);
  });

  it('leaves the computer paused if the release image cannot be resolved', async () => {
    const machine = computer('cmp1');
    fake.images.clear();
    await expect(provider().resumeSession({ sessionId: 'cmp1' })).rejects.toThrow(/no image/);
    expect(machine.state).toBe('paused');
    expect(fake.calls).not.toContain('wake');
  });

  it('wakes a paused computer, records its first start once, and clears its orphan clock', async () => {
    const machine = computer('cmp1', { [ORPHANED_AT_LABEL]: '123' });
    const p = provider();
    await p.resumeSession({ sessionId: 'cmp1' });
    expect(machine.state).toBe('running');
    expect(machine.labels[ORPHANED_AT_LABEL]).toBe('none');
    const first = machine.labels[FIRST_START_LABEL];
    expect(first).toMatch(/^\d+$/);

    await p.attachSession({ sessionId: 'cmp1' }).then((s) => s?.stop());
    await p.resumeSession({ sessionId: 'cmp1' });
    expect(machine.labels[FIRST_START_LABEL]).toBe(first);
    // A healthy desktop needs no launcher.
    expect(fake.execs).toEqual([]);
  });

  it('launches the desktop as root when the bridge is silent after a wake', async () => {
    const machine = computer('cmp1');
    healthy = false;
    fake.onLaunch = () => {
      healthy = true;
    };
    await provider().resumeSession({ sessionId: 'cmp1' });
    expect(machine.state).toBe('running');
    expect(fake.execs.map((e) => e.argv)).toEqual([
      ['sudo', '-n', '/usr/local/bin/crewaid-desktop-up'],
    ]);
    // A restart would drop memory and still not start the desktop.
    expect(fake.calls).not.toContain('restart');
  });

  it('pauses the computer after its bridge readiness deadline', async () => {
    const machine = computer('cmp1');
    healthy = false;
    await expect(
      provider({ readyTimeoutMs: 700, relaunchMs: 200 }).resumeSession({ sessionId: 'cmp1' }),
    ).rejects.toThrow(/did not report healthy within 700ms/);
    expect(fake.execs.length).toBeGreaterThanOrEqual(3);
    expect(machine.state).toBe('paused');
  });

  it('reports the failed wake, not the pause that followed it', async () => {
    computer('cmp1');
    healthy = false;
    vi.spyOn(fake, 'pause').mockRejectedValueOnce(new Error('pause refused'));
    await expect(
      provider({ readyTimeoutMs: 700, relaunchMs: 200 }).resumeSession({ sessionId: 'cmp1' }),
    ).rejects.toThrow(/did not report healthy within 700ms/);
    expect(logged.some((line) => line.includes('could not pause after a failed wake'))).toBe(true);
  });

  it('fails fast, with its output, when the launcher itself fails', async () => {
    computer('cmp1');
    healthy = false;
    fake.execHandler = () => ({ exitCode: 1, stdout: '', stderr: 'sudo: a password is required' });
    await expect(provider().resumeSession({ sessionId: 'cmp1' })).rejects.toThrow(
      /desktop launcher failed \(exit 1\): sudo: a password is required/,
    );
  });

  it('starts a sandbox Runtime stopped from its disk, and launches its desktop', async () => {
    // Runtime stops a sandbox itself when credit or a spending limit runs out,
    // and a restart from disk comes up without the start command.
    const machine = computer('cmp1');
    machine.state = 'stopped';
    healthy = false;
    fake.onLaunch = () => {
      healthy = true;
    };
    await provider().resumeSession({ sessionId: 'cmp1' });
    expect(machine.state).toBe('running');
    expect(fake.calls).toContain('restart');
    expect(fake.execs).toHaveLength(1);
  });

  it('stop and destroy pause — neither ever deletes the sandbox', async () => {
    const machine = computer('cmp1');
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    await session.stop();
    expect(machine.state).toBe('paused');
    await p.resumeSession({ sessionId: 'cmp1' });
    await session.destroy();
    expect(machine.state).toBe('paused');
    expect(fake.calls).not.toContain('delete');
  });

  it('shares a running computer’s port privately, as a WebSocket address (D-223)', async () => {
    const machine = computer('cmp1');
    const p = provider();
    await p.resumeSession({ sessionId: 'cmp1' });
    const access = await p.screenAccess({ sessionId: 'cmp1', port: 7071 });
    const url = new URL(access.url);
    expect(url.protocol).toBe('wss:');
    // The token rides in the query, where a browser's WebSocket can carry it.
    expect(url.searchParams.get('runtime_preview_token')).toBe(`t-${SCREEN_ACCESS_TTL_SECONDS}`);
    expect(access.expiresAt).toBeGreaterThan(Date.now());
    expect(fake.shared.get(machine.id)).toEqual(new Set([7071]));
  });

  it('refuses screen access to a computer that is not running, sharing nothing', async () => {
    const machine = computer('cmp1');
    const p = provider();
    // A preview visit wakes a paused sandbox: a viewer must never be the reason.
    await expect(p.screenAccess({ sessionId: 'cmp1', port: 7071 })).rejects.toThrow(/not running/);
    expect(fake.shared.has(machine.id)).toBe(false);
  });

  it('unshares every port before a computer pauses, so no stale link can wake it', async () => {
    const machine = computer('cmp1');
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    await p.screenAccess({ sessionId: 'cmp1', port: 7071 });
    await session.stop();
    expect(fake.shared.has(machine.id)).toBe(false);
    expect(fake.calls.lastIndexOf('unshareAllPorts')).toBeLessThan(fake.calls.lastIndexOf('pause'));
    expect(machine.state).toBe('paused');
  });

  it('still pauses when unsharing fails', async () => {
    const machine = computer('cmp1');
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    fake.unshareAllPorts = () => Promise.reject(new Error('Runtime is having a moment'));
    await session.stop();
    expect(machine.state).toBe('paused');
  });

  it('waits for a pending preview before unsharing and pausing', async () => {
    const machine = computer('cmp1');
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    const entered = deferred<void>();
    const finish = deferred<void>();
    const share = fake.sharePort;
    fake.sharePort = async (...args) => {
      entered.resolve();
      await finish.promise;
      return share(...args);
    };
    const access = p.screenAccess({ sessionId: 'cmp1', port: 7071 });
    await entered.promise;
    const stopped = session.stop();
    finish.resolve();
    await access;
    await stopped;
    expect(machine.state).toBe('paused');
    expect(fake.shared.has(machine.id)).toBe(false);
    expect(fake.calls.lastIndexOf('sharePort')).toBeLessThan(
      fake.calls.lastIndexOf('unshareAllPorts'),
    );
  });

  it('refuses a grant queued while stop is removing previews', async () => {
    const machine = computer('cmp1');
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    const entered = deferred<void>();
    const finish = deferred<void>();
    const unshare = fake.unshareAllPorts;
    fake.unshareAllPorts = async (...args) => {
      entered.resolve();
      await finish.promise;
      return unshare(...args);
    };
    const stopped = session.stop();
    await entered.promise;
    // The provider's initial lookup still sees running; the queued check must
    // reject after stop completes instead of creating a new preview.
    const access = expect(p.screenAccess({ sessionId: 'cmp1', port: 7071 })).rejects.toThrow(
      /not running/,
    );
    finish.resolve();
    await stopped;
    await access;
    expect(machine.state).toBe('paused');
    expect(fake.shared.has(machine.id)).toBe(false);
    expect(fake.calls).not.toContain('sharePort');
  });

  it('reuses a screen share while its token lasts, asking Runtime only whether it runs', async () => {
    computer('cmp1');
    const p = provider();
    await p.resumeSession({ sessionId: 'cmp1' });
    const first = await p.screenAccess({ sessionId: 'cmp1', port: 7071 });
    const before = fake.calls.length;
    const second = await p.screenAccess({ sessionId: 'cmp1', port: 7071 });
    expect(second).toEqual(first);
    // One lookup — the running check — and no recheck, SDK lookup or create.
    expect(fake.calls.slice(before)).toEqual(['findByName']);
  });

  it('still refuses a reused share once Runtime says the computer is not running', async () => {
    const machine = computer('cmp1');
    const p = provider();
    await p.resumeSession({ sessionId: 'cmp1' });
    await p.screenAccess({ sessionId: 'cmp1', port: 7071 });
    // Paused behind the provider's back, so no stop cleared the share.
    machine.state = 'paused';
    await expect(p.screenAccess({ sessionId: 'cmp1', port: 7071 })).rejects.toThrow(/not running/);
  });

  it('shares afresh once the token has less than a ticket’s life left', async () => {
    computer('cmp1');
    const p = provider();
    await p.resumeSession({ sessionId: 'cmp1' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = await p.screenAccess({ sessionId: 'cmp1', port: 7071 });
      vi.setSystemTime(first.expiresAt - 59_000);
      const second = await p.screenAccess({ sessionId: 'cmp1', port: 7071 });
      expect(fake.calls.filter((call) => call === 'sharePort')).toHaveLength(2);
      expect(second.expiresAt - Date.now()).toBe(SCREEN_ACCESS_TTL_SECONDS * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the share when the computer stops, so the next start shares afresh', async () => {
    computer('cmp1');
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    await p.screenAccess({ sessionId: 'cmp1', port: 7071 });
    await session.stop();
    await p.resumeSession({ sessionId: 'cmp1' });
    await p.screenAccess({ sessionId: 'cmp1', port: 7071 });
    // The stop deleted the first preview; reusing its token would answer 404.
    expect(fake.calls.filter((call) => call === 'sharePort')).toHaveLength(2);
  });

  it('still stops after a failed preview creation', async () => {
    const machine = computer('cmp1');
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    fake.sharePort = () => Promise.reject(new Error('preview unavailable'));
    await expect(p.screenAccess({ sessionId: 'cmp1', port: 7071 })).rejects.toThrow(
      /preview unavailable/,
    );
    await session.stop();
    expect(machine.state).toBe('paused');
  });

  it('orphan cleanup pauses a computer and refuses a sandbox that is not one', async () => {
    const machine = computer('cmp1', {});
    machine.state = 'running';
    const stranger = fake.addMachine('someone-else', { state: 'running', labels: {} });
    const p = provider();
    await p.removeManagedSession({ containerId: machine.id });
    expect(machine.state).toBe('paused');
    await expect(p.removeManagedSession({ containerId: stranger.id })).rejects.toThrow(
      /not a Crewaid computer/,
    );
    expect(stranger.state).toBe('running');
    await expect(p.removeManagedSession({ containerId: 'gone' })).resolves.toBeUndefined();
  });

  it('maps a refused key to the harness authentication error', async () => {
    fake.refuseWith = 401;
    await expect(provider().resumeSession({ sessionId: 'cmp1' })).rejects.toBeInstanceOf(
      HarnessSandboxAuthenticationError,
    );
  });
});

describe('RuntimeSandboxProvider — inventory and health', () => {
  it('lists only its own computers: labelled and named', async () => {
    computer('cmp1');
    computer('cmp2').state = 'running';
    fake.addMachine('crewaid-unlabelled', { labels: {} });
    fake.addMachine('other', { labels: { [COMPUTER_LABEL.key]: COMPUTER_LABEL.value } });
    const p = provider();
    const listed = await p.listManagedSessions();
    expect(listed.map((s) => [s.sessionId, s.running]).sort()).toEqual([
      ['cmp1', false],
      ['cmp2', true],
    ]);
    expect((await p.listWorkspaces()).map((w) => w.botId).sort()).toEqual(['cmp1', 'cmp2']);
  });

  it('answers health as a value: missing, paused, or serving', async () => {
    const p = provider();
    expect(await p.checkHealth({ sessionId: 'cmp1' })).toMatchObject({ ok: false });
    const machine = computer('cmp1');
    expect(await p.checkHealth({ sessionId: 'cmp1' })).toEqual({
      ok: false,
      reason: `sandbox ${machine.id} is paused`,
    });
    machine.state = 'running';
    expect(await p.checkHealth({ sessionId: 'cmp1' })).toEqual({ ok: true });
    healthy = false;
    expect(await p.checkHealth({ sessionId: 'cmp1' })).toMatchObject({ ok: false });
  });

  it('reads workspace history from labels, never from the machine', async () => {
    const p = provider();
    computer('fresh');
    computer('used', { [FIRST_START_LABEL]: '1700000000000' }).state = 'running';
    computer('idle', { [FIRST_START_LABEL]: '1700000000001' });
    expect(await p.inspectWorkspaceHistory({ botId: 'fresh' })).toEqual({
      referenced: false,
      runtimeCreatedAt: null,
    });
    expect(await p.inspectWorkspaceHistory({ botId: 'used' })).toEqual({
      referenced: true,
      runtimeCreatedAt: 1_700_000_000_000,
    });
    expect(await p.inspectWorkspaceHistory({ botId: 'idle' })).toEqual({
      referenced: false,
      runtimeCreatedAt: 1_700_000_000_001,
    });
    await expect(p.inspectWorkspaceHistory({ botId: 'gone' })).rejects.toThrow(/missing/);
    expect(fake.execs).toEqual([]);
    expect(fake.machines.get(fake.machines.keys().next().value ?? '')?.state).toBe('paused');
  });

  it('retires a bot profile as the sandbox user, and leaves a paused computer paused', async () => {
    const machine = computer('cmp1');
    await provider().retireBotProfile({ computerId: 'cmp1', botId: 'bot_1' });
    expect(fake.execs).toEqual([
      {
        machineId: machine.id,
        argv: ['python3', '/opt/agent-bridge/profiles.py', 'retire', 'bot_1'],
      },
    ]);
    expect(machine.state).toBe('paused');
    await expect(
      provider().retireBotProfile({ computerId: 'cmp1', botId: '../x' }),
    ).rejects.toThrow(/Invalid bot profile/);
  });
});

/** The prepare step's exec, among a computer's execs. */
const prepares = () =>
  fake.execs.filter((e) => e.argv[0] === 'sudo' && (e.argv[4] ?? '').includes('mountpoint'));

describe('RuntimeSandboxProvider — following the image (D-219)', () => {
  /** A computer from before the current release: its home still on the image's disk. */
  function oldComputer(id: string, labels: Record<string, string> = {}) {
    return computer(id, { [IMAGE_LABEL]: 'img-old', ...labels });
  }

  it('switches a computer that starts from paused, after preparing its home', async () => {
    const machine = oldComputer('cmp1');
    fake.execHandler = () => ({ exitCode: 0, stdout: 'copied\n', stderr: '' });
    await provider().resumeSession({ sessionId: 'cmp1' });

    expect(fake.switches).toEqual([{ machineId: machine.id, imageId: CURRENT_IMAGE }]);
    expect(machine.labels[IMAGE_LABEL]).toBe(CURRENT_IMAGE);
    expect(machine.state).toBe('running');
    // Prepared as root, before the switch: Chrome closed, an old home copied
    // where the switch keeps it, and the disk flushed.
    const [prepare] = prepares();
    expect(prepare?.argv.slice(0, 4)).toEqual(['sudo', '-n', 'sh', '-c']);
    expect(prepare?.argv[4]).toMatch(/pkill -TERM -u bot -x chrome/);
    expect(prepare?.argv[4]).toMatch(/cp -a "\$home\/\." "\$kept\.next\/"/);
    expect(prepare?.argv[4]).toMatch(/sync$/);
    expect(fake.calls.lastIndexOf('exec')).toBeLessThan(fake.calls.indexOf('switchImage'));
    expect(probes.length).toBeGreaterThan(0);
    expect(logged).toEqual([]);
  });

  it('starts a sandbox Runtime stopped, then switches it', async () => {
    const machine = oldComputer('cmp1');
    machine.state = 'stopped';
    await provider().resumeSession({ sessionId: 'cmp1' });
    expect(fake.calls.indexOf('restart')).toBeLessThan(fake.calls.indexOf('switchImage'));
    expect(machine.labels[IMAGE_LABEL]).toBe(CURRENT_IMAGE);
  });

  it('never switches a computer that is already running', async () => {
    const machine = oldComputer('cmp1');
    machine.state = 'running';
    await provider().resumeSession({ sessionId: 'cmp1' });
    expect(fake.switches).toEqual([]);
    expect(prepares()).toEqual([]);
    expect(machine.labels[IMAGE_LABEL]).toBe('img-old');
  });

  it('leaves a computer on the current version alone', async () => {
    computer('cmp1');
    await provider().resumeSession({ sessionId: 'cmp1' });
    expect(fake.switches).toEqual([]);
    expect(fake.calls).not.toContain('exec');
  });

  it('never switches to an image that would leave the home behind', async () => {
    fake.images.set('crewaid-sandbox:test', {
      id: CURRENT_IMAGE,
      startArgv: ['/usr/local/bin/entrypoint.sh'],
    });
    const machine = oldComputer('cmp1');
    await provider().resumeSession({ sessionId: 'cmp1' });
    expect(fake.switches).toEqual([]);
    expect(prepares()).toEqual([]);
    expect(machine.labels[IMAGE_LABEL]).toBe('img-old');
    expect(logged.join()).toMatch(/stays on its image.*does not start with/);
  });

  it('starts on its old image when preparing fails, and tries again next time', async () => {
    const machine = oldComputer('cmp1');
    fake.execHandler = () => ({ exitCode: 1, stdout: '', stderr: 'cp: No space left on device' });
    await provider().resumeSession({ sessionId: 'cmp1' });
    expect(fake.switches).toEqual([]);
    expect(machine.state).toBe('running');
    expect(logged.join()).toMatch(/preparing the switch failed \(exit 1\): cp: No space/);
    expect(machine.labels[IMAGE_REFUSED_LABEL]).toBeUndefined();
  });

  it('starts on its old image when Runtime refuses, and does not retry that version', async () => {
    const machine = oldComputer('cmp1');
    fake.refuseSwitchWith = 'switch_undone';
    fake.execHandler = () => ({ exitCode: 0, stdout: 'copied\n', stderr: '' });
    const p = provider();
    await p.resumeSession({ sessionId: 'cmp1' });

    expect(machine.labels[IMAGE_LABEL]).toBe('img-old');
    expect(machine.labels[IMAGE_REFUSED_LABEL]).toBe(CURRENT_IMAGE);
    expect(machine.state).toBe('running');
    expect(logged.join()).toMatch(/refused the switch.*switch_undone/);
    // The copy made for it would only fill the old image's disk.
    expect(fake.execs.map((e) => e.argv)).toContainEqual([
      'sudo',
      '-n',
      'rm',
      '-rf',
      '/workspace/.crewaid-home',
    ]);

    fake.execs.length = 0;
    await p.attachSession({ sessionId: 'cmp1' }).then((s) => s?.stop());
    await p.resumeSession({ sessionId: 'cmp1' });
    expect(prepares()).toEqual([]);
  });

  it('keeps a home already in /workspace when a switch is refused', async () => {
    oldComputer('cmp1');
    fake.refuseSwitchWith = 'switch_undone';
    // Nothing was copied: the home was already bound from /workspace.
    await provider().resumeSession({ sessionId: 'cmp1' });
    expect(fake.execs.map((e) => e.argv[2])).not.toContain('rm');
  });

  it('tries the next release after a refused one', async () => {
    const machine = oldComputer('cmp1', { [IMAGE_REFUSED_LABEL]: CURRENT_IMAGE });
    fake.images.set('crewaid-sandbox:test', {
      id: 'img-next',
      startArgv: [RUNTIME_START_COMMAND],
    });
    await provider().resumeSession({ sessionId: 'cmp1' });
    expect(fake.switches).toEqual([{ machineId: machine.id, imageId: 'img-next' }]);
    expect(machine.labels[IMAGE_LABEL]).toBe('img-next');
    expect(machine.labels[IMAGE_REFUSED_LABEL]).toBeUndefined();
  });

  it('fails the start on an API fault outside the switch itself', async () => {
    oldComputer('cmp1');
    fake.refuseSwitchWith = 'internal';
    await expect(provider().resumeSession({ sessionId: 'cmp1' })).rejects.toThrow(
      /internal|undone/,
    );
  });

  it('gives every image the start command a switch requires', () => {
    // build-image.mjs names it, and the image installs it executable.
    const script = readFileSync(resolve(HERE, '../scripts/build-image.mjs'), 'utf8');
    expect(script).toContain(`const START_COMMAND = '${RUNTIME_START_COMMAND}';`);
    expect(script).toMatch(/argv: \[START_COMMAND\]/);
    const dockerfile = readFileSync(resolve(IMAGE_DIR, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      `COPY infra/sandbox-image/crewaid-runtime-start ${RUNTIME_START_COMMAND}`,
    );
    for (const name of ['crewaid-runtime-start', 'crewaid-home-on-workspace']) {
      expect(statSync(resolve(IMAGE_DIR, name)).mode & 0o111).not.toBe(0);
    }
  });
});

describe('RuntimeSandboxProvider — retention', () => {
  const retentionMs = 7 * DAY;

  it('keeps a computer that is not orphaned, clearing any old clock', async () => {
    const machine = computer('cmp1', { [ORPHANED_AT_LABEL]: '5' });
    const p = provider();
    await expect(
      p.retainWorkspace({ botId: 'cmp1', orphaned: false, now: 10, retentionMs }),
    ).resolves.toBe('retained');
    expect(machine.labels[ORPHANED_AT_LABEL]).toBe('none');
    expect(await p.retainWorkspace({ botId: 'gone', orphaned: true, now: 10, retentionMs })).toBe(
      'absent',
    );
  });

  it('starts an orphan clock in a label, then deletes once it runs out — never waking it', async () => {
    const machine = computer('cmp1');
    const p = provider();
    const t0 = 1_000_000;
    expect(await p.retainWorkspace({ botId: 'cmp1', orphaned: true, now: t0, retentionMs })).toBe(
      'retained',
    );
    expect(machine.labels[ORPHANED_AT_LABEL]).toBe(String(t0));
    // A later sweep, or another orchestrator process, reads the same clock.
    expect(
      await provider().retainWorkspace({
        botId: 'cmp1',
        orphaned: true,
        now: t0 + retentionMs - 1,
        retentionMs,
      }),
    ).toBe('retained');
    expect(machine.labels[ORPHANED_AT_LABEL]).toBe(String(t0));
    expect(machine.state).toBe('paused');
    expect(fake.calls).not.toContain('exec');
    expect(fake.calls).not.toContain('wake');

    expect(
      await p.retainWorkspace({
        botId: 'cmp1',
        orphaned: true,
        now: t0 + retentionMs,
        retentionMs,
      }),
    ).toBe('deleted');
    expect(fake.machines.size).toBe(0);
  });

  it('treats a running orphan as in use, and never deletes it', async () => {
    const machine = computer('cmp1', { [ORPHANED_AT_LABEL]: '1' });
    machine.state = 'running';
    expect(
      await provider().retainWorkspace({
        botId: 'cmp1',
        orphaned: true,
        now: 10 * DAY,
        retentionMs,
      }),
    ).toBe('in-use');
    expect(fake.machines.size).toBe(1);
  });
});

describe('RuntimeSandboxProvider — ports through the tunnel', () => {
  let echo: Server;

  beforeAll(async () => {
    echo = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  });

  afterAll(() => new Promise<void>((r) => echo.close(() => r())));

  it('relays bytes both ways through a loopback endpoint, byte for byte', async () => {
    computer('cmp1');
    fake.ports.set(SANDBOX_PORTS.rfb, (echo.address() as AddressInfo).port);
    const session = await provider().resumeSession({ sessionId: 'cmp1' });
    const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.rfb });
    expect(endpoint.headers).toBeUndefined();

    const { hostname, port } = new URL(endpoint.url);
    const payload = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 256));
    const received = await new Promise<Buffer>((resolveBytes, reject) => {
      const socket = connect(Number(port), hostname, () => socket.write(payload));
      const chunks: Buffer[] = [];
      let length = 0;
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        length += chunk.length;
        if (length >= payload.length) {
          socket.end();
          resolveBytes(Buffer.concat(chunks));
        }
      });
      socket.on('error', reject);
    });
    expect(received.equals(payload)).toBe(true);
  });

  it('opens one tunnel per computer, shared by every port', async () => {
    computer('cmp1');
    const session = await provider().resumeSession({ sessionId: 'cmp1' });
    await session.getPortEndpoint({ port: SANDBOX_PORTS.rfb });
    await session.getPortEndpoint({ port: SANDBOX_PORTS.cdp });
    expect(fake.calls.filter((c) => c === 'openTunnel')).toHaveLength(1);
  });

  it('closes live connections when the computer pauses under them', async () => {
    const guestClosed = new Promise<void>((resolveClosed) => {
      echo.once('connection', (guest) => guest.once('close', () => resolveClosed()));
    });
    computer('cmp1');
    fake.ports.set(SANDBOX_PORTS.rfb, (echo.address() as AddressInfo).port);
    const session = await provider().resumeSession({ sessionId: 'cmp1' });
    const { hostname, port } = new URL(
      (await session.getPortEndpoint({ port: SANDBOX_PORTS.rfb })).url,
    );
    const client = connect(Number(port), hostname);
    client.on('error', () => undefined);
    await new Promise<void>((r) => {
      client.once('data', () => r());
      client.write('ping');
    });
    await session.stop();
    await expect(
      Promise.race([
        guestClosed.then(() => 'closed'),
        new Promise((r) => setTimeout(() => r('still open'), 2_000)),
      ]),
    ).resolves.toBe('closed');
    client.destroy();
  });

  it('stops serving ports once the computer is paused, and serves again after a wake', async () => {
    computer('cmp1');
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    await session.stop();
    await expect(session.getPortEndpoint({ port: SANDBOX_PORTS.rfb })).rejects.toBeInstanceOf(
      HarnessError,
    );
    const again = await p.resumeSession({ sessionId: 'cmp1' });
    await expect(again.getPortEndpoint({ port: SANDBOX_PORTS.rfb })).resolves.toMatchObject({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) as unknown,
    });
  });
});

describe.skipIf(!HAS_PYTHON)('RuntimeSandboxProvider — file I/O end to end', () => {
  let bridge: ChildProcess;
  let bridgePort: number;

  beforeAll(async () => {
    bridge = spawn(
      'python3',
      [
        '-c',
        [
          'import sys',
          `sys.path.insert(0, ${JSON.stringify(BRIDGE_DIR)})`,
          'import bridge',
          'from http.server import ThreadingHTTPServer',
          "server = ThreadingHTTPServer(('127.0.0.1', 0), bridge.BridgeHandler)",
          'print(server.server_address[1], flush=True)',
          'server.serve_forever()',
        ].join('\n'),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    bridgePort = await new Promise<number>((resolvePort, reject) => {
      bridge.stdout?.once('data', (chunk: Buffer) => resolvePort(Number(chunk.toString().trim())));
      bridge.once('exit', (code) => reject(new Error(`bridge exited early (${code})`)));
    });
  });

  afterAll(() => {
    bridge?.kill('SIGKILL');
  });

  it('writes and reads a file through provider, tunnel and bridge', async () => {
    computer('cmp1');
    fake.ports.set(SANDBOX_PORTS.bridge, bridgePort);
    const session = await provider().resumeSession({ sessionId: 'cmp1' });
    const dir = spawnSync('mktemp', ['-d']).stdout.toString().trim();
    const path = `${dir}/sub/it's a file.bin`;
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 10]);
    await session.writeBinaryFile({ path, content: bytes });
    const back = await session.readBinaryFile({ path });
    expect(back === null ? null : Array.from(back)).toEqual(Array.from(bytes));
    const run = await session.run({
      command: 'printf "%s" "$X"',
      env: { X: 'y' },
      workingDirectory: '/',
    });
    expect(run).toEqual({ exitCode: 0, stdout: 'y', stderr: '' });
    spawnSync('rm', ['-rf', dir]);
  });
});
