/**
 * The client half of the agent-bridge's streaming exec.
 *
 * A hosted provider reaches a machine through a TCP tunnel, and its own exec
 * API — where it has one — cannot carry what `ContainerSandboxSession` needs:
 * stdin for writes, byte-exact stdout for binary reads, the environment that
 * keeps model-written paths off the command line, and kill for an aborted
 * tool. The bridge inside every machine answers all four on `POST /exec`
 * after an HTTP Upgrade, and this turns that connection into the same
 * `ContainerProcess` a Docker exec produces — so a provider implements
 * `SandboxContainer.spawn` with one call.
 *
 * The frame layout is the bridge's (`agent-bridge/exec_stream.py`): one byte
 * of type, four of big-endian length, then the payload. Both sides are tested
 * against each other, not only against themselves.
 */

import { connect, type Socket } from 'node:net';

import type { ContainerExecSpec, ContainerProcess } from './container.js';

export const BRIDGE_EXEC_UPGRADE = 'crewaid-exec/1';

const FRAME = {
  spec: 0x01,
  stdin: 0x02,
  stdinEnd: 0x03,
  kill: 0x04,
  stdout: 0x11,
  stderr: 0x12,
  exit: 0x13,
  error: 0x14,
} as const;

const HEADER_BYTES = 5;
/** The bridge refuses a frame larger than this, so stdin is split to fit. */
const MAX_FRAME_BYTES = 1024 * 1024;
/** A response head larger than this is not the bridge answering. */
const MAX_HEAD_BYTES = 16 * 1024;

export interface BridgeExecTarget {
  readonly host: string;
  readonly port: number;
  /** Seam for tests. Defaults to `node:net`'s `connect`. */
  readonly connect?: (port: number, host: string) => Socket;
}

/** Thrown when the bridge refuses the exec or the connection breaks mid-run. */
export class BridgeExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeExecError';
  }
}

function frame(kind: number, payload: Uint8Array = new Uint8Array()): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Start `spec` on the machine behind `target` and return it as a process.
 *
 * Resolves once the bridge has accepted the upgrade, so a refusal — an old
 * image without `/exec`, a proxy answering instead of the bridge — rejects
 * here with the status it gave rather than surfacing later as an empty read.
 */
