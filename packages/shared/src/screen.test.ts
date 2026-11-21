import { describe, expect, it } from 'vitest';

import {
  decodeScreenBinaryFrame,
  encodeScreenBinaryFrame,
  SCREEN_FRAME_MAX_BOT_ID_BYTES,
  SCREEN_PIXEL_FORMAT,
} from './screen.js';

/**
 * D-035 — the §4.3 binary envelope.
 *
 * The header is three lines of code and the only thing standing between a
 * click and the wrong bot's desktop, so it is tested at the boundaries rather
 * than on the happy path alone.
 */
describe('screen binary framing (D-035)', () => {
  const botId = 'cmtk4b0x20009a03bc8vtxx0w';
  const pointer = new Uint8Array([5, 1, 0, 100, 0, 200]);

  it('round-trips a bot id and an RFB message', () => {
    const decoded = decodeScreenBinaryFrame(encodeScreenBinaryFrame(botId, pointer));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.botId).toBe(botId);
    expect([...decoded.frame.rfb]).toEqual([...pointer]);
  });

  it('leaves the RFB message byte-identical (§4.3: no transcoding)', () => {
    const jpegish = new Uint8Array(4096).map((_, index) => index % 256);
    const frame = encodeScreenBinaryFrame(botId, jpegish);
    expect(frame.length).toBe(1 + botId.length + jpegish.length);

    const decoded = decodeScreenBinaryFrame(frame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Buffer.from(decoded.frame.rfb)).toEqual(Buffer.from(jpegish));
  });

  it('accepts an id exactly at the length ceiling', () => {
    const longest = 'b'.repeat(SCREEN_FRAME_MAX_BOT_ID_BYTES);
    const decoded = decodeScreenBinaryFrame(encodeScreenBinaryFrame(longest, pointer));
    expect(decoded.ok && decoded.frame.botId).toBe(longest);
  });

  it('refuses to encode an id that will not fit the length byte', () => {
    expect(() => encodeScreenBinaryFrame('c'.repeat(65), pointer)).toThrow(/64 bytes/);
    expect(() => encodeScreenBinaryFrame('', pointer)).toThrow(/1\.\.64/);
  });

  it('refuses to encode an empty RFB message', () => {
    expect(() => encodeScreenBinaryFrame(botId, new Uint8Array(0))).toThrow(/at least one byte/);
  });

  it.each([
    ['an empty frame', new Uint8Array(0), /empty/],
    ['a zero-length id', new Uint8Array([0, 5, 1, 0, 0, 0, 0]), /no bot id/],
    ['an id length past the ceiling', new Uint8Array([200, 5]), /exceeds the 64-byte maximum/],
    ['a header with nothing after it', new Uint8Array([2, 65, 66]), /no RFB message/],
    ['a truncated id', new Uint8Array([9, 65, 66]), /no RFB message/],
  ])('rejects %s', (_label, bytes, reason) => {
    const decoded = decodeScreenBinaryFrame(bytes);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toMatch(reason);
  });

  it('rejects an id that is not valid UTF-8 rather than mangling it to U+FFFD', () => {
    // Otherwise a corrupt id decodes to a replacement character, matches no
    // bot, and the sender is told it is "not subscribed" — which sends the
    // reader looking at subscription state instead of at the framing.
    const decoded = decodeScreenBinaryFrame(new Uint8Array([2, 0xc3, 0x28, 5, 0, 0, 0, 0, 0]));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toMatch(/not valid UTF-8/);
  });

  it('does not copy the RFB payload out of the received buffer', () => {
    // The fan-out forwards thousands of these a minute; a copy per frame per
    // subscriber is the kind of cost that only shows up under load.
    const frame = encodeScreenBinaryFrame(botId, pointer);
    const decoded = decodeScreenBinaryFrame(frame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.rfb.buffer).toBe(frame.buffer);
  });
});

describe('screen pixel format', () => {
  it('puts red in byte 0, which is what noVNC decodes Raw into', () => {
    // Deliberate literals, not a comparison against the constant itself: the
    // only thing worth asserting is that these specific numbers survive, and a
    // test that reads them from the value it is checking proves nothing.
    //
    // 32bpp little-endian puts the LOWEST-shifted channel in byte 0, and
    // noVNC's Raw decoder blits those bytes straight into a canvas RGBA buffer.
    // x11vnc's own native format is redShift 16, so "fixing" this back to match
    // the server is the exact mistake this test exists to catch — it renders
    // Raw rectangles with red and blue swapped while Tight, whose TPIXEL order
    // RFC 6143 fixes at R,G,B, keeps looking correct.
    expect(SCREEN_PIXEL_FORMAT.redShift).toBe(0);
    expect(SCREEN_PIXEL_FORMAT.greenShift).toBe(8);
    expect(SCREEN_PIXEL_FORMAT.blueShift).toBe(16);
  });

  it('keeps the widths that make a Tight TPIXEL 3 bytes', () => {
    // The orchestrator's scanner measures Tight rectangles on this assumption;
    // changing any of the four desyncs it on the first fill rectangle.
    expect(SCREEN_PIXEL_FORMAT.bitsPerPixel).toBe(32);
    expect(SCREEN_PIXEL_FORMAT.depth).toBe(24);
    expect(SCREEN_PIXEL_FORMAT.trueColour).toBe(1);
    expect([
      SCREEN_PIXEL_FORMAT.redMax,
      SCREEN_PIXEL_FORMAT.greenMax,
      SCREEN_PIXEL_FORMAT.blueMax,
    ]).toEqual([255, 255, 255]);
  });
});
