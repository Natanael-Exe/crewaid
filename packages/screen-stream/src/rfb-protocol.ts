import { SCREEN_PIXEL_FORMAT } from '@crewaid/shared';

/**
 * RFB (RFC 6143) wire helpers for the §4.3 screen transport — pure, no I/O.
 *
 * Everything here is bytes in, bytes or offsets out, so the part of the proxy
 * that is easy to get subtly wrong is also the part that needs no socket and
 * no container to test.
 *
 * Why a scanner exists at all
 *
 * §4.3 forwards raw server messages with no transcoding, so nothing here
 * decodes a pixel. But TCP is a byte stream with no message boundaries, and
 * §4.3 also multiplexes ONE upstream connection to MANY subscribers. A client
 * that subscribes mid-stream must start on a message boundary or its decoder
 * desyncs permanently on the first partial frame it is handed.
 *
 * So the proxy has to know where messages END without caring what is in them.
 * `scanServerMessage` walks the structure — rectangle headers, and just enough
 * of each encoding's payload to find its length — and reports the boundary.
 * The bytes themselves are forwarded untouched.
 *
 * Validated against the real x11vnc in the §5 image: 72 complete messages,
 * 208 rectangles, 502 KB, zero leftover bytes, exercising Tight's jpeg, fill
 * and palette+zlib modes.
 */

/** The only version this proxy speaks. x11vnc in the §5 image offers exactly this. */
export const RFB_PROTOCOL_VERSION = 'RFB 003.008\n';

/** `x11vnc -nopw` offers exactly one security type, and this is it. */
export const SECURITY_TYPE_NONE = 1;

/** Server → client message types (RFC 6143 §7.6). */
export const ServerMessage = {
  framebufferUpdate: 0,
  setColourMapEntries: 1,
  bell: 2,
  serverCutText: 3,
} as const;

/** Client → server message types (RFC 6143 §7.5). */
export const ClientMessage = {
  setPixelFormat: 0,
  setEncodings: 2,
  framebufferUpdateRequest: 3,
  keyEvent: 4,
  pointerEvent: 5,
} as const;

/**
 * The encodings this proxy asks for, and therefore the only ones the scanner
 * can encounter. A server may not send an encoding the client never offered,
 * so this list and the scanner's switch are two halves of one decision —
 * change one and the other stops being able to find a boundary.
 *
 * Deliberately absent:
 * - LastRect (-224). It replaces the rectangle count with a 0xFFFF sentinel
 * and an in-band terminator. Advertising it buys nothing here and costs
 * the scanner an extra way to be wrong; without it the count is exact.
 * (The real server does switch to the sentinel the moment it is offered —
 * measured, not assumed.)
 * - DesktopSize (-223). §5 fixes the geometry for the container's lifetime,
 * so a resize rectangle would be a contract violation, not a feature.
 */
export const Encoding = {
  raw: 0,
  copyRect: 1,
  tight: 7,
  /**
   * RichCursor (-239): the pointer's current shape in full colour, drawn by
   * the client.
   *
   * Advertised for the operator's cursor, not for pixels. noVNC starts every
   * connection with an EMPTY cursor image, which it renders as `cursor: none`
   * — so until a server shape arrives, the pointer vanishes over the viewer's
   * canvas the moment the rail's expand button stops covering it. x11vnc
   * sends shapes only to clients that asked, and its fallback (baking the
   * cursor into framebuffer pixels) shows nothing on a static desktop —
   * which is how "the cursor disappeared when I went full screen" happened,
   * and why clicking around seemed to bring it back: a click repaints the
   * region under the pointer, cursor baked in.
   */
  richCursor: -239,
} as const;

/**
 * A cursor shape's transparency mask: one bit per pixel, each row padded to a
 * whole byte. Part of the RichCursor payload's length, alongside the pixels.
 */
const cursorMaskBytes = (width: number, height: number): number => ((width + 7) >> 3) * height;

/** JPEG quality pseudo-encodings are -32..-23 for levels 0..9. */
const QUALITY_LEVEL_BASE = -32;
/** zlib compression pseudo-encodings are -256..-247 for levels 0..9. */
const COMPRESSION_LEVEL_BASE = -256;

