import { describe, expect, it } from 'vitest';

import type {
  ContainerExecSpec,
  ContainerProcess,
  ContainerStatus,
  SandboxContainer,
} from './container.js';
import { ContainerSandboxSession, SANDBOX_PORTS } from './sandbox-session.js';
import { SANDBOX_INFRA_SURFACE } from './types.js';

/**
 * A container that answers execs from a script instead of a daemon.
 *
 * The session's whole job is framing harness calls as commands and reading the
 * results back, so the fake records what was asked and replays what it was told
 * to answer. That makes the two things worth asserting about this layer
 * testable in milliseconds: the bytes that come back, and the commands that go
 * out — the second being where the injection-safety property lives.
 */
interface ExecOutcome {
  readonly stdout?: string | Uint8Array;
  readonly stderr?: string;
  readonly exitCode: number;
}

interface RecordedExec {
  readonly spec: ContainerExecSpec;
  stdin: Uint8Array;
}

class FakeContainer implements SandboxContainer {
  readonly id = 'container-abc123';
  readonly execs: RecordedExec[] = [];
  readonly lifecycle: string[] = [];

  #status: ContainerStatus = {
    running: true,
    exitCode: null,
    portBindings: {
      [SANDBOX_PORTS.rfb]: { host: '127.0.0.1', port: 32768 },
      [SANDBOX_PORTS.cdp]: { host: '127.0.0.1', port: 32769 },
      [SANDBOX_PORTS.bridge]: { host: '127.0.0.1', port: 32770 },
    },
    // The session never reads mounts; the provider owns the workspace (D-039).
    mounts: [],
    labels: {},
  };

  constructor(private readonly answer: (spec: ContainerExecSpec, index: number) => ExecOutcome) {}

  setStatus(status: ContainerStatus): void {
    this.#status = status;
  }

  // Not `async`: these fakes are synchronous, and writing them as async to
  // match the interface's PromiseLike return would be a lie the linter is
  // right to flag.
  start = (): Promise<void> => this.#note('start');
  stop = (): Promise<void> => this.#note('stop');
  remove = (): Promise<void> => this.#note('remove');
  inspect = (): Promise<ContainerStatus> => Promise.resolve(this.#status);

  #note(event: string): Promise<void> {
    this.lifecycle.push(event);
    return Promise.resolve();
  }

  spawn = (spec: ContainerExecSpec): Promise<ContainerProcess> => {
    const record: RecordedExec = { spec, stdin: new Uint8Array() };
    const index = this.execs.length;
    this.execs.push(record);
    const outcome = this.answer(spec, index);

    let killed = false;
    const chunks: Uint8Array[] = [];

    return Promise.resolve({
      stdout: streamOf(outcome.stdout ?? ''),
      stderr: streamOf(outcome.stderr ?? ''),
      stdin:
        spec.stdin === true
          ? new WritableStream<Uint8Array>({
              write(chunk) {
                chunks.push(chunk);
              },
              close() {
                record.stdin = concat(chunks);
              },
            })
          : null,
      wait: () => Promise.resolve({ exitCode: killed ? 143 : outcome.exitCode }),
      kill: () => {
        killed = true;
        this.lifecycle.push('kill');
        return Promise.resolve();
      },
    });
  };
}

