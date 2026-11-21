import { connect as tcpConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  RFB_PROTOCOL_VERSION,
  RfbProtocolError,
  SECURITY_TYPE_NONE,
  SERVER_INIT_FIXED_BYTES,
  encodeClientInit,
  encodeFramebufferUpdateRequest,
  encodeSetEncodings,
  encodeSetPixelFormat,
  parseProtocolVersion,
  parseServerInitHeader,
  scanServerMessage,
  ServerMessage,
  type ScreenGeometry,
} from './rfb-protocol.js';
import { SILENT_SCREEN_LOGGER, type ScreenLogger } from './logger.js';

/**
 * One RFB connection to one sandbox's x11vnc.
 *
 * Owns the handshake and the update pump, and emits COMPLETE server messages.
 * It never inspects a pixel: `onMessage` receives the exact bytes the server
 * sent, sliced only at boundaries, which is what "no transcoding" means in
 * practice.
 *
 * The socket arrives through a factory rather than `net.connect` so the whole
 * state machine — handshake ordering, partial reads, mid-message disconnects —
 * is testable against an in-memory duplex, the `wsClient.ts` seam pattern.
 *
 * The update pump
 *
 * RFB is request/response: the server sends a framebuffer update only when
 * asked. Exactly ONE request is outstanding at a time, and the next is sent
 * when the previous update has been fully received. That is not politeness —
 * it is what bounds memory and lets `stop` mean something. Pipelining
 * requests would queue unbounded updates inside a slow link with no way to
 * cancel them.
 *
 * The rate
 *
 * `resume` takes a MINIMUM interval between requests, which is what §4.3's
 * "with no subscribers, do not read the framebuffer faster than a 1 fps
 * keepalive" comes down to. The case it exists for is not an idle desktop —
 * it is a BUSY one with the panel closed. The bot keeps working while nobody
 * watches, so the server keeps having changes to report, and an unthrottled
 * pump would stream a 1280x800 desktop at full rate into a fan-out with zero
 * recipients. That is the CPU the §7.4 budget is about.
 *
 * It is a ceiling, not a floor. An incremental request against a static
 * desktop is simply not answered until something moves, so a quiet sandbox
 * costs one outstanding request and no wakeups at all.
 */
export interface RfbUpstreamOptions {
  readonly host: string;
  readonly port: number;
  readonly quality: number;
  /** Seam for tests; defaults to a real TCP socket. */
  readonly connect?: (host: string, port: number) => Duplex;
  /** Bounds the handshake, which is the one phase that can hang silently. */
  readonly handshakeTimeoutMs?: number;
  readonly logger?: ScreenLogger;
}

/** What the broker needs to know about a forwarded message. */
export interface ServerMessageMeta {
  /** This update answers a non-incremental request: it carries the whole screen. */
  readonly fullRepaint: boolean;
  /** A FramebufferUpdate, as opposed to an unsolicited Bell or ServerCutText. */
  readonly update: boolean;
}

type Phase = 'connecting' | 'version' | 'security' | 'securityResult' | 'serverInit' | 'streaming';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_INPUT_QUEUE_BYTES = 64 * 1024;

export class RfbUpstream {
  private readonly logger: ScreenLogger;

  private readonly socket: Duplex;
  private readonly handshakeTimeoutMs: number;
  private buffer: Buffer = Buffer.alloc(0);
  private phase: Phase = 'connecting';
  private geometry: ScreenGeometry | null = null;
  private quality: number;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** True between sending a request and receiving the update that answers it. */
  private awaitingUpdate = false;
  /** Whether the request in flight asked for a full repaint rather than a delta. */
  private currentRequestFull = false;
  /** Set when someone needs a full repaint; consumed by the next request. */
  private wantFullNext = false;
  /** Whether the pump should keep asking for updates at all. */
  private pumping = false;
  /** Floor on the gap between requests; 0 is "as fast as the server answers". */
  private minRequestIntervalMs = 0;
  private requestTimer: NodeJS.Timeout | null = null;
  private lastRequestAt = 0;

  private onMessageFn: ((message: Buffer, meta: ServerMessageMeta) => void) | null = null;
  private onReadyFn: ((geometry: ScreenGeometry) => void) | null = null;
  private onCloseFn: ((reason: Error | null) => void) | null = null;

