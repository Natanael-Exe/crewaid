/**
 * The channel noVNC attaches to instead of a VNC socket.
 *
 * Why a shim and not just a websocket
 *
 * noVNC's `RFB` expects to own a connection: it performs the RFB handshake,
 * negotiates a pixel format and encodings, and drives the update pump. Ours
 * owns none of that. The orchestrator holds ONE upstream per sandbox and fans
 * complete server messages out to every subscriber, so by the time
 * bytes reach this renderer the handshake happened minutes ago, on somebody
 * else's socket, and the encodings were chosen for every viewer at once.
 *
 * Rather than reimplement Tight — the reason noVNC is here at all — this
 * presents noVNC with the connection it expects:
 *
 * - The handshake is SYNTHESISED locally. The geometry comes from the
 * `Sandbox` row the client already has (`GET /bots` carries it, and R8
 * fixes it for the container's lifetime), and the pixel format is the one
 * the orchestrator pinned.
 * - Client protocol messages are SWALLOWED. SetPixelFormat, SetEncodings and
 * FramebufferUpdateRequest configure a connection this viewer does not
 * own; forwarding them would reconfigure the stream under every other
 * subscriber, which is exactly what D-036 refuses at the server anyway.
 * - Server messages arrive through `deliver`, already unwrapped from their
 * D-035 envelope.
 *
 * The one agreement that must hold
 *
 * Because SetPixelFormat is swallowed, noVNC decodes using the format it
 * ASKED for while the wire carries the format the orchestrator pinned. The two
 * must be identical or the picture is quietly wrong — with the pre-M2-FE-01
 * pinning they differed only in the shifts, so Tight rectangles were correct
 * (RFC 6143 fixes TPIXEL at R,G,B regardless) and Raw rectangles came out with
 * red and blue swapped. `SCREEN_PIXEL_FORMAT` below is that agreement written
 * down, and it is asserted against the orchestrator's constant in the tests.
 */

import { SCREEN_PIXEL_FORMAT } from '@crewaid/shared';

/** RFC 6143 §7.1.1 — the only version this transport speaks. */
export const PROTOCOL_VERSION = 'RFB 003.008\n';
const SECURITY_TYPE_NONE = 1;

/** RFC 6143 §7.5 client message types and their fixed sizes. */
const CLIENT_MESSAGE_SIZES: Readonly<Record<number, number>> = {
  0: 20, // SetPixelFormat
  3: 10, // FramebufferUpdateRequest
  4: 8, // KeyEvent
  5: 6, // PointerEvent
};
const SET_ENCODINGS = 2;
const CLIENT_CUT_TEXT = 6;

type Phase = 'idle' | 'version' | 'security' | 'clientInit' | 'streaming' | 'closed';

/** ws readyState values, named rather than repeated as bare numbers. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * Whether one server message gives noVNC picture content to paint.
 *
 * Type 0 is FramebufferUpdate and bytes 2..3 carry its rectangle count. A
 * zero-rectangle update is a legal keepalive, but hiding the connecting state
 * for one would expose the same empty canvas the loading treatment prevents.
 */
export function hasFramebufferRectangles(message: Uint8Array): boolean {
  return (
    message.length >= 4 && message[0] === 0 && ((message[2] ?? 0) !== 0 || (message[3] ?? 0) !== 0)
  );
}

export interface RfbChannelOptions {
  readonly widthPx: number;
  readonly heightPx: number;
  /** Shown by noVNC as the desktop name; cosmetic. */
  readonly name?: string;
  /**
   * A client message noVNC sent that this shim did not consume. Never expected
   * — every message noVNC can send at this point has a known size — so it
   * means a desync, and the caller should tear the viewer down rather than
   * render whatever comes next.
   */
  readonly onProtocolError?: (reason: string) => void;
  /** One complete KeyEvent or PointerEvent produced by noVNC. */
  readonly onInput?: (message: Uint8Array) => void;
}

/**
 * The subset of `WebSocket` noVNC's `Websock.attach` requires. It checks for
 * each of these by name and throws if one is missing, so the list is a
 * contract rather than a convenience.
 */
export interface RawChannel {
  binaryType: string;
  protocol: string;
  readonly readyState: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(): void;
}

export class RfbChannel implements RawChannel {
  binaryType = 'arraybuffer';
  protocol = '';

  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;

