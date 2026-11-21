import { runGitProcess, type GitProcessRunner } from './git-process.js';
/**
 * `HarnessV1NetworkSandboxSession` over a `SandboxContainer`.
 *
 * Everything here is the harness contract expressed in terms of the narrow
 * container port, so none of it knows about Docker and all of it is testable
 * against a fake. The parts worth reading before changing:
 *
 * - File I/O is framed over exec rather than Docker's archive endpoints. The
 * archive API speaks tar in both directions, and this package would have to
 * grow a tar implementation to satisfy a contract whose primitives are
 * "read these bytes" and "write these bytes". Exec gets there with `cat`.
 * - Paths reach the shell through the environment, never through
 * interpolation. Skill code is model-generated and picks its own
 * paths, so a quoted-string command line here is a command injection with
 * extra steps.
 * - `setNetworkPolicy` and `setPorts` are deliberately NOT implemented. Both
 * are optional upstream, both would need capabilities §5.1 drops, and
 * omitting them is what makes callers write the optional-call form
 * DECISIONS.md requires. §7.3's egress policy is iptables on `agent-net`
 * (M2-BE-09), which is the primary mechanism regardless.
 */

import {
  HarnessError,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PortEndpoint,
  type SandboxProcess,
  type SandboxProcessOptions,
  type SandboxReadFileOptions,
  type SandboxReadTextFileOptions,
  type SandboxRunResult,
  type SandboxWriteBinaryOptions,
  type SandboxWriteStreamOptions,
  type SandboxWriteTextOptions,
  type ToolSandboxSession,
} from './types.js';
import type { ContainerProcess, SandboxContainer } from './container.js';

/**
 * §5's machine ports — the screen, CDP and the bridge.
 *
 * Not the only ports this session resolves: a seat's RFB port goes through
 * `getPortEndpoint` too. These three are the ones the machine itself
 * runs from boot.
 */
export const SANDBOX_PORTS = {
  /** x11vnc on the whole display. The machine's own screen. */
  rfb: 5900,
  /** Chrome DevTools Protocol. M4 attaches here. */
  cdp: 9222,
  /** agent-bridge. */
  bridge: 7070,
} as const;

/**
 * The whole-display RFB streams, one per seat.
 *
 * A seat is a bot's own DESKTOP on a shared machine, so each port captures an
 * entire display rather than one window (WORKSPACE §20, as amended). The range
 * is published when the CONTAINER is created and cannot grow afterwards:
 * `setPorts` is deliberately not implemented, so a machine's ceiling on
 * concurrent seats is fixed for its life and widening it means replacing the
 * machine.
 *
 * Sixteen is read off §20's measurement against the machine's own memory limit
 * rather than chosen — a display seat costs ~439 MB and `memoryBytes` defaults
 * to 2 GB, so memory is what refuses the fifth or sixth seat, which is where
 * the bound belongs. That makes sixteen a ceiling rather than a promise that
 * sixteen desktops fit: the bridge admits against real PID and memory headroom
 * and will refuse long before the ports run out. A published port that nothing
 * listens on costs a port binding and nothing else.
 */
export const SEAT_PORT_BASE = 5901;
export const SEAT_PORT_COUNT = 16;

/** Every seat port a machine publishes, in the order they are handed out. */
export const SEAT_PORTS: readonly number[] = Array.from(
  { length: SEAT_PORT_COUNT },
  (_, index) => SEAT_PORT_BASE + index,
);

/**
 * The seat browsers' relays, one per seat, published the same way and for the
 * same reason as the RFB range above.
 *
 * A relay rather than Chrome's own listener because Chrome binds
 * `--remote-debugging-port` to loopback and ignores `--remote-debugging-address`
 * — Docker forwards a published port to the container's interface, not to its
 * loopback, so mapping Chrome directly reaches nothing. The bridge starts a
 * `socat` on this port in front of Chrome's private one, exactly as the
 * entrypoint already does for the machine's own browser on 9222.
 */
