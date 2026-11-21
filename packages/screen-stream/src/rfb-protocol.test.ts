import { describe, expect, it } from 'vitest';

import {
  Encoding,
  MAX_QUALITY,
  RfbProtocolError,
  ServerMessage,
  encodeFramebufferUpdateRequest,
  encodeSetEncodings,
  encodeSetPixelFormat,
  scanServerMessage,
} from './rfb-protocol.js';

/**
 * M2-BE-06 — the §4.3 boundary scanner.
 *
 * The proxy forwards raw bytes, so the ONE thing it must get right is where a
 * server message ends. Everything here is about that boundary: a scanner that
 * over-consumes by a byte hands every subscriber a permanently desynchronised
 * stream, and nothing upstream errors to say so.
 *
 * The builders below construct real wire bytes rather than fixtures, so a test
 * that says "a palette rectangle of two colours" is checkable against the spec
 * by reading it.
 */

/** Tight's 1–3 byte length. */
function compactLength(n: number): Buffer {
  const bytes: number[] = [];
  let value = n;
  for (;;) {
    const seven = value & 0x7f;
    value >>>= 7;
    bytes.push(value > 0 ? seven | 0x80 : seven);
    if (value === 0) break;
  }
  return Buffer.from(bytes);
}

function rectHeader(width: number, height: number, encoding: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(width, 4);
  header.writeUInt16BE(height, 6);
  header.writeInt32BE(encoding, 8);
  return header;
}

function framebufferUpdate(...rectangles: Buffer[]): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt8(ServerMessage.framebufferUpdate, 0);
  header.writeUInt16BE(rectangles.length, 2);
  return Buffer.concat([header, ...rectangles]);
}

const tight = {
  fill: (w = 4, h = 4) =>
    Buffer.concat([rectHeader(w, h, Encoding.tight), Buffer.from([0x80]), Buffer.alloc(3)]),
  jpeg: (bytes: number, w = 64, h = 64) =>
    Buffer.concat([
      rectHeader(w, h, Encoding.tight),
      Buffer.from([0x90]),
      compactLength(bytes),
      Buffer.alloc(bytes),
    ]),
  /** Basic, copy filter, payload short enough that Tight sends it uncompressed. */
  basicRaw: (w = 1, h = 3) =>
    Buffer.concat([
      rectHeader(w, h, Encoding.tight),
      Buffer.from([0x40, 0x00]),
      Buffer.alloc(w * h * 3),
    ]),
  basicZlib: (bytes: number, w = 40, h = 40) =>
    Buffer.concat([
      rectHeader(w, h, Encoding.tight),
      Buffer.from([0x40, 0x00]),
      compactLength(bytes),
      Buffer.alloc(bytes),
    ]),
  /** Two-colour palette packs one bit per pixel, each row padded to a byte. */
  palette2: (bytes: number, w = 40, h = 40) =>
    Buffer.concat([
      rectHeader(w, h, Encoding.tight),
      Buffer.from([0x40, 0x01, 0x01]),
      Buffer.alloc(2 * 3),
      compactLength(bytes),
      Buffer.alloc(bytes),
    ]),
  /** More than two colours use a byte-wide index per pixel. */
  paletteN: (colours: number, bytes: number, w = 40, h = 40) =>
    Buffer.concat([
      rectHeader(w, h, Encoding.tight),
      Buffer.from([0x40, 0x01, colours - 1]),
      Buffer.alloc(colours * 3),
      compactLength(bytes),
      Buffer.alloc(bytes),
    ]),
  gradient: (bytes: number, w = 40, h = 40) =>
    Buffer.concat([
      rectHeader(w, h, Encoding.tight),
      Buffer.from([0x40, 0x02]),
      compactLength(bytes),
      Buffer.alloc(bytes),
    ]),
};

const raw = (w: number, h: number) =>
  Buffer.concat([rectHeader(w, h, Encoding.raw), Buffer.alloc(w * h * 4)]);
