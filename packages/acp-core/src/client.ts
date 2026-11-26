import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type StopReason,
} from '@agentclientprotocol/sdk';
import { relativizeReportedPath, sanitizeOneLine } from './privacy.js';
import { AcpSessionProjector } from './projector.js';
import type {
  AcpByteTransport,
  AcpPermissionRequest,
  AcpRunInput,
  AcpRunOutput,
  AcpSessionStatus,
} from './types.js';

const DEFAULT_CANCEL_GRACE_MS = 5_000;
const DEFAULT_CLIENT_INFO = { name: 'crewaid-acp', version: '0.1.0' } as const;

/**
 * Wraps a Node `Readable` + `Writable` pair (such as `child.stdout` /
 * `child.stdin` or a sandbox `bridgeExec` stdio pipe) into a typed
 * `AcpByteTransport`.
 *
 * Swallows broken-pipe errors on write once the peer closes so an exiting
 * harness does not emit an unhandled stream `'error'` event.
 */
export function createNodeStreamTransport(streams: {
  readonly input: Readable;
  readonly output: Writable;
  readonly close?: (() => void | Promise<void>) | undefined;
}): AcpByteTransport {
  const { input, output } = streams;
  output.on('error', () => {
    // Peer exited before our final write; `conn.closed` reports the disconnect.
  });

  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer | string) => {
        if (closed) return;
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      };
      const onEnd = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      const onError = (err: Error) => {
        if (closed) return;
        closed = true;
        controller.error(err);
      };
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('close', onEnd);
      input.once('error', onError);
    },
    cancel() {
      closed = true;
      input.destroy();
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        if (output.destroyed || output.writableEnded) {
          resolve();
          return;
        }
        output.write(chunk, (error) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
              resolve();
              return;
            }
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    close() {
      if (!output.destroyed && !output.writableEnded) {
        output.end();
      }
    },
    abort() {
      output.destroy();
    },
  });

  return {
    readable,
    writable,
    close: async () => {
      if (!output.destroyed && !output.writableEnded) output.end();
      if (!input.destroyed) input.destroy();
      await streams.close?.();
    },
  };
}

/**
 * Wraps a spawned ACP agent subprocess (`stdio: ['pipe', 'pipe', ...]`) into an
 * `AcpByteTransport`, ensuring the subprocess is terminated cleanly on close.
 */
export function createChildProcessTransport(
  child: ChildProcess & { readonly stdin: Writable; readonly stdout: Readable },
): AcpByteTransport {
  return createNodeStreamTransport({
    input: child.stdout,
    output: child.stdin,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
          resolve();
        }, 1_500);
        timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  });
}

function mapStopReason(reason: StopReason): AcpSessionStatus {
  switch (reason) {
    case 'end_turn':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
      return 'incomplete';
  }
}