export const SEAT_CDP_PORTS: readonly number[] = Array.from(
  { length: SEAT_PORT_COUNT },
  (_, index) => 9301 + index,
);

/** §5's `WORKDIR`. Read from the image rather than guessed by callers. */
export const SANDBOX_WORKING_DIRECTORY = '/home/bot';

/**
 * Exit code the read helper uses for "no such file", chosen from the range no
 * standard utility returns so it cannot be confused with `cat` failing for a
 * reason the caller should hear about — a directory, a permission error, a
 * full disk. Those must throw; only a missing file resolves to null.
 */
const EXIT_NOT_FOUND = 42;

export interface SandboxSessionOptions {
  /** The id the orchestrator will persist and resume by. */
  readonly sessionId: string;
  readonly container: SandboxContainer;
  /**
   * The runtime's own id for this machine — Docker's container id, or a hosted
   * provider's session id. Not part of the harness contract; logs and tests.
   */
  readonly containerId: string;
  readonly screen: { readonly widthPx: number; readonly heightPx: number };
}

export class ContainerSandboxSession implements HarnessV1NetworkSandboxSession {
  readonly #container: SandboxContainer;
  readonly #screen: { readonly widthPx: number; readonly heightPx: number };

  /**
   * The harness persists this as "the durable lookup key for cross-process
   * resume", and a later process hands it straight back as
   * `resumeSession({ sessionId })`. So it has to be the sessionId itself, not
   * the container id and not the container name — either of those round-trips
   * into a lookup for a resource that was never named that way. The container
   * id is exposed separately for logging and assertions.
   */
  readonly id: string;
  readonly containerId: string;
  readonly defaultWorkingDirectory = SANDBOX_WORKING_DIRECTORY;
  /**
   * Every port this session exposes.
   *
   * The harness documents the member as "ports the sandbox exposes; resolvable
   * via `getPortEndpoint`", and the container publishes the seat range at
   * creation — so a list of the machine's three would understate
   * what this session hands out, and a reader of it would take a seat's port
   * for unreachable.
   */
  readonly ports: ReadonlyArray<number> = Object.freeze([
    SANDBOX_PORTS.rfb,
    SANDBOX_PORTS.cdp,
    SANDBOX_PORTS.bridge,
    ...SEAT_PORTS,
    ...SEAT_CDP_PORTS,
  ]);

  constructor(options: SandboxSessionOptions) {
    this.id = options.sessionId;
    this.containerId = options.containerId;
    this.#container = options.container;
    this.#screen = options.screen;
  }

  get screen(): { readonly widthPx: number; readonly heightPx: number } {
    return this.#screen;
  }

  get description(): string {
    const { widthPx, heightPx } = this.#screen;
    return [
      `A Debian 12 desktop running XFCE on a ${widthPx}x${heightPx} display.`,
      `The working directory is ${SANDBOX_WORKING_DIRECTORY}.`,
      'Google Chrome, the Thunar file manager and a terminal are in the dock.',
      'The display resolution is fixed and cannot be changed.',
      'Outbound network access is limited to HTTP and HTTPS.',
    ].join(' ');
  }

  // ── ports (D-012) ──────────────────────────────────────────────────────────