const copyRect = () => Buffer.concat([rectHeader(8, 8, Encoding.copyRect), Buffer.alloc(4)]);
/** Pixels in the pinned 32bpp format, then the 1-bit mask (rows padded to bytes). */
const richCursor = (w: number, h: number) =>
  Buffer.concat([
    rectHeader(w, h, Encoding.richCursor),
    Buffer.alloc(w * h * 4 + Math.ceil(w / 8) * h),
  ]);

describe('scanServerMessage — message boundaries', () => {
  it('reports the exact length of every server message type', () => {
    const bell = Buffer.from([ServerMessage.bell]);
    expect(scanServerMessage(bell)).toBe(1);

    const cutText = Buffer.concat([
      Buffer.from([ServerMessage.serverCutText, 0, 0, 0]),
      (() => {
        const n = Buffer.alloc(4);
        n.writeUInt32BE(5, 0);
        return n;
      })(),
      Buffer.from('hello', 'ascii'),
    ]);
    expect(scanServerMessage(cutText)).toBe(13);

    const colourMap = Buffer.concat([
      Buffer.from([ServerMessage.setColourMapEntries, 0, 0, 0, 0, 2]),
      Buffer.alloc(2 * 6),
    ]);
    expect(scanServerMessage(colourMap)).toBe(18);
  });

  it.each([
    ['raw', raw(4, 4)],
    ['copyRect', copyRect()],
    ['tight fill', tight.fill()],
    ['tight jpeg', tight.jpeg(300)],
    ['tight basic uncompressed', tight.basicRaw()],
    ['tight basic zlib', tight.basicZlib(500)],
    ['tight palette (2 colours)', tight.palette2(64)],
    ['tight palette (17 colours)', tight.paletteN(17, 700)],
    ['tight gradient', tight.gradient(900)],
    ['rich cursor shape', richCursor(11, 17)],
  ])('consumes a %s rectangle exactly', (_name, rectangle) => {
    const message = framebufferUpdate(rectangle);
    expect(scanServerMessage(message)).toBe(message.length);
  });

  it('walks a cursor shape riding inside a pixel update', () => {
    // x11vnc delivers the cursor as one rectangle among the pixels; the
    // fan-out forwards the whole update untouched, so the scanner only has to
    // find the boundary through it.
    const message = framebufferUpdate(tight.fill(32, 32), richCursor(11, 17), tight.fill(32, 32));
    expect(scanServerMessage(message)).toBe(message.length);
  });

  it('walks a multi-rectangle update of mixed encodings', () => {
    const message = framebufferUpdate(
      tight.jpeg(120),
      copyRect(),
      tight.fill(),
      raw(2, 2),
      tight.palette2(30),
    );
    expect(scanServerMessage(message)).toBe(message.length);
  });

  it('stops at the first message when several are buffered together', () => {
    const first = framebufferUpdate(tight.fill());
    const rest = Buffer.concat([Buffer.from([ServerMessage.bell]), framebufferUpdate(raw(2, 2))]);
    expect(scanServerMessage(Buffer.concat([first, rest]))).toBe(first.length);
  });

  it('reads a three-byte compact length, not just a one-byte one', () => {
    // 2^14 forces the third continuation byte. A scanner that stopped after
    // two would under-read by exactly one byte and desync on large JPEGs —
    // which only appear once the desktop shows a photo, not in a smoke test.
    const message = framebufferUpdate(tight.jpeg(16_384, 640, 480));
    expect(scanServerMessage(message)).toBe(message.length);
  });
});

describe('scanServerMessage — incomplete input', () => {
  it('returns null rather than guessing, for every truncation of a real update', () => {
    const message = framebufferUpdate(tight.jpeg(200), copyRect(), tight.palette2(40));
    for (let length = 0; length < message.length; length += 1) {
      expect(scanServerMessage(message.subarray(0, length))).toBeNull();
    }
    expect(scanServerMessage(message)).toBe(message.length);
  });

  it('treats a rectangle header split across reads as incomplete', () => {
    const message = framebufferUpdate(raw(8, 8));
    expect(scanServerMessage(message.subarray(0, 4 + 7))).toBeNull();
  });
});

