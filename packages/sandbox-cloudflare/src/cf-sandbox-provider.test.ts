import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, connect, type AddressInfo, type Server } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HarnessError,
  HarnessSandboxAuthenticationError,
  SANDBOX_PORTS,
} from '@crewaid/sandbox-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CloudflareControl, CloudflareControlError } from './cf-control.js';
import { CloudflareSandboxProvider } from './cf-sandbox-provider.js';
import { FAKE_SECRET, FakeCloudflareControl } from './fake-cf-control.js';

const BRIDGE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../infra/sandbox-image/agent-bridge',
);
// skip-reason: the end-to-end case runs the real bridge under python3;
// owner: sandbox-cloudflare. Present on every CI runner and dev machine.
const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;

let fake: FakeCloudflareControl;
let healthy: boolean;
let probes: string[];

function control(secret = FAKE_SECRET): CloudflareControl {
  return new CloudflareControl({ url: fake.url, secret });
}

function provider(
  overrides: { secret?: string; readyTimeoutMs?: number } = {},
): CloudflareSandboxProvider {
  return new CloudflareSandboxProvider({
    control: control(overrides.secret),
    readyTimeoutMs: overrides.readyTimeoutMs ?? 2_000,
    bridgeProbe: (url) => {
      probes.push(url);
      return Promise.resolve(healthy);
    },
  });
}

beforeEach(async () => {
  fake = new FakeCloudflareControl();
  await fake.start();
  healthy = true;
  probes = [];
});

afterEach(async () => {
  await fake.stop();
});

