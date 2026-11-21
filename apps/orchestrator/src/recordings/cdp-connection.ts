import { WebSocket } from 'ws';
import type { RawData } from 'ws';

/**
 * One Chrome DevTools Protocol connection over a WebSocket.
 *
 * CDP is one JSON object per frame in each direction, in two shapes: a COMMAND
 * carries an `id` and is eventually answered by a frame carrying the same
 * `id`, and an EVENT carries a `method` and no `id` at all. Both arrive on the
 * same socket, interleaved — which is the entire reason this file exists. A
 * caller reading the socket directly cannot tell an answer from an event, and
 * by the time an event has arrived, the answer to an earlier command may
 * still be on its way.
 *
 * Deliberately narrow: it opens, sends, subscribes, and closes. It knows
 * nothing about pages, targets or recordings — the capture script
 * and the navigation events are callers of `send` and `on`, not
 * reasons for this file to grow a feature.
 */

/** A protocol event pushed by the peer, e.g. `Page.frameNavigated`. */
export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** Present when the event belongs to one attached target session. */
  readonly sessionId?: string;
}

export type CdpEventListener = (event: CdpEvent) => void;

/** How a connection ended: an `Error` for a drop, `null` for a close we asked for. */
export type CdpCloseOutcome = Error | null;

export interface CdpConnection {
  /**
   * Send one command and resolve with its `result`; rejects on a protocol
   * `error` answer or when the command outlives `commandTimeoutMs`.
   */
  send(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;

  /** Subscribe to one protocol event. Returns the unsubscribe. */
  on(method: string, listener: CdpEventListener): () => void;

  /**
   * Notified once when the connection ends, whoever ended it. Registering
   * after it has ended notifies immediately rather than never — the socket
   * can drop between the statement that opened it and the statement that
   * registers interest in its death.
   */
  onClose(listener: (outcome: CdpCloseOutcome) => void): () => void;

  /** True once the socket can no longer carry a command. */
  readonly closed: boolean;

  /**
   * Close the connection — idempotent, never rejects, resolves once the
   * socket is closed (bounded: the farewell gets a grace period, then the
   * socket is torn down).
   */
  close(): Promise<void>;
}

export interface OpenCdpConnectionOptions {
  /** The debugger WebSocket URL, already pinned to the address it must be reached at. */
  readonly url: string;
  /** Headers the sandbox endpoint requires; sent on the upgrade request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Ceiling on the WebSocket handshake. */
  readonly handshakeTimeoutMs?: number;
  /** Default ceiling on one command's round trip. */
  readonly commandTimeoutMs?: number;
  /** Largest accepted frame; a peer that outgrows it is disconnected by `ws`. */
  readonly maxPayloadBytes?: number;
  /**
   * Where a listener's own throw goes. Without it, such an error would
   * surface as an uncaught exception and take the process down — a
   * subscriber's bug must cost at most that subscription.
   */
  readonly onListenerError?: (error: unknown, source: string) => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Bound on a single inbound frame.
 *
 * CDP frames this client expects — a command result, a binding call, a
 * navigation event — are kilobytes. A sandbox is the untrusted side of this
 * socket, and `ws` buffers a frame before anything downstream can
 * judge it, so the bound belongs here rather than in a consumer. `ws` answers
 * an oversized frame by dropping the connection, which surfaces to the caller
 * as exactly what it is: the peer stopped talking.
 */
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** How long a requested close waits for the farewell frame before tearing the socket down. */
const CLOSE_GRACE_MS = 1_000;

interface PendingCommand {
  readonly method: string;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Open a CDP connection, resolving only once the socket is OPEN.
 *
 * A failure here is reject-with-a-reason, never a half-open socket: the
 * sandbox may have no Chrome yet, or none it is willing to debug.
 */
export async function openCdpConnection(options: OpenCdpConnectionOptions): Promise<CdpConnection> {
  const socket = new WebSocket(options.url, {
    ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
    handshakeTimeout: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    maxPayload: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    // Chrome does not offer permessage-deflate for CDP, so negotiating it
    // would only add a compressor to a control channel that carries none.
    perMessageDeflate: false,
  });
  try {
    await opened(socket, options.url);
  } catch (error: unknown) {
    // `terminate`, not `close`: the peer just failed a handshake and is the
    // last thing to ask before this process gives up on it.
    socket.terminate();
    throw error;
  }
  return new SocketCdpConnection(socket, options);
}

/** The open/timeout race for the handshake, isolated so the class above starts from OPEN. */
function opened(socket: WebSocket, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new Error(`the CDP WebSocket at ${url} did not open: ${error.message}`));
    };
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      // A close before OPEN is how a rejected upgrade usually arrives; a bare
      // "socket closed" with no code here would read as a network fault.
      reject(
        new Error(
          `the CDP WebSocket at ${url} closed during its handshake ` +
            `(code ${code}${reason.length > 0 ? `: ${reason.toString('utf8')}` : ''})`,
        ),
      );
    };
    socket.on('open', onOpen);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

class SocketCdpConnection implements CdpConnection {
  private readonly socket: WebSocket;
  private readonly commandTimeoutMs: number;
  private readonly onListenerError: ((error: unknown, source: string) => void) | null;
  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly closeListeners = new Set<(outcome: CdpCloseOutcome) => void>();
  private readonly pending = new Map<number, PendingCommand>();