describe('scanServerMessage — refusals', () => {
  it('rejects an encoding it never advertised', () => {
    // Hextile. A server should not send it, and forwarding a rectangle whose
    // length we cannot compute would corrupt every following message.
    const message = framebufferUpdate(Buffer.concat([rectHeader(4, 4, 5), Buffer.alloc(16)]));
    expect(() => scanServerMessage(message)).toThrow(RfbProtocolError);
    expect(() => scanServerMessage(message)).toThrow(/never advertised/);
  });

  it('rejects the LastRect sentinel count', () => {
    const header = Buffer.alloc(4);
    header.writeUInt8(ServerMessage.framebufferUpdate, 0);
    header.writeUInt16BE(0xffff, 2);
    expect(() => scanServerMessage(header)).toThrow(/LastRect/);
  });

  it('rejects an unknown server message type', () => {
    expect(() => scanServerMessage(Buffer.from([9]))).toThrow(/unknown server message type 9/);
  });

  it('rejects a reserved tight compression mode', () => {
    // 0x0A is PNG, which only a TightPNG server sends and we never offer.
    const message = framebufferUpdate(
      Buffer.concat([rectHeader(4, 4, Encoding.tight), Buffer.from([0xa0])]),
    );
    expect(() => scanServerMessage(message)).toThrow(/compression-control/);
  });

  it('rejects an unknown tight filter id', () => {
    const message = framebufferUpdate(
      Buffer.concat([rectHeader(4, 4, Encoding.tight), Buffer.from([0x40, 0x09])]),
    );
    expect(() => scanServerMessage(message)).toThrow(/filter id 9/);
  });
});

describe('client messages', () => {
  it('offers tight before its fallbacks, since a server takes the first it knows', () => {
    const message = encodeSetEncodings(6);
    const count = message.readUInt16BE(2);
    const encodings = Array.from({ length: count }, (_, i) => message.readInt32BE(4 + i * 4));
    expect(encodings.slice(0, 3)).toEqual([Encoding.tight, Encoding.copyRect, Encoding.raw]);
    // Quality 6 -> -32 + 6, and the fixed compression level.
    expect(encodings).toContain(-26);
    expect(encodings).toContain(-250);
    // The cursor shape: without it noVNC renders `cursor: none` and the
    // operator's pointer vanishes over the fullscreen canvas.
    expect(encodings).toContain(Encoding.richCursor);
    expect(message.readUInt8(0)).toBe(2);
  });

  it.each([-1, MAX_QUALITY + 1, 1.5, Number.NaN])('refuses quality %s', (quality) => {
    expect(() => encodeSetEncodings(quality)).toThrow(RfbProtocolError);
  });

  it('pins the pixel format the scanner’s 3-byte TPIXEL depends on', () => {
    // If this ever stops being 32bpp true-colour with 255 maxima, Tight's
    // compact pixel stops being three bytes and every fill rectangle desyncs.
    const message = encodeSetPixelFormat();
    expect(message.readUInt8(0)).toBe(0);
    expect(message.readUInt8(4)).toBe(32);
    expect(message.readUInt8(5)).toBe(24);
    expect(message.readUInt8(7)).toBe(1);
    expect([message.readUInt16BE(8), message.readUInt16BE(10), message.readUInt16BE(12)]).toEqual([
      255, 255, 255,
    ]);
  });

  it('asks for the whole screen when the request is not incremental', () => {
    const full = encodeFramebufferUpdateRequest({ widthPx: 1280, heightPx: 800 }, false);
    expect(full.readUInt8(1)).toBe(0);
    expect(full.readUInt16BE(6)).toBe(1280);
    expect(full.readUInt16BE(8)).toBe(800);
    expect(encodeFramebufferUpdateRequest({ widthPx: 1, heightPx: 1 }, true).readUInt8(1)).toBe(1);
  });
});

describe('large Tight compact lengths', () => {
  it('uses all eight bits of the third length byte', () => {
    const payload = Buffer.alloc(1 << 21);
    const frame = framebufferUpdate(
      Buffer.concat([
        rectHeader(1024, 768, Encoding.tight),
        Buffer.from([0x90, 0x80, 0x80, 0x80]),
        payload,
      ]),
    );
    expect(scanServerMessage(frame)).toBe(frame.length);
    expect(scanServerMessage(frame.subarray(0, -1))).toBeNull();
  });
});
