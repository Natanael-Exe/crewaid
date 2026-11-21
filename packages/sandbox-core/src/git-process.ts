import type { ContainerProcess, SandboxContainer } from './container.js';

export const GIT_TIMEOUT_MS = 600_000;
export const GIT_TRANSFER_LIMIT = 1024 ** 3;
const FRAME_LIMIT = 65_536;

/** Narrow, credential-free capability available on the reduced tool session. */
export type GitProcessSpec = {
  readonly mode: 'clone' | 'fetch' | 'push' | 'inspect';
  readonly root: string;
  readonly path: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly branch?: string;
  readonly previousHead?: string;
  readonly head?: string;
  readonly tree?: string;
  readonly identity?: { readonly name: string; readonly email: string };
};
export type GitHttpRequest = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: ReadableStream<Uint8Array>;
};
export type GitHttpResponse = {
  readonly status: number;
  readonly contentType: string;
  readonly body: ReadableStream<Uint8Array> | null;
};
export type GitHttpForward = (
  request: GitHttpRequest,
  signal: AbortSignal,
) => Promise<GitHttpResponse>;
export type GitProcessResult = {
  readonly exitCode: number;
  readonly data: unknown;
  readonly output: string;
};
export type GitProcessRunner = (
  spec: GitProcessSpec,
  forward: GitHttpForward,
  signal?: AbortSignal,
) => Promise<GitProcessResult>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requestHead(bytes: Uint8Array): Omit<GitHttpRequest, 'body'> {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (
    !object(value) ||
    (value.method !== 'GET' && value.method !== 'POST') ||
    typeof value.path !== 'string' ||
    !object(value.headers)
  )
    throw new Error('Invalid Git relay request.');
  const headers: Record<string, string> = {};
  for (const [name, field] of Object.entries(value.headers)) {
    if (
      !['Content-Type', 'Accept', 'Git-Protocol'].includes(name) ||
      typeof field !== 'string' ||
      field.length > 1024 ||
      /[\r\n]/.test(field)
    )
      throw new Error('Invalid Git relay header.');
    headers[name] = field;
  }
  return { method: value.method, path: value.path, headers };
}

/** The exec stream carries framed bytes; it never contains an authentication header. */
export async function runGitProcess(
  container: SandboxContainer,
  spec: GitProcessSpec,
  forward: GitHttpForward,
  parentSignal?: AbortSignal,
): Promise<GitProcessResult> {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(GIT_TIMEOUT_MS),
    ...(parentSignal ? [parentSignal] : []),
  ]);
  signal.throwIfAborted();
  const process = await container.spawn({
    command: ['python3', '/opt/agent-bridge/git_helper.py', JSON.stringify(spec)],
    stdin: true,
  });
  return relayGitProcess(process, spec, forward, signal, controller);
}