/**
 * Tight's compression level. Fixed rather than exposed: WebSocket gives the client
 * a `quality` knob and no compression knob, and inventing a second one would
 * be inventing wire contract. Six is TightVNC's own default — the knee of the
 * curve, where more CPU stops buying meaningful bandwidth.
 */
const TIGHT_COMPRESSION_LEVEL = 6;

export const MIN_QUALITY = 0;
export const MAX_QUALITY = 9;

/**
 * The pixel format the proxy pins with SetPixelFormat.
 *
 * The VALUES live in `@crewaid/shared` because the renderer's noVNC channel
 * depends on them too and cannot ask what they are — it swallows noVNC's own
 * SetPixelFormat, so the two ends agree by importing one constant or not at
 * all. The reasoning for the shifts is written down there.
 *
 * What matters HERE is the widths: TPIXEL — the per-pixel size inside every
 * Tight rectangle — is 3 bytes ONLY for a 32bpp true-colour format whose three
 * maxima are 255. A build reporting something else would silently change
 * TPIXEL and desync the scanner on the first fill rectangle, so pinning makes
 * the assumption the scanner depends on a thing we assert, not inherit.
 */
export const PIXEL_FORMAT = SCREEN_PIXEL_FORMAT;

/** Bytes per pixel in a Raw rectangle. */
const BYTES_PER_PIXEL = PIXEL_FORMAT.bitsPerPixel / 8;

/**
 * Tight's compact pixel: the three colour bytes without the padding byte.
 * True only because `PIXEL_FORMAT` is 32bpp/depth-24 with all maxima 255.
 */
const TPIXEL_BYTES = 3;

/** Tight compression-control modes, read from the high nibble. */
const TIGHT_MODE_FILL = 0x08;
const TIGHT_MODE_JPEG = 0x09;
/** 0x0A is PNG, which only TightPNG servers send, and we never offer it. */
const TIGHT_MODE_MIN_INVALID = 0x0a;
/** Within basic mode, this bit of the high nibble means a filter id follows. */
const TIGHT_BASIC_FILTER_FLAG = 0x04;

const TIGHT_FILTER_COPY = 0;
const TIGHT_FILTER_PALETTE = 1;
const TIGHT_FILTER_GRADIENT = 2;

/**
 * Below this, Tight sends basic-mode data uncompressed — zlib's own overhead
 * would exceed the payload. The threshold is part of the format, not a tuning
 * choice: read it wrong and every small rectangle desyncs.
 */
const TIGHT_MIN_TO_COMPRESS = 12;

/** Geometry the scanner needs to size a Raw rectangle. */
export interface ScreenGeometry {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface ServerInit {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly name: string;
}

/** Thrown for a stream that cannot be a legal RFB message under our encodings. */
export class RfbProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RfbProtocolError';
  }
}

/** Signals "not enough bytes yet", which is a normal state, not a failure. */
class Incomplete extends Error {}

/**
 * A cursor that throws `Incomplete` rather than reading past the end, so the
 * scanner can be written as straight-line structure walking instead of a
 * length check before every field.
 */
class Cursor {
  offset = 0;
  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.offset + n > this.buf.length) throw new Incomplete();
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }

  u16(): number {
    this.need(2);
    const value = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.need(4);
    const value = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  skip(n: number): void {
    // A negative or absurd length is a desync, not a short read: without this
    // a corrupt length would rewind the cursor and loop forever.
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new RfbProtocolError(`refusing to skip ${n} bytes — the stream is desynchronised`);
    }
    this.need(n);
    this.offset += n;
  }

  /** Tight's 1–3 byte length, 7 bits per byte, high bit = continue. */
  compactLength(): number {
    let byte = this.u8();
    let length = byte & 0x7f;
    if ((byte & 0x80) !== 0) {
      byte = this.u8();
      length |= (byte & 0x7f) << 7;
      if ((byte & 0x80) !== 0) {
        byte = this.u8();
        length |= byte << 14;
      }
    }
    return length;
  }
}

/**
 * The length of ONE complete server message at the head of `buf`, or `null`
 * when the message has not fully arrived. Never consumes; the caller slices.
 *
 * Throws `RfbProtocolError` only for bytes that cannot be a legal message
 * under the encodings we offered — that is a desync or a server bug, and
 * continuing past it would forward garbage to every subscriber.
 */