function normalizePermissionRequest(
  cwd: string,
  params: RequestPermissionRequest,
): AcpPermissionRequest {
  const locations = (params.toolCall.locations ?? [])
    .map((loc) => relativizeReportedPath(cwd, loc.path))
    .filter((loc) => loc !== '');
  return {
    acpSessionId: params.sessionId,
    toolCallId: params.toolCall.toolCallId,
    title: sanitizeOneLine(params.toolCall.title ?? params.toolCall.name ?? 'Tool action'),
    toolKind: params.toolCall.kind ?? 'other',
    locations,
    options: params.options.map((option) => ({
      optionId: option.optionId,
      name: sanitizeOneLine(option.name, 80),
      kind: option.kind,
    })),
  };
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Executes a single ACP v1 coding turn (`initialize` → `session/new` →
 * `session/prompt`) over any NDJSON byte transport.
 *
 * Uses the stable `@agentclientprotocol/sdk` v1 entry point (`client()`,
 * `methods`, `ndJsonStream`).
 */
export async function runAcpSession(input: AcpRunInput): Promise<AcpRunOutput> {
  const startedAt = Date.now();
  const reportMode = input.reportMode ?? 'summary';
  const cancelGraceMs = input.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const projector = new AcpSessionProjector({ cwd: input.cwd, reportMode });

  if (input.abortSignal?.aborted === true) {
    await input.transport.close?.();
    return projector.finalize({
      status: 'cancelled',
      acpSessionId: null,
      durationMs: Date.now() - startedAt,
    });
  }

  let activeSessionId: string | null = null;
  let agentName: string | undefined;
  let cancelledByAbort = false;

  const permissionAbort = new AbortController();

  const app = client({ name: input.clientInfo?.name ?? DEFAULT_CLIENT_INFO.name })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (activeSessionId !== null && params.sessionId !== activeSessionId) return;
      const event = projector.apply(params.sessionId, params.update);
      if (event !== undefined) {
        input.onProgress?.(event);
      }
    })
    .onRequest(
      methods.client.session.requestPermission,
      async ({ params, signal }): Promise<RequestPermissionResponse> => {
        if (
          input.onPermissionRequest === undefined ||
          input.abortSignal?.aborted === true ||
          signal.aborted
        ) {
          return { outcome: { outcome: 'cancelled' } };
        }
        const normalized = normalizePermissionRequest(input.cwd, params);
        input.onProgress?.({
          kind: 'waiting_local_permission',
          acpSessionId: normalized.acpSessionId,
          toolCallId: normalized.toolCallId,
          title: normalized.title,
          toolKind: normalized.toolKind,
        });

        const combined = new AbortController();
        const abortCombined = () => combined.abort();
        signal.addEventListener('abort', abortCombined, { once: true });
        permissionAbort.signal.addEventListener('abort', abortCombined, { once: true });

        let resolvedOutcome: 'selected' | 'cancelled' = 'cancelled';
        try {
          const decision = await input.onPermissionRequest(normalized, combined.signal);
          if (decision.outcome === 'selected') {
            const validOption = params.options.some((opt) => opt.optionId === decision.optionId);
            if (validOption) {
              resolvedOutcome = 'selected';
              return { outcome: { outcome: 'selected', optionId: decision.optionId } };
            }
          }
          return { outcome: { outcome: 'cancelled' } };
        } catch {
          return { outcome: { outcome: 'cancelled' } };
        } finally {
          signal.removeEventListener('abort', abortCombined);
          permissionAbort.signal.removeEventListener('abort', abortCombined);
          input.onProgress?.({
            kind: 'resumed',
            acpSessionId: normalized.acpSessionId,
            toolCallId: normalized.toolCallId,
            outcome: resolvedOutcome,
          });
        }
      },
    );

  const stream = ndJsonStream(input.transport.writable, input.transport.readable);
  const connection = app.connect(stream);

  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    cancelledByAbort = true;
    permissionAbort.abort();
    if (activeSessionId !== null) {
      void connection.agent
        .notify(methods.agent.session.cancel, { sessionId: activeSessionId })
        .catch(() => undefined);
    }
    if (cancelTimer === undefined) {
      cancelTimer = setTimeout(() => {
        connection.close(new Error('ACP session cancel grace period elapsed'));
        void Promise.resolve(input.transport.close?.()).catch(() => undefined);
      }, cancelGraceMs);
      cancelTimer.unref();
    }
  };
  input.abortSignal?.addEventListener('abort', onAbort, { once: true });

  const disconnected = connection.closed.then(() => {
    throw new Error('ACP agent closed the connection unexpectedly.');
  });
  // Avoid unhandled rejections when prompt settles normally before close.
  void disconnected.catch(() => undefined);

  let output: AcpRunOutput;
  try {
    const clientInfo = input.clientInfo ?? DEFAULT_CLIENT_INFO;
    const initParams: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: clientInfo.name, version: clientInfo.version },
    };
    const init = await Promise.race([
      connection.agent.request(methods.agent.initialize, initParams),
      disconnected,
    ]);
    if (init.agentInfo?.name) {
      agentName = init.agentInfo.name;
    }

    const created = await Promise.race([
      connection.agent.request(methods.agent.session.new, {
        cwd: input.cwd,
        mcpServers: [],
      }),
      disconnected,
    ]);
    activeSessionId = created.sessionId;
    input.onProgress?.({
      kind: 'started',
      acpSessionId: activeSessionId,
      harness: input.harnessId ?? 'custom',
      ...(agentName === undefined ? {} : { agentName }),
      cwd: input.cwd,
    });

    if (cancelledByAbort) {
      void connection.agent
        .notify(methods.agent.session.cancel, { sessionId: activeSessionId })
        .catch(() => undefined);
    }

    const promptResponse = await Promise.race([
      connection.agent.request(methods.agent.session.prompt, {
        sessionId: activeSessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      }),
      disconnected,
    ]);

    const status = cancelledByAbort ? 'cancelled' : mapStopReason(promptResponse.stopReason);
    output = projector.finalize({
      status,
      stopReason: promptResponse.stopReason,
      acpSessionId: activeSessionId,
      ...(agentName === undefined ? {} : { agentName }),
      durationMs: Date.now() - startedAt,
    });
  } catch (error: unknown) {
    if (cancelledByAbort) {
      output = projector.finalize({
        status: 'cancelled',
        acpSessionId: activeSessionId,
        ...(agentName === undefined ? {} : { agentName }),
        durationMs: Date.now() - startedAt,
      });
    } else {
      output = projector.finalize({
        status: 'failed',
        acpSessionId: activeSessionId,
        ...(agentName === undefined ? {} : { agentName }),
        durationMs: Date.now() - startedAt,
        error: {
          code: 'ACP_SESSION_FAILED',
          message: errorMessageOf(error),
        },
      });
    }
  } finally {
    if (cancelTimer !== undefined) clearTimeout(cancelTimer);
    input.abortSignal?.removeEventListener('abort', onAbort);
    permissionAbort.abort();
    connection.close();
    await Promise.resolve(input.transport.close?.()).catch(() => undefined);
  }

  if (activeSessionId !== null) {
    input.onProgress?.({
      kind: 'finished',
      acpSessionId: activeSessionId,
      status: output.status,
      steps: output.steps,
      durationMs: output.durationMs,
      filesChangedCount: output.filesChanged.length,
    });
  }

  return output;
}