/** Exported for real-Git process tests; production obtains the process from the provider. */
export async function relayGitProcess(
  process: ContainerProcess,
  spec: GitProcessSpec,
  forward: GitHttpForward,
  signal: AbortSignal,
  controller = new AbortController(),
): Promise<GitProcessResult> {
  if (process.stdin === null) {
    await process.kill();
    throw new Error('Git streaming stdin is unavailable.');
  }
  const writer = process.stdin.getWriter();
  const reader = process.stdout.getReader();
  let output = '';
  let result: GitProcessResult | undefined;
  let bytesTransferred = 0;
  let responseTask: Promise<void> | null = null;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let drained: (() => void) | undefined;
  let failure: unknown;
  let requestOpen = false;
  let writes = Promise.resolve();
  const send = (kind: number, bytes: Uint8Array) => {
    const packet = Buffer.alloc(5 + bytes.byteLength);
    packet.writeUInt8(kind, 0);
    packet.writeUInt32BE(bytes.byteLength, 1);
    packet.set(bytes, 5);
    const next = writes.then(() => writer.write(packet));
    writes = next;
    return next;
  };
  const stop = () => {
    controller.abort();
    drained?.();
    try {
      bodyController?.error(new Error('Git operation cancelled.'));
    } catch {
      /* Already closed. */
    }
    void process.kill();
    void reader.cancel();
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const stderr = (async () => {
    const stream = process.stderr.getReader();
    try {
      while (true) {
        const item = await stream.read();
        if (item.done) break;
        output = (output + Buffer.from(item.value).toString('utf8')).slice(0, 16000);
      }
    } finally {
      stream.releaseLock();
    }
  })();
  const transfer = (size: number) => {
    bytesTransferred += size;
    if (bytesTransferred > GIT_TRANSFER_LIMIT)
      throw new Error('Git transfer exceeds the 1 GiB limit.');
  };
  try {
    let buffer = Buffer.alloc(0);
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      buffer = Buffer.concat([buffer, item.value]);
      while (buffer.length >= 5) {
        if (result !== undefined) throw new Error('Git relay sent data after its result.');
        const kind = buffer.readUInt8(0),
          length = buffer.readUInt32BE(1);
        if (length > FRAME_LIMIT) throw new Error('Oversized Git relay frame.');
        if (buffer.length < 5 + length) break;
        const payload = Buffer.from(buffer.subarray(5, 5 + length));
        buffer = Buffer.from(buffer.subarray(5 + length));
        if (kind === 1) {
          if (requestOpen) throw new Error('Overlapping Git relay requests.');
          requestOpen = true;
          if (spec.mode === 'inspect') throw new Error('Inspection cannot contact GitHub.');
          if (responseTask !== null) await responseTask;
          const head = requestHead(payload);
          const body = new ReadableStream<Uint8Array>(
            {
              start(c) {
                bodyController = c;
              },
              pull() {
                drained?.();
                drained = undefined;
              },
              cancel() {
                drained?.();
                drained = undefined;
              },
            },
            { highWaterMark: FRAME_LIMIT, size: (data) => data.byteLength },
          );
          responseTask = (async () => {
            try {
              const response = await forward(
                { ...head, ...(head.method === 'POST' ? { body } : {}) },
                signal,
              );
              if (
                !Number.isInteger(response.status) ||
                response.status < 100 ||
                response.status > 599 ||
                response.contentType.length > 256 ||
                /[\r\n]/.test(response.contentType)
              )
                throw new Error('Invalid Git relay response.');
              await send(
                17,
                Buffer.from(
                  JSON.stringify({ status: response.status, contentType: response.contentType }),
                ),
              );
              if (response.body !== null) {
                const source = response.body.getReader();
                try {
                  while (true) {
                    const part = await source.read();
                    if (part.done) break;
                    transfer(part.value.byteLength);
                    for (let offset = 0; offset < part.value.byteLength; offset += FRAME_LIMIT)
                      await send(18, part.value.subarray(offset, offset + FRAME_LIMIT));
                  }
                } finally {
                  await source.cancel().catch(() => undefined);
                  source.releaseLock();
                }
              }
              await send(19, new Uint8Array());
            } catch (error: unknown) {
              failure = error;
              stop();
            }
          })();
        } else if (kind === 2) {
          if (bodyController === undefined) throw new Error('Unexpected Git request body.');
          transfer(payload.length);
          bodyController.enqueue(payload);
          if (bodyController.desiredSize !== null && bodyController.desiredSize <= 0)
            await new Promise<void>((resolve) => {
              drained = resolve;
            });
        } else if (kind === 3) {
          if (!requestOpen || payload.length !== 0) throw new Error('Unexpected Git request end.');
          requestOpen = false;
          bodyController?.close();
          bodyController = undefined;
        } else if (kind === 32) {
          output = (output + payload.toString('utf8')).slice(0, 16000);
        } else if (kind === 33) {
          const data: unknown = JSON.parse(payload.toString('utf8'));
          if (!object(data) || typeof data.exitCode !== 'number')
            throw new Error('Invalid Git result.');
          result = { exitCode: data.exitCode, data, output };
        } else throw new Error('Unknown Git relay frame.');
      }
    }
    if (buffer.length !== 0 || requestOpen)
      throw new Error('Incomplete Git relay frame or request.');
    if (responseTask !== null) await responseTask;
    if (failure !== undefined)
      throw failure instanceof Error ? failure : new Error('Git relay failed.');
    signal.throwIfAborted();
    await writes;
    await writer.close();
    await process.wait();
    await stderr;
    if (result === undefined)
      throw new Error(
        'Git helper is unavailable or ended without a result. Rebuild the computer image.',
      );
    return { ...result, output };
  } catch (error: unknown) {
    stop();
    await writer.abort().catch(() => undefined);
    await process.wait().catch(() => undefined);
    await stderr.catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', stop);
    writer.releaseLock();
    reader.releaseLock();
  }
}