  private phase: Phase = 'idle';
  /** Partial client message carried across `send` calls. */
  private inbound: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  /** Messages waiting to reach noVNC; see `emit` for why they wait. */
  private readonly outbox: Uint8Array[] = [];
  private draining = false;
  private readonly options: RfbChannelOptions;

  constructor(options: RfbChannelOptions) {
    this.options = options;
  }

  /**
   * CONNECTING until `start`, exactly as a real WebSocket would report.
   *
   * Not cosmetic. noVNC's `_connect` calls `_socketOpen` ITSELF when the
   * channel it was handed is already open — so a shim that reports OPEN from
   * construction gets opened twice: once by noVNC, once by `start`. The
   * second one arrives with the handshake already begun and noVNC fails the
   * connection with "Unexpected server connection while connecting", having
   * never drawn anything.
   */
  get readyState(): number {
    if (this.phase === 'closed') return CLOSED;
    return this.phase === 'idle' ? CONNECTING : OPEN;
  }

  /** True once the synthetic handshake is finished and frames can be delivered. */
  get isStreaming(): boolean {
    return this.phase === 'streaming';
  }

  /**
   * Begin the synthetic handshake.
   *
   * Separate from the constructor because noVNC installs its handlers inside
   * `new RFB(...)`, so anything emitted before that call returns is delivered
   * to `null`. An explicit call is a timing contract; a `queueMicrotask` in the
   * constructor would be a timing accident.
   */
  start(): void {
    if (this.phase !== 'idle') return;
    this.phase = 'version';
    this.onopen?.();
    this.emit(encodeAscii(PROTOCOL_VERSION));
  }

