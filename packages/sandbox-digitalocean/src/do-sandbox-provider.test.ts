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

import { DigitalOceanApi, DigitalOceanApiError } from './do-api.js';
import {
  DigitalOceanSandboxProvider,
  IDLE_BACKSTOP,
  sessionNameFor,
} from './do-sandbox-provider.js';
import { FAKE_TOKEN, FakeDigitalOcean } from './fake-do-api.js';

const BRIDGE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../infra/sandbox-image/agent-bridge',
);
// skip-reason: the end-to-end case runs the real bridge under python3;
// owner: sandbox-digitalocean. Present on every CI runner and dev machine.
const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;

let fake: FakeDigitalOcean;
let healthy: boolean;
let probes: string[];

function provider(overrides: { token?: string } = {}): DigitalOceanSandboxProvider {
  return new DigitalOceanSandboxProvider({
    api: new DigitalOceanApi({ token: overrides.token ?? FAKE_TOKEN, apiUrl: fake.url }),
    template: 'crewaid-sandbox',
    readyTimeoutMs: 2_000,
    bridgeProbe: (url) => {
      probes.push(url);
      return Promise.resolve(healthy);
    },
  });
}

beforeEach(async () => {
  fake = new FakeDigitalOcean();
  await fake.start();
  healthy = true;
  probes = [];
});

afterEach(async () => {
  await fake.stop();
});

const markerExecs = (mode: string) =>
  fake.execs.filter((call) => call.argv.includes('-c') && call.argv.at(-1) === mode);