export function scanServerMessage(buf: Buffer): number | null {
  const cursor = new Cursor(buf);
  try {
    const type = cursor.u8();
    switch (type) {
      case ServerMessage.framebufferUpdate:
        scanFramebufferUpdate(cursor);
        break;
      case ServerMessage.setColourMapEntries: {
        cursor.skip(3);
        const count = cursor.u16();
        cursor.skip(count * 6);
        break;
      }
      case ServerMessage.bell:
        break;
      case ServerMessage.serverCutText: {
        cursor.skip(3);
        cursor.skip(cursor.u32());
        break;
      }
      default:
        throw new RfbProtocolError(`unknown server message type ${type}`);
    }
    return cursor.offset;
  } catch (error: unknown) {
    if (error instanceof Incomplete) return null;
    throw error;
  }
}

function scanFramebufferUpdate(cursor: Cursor): void {
  cursor.skip(1); // padding
  const rectangles = cursor.u16();
  // 0xFFFF is LastRect's sentinel count. We never advertise LastRect, so a
  // server sending it has ignored our SetEncodings — worth naming exactly,
  // because the symptom otherwise is 65535 rectangles of nonsense.
  if (rectangles === 0xffff) {
    throw new RfbProtocolError(
      'server used the LastRect sentinel count, which this client never advertised',
    );
  }

  for (let index = 0; index < rectangles; index += 1) {
    cursor.skip(4); // x, y
    const width = cursor.u16();
    const height = cursor.u16();
    const encoding = cursor.i32();

    switch (encoding) {
      case Encoding.raw:
        cursor.skip(width * height * BYTES_PER_PIXEL);
        break;
      case Encoding.copyRect:
        cursor.skip(4); // src-x, src-y
        break;
      case Encoding.tight:
        scanTightRectangle(cursor, width, height);
        break;
      case Encoding.richCursor:
        // RFC 6143 §7.7.5: the shape's pixels in the pinned 32bpp format,
        // then the transparency mask. The rectangle's x/y ARE the hotspot —
        // there is no trailing position field to skip. Forwarded untouched;
        // the renderer's noVNC draws the operator's cursor from it.
        cursor.skip(width * height * BYTES_PER_PIXEL + cursorMaskBytes(width, height));
        break;
      default:
        throw new RfbProtocolError(
          `server sent encoding ${encoding}, which this client never advertised`,
        );
    }
  }
}

function scanTightRectangle(cursor: Cursor, width: number, height: number): void {
  const control = cursor.u8();
  // The low nibble only resets zlib streams; the high nibble picks the mode.
  const mode = control >> 4;

  if (mode === TIGHT_MODE_FILL) {
    cursor.skip(TPIXEL_BYTES);
    return;
  }
  if (mode === TIGHT_MODE_JPEG) {
    cursor.skip(cursor.compactLength());
    return;
  }
  if (mode >= TIGHT_MODE_MIN_INVALID) {
    throw new RfbProtocolError(`invalid tight compression-control byte 0x${control.toString(16)}`);
  }

  const filter = (mode & TIGHT_BASIC_FILTER_FLAG) !== 0 ? cursor.u8() : TIGHT_FILTER_COPY;

  let uncompressed: number;
  switch (filter) {
    case TIGHT_FILTER_PALETTE: {
      const colours = cursor.u8() + 1;
      cursor.skip(colours * TPIXEL_BYTES);
      // Two colours pack one bit per pixel, row-aligned to a byte; more than
      // two use a byte-wide index per pixel.
      uncompressed = colours <= 2 ? Math.ceil(width / 8) * height : width * height;
      break;
    }
    case TIGHT_FILTER_COPY:
    case TIGHT_FILTER_GRADIENT:
      uncompressed = width * height * TPIXEL_BYTES;
      break;
    default:
      throw new RfbProtocolError(`unknown tight filter id ${filter}`);
  }

  if (uncompressed < TIGHT_MIN_TO_COMPRESS) {
    cursor.skip(uncompressed);
    return;
  }
  cursor.skip(cursor.compactLength());
}

/** `RFB 003.008\n` → the version the peer offered, unparsed but length-checked. */
export function parseProtocolVersion(buf: Buffer): string {
  if (buf.length !== 12) {
    throw new RfbProtocolError(`ProtocolVersion must be 12 bytes, got ${buf.length}`);
  }
  return buf.toString('ascii');
}

/** ServerInit is 24 fixed bytes plus a name; the caller reads the name separately. */
export const SERVER_INIT_FIXED_BYTES = 24;