describe('CloudflareSandboxProvider — lifecycle', () => {
  it('provisions a workspace record without starting anything', async () => {
    const p = provider();
    await p.provisionWorkspace({ botId: 'cmp1' });
    await p.provisionWorkspace({ botId: 'cmp1' });
    const computer = fake.computers.get('cmp1');
    expect(computer?.running).toBe(false);
    expect(computer?.starts).toBe(0);
    expect(await p.inspectWorkspace({ botId: 'cmp1' })).toEqual({
      exists: true,
      ok: true,
      volumeName: 'cmp1',
    });
    expect(await p.inspectWorkspace({ botId: 'nope' })).toEqual({ exists: false });
  });

  it('attaches only to a provisioned computer, and resumes it until the bridge answers', async () => {
    fake.add('cmp1');
    const p = provider();
    expect(await p.attachSession({ sessionId: 'nope' })).toBeNull();
    expect(await p.attachSession({ sessionId: 'cmp1' })).not.toBeNull();

    const session = await p.resumeSession({ sessionId: 'cmp1' });
    expect(fake.computers.get('cmp1')?.running).toBe(true);
    expect(probes.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.id).toBe('cmp1');
    expect(session.containerId).toBe('cmp1');
  });

  it('refuses to recreate a missing workspace, or to create over a running computer', async () => {
    fake.add('running', { running: true });
    const p = provider();
    await expect(
      p.createSession({ sessionId: 'gone', identity: 'gone', requireExistingWorkspace: true }),
    ).rejects.toThrow(/workspace is missing/);
    await expect(p.createSession({ sessionId: 'running', identity: 'running' })).rejects.toThrow(
      /already running/,
    );
    await expect(p.createSession({ sessionId: 'a', identity: 'b' })).rejects.toThrow(/identity b/);
    expect(fake.computers.has('gone')).toBe(false);
  });

  it('creates a fresh computer: provision, start, first-start time recorded', async () => {
    const p = provider();
    const session = await p.createSession({ sessionId: 'cmp9', identity: 'cmp9' });
    expect(session.id).toBe('cmp9');
    expect(fake.computers.get('cmp9')?.running).toBe(true);
    expect((await p.inspectWorkspaceHistory({ botId: 'cmp9' })).runtimeCreatedAt).not.toBeNull();
  });

  it('stop and destroy stop the container, saving the workspace; neither deletes it', async () => {
    fake.add('cmp1');
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    await session.stop();
    expect(fake.computers.get('cmp1')).toMatchObject({ running: false, stops: 1 });
    expect(fake.computers.get('cmp1')?.savedAt).not.toBeNull();

    const again = await p.resumeSession({ sessionId: 'cmp1' });
    await again.destroy();
    expect(fake.computers.get('cmp1')).toMatchObject({ running: false, stops: 2 });
    expect(await p.inspectWorkspace({ botId: 'cmp1' })).toMatchObject({ exists: true });
  });

  it('reports a desktop that dies while starting instead of waiting out the deadline', async () => {
    fake.add('cmp1');
    fake.exitOnStart = 1;
    const p = provider({ readyTimeoutMs: 60_000 });
    const started = Date.now();
    await expect(p.resumeSession({ sessionId: 'cmp1' })).rejects.toThrow(/exited/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('waits for the bridge, then fails at the deadline when it never answers', async () => {
    fake.add('cmp1');
    healthy = false;
    const p = provider({ readyTimeoutMs: 500 });
    await expect(p.resumeSession({ sessionId: 'cmp1' })).rejects.toBeInstanceOf(HarnessError);
    expect(probes.length).toBeGreaterThan(1);
  });

  it('stops a computer whose create fails after starting, so nothing is left running', async () => {
    const p = provider({ readyTimeoutMs: 300 });
    healthy = false;
    await expect(p.createSession({ sessionId: 'cmp2', identity: 'cmp2' })).rejects.toBeInstanceOf(
      HarnessError,
    );
    expect(fake.computers.get('cmp2')?.running).toBe(false);
  });
});

describe('CloudflareSandboxProvider — inventory, history and health', () => {
  it('lists running computers as runtimes and every computer as a workspace', async () => {
    fake.add('up', { running: true });
    fake.add('down');
    const p = provider();
    expect((await p.listManagedSessions()).map((s) => s.containerId)).toEqual(['up']);
    expect((await p.listWorkspaces()).map((w) => w.botId).sort()).toEqual(['down', 'up']);
  });

  it('orphan cleanup stops the runtime and keeps the workspace', async () => {
    fake.add('up', { running: true });
    const p = provider();
    await p.removeManagedSession({ containerId: 'up' });
    await p.removeManagedSession({ containerId: 'never-existed' });
    expect(fake.computers.get('up')).toMatchObject({ running: false, stops: 1 });
  });

  it('answers workspace history from the record, never starting a machine', async () => {
    fake.add('fresh');
    fake.add('used', { runtimeCreatedAt: 1234 });
    fake.add('live', { runtimeCreatedAt: 99, running: true });
    const p = provider();
    expect(await p.inspectWorkspaceHistory({ botId: 'fresh' })).toEqual({
      referenced: false,
      runtimeCreatedAt: null,
    });
    expect(await p.inspectWorkspaceHistory({ botId: 'used' })).toEqual({
      referenced: false,
      runtimeCreatedAt: 1234,
    });
    expect(await p.inspectWorkspaceHistory({ botId: 'live' })).toEqual({
      referenced: true,
      runtimeCreatedAt: 99,
    });
    await expect(p.inspectWorkspaceHistory({ botId: 'nope' })).rejects.toThrow(/missing/);
    expect(fake.calls.some((call) => call.endsWith('/start'))).toBe(false);
  });

  it('answers health as a value: missing, stopped with its exit, or serving', async () => {
    fake.add('stopped', { exit: { code: 1, at: 1 } });
    fake.add('up', { running: true });
    const p = provider();
    expect(await p.checkHealth({ sessionId: 'nope' })).toMatchObject({ ok: false });
    expect(await p.checkHealth({ sessionId: 'stopped' })).toEqual({
      ok: false,
      reason: 'computer stopped is stopped: it exited with code 1',
    });
    expect(await p.checkHealth({ sessionId: 'up' })).toEqual({ ok: true });
    healthy = false;
    expect(await p.checkHealth({ sessionId: 'up' })).toMatchObject({ ok: false });
  });

  it('maps a refused secret to the harness authentication error', async () => {
    const p = provider({ secret: 'wrong-secret-wrong-secret-wrong-secret' });
    const error: unknown = await p.listWorkspaces().catch((e: unknown) => e);
    expect(HarnessSandboxAuthenticationError.isInstance(error)).toBe(true);
  });

  it('rejects a refused tunnel with a control error, and nothing is thrown afterwards', async () => {
    // ws emits an 'error' as a refused handshake is torn down; with no
    // listener left that is an uncaught exception, which ends the process.
    fake.add('cmp1');
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const error: unknown = await control()
        .openTunnel('cmp1', SANDBOX_PORTS.rfb)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareControlError);
      expect((error as CloudflareControlError).status).toBe(409);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });
});

describe('CloudflareSandboxProvider — retention and profiles', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('keeps an in-use computer, clocks an orphan in the record, deletes it after the window', async () => {
    fake.add('cmp1');
    fake.add('live', { running: true });
    const p = provider();
    expect(
      await p.retainWorkspace({ botId: 'live', orphaned: true, now: 1, retentionMs: DAY }),
    ).toBe('in-use');
    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: true, now: 10, retentionMs: DAY }),
    ).toBe('retained');
    expect(fake.computers.get('cmp1')?.orphanedSince).toBe(10);
    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: true, now: 10 + DAY, retentionMs: DAY }),
    ).toBe('deleted');
    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: true, now: 0, retentionMs: DAY }),
    ).toBe('absent');
    expect(fake.calls.some((call) => call.endsWith('/start'))).toBe(false);
  });

  it('forgets the orphan clock when the computer is no longer orphaned', async () => {
    fake.add('cmp1', { orphanedSince: 5 });
    const p = provider();
    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: false, now: 6, retentionMs: DAY }),
    ).toBe('retained');
    expect(fake.computers.get('cmp1')?.orphanedSince).toBeNull();
  });

  it('retires a profile now when running, and on the next start when stopped', async () => {
    fake.add('up', { running: true });
    fake.add('down');
    const p = provider();
    await p.retireBotProfile({ computerId: 'up', botId: 'bot-a' });
    await p.retireBotProfile({ computerId: 'down', botId: 'bot-b' });
    expect(fake.computers.get('up')?.retired).toEqual(['bot-a']);
    expect(fake.computers.get('down')).toMatchObject({
      retired: [],
      pendingRetirements: ['bot-b'],
    });
    const session = await p.resumeSession({ sessionId: 'down' });
    expect(fake.computers.get('down')?.retired).toEqual(['bot-b']);
    // The tombstone lives only on the container's disk until a save captures it.
    expect(fake.computers.get('down')?.pendingRetirements).toEqual(['bot-b']);
    await session.stop();
    expect(fake.computers.get('down')?.pendingRetirements).toEqual([]);
    await expect(p.retireBotProfile({ computerId: 'up', botId: '../x' })).rejects.toThrow(
      /Invalid/,
    );
  });
});