describe('DigitalOceanSandboxProvider — lifecycle', () => {
  it('provisions a paused session from one shared environment with an idle backstop', async () => {
    const p = provider();
    await p.provisionWorkspace({ botId: 'cmp1' });
    await p.provisionWorkspace({ botId: 'cmp1' });
    await p.provisionWorkspace({ botId: 'cmp2' });

    expect(fake.configs).toHaveLength(1);
    // Never keep_warm: a warm session refuses to pause (409), which would
    // leave every computer running and billing.
    expect(fake.configs[0]?.manifest_yaml).not.toContain('keep_warm');
    expect(fake.configs[0]?.manifest_yaml).toContain(`idle_timeout: ${IDLE_BACKSTOP}`);
    expect(fake.configs[0]?.manifest_yaml).toContain('template: crewaid-sandbox');
    const sessions = [...fake.sessions.values()];
    expect(sessions.map((s) => s.name).sort()).toEqual(['crewaid-cmp1', 'crewaid-cmp2']);
    expect(sessions.every((s) => s.status === 'SESSION_STATUS_PAUSED')).toBe(true);
    expect(sessions.every((s) => s.config_id === fake.configs[0]?.id)).toBe(true);
  });

  it('resumes a paused computer, clears its orphan clock and waits for the bridge', async () => {
    const session = fake.addSession(sessionNameFor('cmp1'));
    const p = provider();

    expect(await p.attachSession({ sessionId: 'cmp1' })).not.toBeNull();
    const resumed = await p.resumeSession({ sessionId: 'cmp1' });

    expect(session.status).toBe('SESSION_STATUS_READY');
    expect(markerExecs('clear')).toHaveLength(1);
    expect(probes.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(resumed.id).toBe('cmp1');
    expect(resumed.containerId).toBe(session.session_id);
  });

  it('runs the desktop launcher once when the bridge does not answer after a resume', async () => {
    fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    healthy = false;
    fake.execHandler = (call) => {
      if (call.argv[0] === '/usr/local/bin/crewaid-desktop-up') healthy = true;
      return {
        exit_code: 0,
        stdout: call.argv.at(-1) === 'clear' ? 'clear\n' : 'ok\n',
        stderr: '',
      };
    };
    await p.resumeSession({ sessionId: 'cmp1' });
    expect(
      fake.execs.filter((c) => c.argv[0] === '/usr/local/bin/crewaid-desktop-up'),
    ).toHaveLength(1);
  });

  it('launches the desktop again when one launch does not bring it up', async () => {
    fake.addSession(sessionNameFor('cmp1'));
    const p = new DigitalOceanSandboxProvider({
      api: new DigitalOceanApi({ token: FAKE_TOKEN, apiUrl: fake.url }),
      template: 'crewaid-sandbox',
      readyTimeoutMs: 5_000,
      relaunchMs: 50,
      bridgeProbe: () => Promise.resolve(healthy),
    });
    healthy = false;
    let launches = 0;
    fake.execHandler = (call) => {
      if (call.argv[0] === '/usr/local/bin/crewaid-desktop-up' && ++launches === 2) healthy = true;
      return {
        exit_code: 0,
        stdout: call.argv.at(-1) === 'clear' ? 'clear\n' : 'ok\n',
        stderr: '',
      };
    };
    await p.resumeSession({ sessionId: 'cmp1' });
    expect(launches).toBe(2);
  });

  it('refuses to create over an existing computer, or without its workspace', async () => {
    fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    await expect(p.createSession({ sessionId: 'cmp1', identity: 'cmp1' })).rejects.toThrow(
      /already exists/,
    );
    await expect(
      p.createSession({ sessionId: 'cmp2', identity: 'cmp2', requireExistingWorkspace: true }),
    ).rejects.toThrow(/workspace is missing/);
    await expect(p.createSession({ sessionId: 'cmp3', identity: 'other' })).rejects.toThrow(
      /identity other/,
    );
    expect(fake.sessions.size).toBe(1);
  });

  it('creates a fresh computer and writes its runtime marker', async () => {
    const p = provider();
    const session = await p.createSession({ sessionId: 'cmp9', identity: 'cmp9' });
    expect(session.id).toBe('cmp9');
    expect([...fake.sessions.values()].map((s) => s.name)).toEqual(['crewaid-cmp9']);
    expect(markerExecs('write')).toHaveLength(1);
  });

  it('stop and destroy pause — neither ever deletes the session', async () => {
    const record = fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });

    await session.stop();
    expect(record.status).toBe('SESSION_STATUS_PAUSED');
    await p.resumeSession({ sessionId: 'cmp1' });
    await session.destroy();
    expect(record.status).toBe('SESSION_STATUS_PAUSED');
    expect(fake.sessions.has(record.session_id)).toBe(true);
    expect(fake.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('orphan cleanup pauses a computer and refuses a session that is not one', async () => {
    const mine = fake.addSession(sessionNameFor('cmp1'), 'SESSION_STATUS_READY');
    const theirs = fake.addSession('someone-elses-agent', 'SESSION_STATUS_READY');
    const p = provider();
    await p.removeManagedSession({ containerId: mine.session_id });
    expect(mine.status).toBe('SESSION_STATUS_PAUSED');
    await expect(p.removeManagedSession({ containerId: theirs.session_id })).rejects.toThrow(
      /not a Crewaid computer/,
    );
    expect(theirs.status).toBe('SESSION_STATUS_READY');
    expect(fake.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });
});

describe('DigitalOceanSandboxProvider — inventory and health', () => {
  it('lists only its own computers, by exact name', async () => {
    fake.addSession(sessionNameFor('cmp1'), 'SESSION_STATUS_READY');
    fake.addSession(sessionNameFor('cmp2'));
    fake.addSession('opencode-unrelated');
    const p = provider();
    const observed = await p.listManagedSessions();
    expect(observed.map((o) => [o.botId, o.running]).sort()).toEqual([
      ['cmp1', true],
      ['cmp2', false],
    ]);
    expect((await p.listWorkspaces()).map((w) => w.botId).sort()).toEqual(['cmp1', 'cmp2']);
  });

  it('never hands one computer another computer whose name it prefixes', async () => {
    // The fake's ?name= filter matches prefixes, as a server might.
    fake.addSession(sessionNameFor('cmp10'));
    const p = provider();
    expect(await p.attachSession({ sessionId: 'cmp1' })).toBeNull();
    expect(await p.inspectWorkspace({ botId: 'cmp1' })).toEqual({ exists: false });
  });

  it('answers health as a value: missing, paused, or serving', async () => {
    const p = provider();
    expect(await p.checkHealth({ sessionId: 'cmp1' })).toEqual({
      ok: false,
      reason: 'no DigitalOcean session is named crewaid-cmp1',
    });
    fake.addSession(sessionNameFor('cmp1'));
    expect(await p.checkHealth({ sessionId: 'cmp1' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('paused, manual') as unknown,
    });
    await p.resumeSession({ sessionId: 'cmp1' });
    expect(await p.checkHealth({ sessionId: 'cmp1' })).toEqual({ ok: true });
  });

  it('keeps a running, healthy computer awake at most once per interval', async () => {
    // DigitalOcean's idle timer ignores tunnel traffic but counts exec, so a
    // computer the orchestrator is using must be told so, or it pauses mid-task.
    fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    await p.resumeSession({ sessionId: 'cmp1' });
    const keepAlives = () => fake.execs.filter((c) => c.argv.length === 1 && c.argv[0] === 'true');
    await p.checkHealth({ sessionId: 'cmp1' });
    await p.checkHealth({ sessionId: 'cmp1' });
    expect(keepAlives()).toHaveLength(1);
    healthy = false;
    await p.checkHealth({ sessionId: 'cmp1' });
    expect(keepAlives()).toHaveLength(1);
  });

  it('reads workspace history from the runtime marker', async () => {
    fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    expect(await p.inspectWorkspaceHistory({ botId: 'cmp1' })).toEqual({
      referenced: false,
      runtimeCreatedAt: null,
    });
    await expect(p.inspectWorkspaceHistory({ botId: 'nope' })).rejects.toThrow(/missing/);
  });

  it("reads a paused computer's history once, and leaves it paused", async () => {
    // The workspace sweep asks every minute about a computer that has never
    // started. DigitalOcean's exec wakes a paused session, so each ask would
    // otherwise leave a machine running that the database says is stopped.
    const record = fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    await p.inspectWorkspaceHistory({ botId: 'cmp1' });
    expect(record.status).toBe('SESSION_STATUS_PAUSED');
    await p.inspectWorkspaceHistory({ botId: 'cmp1' });
    expect(markerExecs('read')).toHaveLength(1);
  });

  it('records runtime history when a provisioned computer first starts', async () => {
    // Provisioning creates the session, so the lifecycle's first start is a
    // resume, never a create; the marker must be written on that path.
    const p = provider();
    await p.provisionWorkspace({ botId: 'cmp1' });
    expect(await p.inspectWorkspaceHistory({ botId: 'cmp1' })).toMatchObject({
      runtimeCreatedAt: null,
    });
    await p.resumeSession({ sessionId: 'cmp1' });
    const history = await p.inspectWorkspaceHistory({ botId: 'cmp1' });
    expect(history.referenced).toBe(true);
    expect(history.runtimeCreatedAt).not.toBeNull();
  });

  it('gives every configuration its own environment, however long the template name', async () => {
    const template = 't'.repeat(58);
    const withSize = (size: string) =>
      new DigitalOceanSandboxProvider({
        api: new DigitalOceanApi({ token: FAKE_TOKEN, apiUrl: fake.url }),
        template,
        size,
        bridgeProbe: () => Promise.resolve(true),
      });
    await withSize('mars-4vcpu-8gb').provisionWorkspace({ botId: 'cmp1' });
    await withSize('mars-16vcpu-32gb').provisionWorkspace({ botId: 'cmp2' });
    expect(fake.configs).toHaveLength(2);
    expect(fake.configs.every((c) => c.name.length <= 64)).toBe(true);
    expect(new Set(fake.configs.map((c) => c.name)).size).toBe(2);
  });

  it('maps a refused token to the harness authentication error', async () => {
    const p = provider({ token: 'dop_v1_wrong' });
    const error: unknown = await p.listWorkspaces().catch((e: unknown) => e);
    expect(HarnessSandboxAuthenticationError.isInstance(error)).toBe(true);
  });

  it('rejects a refused tunnel with an API error, and nothing is thrown afterwards', async () => {
    // ws emits an 'error' as the refused handshake is torn down; with no
    // listener left that is an uncaught exception, which ends the process.
    const record = fake.addSession(sessionNameFor('cmp1'));
    const api = new DigitalOceanApi({ token: 'dop_v1_wrong', apiUrl: fake.url });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const error: unknown = await api
        .openPortForward(record.session_id, SANDBOX_PORTS.rfb)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DigitalOceanApiError);
      expect((error as DigitalOceanApiError).status).toBe(401);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });
});

describe('DigitalOceanSandboxProvider — retention', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('keeps an in-use computer without waking it', async () => {
    fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: false, now: 1, retentionMs: DAY }),
    ).toBe('retained');
    expect(fake.execs).toHaveLength(0);
  });

  it('marks an orphan once, then decides from the cache until it expires', async () => {
    const record = fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    const t0 = 1_000_000;
    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: true, now: t0, retentionMs: DAY }),
    ).toBe('retained');
    expect(markerExecs('mark')).toHaveLength(1);
    // Reading the marker woke it; it went back to sleep.
    expect(record.status).toBe('SESSION_STATUS_PAUSED');

    expect(
      await p.retainWorkspace({
        botId: 'cmp1',
        orphaned: true,
        now: t0 + 60_000,
        retentionMs: DAY,
      }),
    ).toBe('retained');
    expect(fake.execs).toHaveLength(1);

    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: true, now: t0 + DAY, retentionMs: DAY }),
    ).toBe('deleted');
    expect(fake.sessions.has(record.session_id)).toBe(false);
  });

  it('treats a running orphan as in use, and a restored one as no longer orphaned', async () => {
    const record = fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    await p.retainWorkspace({ botId: 'cmp1', orphaned: true, now: 1, retentionMs: DAY });
    record.status = 'SESSION_STATUS_READY';
    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: true, now: 2, retentionMs: DAY }),
    ).toBe('in-use');
    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: false, now: 3, retentionMs: DAY }),
    ).toBe('retained');
    expect(markerExecs('clear')).toHaveLength(1);
  });
});

