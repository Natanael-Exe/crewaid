import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BridgeExecError, bridgeExec } from './bridge-exec.js';
import { ContainerSandboxSession } from './sandbox-session.js';
import type { ContainerStatus, SandboxContainer } from './container.js';

/**
 * The client against the REAL bridge (`agent-bridge/exec_stream.py`), started
 * as a Python process on a free loopback port.
 *
 * Each side has its own unit tests, and a framing mistake made the same way on
 * both would pass them all; this is the test that makes the two ends agree.
 * It needs `python3`, which every CI runner and the sandbox image have.
 */
const BRIDGE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../infra/sandbox-image/agent-bridge',
);
// skip-reason: needs python3 to run the bridge; owner: sandbox-core. Present on
// every CI runner and dev machine this repo supports, so a skip here means the
// host is missing it, not that the guard is dormant.
const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe.skipIf(!HAS_PYTHON)('bridgeExec against the real agent-bridge', () => {
  let bridge: ChildProcess;
  let port: number;

  beforeAll(async () => {
    bridge = spawn(
      'python3',
      [
        '-c',
        [
          'import sys, threading',
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
    port = await new Promise<number>((resolvePort, reject) => {
      bridge.stdout?.once('data', (chunk: Buffer) => resolvePort(Number(chunk.toString().trim())));
      bridge.once('exit', (code) => reject(new Error(`bridge exited early (${code})`)));
    });
  });

  afterAll(() => {
    bridge?.kill('SIGKILL');
  });

  const target = () => ({ host: '127.0.0.1', port });

  it('returns stdout, stderr and the exit code as separate streams', async () => {
    const process = await bridgeExec(target(), {
      command: ['sh', '-c', 'printf out; printf err >&2; exit 4'],
    });
    const [out, err, { exitCode }] = await Promise.all([
      collect(process.stdout),
      collect(process.stderr),
      process.wait(),
    ]);
    expect([out.toString(), err.toString(), exitCode]).toEqual(['out', 'err', 4]);
    expect(process.stdin).toBeNull();
  });

  it('round-trips binary stdin larger than one frame, byte for byte', async () => {
    const data = new Uint8Array(3 * 1024 * 1024 + 17);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 31 + 7) % 256;
    const process = await bridgeExec(target(), { command: ['cat'], stdin: true });
    const writer = process.stdin!.getWriter();
    const reading = collect(process.stdout);
    await writer.write(data);
    await writer.close();
    const [out, { exitCode }] = await Promise.all([reading, process.wait()]);
    expect(exitCode).toBe(0);
    expect(out.equals(Buffer.from(data))).toBe(true);
  });

  it('carries the environment and working directory without a shell', async () => {
    const process = await bridgeExec(target(), {
      command: ['sh', '-c', 'printf "%s|%s" "$CREWAID_PATH" "$(pwd -P)"'],
      workingDirectory: '/',
      env: { CREWAID_PATH: "/tmp/it's $(not) run" },
    });
    const [out] = await Promise.all([collect(process.stdout), process.wait()]);
    expect(out.toString()).toBe("/tmp/it's $(not) run|/");
  });

  it('kill ends the process with the signal exit code', async () => {
    const process = await bridgeExec(target(), { command: ['sleep', '30'] });
    await new Promise((r) => setTimeout(r, 100));
    await process.kill();
    const [, , { exitCode }] = await Promise.all([
      collect(process.stdout),
      collect(process.stderr),
      process.wait(),
    ]);
    expect(exitCode).toBe(137);
  });

  it('rejects wait and the streams when the bridge refuses the spec', async () => {
    const process = await bridgeExec(target(), { command: [] });
    await expect(process.wait()).rejects.toThrow(/INVALID_EXEC_REQUEST/);
    await expect(collect(process.stdout)).rejects.toBeInstanceOf(BridgeExecError);
  });

  it('gives ContainerSandboxSession working file I/O through the bridge', async () => {
    // The point of the endpoint: a provider whose container spawns through
    // the bridge gets the session's reads and writes unchanged.
    const container: SandboxContainer = {
      id: 'bridge-test',
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      inspect: (): Promise<ContainerStatus> =>
        Promise.resolve({
          running: true,
          exitCode: null,
          portBindings: {},
          mounts: [],
          labels: {},
        }),
      spawn: (spec) => bridgeExec(target(), spec),
    };
    const session = new ContainerSandboxSession({
      sessionId: 'bridge-test',
      container,
      containerId: 'bridge-test',
      screen: { widthPx: 1280, heightPx: 800 },
    });
    const dir = spawnSync('mktemp', ['-d']).stdout.toString().trim();
    const path = `${dir}/nested/it's here.bin`;
    const bytes = new Uint8Array([0, 255, 10, 13, 128, 1]);
    await session.writeBinaryFile({ path, content: bytes });
    const back = await session.readBinaryFile({ path });
    expect(back === null ? null : Array.from(back)).toEqual(Array.from(bytes));
    expect(await session.readTextFile({ path: `${dir}/absent.txt` })).toBeNull();
    // The session defaults to the image's /home/bot, which this host lacks.
    const run = await session.run({ command: 'printf ok', workingDirectory: '/' });
    expect(run).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    spawnSync('rm', ['-rf', dir]);
  });
});

describe('bridgeExec refusals', () => {
  let server: Server;
  let port: number;
  let answer = '';

  beforeAll(async () => {
    server = createServer((socket) => {
      socket.once('data', () => socket.end(answer));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('names the status when something other than the bridge answers', async () => {
    // An image built before /exec answers 404; a proxy in the way answers
    // anything. Either must fail at spawn, not read as an empty result.
    answer = 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n';
    await expect(bridgeExec({ host: '127.0.0.1', port }, { command: ['true'] })).rejects.toThrow(
      /expected 101 Switching Protocols, got "HTTP\/1.1 404 Not Found"/,
    );
  });

  it('rejects when the connection closes before an answer', async () => {
    answer = '';
    await expect(bridgeExec({ host: '127.0.0.1', port }, { command: ['true'] })).rejects.toThrow(
      /closed before the upgrade was answered/,
    );
  });
});