  constructor(private readonly options: RfbUpstreamOptions) {
    this.logger = options.logger ?? SILENT_SCREEN_LOGGER;
    this.quality = options.quality;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const factory = options.connect ?? defaultConnect;
    this.socket = factory(options.host, options.port);

    this.socket.on('data', (chunk: Buffer) => this.ingest(chunk));
    this.socket.on('error', (error: Error) => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('RFB upstream closed unexpectedly')));
    // Our version goes out before x11vnc's arrives. The order is invisible to
    // the server, which reads it only after sending its own, but not to its
    // VNC library: that waits up to 100 ms on every new connection for a
    // WebSocket client to speak first, and greets only after — a client that
    // has already spoken is greeted at once (measured 2026-10-15: 100 ms →
    // 1 ms). The server's version is still checked when it lands, and anything
    // but 3.8 still ends the handshake.
    this.socket.write(Buffer.from(RFB_PROTOCOL_VERSION, 'ascii'));

    this.handshakeTimer = setTimeout(() => {
      this.fail(
        new RfbProtocolError(
          `x11vnc at ${options.host}:${options.port} did not complete the RFB handshake ` +
            `within ${this.handshakeTimeoutMs}ms (stalled at "${this.phase}")`,
        ),
      );
    }, this.handshakeTimeoutMs);
    this.handshakeTimer.unref();
  }

  /** Fires once, when ServerInit lands and the stream is usable. */
  onReady(fn: (geometry: ScreenGeometry) => void): void {
    this.onReadyFn = fn;
  }

  /**
   * One complete server message, byte-identical to what x11vnc sent.
   *
   * `meta.fullRepaint` marks the update that answers a non-incremental
   * request. That single bit is what makes multiplexing safe: a subscriber
   * that joined mid-stream has no framebuffer, so it may only be attached on
   * a message carrying the whole screen — every earlier delta would decode
   * against pixels it never had.
   */
  onMessage(fn: (message: Buffer, meta: ServerMessageMeta) => void): void {
    this.onMessageFn = fn;
  }

  /** `null` reason means an ordinary close rather than a fault. */
  onClose(fn: (reason: Error | null) => void): void {
    this.onCloseFn = fn;
  }

  get screen(): ScreenGeometry | null {
    return this.geometry;
  }

  get isStreaming(): boolean {
    return this.phase === 'streaming' && !this.closed;
  }

  /**
   * Start requesting updates, no more often than `minRequestIntervalMs`.
   *
   * Idempotent, and safe to call with a new rate at any time: a pending wait
   * is re-evaluated against the new interval, so a subscriber arriving during
   * a keepalive gap does not sit through the rest of it.
   */
  resume(minRequestIntervalMs = 0): void {
    if (!this.isStreaming) return;
    this.minRequestIntervalMs = Math.max(0, minRequestIntervalMs);
    this.pumping = true;
    this.scheduleRequest();
  }

  /**
   * Ask for a whole-screen repaint.
   *
   * Deliberately does NOT send a second request when one is already in
   * flight: RFB has no request ids, so two outstanding requests produce two
   * updates with no way to tell which answered which — and the `fullRepaint`
   * bit subscribers are admitted on would become a guess. The flag is
   * consumed by the next request instead.
   */
  requestFullRepaint(): void {
    if (!this.isStreaming) return;
    this.wantFullNext = true;
    this.pumping = true;
    // Deliberately not rate-limited. A repaint is asked for when a human just
    // opened a panel, and the keepalive interval exists to stop us reading a
    // screen nobody is looking at — which stopped being true a moment ago.
    this.clearRequestTimer();
    if (!this.awaitingUpdate) this.request();
  }

  /** Stop asking for updates. The connection stays open. */
  pause(): void {
    this.pumping = false;
    this.clearRequestTimer();
  }

  /**
   * Write one already-validated client message upstream (§4.3 inbound, R6).
   *
   * Deliberately takes bytes rather than an event: §4.3 forwards, it does not
   * re-encode, and the message that reaches x11vnc is the one the operator's
   * client produced. `false` means the connection is not in a state to carry
   * it — a dropped keystroke the caller can report, never a thrown error on
   * what is a best-effort, high-rate path.
   *
   * Safe only because `validateClientInput` has already refused everything but
   * KeyEvent and PointerEvent; see rfb-input.ts for what the other four types
   * would do to this shared connection.
   */
  sendInput(bytes: Uint8Array): boolean {
    if (!this.isStreaming) return false;
    // Input is unsolicited: unlike the update pump, no response bounds its
    // rate. A stalled peer must not accumulate an unlimited queue. Close the
    // stream so viewers resubscribe instead of silently losing key releases.
    if (this.socket.writableLength + bytes.byteLength > MAX_INPUT_QUEUE_BYTES) {
      this.fail(new RfbProtocolError('RFB input queue exceeded 64 KiB; upstream is stalled'));
      return false;
    }
    this.socket.write(bytes);
    return true;
  }

  /** Re-negotiate the JPEG quality mid-stream. Cheap: one SetEncodings. */
  setQuality(quality: number, repaint = true): void {
    if (quality === this.quality) return;
    this.quality = quality;
    if (!this.isStreaming) return;
    this.socket.write(encodeSetEncodings(quality));
    // The change only shows up in newly encoded rectangles, so ask for a full
    // repaint — otherwise the operator sees the old quality until something
    // on the desktop happens to move. Not when stepping down for a slow line:
    // a whole-screen update is the last thing that line needs, and a busy
    // screen re-encodes itself at the new quality soon enough.
    if (repaint) this.requestFullRepaint();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHandshakeTimer();
    this.clearRequestTimer();
    this.socket.destroy();
  }

  // receive path

  private ingest(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this.drain();
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Consume as much of the buffer as forms complete units for the current phase. */
  private drain(): void {
    for (;;) {
      if (this.closed) return;
      const before = this.buffer.length;

      switch (this.phase) {
        case 'connecting':
        case 'version':
          if (!this.readVersion()) return;
          break;
        case 'security':
          if (!this.readSecurityTypes()) return;
          break;
        case 'securityResult':
          if (!this.readSecurityResult()) return;
          break;
        case 'serverInit':
          if (!this.readServerInit()) return;
          break;
        case 'streaming':
          if (!this.readOneMessage()) return;
          break;
      }

      // Every branch above either consumed bytes or returned false. This is
      // the guard that turns a future off-by-one into a test failure rather
      // than a pegged CPU core.
      if (this.buffer.length === before && this.phase !== 'streaming') {
        throw new RfbProtocolError(`RFB handshake made no progress in phase "${this.phase}"`);
      }
    }
  }

  private take(n: number): Buffer | null {
    if (this.buffer.length < n) return null;
    const head = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return head;
  }

  private readVersion(): boolean {
    const version = this.take(12);
    if (version === null) return false;
    const offered = parseProtocolVersion(version);
    if (offered !== RFB_PROTOCOL_VERSION) {
      throw new RfbProtocolError(
        `x11vnc offered ${JSON.stringify(offered)}; this proxy speaks only ` +
          `${JSON.stringify(RFB_PROTOCOL_VERSION)}`,
      );
    }
    this.phase = 'security';
    return true;
  }

  private readSecurityTypes(): boolean {
    if (this.buffer.length < 1) return false;
    const count = this.buffer.readUInt8(0);
    if (count === 0) {
      // A zero count means the server is refusing us and a reason string
      // follows. Surfacing it beats reporting "handshake failed".
      const header = this.take(1 + 4);
      if (header === null) return false;
      const reason = this.take(header.readUInt32BE(1));
      throw new RfbProtocolError(
        `x11vnc refused the connection: ${reason?.toString('utf8') ?? '(no reason given)'}`,
      );
    }
    const message = this.take(1 + count);
    if (message === null) return false;
    const offered = [...message.subarray(1)];
    if (!offered.includes(SECURITY_TYPE_NONE)) {
      throw new RfbProtocolError(
        `x11vnc offered security types [${offered.join(', ')}]; §5 runs it with -nopw, so ` +
          `type ${SECURITY_TYPE_NONE} (None) was expected. A password-protected server needs ` +
          'a credential path this proxy does not have.',
      );
    }
    this.socket.write(Buffer.from([SECURITY_TYPE_NONE]));
    this.phase = 'securityResult';
    return true;
  }

  private readSecurityResult(): boolean {
    const result = this.take(4);
    if (result === null) return false;
    const status = result.readUInt32BE(0);
    if (status !== 0) throw new RfbProtocolError(`x11vnc rejected security type None (${status})`);
    this.socket.write(encodeClientInit(true));
    this.phase = 'serverInit';
    return true;
  }

  private readServerInit(): boolean {
    if (this.buffer.length < SERVER_INIT_FIXED_BYTES) return false;
    const { init, nameLength } = parseServerInitHeader(
      this.buffer.subarray(0, SERVER_INIT_FIXED_BYTES),
    );
    const total = SERVER_INIT_FIXED_BYTES + nameLength;
    if (this.buffer.length < total) return false;
    this.take(total);

    this.geometry = { widthPx: init.widthPx, heightPx: init.heightPx };
    this.phase = 'streaming';
    this.clearHandshakeTimer();

    // Pin the format the scanner's TPIXEL width depends on, then the
    // encodings. Both must precede the first update request or the server
    // answers in its own native format.
    this.socket.write(encodeSetPixelFormat());
    this.socket.write(encodeSetEncodings(this.quality));

    this.logger.log(
      `RFB upstream ready: ${this.options.host}:${this.options.port} ` +
        `${init.widthPx}x${init.heightPx} quality ${this.quality}`,
    );
    this.onReadyFn?.(this.geometry);
    return true;
  }

  private readOneMessage(): boolean {
    const length = scanServerMessage(this.buffer);
    if (length === null) return false;
    const message = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);

    // Bell and ServerCutText arrive unsolicited, so they answer no request and
    // must not clear the in-flight flag — nor may they ever be mistaken for a
    // repaint and admit a subscriber onto a screen it cannot draw.
    const isUpdate = message.readUInt8(0) === ServerMessage.framebufferUpdate;
    const fullRepaint = isUpdate && this.currentRequestFull;
    if (isUpdate) {
      this.awaitingUpdate = false;
      this.currentRequestFull = false;
    }

    this.onMessageFn?.(message, { fullRepaint, update: isUpdate });

    // Ask for the next one only after this is delivered, keeping exactly one
    // request in flight — and no sooner than the current rate allows.
    if (isUpdate && this.pumping) this.scheduleRequest();
    return true;
  }

  /** Send now, or after enough of the current interval has elapsed. */
  private scheduleRequest(): void {
    if (!this.isStreaming || !this.pumping || this.awaitingUpdate) return;
    this.clearRequestTimer();

    const due = this.lastRequestAt + this.minRequestIntervalMs - Date.now();
    if (this.minRequestIntervalMs === 0 || due <= 0) {
      this.request();
      return;
    }
    // `unref` for the same reason the handshake timer is unref'd: a pending
    // keepalive must never be the thing holding a shutdown or a test runner
    // open for a second.
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null;
      this.request();
    }, due);
    this.requestTimer.unref();
  }

  private request(): void {
    if (!this.isStreaming || this.geometry === null) return;
    const full = this.wantFullNext;
    this.wantFullNext = false;
    this.currentRequestFull = full;
    this.awaitingUpdate = true;
    this.lastRequestAt = Date.now();
    this.socket.write(encodeFramebufferUpdateRequest(this.geometry, !full));
  }

  private clearRequestTimer(): void {
    if (this.requestTimer !== null) clearTimeout(this.requestTimer);
    this.requestTimer = null;
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private fail(reason: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHandshakeTimer();
    this.clearRequestTimer();
    this.socket.destroy();
    if (reason !== null) {
      this.logger.warn(
        `RFB upstream ${this.options.host}:${this.options.port} failed: ${reason.message}`,
      );
    }
    this.onCloseFn?.(reason);
  }
}

function defaultConnect(host: string, port: number): Socket {
  // A static desktop can leave an incremental request unanswered indefinitely.
  // Docker Desktop still traverses a VM/NAT transport on localhost; TCP
  // keepalives preserve that idle mapping without extra framebuffer requests.
  return tcpConnect({ host, port, keepAlive: true, keepAliveInitialDelay: 30_000 });
}