describe('DigitalOceanSandboxProvider — ports through the tunnel', () => {
  let echo: Server;

  beforeAll(async () => {
    echo = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  });

  afterAll(() => new Promise<void>((r) => echo.close(() => r())));

  it('relays bytes both ways through a loopback endpoint, byte for byte', async () => {
    fake.addSession(sessionNameFor('cmp1'));
    fake.ports.set(SANDBOX_PORTS.rfb, (echo.address() as AddressInfo).port);
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.rfb });
    expect(endpoint.headers).toBeUndefined();

    const { hostname, port } = new URL(endpoint.url);
    const payload = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 256));
    // Read the whole echo before closing: a WebSocket has no half-close, so
    // ending the write side ends the stream (as with doctl's port-forward).
    // RFB, CDP and HTTP clients never half-close.
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

  it('closes the upstream stream when the computer pauses under a live connection', async () => {
    // Pausing destroys the loopback sockets, which emits neither 'end' nor
    // 'error'; the stream to DigitalOcean must close on 'close' as well.
    const guestClosed = new Promise<void>((resolveClosed) => {
      echo.once('connection', (guest) => guest.once('close', () => resolveClosed()));
    });
    fake.addSession(sessionNameFor('cmp1'));
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
    await session.stop();
    await expect(
      Promise.race([
        guestClosed.then(() => 'closed'),
        new Promise((r) => setTimeout(() => r('still open'), 2_000)),
      ]),
    ).resolves.toBe('closed');
    client.destroy();
  });

  it('stops serving ports once the computer is paused', async () => {
    fake.addSession(sessionNameFor('cmp1'));
    const p = provider();
    const session = await p.resumeSession({ sessionId: 'cmp1' });
    await session.stop();
    await expect(session.getPortEndpoint({ port: SANDBOX_PORTS.rfb })).rejects.toBeInstanceOf(
      HarnessError,
    );
  });
});

describe.skipIf(!HAS_PYTHON)('DigitalOceanSandboxProvider — file I/O end to end', () => {
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
    fake.addSession(sessionNameFor('cmp1'));
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