  getPortEndpoint = async (options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<HarnessV1PortEndpoint> => {
    const status = await this.#container.inspect();
    const binding = status.portBindings[options.port];

    if (binding === undefined) {
      // A stopped sandbox reaches here as readily as a misconfigured one, and
      // the difference decides whether the caller should start it or fix it.
      throw new HarnessError({
        message:
          `sandbox ${this.id}: port ${options.port} is not reachable ` +
          `(container ${status.running ? 'is running' : 'is not running'}). ` +
          `Published ports: ${Object.keys(status.portBindings).join(', ') || 'none'}`,
      });
    }

    // No headers: this transport reaches the container directly and needs none.
    // That is not licence for a caller to drop them — D-012 exists because a
    // provider that DOES return headers fails invisibly when they are ignored.
    return { url: `${options.protocol ?? 'http'}://${binding.host}:${binding.port}` };
  };

  /** @deprecated Use `getPortEndpoint`. Required by the interface. */
  getPortUrl = async (options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<string> => (await this.getPortEndpoint(options)).url;

  // lifecycle

  stop = async (): Promise<void> => {
    await this.#container.stop();
  };

  destroy = async (): Promise<void> => {
    // Contract: must handle both a running and an already-stopped sandbox, and
    // both of these are idempotent at the port, so destroy is safe to retry.
    // Leave Chrome's shutdown hook its five-second flush window while staying
    // below the ten-second bot-deletion budget.
    await this.#container.stop(5);
    await this.#container.remove();
  };

  // processes

  spawn = async (options: SandboxProcessOptions): Promise<SandboxProcess> => {
    const process = await this.#container.spawn({
      command: ['sh', '-c', options.command],
      ...(options.workingDirectory !== undefined
        ? { workingDirectory: options.workingDirectory }
        : { workingDirectory: SANDBOX_WORKING_DIRECTORY }),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });

    // The harness passes an abortSignal meaning "kill the process", which is
    // not the same as "stop listening" — a sandbox process left running after
    // its turn was cancelled keeps burning the bot's 1.0 CPU.
    if (options.abortSignal !== undefined) {
      const onAbort = () => void process.kill();
      if (options.abortSignal.aborted) onAbort();
      else options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    // `pid` is dropped on the way out, and upstream marks it optional for
    // exactly this case. Docker only reports an exec's pid on a separate
    // inspect call, and the value is not known at the instant spawn returns —
    // so the honest options are an extra daemon round trip on every read and
    // write, or admitting we do not expose one. `kill()` does not need it from
    // here; the adapter looks it up when it is actually required.
    return {
      stdout: process.stdout,
      stderr: process.stderr,
      wait: () => process.wait(),
      kill: () => process.kill(),
    };
  };

  run = async (options: SandboxProcessOptions): Promise<SandboxRunResult> => {
    const process = await this.spawn(options);
    // Both streams must be drained concurrently with the wait. Draining one
    // and then the other deadlocks the moment a command fills the pipe buffer
    // on the stream nobody is reading yet.
    const [stdout, stderr, { exitCode }] = await Promise.all([
      collectText(process.stdout),
      collectText(process.stderr),
      process.wait(),
    ]);
    return { exitCode, stdout, stderr };
  };

  // reads

  readFile = async (
    options: SandboxReadFileOptions,
  ): Promise<ReadableStream<Uint8Array> | null> => {
    const bytes = await this.readBinaryFile(options);
    if (bytes === null) return null;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  };

  readBinaryFile = async (options: SandboxReadFileOptions): Promise<Uint8Array | null> => {
    const process = await this.#container.spawn({
      // The path travels in the environment. Interpolating it into the command
      // string would let a model-authored path close the quote and append a
      // command, and skill code chooses its own paths.
      command: [
        'sh',
        '-c',
        `[ -e "$CREWAID_PATH" ] || exit ${EXIT_NOT_FOUND}; exec cat "$CREWAID_PATH"`,
      ],
      env: { CREWAID_PATH: options.path },
    });

    const [stdout, stderr, { exitCode }] = await Promise.all([
      collectBytes(process.stdout),
      collectText(process.stderr),
      process.wait(),
    ]);