  /** One complete server message from the orchestrator, forwarded verbatim. */
  deliver(message: Uint8Array): void {
    if (this.phase !== 'streaming') return;
    this.emit(message);
  }

  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.onclose?.({ code: 1000, reason: 'viewer closed' });
  }

  /** noVNC writing to what it believes is a socket. */
  send(data: ArrayBufferView | ArrayBuffer): void {
    if (this.phase === 'closed') return;
    this.inbound = concat(this.inbound, toBytes(data));
    // A loop, not a single parse: noVNC flushes a queue, so one `send` can
    // carry SetPixelFormat, SetEncodings and an update request together.
    for (;;) {
      const consumed = this.consume();
      if (consumed === 0) return;
      this.inbound = this.inbound.subarray(consumed);
    }
  }

  /** Bytes consumed, or 0 when the buffer holds no complete message yet. */
  private consume(): number {
    const bytes: Uint8Array<ArrayBuffer> = this.inbound;
    if (bytes.length === 0) return 0;

    switch (this.phase) {
      case 'version': {
        if (bytes.length < 12) return 0;
        // The version noVNC echoes is not checked: it necessarily matches,
        // because this shim is the only thing that ever offered one.
        this.phase = 'security';
        this.emit(new Uint8Array([1, SECURITY_TYPE_NONE]));
        return 12;
      }
      case 'security': {
        const chosen = bytes[0] as number;
        if (chosen !== SECURITY_TYPE_NONE) {
          this.fail(`noVNC chose security type ${chosen}; only None is offered`);
          return 0;
        }
        this.phase = 'clientInit';
        this.emit(new Uint8Array([0, 0, 0, 0])); // SecurityResult: OK
        return 1;
      }
      case 'clientInit': {
        // The shared flag is ignored: sharing was decided on the upstream
        // connection, which this viewer is one of several readers of.
        this.phase = 'streaming';
        this.emit(this.serverInit());
        return 1;
      }
      case 'streaming':
        return this.consumeClientMessage(bytes);
      default:
        return 0;
    }
  }

  private consumeClientMessage(bytes: Uint8Array<ArrayBuffer>): number {
    const type = bytes[0] as number;

    const fixed = CLIENT_MESSAGE_SIZES[type];
    if (fixed !== undefined) {
      if (bytes.length < fixed) return 0;
      // Configuration and update requests belong to the shared upstream and
      // stay swallowed here. Human input is the only client traffic D-036
      // permits, one exact RFB message per binary WebSocket frame.
      if (type === 4 || type === 5) this.options.onInput?.(bytes.slice(0, fixed));
      return fixed;
    }

    if (type === SET_ENCODINGS) {
      if (bytes.length < 4) return 0;
      const count = readUint16(bytes, 2);
      const size = 4 + count * 4;
      return bytes.length < size ? 0 : size;
    }
    if (type === CLIENT_CUT_TEXT) {
      if (bytes.length < 8) return 0;
      const size = 8 + readUint32(bytes, 4);
      return bytes.length < size ? 0 : size;
    }

    // Nothing else can arrive: noVNC only sends the extended messages after a
    // server confirms the matching pseudo-encoding, and this shim never does.
    // If one does, the stream position is unknown from here on.
    this.fail(`unsupported RFB client message type ${type}`);
    return 0;
  }

  /** RFC 6143 §7.3.2 — geometry, pixel format, then the desktop name. */
  private serverInit(): Uint8Array<ArrayBuffer> {
    const name = encodeUtf8(this.options.name ?? 'crewaid sandbox');
    const message = new Uint8Array(24 + name.length);
    const view = new DataView(message.buffer);
    view.setUint16(0, this.options.widthPx);
    view.setUint16(2, this.options.heightPx);
    view.setUint8(4, SCREEN_PIXEL_FORMAT.bitsPerPixel);
    view.setUint8(5, SCREEN_PIXEL_FORMAT.depth);
    view.setUint8(6, SCREEN_PIXEL_FORMAT.bigEndian);
    view.setUint8(7, SCREEN_PIXEL_FORMAT.trueColour);
    view.setUint16(8, SCREEN_PIXEL_FORMAT.redMax);
    view.setUint16(10, SCREEN_PIXEL_FORMAT.greenMax);
    view.setUint16(12, SCREEN_PIXEL_FORMAT.blueMax);
    view.setUint8(14, SCREEN_PIXEL_FORMAT.redShift);
    view.setUint8(15, SCREEN_PIXEL_FORMAT.greenShift);
    view.setUint8(16, SCREEN_PIXEL_FORMAT.blueShift);
    // bytes 17-19 padding
    view.setUint32(20, name.length);
    message.set(name, 24);
    return message;
  }

  private fail(reason: string): void {
    this.inbound = new Uint8Array(0);
    this.options.onProtocolError?.(reason);
    this.onerror?.(new Error(reason));
    this.close();
  }

  /**
   * Hand one message to noVNC — on a later microtask, never synchronously.
   *
   * This is the difference between a shim and a socket, and it is not a
   * nicety. Every emit here is a REPLY to something noVNC just sent, so
   * delivering it inline would call noVNC's message handler from inside its
   * own `send`. Its receive queue is being mutated by the outer frame at
   * that moment, and the nested read leaves `_rQi`/`_rQlen` inconsistent: the
   * handshake gets exactly as far as the security list and then stops, with no
   * error anywhere — noVNC simply never answers.
   *
   * A real WebSocket cannot do this to you, because delivery is always a
   * separate task. Queueing restores that guarantee, and the queue also keeps
   * ordering: a screen frame that arrives mid-handshake is delivered after the
   * ServerInit rather than in front of it.
   */
  private emit(bytes: Uint8Array): void {
    this.outbox.push(bytes);
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    this.draining = false;
    for (;;) {
      const next = this.outbox.shift();
      if (next === undefined) return;
      if (this.phase === 'closed') {
        this.outbox.length = 0;
        return;
      }
      // A fresh ArrayBuffer, not `bytes.buffer`: every payload here is a view
      // into a larger allocation, and handing over the backing store would
      // give noVNC the neighbouring bytes as well.
      this.onmessage?.({ data: copyToArrayBuffer(next) });
    }
  }
}

/**
 * Always a copy into a plain `ArrayBuffer`. noVNC's queue is reused between
 * flushes, so a view onto it would change under a partial message held across
 * two `send` calls — and the copy is what keeps `SharedArrayBuffer` out of the
 * buffered type, which the rest of this file relies on.
 */
function toBytes(data: ArrayBufferView | ArrayBuffer): Uint8Array<ArrayBuffer> {
  const view =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy;
}

function concat(
  left: Uint8Array<ArrayBuffer>,
  right: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  if (left.length === 0) return right;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) * 0x1000000 +
    (((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number))
  );
}

function encodeAscii(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