export async function bridgeExec(
  target: BridgeExecTarget,
  spec: ContainerExecSpec,
): Promise<ContainerProcess> {
  const socket = (target.connect ?? ((port, host) => connect(port, host)))(
    target.port,
    target.host,
  );
  socket.setNoDelay(true);

  const leftover = await upgrade(socket, target);

  let settled = false;
  let resolveWait!: (value: { exitCode: number }) => void;
  let rejectWait!: (reason: Error) => void;
  const exited = new Promise<{ exitCode: number }>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  // A caller that never awaits wait must not produce an unhandled rejection
  // when the connection drops; the streams carry the same error.
  exited.catch(() => undefined);

  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = (assign: (c: ReadableStreamDefaultController<Uint8Array>) => void) =>
    new ReadableStream<Uint8Array>({
      start: (controller) => assign(controller),
      // One socket feeds both streams, so a slow reader of either pauses both;
      // the alternative is buffering a whole screen recording in memory.
      pull: () => {
        if (socket.isPaused()) socket.resume();
      },
    });
  const stdout = readable((c) => (stdoutController = c));
  const stderr = readable((c) => (stderrController = c));

  const finish = (outcome: { exitCode: number } | Error) => {
    if (settled) return;
    settled = true;
    for (const controller of [stdoutController, stderrController]) {
      try {
        if (outcome instanceof Error) controller.error(outcome);
        else controller.close();
      } catch {
        // Already closed or errored by the reader cancelling.
      }
    }
    if (outcome instanceof Error) rejectWait(outcome);
    else resolveWait(outcome);
    socket.end();
  };

  let buffer: Buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = buffer.byteLength === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (!settled && buffer.byteLength >= HEADER_BYTES) {
      const kind = buffer.readUInt8(0);
      const length = buffer.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) {
        finish(
          new BridgeExecError(
            `bridge sent a ${length}-byte frame; the limit is ${MAX_FRAME_BYTES}`,
          ),
        );
        return;
      }
      if (buffer.byteLength < HEADER_BYTES + length) break;
      const payload = new Uint8Array(buffer.subarray(HEADER_BYTES, HEADER_BYTES + length));
      buffer = buffer.subarray(HEADER_BYTES + length);
      handle(kind, payload);
    }
  };

  const handle = (kind: number, payload: Uint8Array) => {
    switch (kind) {
      case FRAME.stdout:
      case FRAME.stderr: {
        const controller = kind === FRAME.stdout ? stdoutController : stderrController;
        try {
          controller.enqueue(payload);
          if ((controller.desiredSize ?? 1) <= 0) socket.pause();
        } catch {
          // The reader cancelled this stream; the other one may still be read.
        }
        return;
      }
      case FRAME.exit:
        finish({ exitCode: Buffer.from(payload).readInt32BE(0) });
        return;
      case FRAME.error: {
        let detail = Buffer.from(payload).toString('utf8');
        try {
          const parsed = JSON.parse(detail) as { code?: unknown; detail?: unknown };
          detail = `${String(parsed.code)}: ${String(parsed.detail)}`;
        } catch {
          // Not JSON; report the bytes as sent.
        }
        finish(new BridgeExecError(`bridge refused the exec: ${detail}`));
        return;
      }
      default:
        finish(new BridgeExecError(`bridge sent an unknown frame type 0x${kind.toString(16)}`));
    }
  };

  socket.on('data', onData);
  socket.on('error', (error) =>
    finish(new BridgeExecError(`bridge connection failed: ${error.message}`)),
  );
  socket.on('close', () =>
    finish(new BridgeExecError('bridge connection closed before the process exited')),
  );

  const send = (kind: number, payload?: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      if (settled || socket.destroyed) {
        resolve();
        return;
      }
      socket.write(frame(kind, payload), (error) => (error ? reject(error) : resolve()));
    });

  const specJson = {
    argv: [...spec.command],
    ...(spec.workingDirectory !== undefined ? { cwd: spec.workingDirectory } : {}),
    ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
    stdin: spec.stdin === true,
  };
  await send(FRAME.spec, new Uint8Array(Buffer.from(JSON.stringify(specJson), 'utf8')));
  if (leftover.byteLength > 0) onData(leftover);
  socket.resume();

  const stdin =
    spec.stdin === true
      ? new WritableStream<Uint8Array>({
          write: async (chunk) => {
            for (let offset = 0; offset < chunk.byteLength; offset += MAX_FRAME_BYTES) {
              await send(FRAME.stdin, chunk.subarray(offset, offset + MAX_FRAME_BYTES));
            }
          },
          close: () => send(FRAME.stdinEnd),
          abort: () => send(FRAME.kill),
        })
      : null;

  return {
    stdout,
    stderr,
    stdin,
    wait: () => exited,
    kill: () => send(FRAME.kill),
  };
}

/**
 * Send the upgrade request and read the response head. Resolves with any
 * bytes that arrived after the head — the bridge may already be writing
 * frames — and rejects with the status line when it is not a 101.
 */
function upgrade(socket: Socket, target: BridgeExecTarget): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let head: Buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const fail = (message: string) => {
      cleanup();
      socket.destroy();
      reject(new BridgeExecError(`bridge exec at ${target.host}:${target.port}: ${message}`));
    };
    const onError = (error: Error) => fail(`connection failed: ${error.message}`);
    const onClose = () => fail('connection closed before the upgrade was answered');
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.byteLength > MAX_HEAD_BYTES) fail('response head is too large to be the bridge');
        return;
      }
      const statusLine = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
      if (!/^HTTP\/1\.[01] 101 /.test(statusLine)) {
        fail(`expected 101 Switching Protocols, got "${statusLine}"`);
        return;
      }
      // Paused across the handoff: with no 'data' listener attached, a
      // flowing socket drops whatever arrives before bridgeExec attaches its
      // own, and the first frame the bridge sends would be lost.
      socket.pause();
      cleanup();
      resolve(head.subarray(end + 4));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(
      'POST /exec HTTP/1.1\r\n' +
        `Host: ${target.host}:${target.port}\r\n` +
        'Connection: Upgrade\r\n' +
        `Upgrade: ${BRIDGE_EXEC_UPGRADE}\r\n` +
        'Content-Length: 0\r\n\r\n',
    );
  });
}