    if (exitCode === EXIT_NOT_FOUND) return null;
    if (exitCode !== 0) {
      throw new HarnessError({
        message: `sandbox ${this.id}: reading ${options.path} failed (exit ${exitCode}): ${stderr.trim()}`,
      });
    }
    return stdout;
  };

  readTextFile = async (options: SandboxReadTextFileOptions): Promise<string | null> => {
    const bytes = await this.readBinaryFile(options);
    if (bytes === null) return null;

    const text = new TextDecoder(options.encoding ?? 'utf-8').decode(bytes);
    if (options.startLine === undefined && options.endLine === undefined) return text;

    // Line ranges are 1-based and inclusive, and an endLine past EOF reads
    // through EOF without error — so this clamps rather than validates.
    const lines = text.split('\n');
    const from = Math.max(1, options.startLine ?? 1) - 1;
    const to =
      options.endLine === undefined ? lines.length : Math.min(lines.length, options.endLine);
    return lines.slice(from, to).join('\n');
  };

  // ── writes ─────────────────────────────────────────────────────────────────

  writeFile = async (options: SandboxWriteStreamOptions): Promise<void> => {
    await this.#write(options.path, await collectBytes(options.content));
  };

  writeBinaryFile = async (options: SandboxWriteBinaryOptions): Promise<void> => {
    await this.#write(options.path, options.content);
  };

  writeTextFile = async (options: SandboxWriteTextOptions): Promise<void> => {
    const encoding = options.encoding ?? 'utf-8';
    if (!isSupportedWriteEncoding(encoding)) {
      // Silently writing UTF-8 under another encoding's name corrupts the file
      // in a way that only shows up when something reads it back.
      throw new HarnessError({
        message:
          `sandbox ${this.id}: unsupported write encoding "${encoding}". ` +
          `Supported: ${SUPPORTED_WRITE_ENCODINGS.join(', ')}`,
      });
    }
    await this.#write(options.path, new Uint8Array(Buffer.from(options.content, encoding)));
  };

  async #write(path: string, content: Uint8Array): Promise<void> {
    const process = await this.#container.spawn({
      command: ['sh', '-c', 'mkdir -p "$(dirname "$CREWAID_PATH")" && exec cat > "$CREWAID_PATH"'],
      env: { CREWAID_PATH: path },
      stdin: true,
    });

    if (process.stdin === null) {
      throw new HarnessError({
        message: `sandbox ${this.id}: the container engine did not open stdin for the write to ${path}`,
      });
    }

    const writer = process.stdin.getWriter();
    try {
      await writer.write(content);
    } finally {
      // Closing stdin is what ends `cat`. Skipping it on the error path leaves
      // the process waiting on a pipe that will never close, and `wait()`
      // below never resolves.
      await writer.close().catch(() => undefined);
    }

    const [stderr, { exitCode }] = await Promise.all([collectText(process.stderr), process.wait()]);
    if (exitCode !== 0) {
      throw new HarnessError({
        message: `sandbox ${this.id}: writing ${path} failed (exit ${exitCode}): ${stderr.trim()}`,
      });
    }
  }

  // ── R4 ─────────────────────────────────────────────────────────────────────

  /**
   * The view tool `execute()` calls receive. It points at the same container —
   * it is a narrower surface, not a second sandbox — and deliberately carries
   * no `stop`, `destroy`, `getPortEndpoint`, or network-policy method, so a
   * tool cannot take the desktop away from the operator watching it.
   *
   * `ToolSandboxSession` rather than the plain reduced alias (M5-BE-07). The
   * wide session is structurally assignable to the alias, so `restricted = ()
   * => this` — the shape a provider slides into — typechecked here; the
   * intersection puts the implementation under the same fence as the wiring.
   */
  git: GitProcessRunner = (spec, forward, signal) =>
    runGitProcess(this.#container, spec, forward, signal);

  restricted = (): ToolSandboxSession => ({
    git: this.git,
    description: this.description,
    readFile: this.readFile,
    readBinaryFile: this.readBinaryFile,
    readTextFile: this.readTextFile,
    writeFile: this.writeFile,
    writeBinaryFile: this.writeBinaryFile,
    writeTextFile: this.writeTextFile,
    spawn: this.spawn,
    run: this.run,
  });
}

const SUPPORTED_WRITE_ENCODINGS = [
  'utf-8',
  'utf8',
  'latin1',
  'ascii',
  'utf16le',
  'ucs2',
  'base64',
  'hex',
] as const;

function isSupportedWriteEncoding(encoding: string): encoding is BufferEncoding {
  return (SUPPORTED_WRITE_ENCODINGS as readonly string[]).includes(encoding);
}

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await collectBytes(stream));
}

export type { ContainerProcess };