export function parseServerInitHeader(buf: Buffer): {
  init: Omit<ServerInit, 'name'>;
  nameLength: number;
} {
  if (buf.length < SERVER_INIT_FIXED_BYTES) {
    throw new RfbProtocolError(`ServerInit header must be ${SERVER_INIT_FIXED_BYTES} bytes`);
  }
  return {
    init: { widthPx: buf.readUInt16BE(0), heightPx: buf.readUInt16BE(2) },
    nameLength: buf.readUInt32BE(20),
  };
}

export function encodeClientInit(shared: boolean): Buffer {
  // Shared: §4.3 holds one connection per sandbox, but a non-shared client
  // makes the server hang up on every OTHER viewer, which would turn a stray
  // `vncviewer` during debugging into a silent disconnect for the operator.
  return Buffer.from([shared ? 1 : 0]);
}

export function encodeSetPixelFormat(): Buffer {
  const message = Buffer.alloc(20);
  message.writeUInt8(ClientMessage.setPixelFormat, 0);
  // bytes 1-3 padding
  message.writeUInt8(PIXEL_FORMAT.bitsPerPixel, 4);
  message.writeUInt8(PIXEL_FORMAT.depth, 5);
  message.writeUInt8(PIXEL_FORMAT.bigEndian, 6);
  message.writeUInt8(PIXEL_FORMAT.trueColour, 7);
  message.writeUInt16BE(PIXEL_FORMAT.redMax, 8);
  message.writeUInt16BE(PIXEL_FORMAT.greenMax, 10);
  message.writeUInt16BE(PIXEL_FORMAT.blueMax, 12);
  message.writeUInt8(PIXEL_FORMAT.redShift, 14);
  message.writeUInt8(PIXEL_FORMAT.greenShift, 15);
  message.writeUInt8(PIXEL_FORMAT.blueShift, 16);
  // bytes 17-19 padding
  return message;
}

/**
 * SetEncodings carrying the real encodings then the quality/compression
 * pseudo-encodings. Order matters: a server picks the first encoding it
 * supports, so Tight must precede the fallbacks.
 */
export function encodeSetEncodings(quality: number): Buffer {
  if (!Number.isInteger(quality) || quality < MIN_QUALITY || quality > MAX_QUALITY) {
    throw new RfbProtocolError(`quality must be an integer ${MIN_QUALITY}..${MAX_QUALITY}`);
  }
  const encodings = [
    Encoding.tight,
    Encoding.copyRect,
    Encoding.raw,
    // A pseudo-encoding, not a pixel format: advertising it turns cursor
    // shapes on. Order after `tight` matters for the pixel encodings — a
    // server takes the first it knows — and is irrelevant to this one.
    Encoding.richCursor,
    QUALITY_LEVEL_BASE + quality,
    COMPRESSION_LEVEL_BASE + TIGHT_COMPRESSION_LEVEL,
  ];
  const message = Buffer.alloc(4 + encodings.length * 4);
  message.writeUInt8(ClientMessage.setEncodings, 0);
  message.writeUInt16BE(encodings.length, 2);
  encodings.forEach((encoding, index) => message.writeInt32BE(encoding, 4 + index * 4));
  return message;
}

export function encodeFramebufferUpdateRequest(
  geometry: ScreenGeometry,
  incremental: boolean,
): Buffer {
  const message = Buffer.alloc(10);
  message.writeUInt8(ClientMessage.framebufferUpdateRequest, 0);
  message.writeUInt8(incremental ? 1 : 0, 1);
  message.writeUInt16BE(0, 2);
  message.writeUInt16BE(0, 4);
  message.writeUInt16BE(geometry.widthPx, 6);
  message.writeUInt16BE(geometry.heightPx, 8);
  return message;
}

/** Reset all four Tight dictionaries before a fresh upstream's full repaint.
 * The one-pixel fill is immediately overwritten by that repaint. No upstream
 * pixel payload is decoded or re-encoded.
 */
export function encodeTightReset(): Buffer {
  const message = Buffer.alloc(20);
  message.writeUInt16BE(1, 2);
  message.writeUInt16BE(1, 8);
  message.writeUInt16BE(1, 10);
  message.writeInt32BE(Encoding.tight, 12);
  message[16] = 0x8f;
  return message;
}