function streamOf(payload: string | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function sessionOver(container: FakeContainer): ContainerSandboxSession {
  return new ContainerSandboxSession({
    sessionId: 'session-1',
    container,
    containerId: container.id,
    screen: { widthPx: 1280, heightPx: 800 },
  });
}

const FOUND = { exitCode: 0 } as const;
const NOT_FOUND = { exitCode: 42 } as const;

describe('reading files', () => {
  it('returns the file bytes', async () => {
    const container = new FakeContainer(() => ({ ...FOUND, stdout: 'hello desktop' }));
    await expect(sessionOver(container).readTextFile({ path: '/home/bot/a.txt' })).resolves.toBe(
      'hello desktop',
    );
  });

  it('resolves null for a missing file rather than throwing', async () => {
    const container = new FakeContainer(() => NOT_FOUND);
    await expect(sessionOver(container).readBinaryFile({ path: '/nope' })).resolves.toBeNull();
  });

  it('throws when the read fails for a reason that is not absence', async () => {
    // A directory, a permission error and a full disk all land here. Folding
    // them into `null` would tell the caller the file does not exist, which is
    // the one thing that is not true.
    const container = new FakeContainer(() => ({
      exitCode: 1,
      stderr: 'cat: /etc: Is a directory',
    }));
    await expect(sessionOver(container).readBinaryFile({ path: '/etc' })).rejects.toThrow(
      /Is a directory/,
    );
  });

  it('never puts the path in the command string', async () => {
    // Skill code is model-generated (§7.3) and picks its own paths. A path
    // interpolated into `sh -c` is a command injection, so it travels in the
    // environment and the command stays a constant.
    const hostile = '/tmp/x"; touch /tmp/pwned; echo "';
    const container = new FakeContainer(() => ({ ...FOUND, stdout: '' }));

    await sessionOver(container).readBinaryFile({ path: hostile });

    const [exec] = container.execs;
    expect(exec?.spec.command.join(' ')).not.toContain('pwned');
    expect(exec?.spec.env?.['CREWAID_PATH']).toBe(hostile);
  });

  it('slices a 1-based inclusive line range', async () => {
    const container = new FakeContainer(() => ({ ...FOUND, stdout: 'one\ntwo\nthree\nfour' }));
    await expect(
      sessionOver(container).readTextFile({ path: '/f', startLine: 2, endLine: 3 }),
    ).resolves.toBe('two\nthree');
  });

  it('reads through EOF when endLine is past the end', async () => {
    // Upstream is explicit that this is not an error.
    const container = new FakeContainer(() => ({ ...FOUND, stdout: 'one\ntwo' }));
    await expect(
      sessionOver(container).readTextFile({ path: '/f', startLine: 2, endLine: 9_000 }),
    ).resolves.toBe('two');
  });

  it('decodes with the requested encoding', async () => {
    const container = new FakeContainer(() => ({
      ...FOUND,
      stdout: new Uint8Array([0xe9, 0x74, 0xe9]), // "été" in latin1
    }));
    await expect(
      sessionOver(container).readTextFile({ path: '/f', encoding: 'latin1' }),
    ).resolves.toBe('été');
  });

  it('slices small files via readTextFileRange without leaking paths into the shell', async () => {
    const hostile = '/home/bot/x"; touch /tmp/pwned; echo "';
    const container = new FakeContainer(() => ({
      ...FOUND,
      stdout: 'FULL 18\none\ntwo\nthree\nfour\n',
    }));
    const result = await sessionOver(container).readTextFileRange({
      path: hostile,
      startLine: 2,
      endLine: 3,
    });
    expect(result).toEqual({
      text: 'two\nthree',
      totalLines: 4,
      totalBytes: 18,
      startLine: 2,
      byteTruncated: false,
      binary: false,
    });
    const [exec] = container.execs;
    expect(exec?.spec.command.join(' ')).toContain('sed -n');
    expect(exec?.spec.command.join(' ')).not.toContain('pwned');
    expect(exec?.spec.env?.['CREWAID_PATH']).toBe(hostile);
    expect(exec?.spec.env?.['CREWAID_START']).toBe('2');
    expect(exec?.spec.env?.['CREWAID_END']).toBe('3');
  });

  it('handles large-file slices and byte caps in readTextFileRange', async () => {
    const container = new FakeContainer(() => ({
      ...FOUND,
      stdout: 'LARGE 209715200 500000\nline100\nline101\n',
    }));
    const slice = await sessionOver(container).readTextFileRange({
      path: '/home/bot/big.log',
      startLine: 100,
      endLine: 101,
      maxBytes: 1024,
    });
    expect(slice).toEqual({
      text: 'line100\nline101',
      totalLines: 500_000,
      totalBytes: 209_715_200,
      startLine: 100,
      byteTruncated: false,
      binary: false,
    });

    const cappedContainer = new FakeContainer(() => ({
      ...FOUND,
      stdout: 'LARGE 209715200 500000\n1234567890X',
    }));
    const capped = await sessionOver(cappedContainer).readTextFileRange({
      path: '/home/bot/big.log',
      maxBytes: 10,
    });
    expect(capped?.text).toBe('1234567890');
    expect(capped?.byteTruncated).toBe(true);
  });

  it('reports null for missing files and binary flag for NUL bytes in readTextFileRange', async () => {
    const missing = new FakeContainer(() => NOT_FOUND);
    await expect(
      sessionOver(missing).readTextFileRange({ path: '/home/bot/missing.txt' }),
    ).resolves.toBeNull();

    const binary = new FakeContainer(() => ({
      ...FOUND,
      stdout: Buffer.concat([Buffer.from('FULL 4\n'), Buffer.from([0x89, 0x50, 0x00, 0x47])]),
    }));
    await expect(
      sessionOver(binary).readTextFileRange({ path: '/home/bot/img.png' }),
    ).resolves.toMatchObject({ binary: true });
  });
});

describe('writing files', () => {
  it('sends the content on stdin and creates parent directories', async () => {
    const container = new FakeContainer(() => FOUND);
    await sessionOver(container).writeTextFile({ path: '/home/bot/deep/a.txt', content: 'proof' });

    const [exec] = container.execs;
    expect(exec?.spec.stdin).toBe(true);
    expect(exec?.spec.command.join(' ')).toContain('mkdir -p');
    expect(new TextDecoder().decode(exec?.stdin)).toBe('proof');
    expect(exec?.spec.env?.['CREWAID_PATH']).toBe('/home/bot/deep/a.txt');
  });

  it('writes raw bytes unchanged', async () => {
    const container = new FakeContainer(() => FOUND);
    const content = new Uint8Array([0, 1, 2, 255, 0]);
    await sessionOver(container).writeBinaryFile({ path: '/f', content });
    expect(container.execs[0]?.stdin).toEqual(content);
  });

  it('refuses an encoding it cannot honour instead of writing utf-8 under its name', async () => {
    // Corrupting the file silently would only surface when something reads it
    // back, somewhere else, much later.
    const container = new FakeContainer(() => FOUND);
    await expect(
      sessionOver(container).writeTextFile({ path: '/f', content: 'x', encoding: 'shift-jis' }),
    ).rejects.toThrow(/unsupported write encoding/);
    expect(container.execs).toHaveLength(0);
  });

  it('throws when the write fails', async () => {
    const container = new FakeContainer(() => ({ exitCode: 1, stderr: 'No space left on device' }));
    await expect(
      sessionOver(container).writeTextFile({ path: '/f', content: 'x' }),
    ).rejects.toThrow(/No space left on device/);
  });
});

describe('running commands', () => {
  it('returns exit code, stdout and stderr together', async () => {
    const container = new FakeContainer(() => ({ exitCode: 3, stdout: 'out', stderr: 'err' }));
    await expect(sessionOver(container).run({ command: 'false' })).resolves.toEqual({
      exitCode: 3,
      stdout: 'out',
      stderr: 'err',
    });
  });

  it('defaults the working directory to the image WORKDIR', async () => {
    const container = new FakeContainer(() => FOUND);
    await sessionOver(container).run({ command: 'pwd' });
    expect(container.execs[0]?.spec.workingDirectory).toBe('/home/bot');
  });

  it('kills the process when the turn is aborted', async () => {
    // Not merely stopping the read: an abandoned process keeps burning the
    // bot's 1.0 CPU for the rest of the container's life.
    const controller = new AbortController();
    const container = new FakeContainer(() => FOUND);

    await sessionOver(container).spawn({ command: 'sleep 900', abortSignal: controller.signal });
    controller.abort();

    expect(container.lifecycle).toContain('kill');
  });
});

describe('port resolution (D-012)', () => {
  it('resolves a published port to a reachable url', async () => {
    const container = new FakeContainer(() => FOUND);
    await expect(
      sessionOver(container).getPortEndpoint({ port: SANDBOX_PORTS.cdp }),
    ).resolves.toEqual({ url: 'http://127.0.0.1:32769' });
  });

  it('honours the requested protocol', async () => {
    const container = new FakeContainer(() => FOUND);
    const endpoint = await sessionOver(container).getPortEndpoint({
      port: SANDBOX_PORTS.rfb,
      protocol: 'ws',
    });
    expect(endpoint.url).toBe('ws://127.0.0.1:32768');
  });

  it('says whether the container is running when a port is unreachable', async () => {
    // "Port not published" and "the sandbox is stopped" need different fixes,
    // and the caller cannot tell them apart from the outside.
    const container = new FakeContainer(() => FOUND);
    container.setStatus({
      running: false,
      exitCode: 1,
      portBindings: {},
      mounts: [],
      labels: {},
    });

    await expect(sessionOver(container).getPortEndpoint({ port: 5900 })).rejects.toThrow(
      /is not running/,
    );
  });

  it('keeps the deprecated getPortUrl answering the same address', async () => {
    const container = new FakeContainer(() => FOUND);
    const session = sessionOver(container);
    const [endpoint, url] = await Promise.all([
      session.getPortEndpoint({ port: SANDBOX_PORTS.bridge }),
      session.getPortUrl({ port: SANDBOX_PORTS.bridge }),
    ]);
    expect(url).toBe(endpoint.url);
  });
});

describe('lifecycle', () => {
  it('destroy stops before it removes', async () => {
    const container = new FakeContainer(() => FOUND);
    await sessionOver(container).destroy();
    expect(container.lifecycle).toEqual(['stop', 'remove']);
  });

  it('exposes the session id the orchestrator resumes by, not the container id', () => {
    // The harness persists `id` and hands it straight back to
    // resumeSession({ sessionId }). Returning the container id here would
    // round-trip into a lookup for a resource that was never named that way.
    const container = new FakeContainer(() => FOUND);
    const session = sessionOver(container);
    expect(session.id).toBe('session-1');
    expect(session.containerId).toBe('container-abc123');
  });
});

describe('the reduced view (R4)', () => {
  it('carries file and process access', async () => {
    const container = new FakeContainer(() => ({ ...FOUND, stdout: 'ok' }));
    const restricted = sessionOver(container).restricted();

    await expect(restricted.run({ command: 'echo ok' })).resolves.toMatchObject({ stdout: 'ok' });
    expect(typeof restricted.description).toBe('string');
  });

  it('carries nothing that could take the desktop away from the operator', () => {
    // A tool must not be able to stop the sandbox, destroy it, change its
    // network policy, or resolve a port and reach it out of band.
    //
    // Driven off SANDBOX_INFRA_SURFACE rather than a list written out here,
    // because that list is asserted in types.test.ts to be exactly the
    // difference between the two interfaces. A second copy would agree with it
    // on the day it was written and then stop, silently, the first time
    // upstream adds a member — which is the case this test is for.
    const restricted = sessionOver(new FakeContainer(() => FOUND)).restricted();

    for (const forbidden of SANDBOX_INFRA_SURFACE) {
      expect(restricted).not.toHaveProperty(forbidden);
    }
  });
});