  private nextId = 1;
  /** `open` until a close is requested or the peer drops the socket. */
  private state: 'open' | 'closing' | 'closed' = 'open';
  /** How it ended, once it has: `null` for a close this side requested. */
  private outcome: CdpCloseOutcome = null;
  /** The socket-level failure that preceded the close event, if any. */
  private socketError: Error | null = null;
  /** The in-flight or settled close, so `close()` can be called any number of times. */
  private closing: Promise<void> | null = null;

  constructor(socket: WebSocket, options: OpenCdpConnectionOptions) {
    this.socket = socket;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.onListenerError = options.onListenerError ?? null;
    socket.on('message', (data) => {
      this.receive(data);
    });
    socket.on('error', (error) => {
      // A socket error is followed by a close event; keeping it is what makes
      // the close outcome name the host-level cause instead of a bare code.
      this.socketError = error;
    });
    socket.on('close', (code, reason) => {
      this.finalize(code, reason);
    });
  }

  get closed(): boolean {
    return this.state !== 'open';
  }

  send(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.state !== 'open') {
      return Promise.reject(new Error(`the CDP connection is closed; ${method} was not sent`));
    }
    const id = this.nextId;
    this.nextId += 1;
    const frame: Record<string, unknown> = { id, method };
    if (params !== undefined) frame['params'] = params;
    if (sessionId !== undefined) frame['sessionId'] = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} did not answer within ${this.commandTimeoutMs} ms`));
      }, this.commandTimeoutMs);
      // A pending command must never be the thing that keeps a process alive
      // (same reason every timer in the recording path is unref'd).
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify(frame), (error?: Error) => {
        // The socket can have been closing when this was handed to it; an
        // answer will never arrive, so the command is failed here rather
        // than left to its timeout.
        if (error === undefined || error === null) return;
        const command = this.pending.get(id);
        if (command === undefined) return;
        this.pending.delete(id);
        clearTimeout(command.timer);
        command.reject(new Error(`CDP ${method} could not be sent: ${error.message}`));
      });
    });
  }

  on(method: string, listener: CdpEventListener): () => void {
    const existing = this.listeners.get(method);
    const listeners = existing ?? new Set<CdpEventListener>();
    if (existing === undefined) this.listeners.set(method, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  onClose(listener: (outcome: CdpCloseOutcome) => void): () => void {
    if (this.state === 'closed') {
      listener(this.outcome);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }

  private closeOnce(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'closing';
    // Anything still in flight when the close was requested will never be
    // answered; failing it now is what keeps callers from waiting out a
    // timeout that the close has already made pointless.
    this.rejectPending(new Error('the CDP connection was closed'));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, CLOSE_GRACE_MS);
      timer.unref();
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close(1000, 'closed by the orchestrator');
    });
  }

  /** The socket is gone — tell whoever is waiting, however it got here. */
  private finalize(code: number, reason: Buffer): void {
    const wasOpen = this.state === 'open';
    this.state = 'closed';
    if (wasOpen) {
      this.outcome =
        this.socketError ??
        new Error(
          `the CDP connection dropped (code ${code}${reason.length > 0 ? `: ${reason.toString('utf8')}` : ''})`,
        );
      this.rejectPending(this.outcome);
    }
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener(this.outcome);
      } catch (error: unknown) {
        this.onListenerError?.(error, 'onClose');
      }
    }
  }

  private rejectPending(error: Error): void {
    const commands = [...this.pending.values()];
    this.pending.clear();
    for (const command of commands) {
      clearTimeout(command.timer);
      command.reject(error);
    }
  }

  private receive(data: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(toText(data));
    } catch {
      // Chrome answers every frame with JSON. Anything else cannot match a
      // command that was sent or an event anyone subscribed to, so it is
      // dropped — and, like a frame that cannot be built, it must not read
      // as a fault of the connection.
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const frame = message as Record<string, unknown>;
    const id = frame['id'];
    if (typeof id === 'number') {
      this.answer(id, frame);
      return;
    }
    const method = frame['method'];
    if (typeof method === 'string') this.publish(method, frame);
  }

  private answer(id: number, frame: Record<string, unknown>): void {
    const command = this.pending.get(id);
    // A command that already timed out was removed from the map; its answer
    // arriving late is expected protocol behaviour, not an error.
    if (command === undefined) return;
    this.pending.delete(id);
    clearTimeout(command.timer);
    const error = frame['error'];
    if (typeof error === 'object' && error !== null) {
      const detail = error as Record<string, unknown>;
      command.reject(
        new Error(
          `CDP ${command.method} failed: ${printable(detail['message'] ?? 'no message')} ` +
            `(code ${printable(detail['code'] ?? 'unknown')})`,
        ),
      );
      return;
    }
    const result = frame['result'];
    command.resolve(
      typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {},
    );
  }

  private publish(method: string, frame: Record<string, unknown>): void {
    const listeners = this.listeners.get(method);
    if (listeners === undefined || listeners.size === 0) return;
    const params = frame['params'];
    const sessionId = frame['sessionId'];
    const event: CdpEvent = {
      method,
      params:
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {},
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        // One subscriber's throw must not reach the others (or crash the
        // process through the socket's event handler) — the connection
        // outlives any single listener.
        this.onListenerError?.(error, method);
      }
    }
  }
}

/** `ws` hands text frames over as Buffer (or an ArrayBuffer under other binaryTypes). */
function toText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * A CDP `error` field is a JSON value, not a string — a peer answers with
 * whatever it has. Readable pieces go into the message as themselves; the
 * rest is described rather than stringified into `[object Object]`.
 */
function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? typeof value;
}