describe('CloudflareSandboxProvider — ports through the tunnel', () => {
  let echo: Server;

  beforeAll(async () => {
    echo = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  });

  afterAll(() => new Promise<void>((r) => echo.close(() => r())));

  it('relays bytes both ways through a loopback endpoint, byte for byte', async () => {
    fake.add('cmp1');
    fake.ports.set(SANDBOX_PORTS.rfb, (echo.address() as AddressInfo).port);
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
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

  it('closes every tunnel before stopping, and serves no ports afterwards', async () => {
    // An open tunnel keeps a Cloudflare container awake; stop must not leave one.
    fake.add('cmp1');
    fake.ports.set(SANDBOX_PORTS.rfb, (echo.address() as AddressInfo).port);
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    const { hostname, port } = new URL(
      (await session.getPortEndpoint({ port: SANDBOX_PORTS.rfb })).url,
    );
    const client = connect(Number(port), hostname);
    client.on('error', () => undefined);
    await new Promise<void>((r) => {
      client.once('data', () => r());
      client.write('ping');
    });
    expect(fake.openTunnels).toBeGreaterThan(0);
    await session.stop();
    for (let i = 0; i < 40 && fake.openTunnels > 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(fake.openTunnels).toBe(0);
    await expect(session.getPortEndpoint({ port: SANDBOX_PORTS.rfb })).rejects.toBeInstanceOf(
      HarnessError,
    );
    client.destroy();
  });
});

describe.skipIf(!HAS_PYTHON)('CloudflareSandboxProvider — file I/O end to end', () => {
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
          "server = bridge.BridgeServer(('127.0.0.1', 0), bridge.BridgeHandler)",
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
    fake.add('cmp1');
    fake.ports.set(SANDBOX_PORTS.bridge, bridgePort);
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
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
