import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

import {
  CROP_PX,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_PIXELS,
  cropScreenshot,
  cropWindow,
  readPngHeader,
} from '../src/recordings/png-crop.js';

/**
 * M3-BE-04 — the 200x200 crop PRD §6/M3 stores on every button-down.
 *
 * Everything here is pure. The geometry is where the edge cases are, and a
 * click in a corner needs no bridge, no sandbox and no file to be wrong.
 */

/**
 * Every pixel carries its own index, split little-endian across RGB, so any
 * pixel of a crop can be traced back to the framebuffer coordinate it came
 * from. A 1280x800 desktop indexes to 1,023,999 — comfortably inside 24 bits,
 * so the encoding is exact rather than a hash that could collide.
 */
function paint(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const at = index * 4;
      png.data[at] = index & 0xff;
      png.data[at + 1] = (index >> 8) & 0xff;
      png.data[at + 2] = (index >> 16) & 0xff;
      png.data[at + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** The framebuffer coordinates the pixel at (x, y) of a crop came from. */
function sourceOf(png: PNG, x: number, y: number, sourceWidth: number): { x: number; y: number } {
  const at = (y * png.width + x) * 4;
  const index = png.data[at]! + (png.data[at + 1]! << 8) + (png.data[at + 2]! << 16);
  return { x: index % sourceWidth, y: Math.floor(index / sourceWidth) };
}

/** §5.1 provisions this; the numbers below are chosen against it. */
const SCREEN = { width: 1280, height: 800 };

describe('cropWindow — PRD §6/M3 "200x200 centered on the click point"', () => {
  it('centers the window on a click with room around it', () => {
    const rect = cropWindow(640, 400, SCREEN.width, SCREEN.height);

    expect(rect).toEqual({ x: 540, y: 300, width: CROP_PX, height: CROP_PX });
  });

  it('keeps the click inside the window it clamps at an edge', () => {
    // 10px from the left edge: centering would start at -90, which is not a
    // framebuffer coordinate.
    const rect = cropWindow(10, 400, SCREEN.width, SCREEN.height);

    expect(rect.x).toBe(0);
    expect(rect.width).toBe(CROP_PX);
    // The click is still shown — off-center, but present, which is the whole
    // reason the window slides rather than shrinking.
    expect(10).toBeGreaterThanOrEqual(rect.x);
    expect(10).toBeLessThan(rect.x + rect.width);
  });

  it('clamps against the far edges too', () => {
    const rect = cropWindow(SCREEN.width - 1, SCREEN.height - 1, SCREEN.width, SCREEN.height);

    // Flush with the bottom-right corner, and still a full 200x200 of real
    // pixels: no padding, which would read to a model as screen content.
    expect(rect).toEqual({
      x: SCREEN.width - CROP_PX,
      y: SCREEN.height - CROP_PX,
      width: CROP_PX,
      height: CROP_PX,
    });
  });

  it('stays inside the framebuffer for a click outside it', () => {
    // §4.3's validator deliberately does not clamp coordinates — an
    // out-of-range pointer is legal RFB — so this layer is the one that has
    // the geometry to decide.
    const beyond = cropWindow(99_999, 99_999, SCREEN.width, SCREEN.height);
    const negative = cropWindow(-500, -500, SCREEN.width, SCREEN.height);

    expect(beyond).toEqual({
      x: SCREEN.width - CROP_PX,
      y: SCREEN.height - CROP_PX,
      width: CROP_PX,
      height: CROP_PX,
    });
    expect(negative).toEqual({ x: 0, y: 0, width: CROP_PX, height: CROP_PX });
  });

  it('always lands on a whole pixel', () => {
    const rect = cropWindow(640.6, 400.4, SCREEN.width, SCREEN.height);

    // The origin is handed to `PNG.bitblt` as an offset into a pixel array,
    // where a fraction is not a position between two pixels — it is an index
    // into the middle of a channel.
    expect(rect).toEqual({ x: 541, y: 300, width: CROP_PX, height: CROP_PX });
    expect(Number.isInteger(rect.x)).toBe(true);
    expect(Number.isInteger(rect.y)).toBe(true);
  });

  it('never asks for more pixels than the framebuffer has', () => {
    const rect = cropWindow(30, 20, 64, 48);

    // A desktop smaller than the crop yields the whole desktop rather than a
    // request the decoder would refuse.
    expect(rect).toEqual({ x: 0, y: 0, width: 64, height: 48 });
  });
});

describe('readPngHeader — the decode gate', () => {
  it('reads the dimensions a real PNG declares', () => {
    expect(readPngHeader(paint(320, 240))).toEqual({ width: 320, height: 240 });
  });

  it('refuses dimensions that would allocate more than the cap', () => {
    // A decompression bomb: a few bytes of header claiming a framebuffer whose
    // RGBA buffer is gigabytes. The sandbox is the untrusted side of this
    // connection (§7.3), and the orchestrator supervises every other bot.
    const bomb = Buffer.concat([paint(1, 1).subarray(0, 16), Buffer.alloc(8)]);
    bomb.writeUInt32BE(30_000, 16);
    bomb.writeUInt32BE(30_000, 20);

    expect(() => readPngHeader(bomb)).toThrow(/30000x30000/);
    expect(30_000 * 30_000).toBeGreaterThan(MAX_SCREENSHOT_PIXELS);
  });

  it('bounds the memory, not the shape', () => {
    // 8192x100 is 819,200 pixels — a rounding error against the cap, and
    // refused by any per-axis bound tight enough to bound the same memory.
    // The gate exists to stop an allocation, not to have an opinion about
    // aspect ratio.
    const strip = Buffer.concat([paint(1, 1).subarray(0, 16), Buffer.alloc(8)]);
    strip.writeUInt32BE(8192, 16);
    strip.writeUInt32BE(100, 20);

    expect(readPngHeader(strip)).toEqual({ width: 8192, height: 100 });
    expect(8192 * 100).toBeLessThan(MAX_SCREENSHOT_PIXELS);
  });

  it('refuses an empty framebuffer', () => {
    const empty = Buffer.concat([paint(1, 1).subarray(0, 16), Buffer.alloc(8)]);
    empty.writeUInt32BE(0, 16);
    empty.writeUInt32BE(0, 20);

    expect(() => readPngHeader(empty)).toThrow(/empty 0x0/);
  });

  it('refuses bytes that are not a PNG at all', () => {
    expect(() => readPngHeader(Buffer.from('<html>not a screenshot</html>'))).toThrow(/not a PNG/);
    expect(() => readPngHeader(Buffer.alloc(4))).toThrow(/not a PNG/);
  });

  it('refuses a PNG that stops inside its own header', () => {
    // Signature, length, "IHDR", width — and then the response ended. Without
    // this the height read runs off the end and reports a RangeError.
    const truncated = paint(64, 48).subarray(0, 20);

    expect(() => readPngHeader(Buffer.from(truncated))).toThrow(/truncated: 20 bytes/);
  });

  it('refuses a PNG whose first chunk is not IHDR', () => {
    const shuffled = Buffer.from(paint(8, 8));
    shuffled.write('IDAT', 12, 'latin1');

    expect(() => readPngHeader(shuffled)).toThrow(/no IHDR chunk/);
  });

  it('refuses a body over the byte cap before it looks at anything else', () => {
    const huge = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1);

    expect(() => readPngHeader(huge)).toThrow(/over the \d+ cap/);
  });
});

describe('cropScreenshot — what actually lands on disk', () => {
  it('cuts the window around the click out of the framebuffer', () => {
    const { png, rect } = cropScreenshot(paint(SCREEN.width, SCREEN.height), 640, 400);
    const cropped = PNG.sync.read(png);

    expect(rect).toEqual({ x: 540, y: 300, width: CROP_PX, height: CROP_PX });
    expect(cropped.width).toBe(CROP_PX);
    expect(cropped.height).toBe(CROP_PX);
    // The pixels are the source's, at the offset the rect names — the crop is
    // a cut, not a resize.
    expect(sourceOf(cropped, 0, 0, SCREEN.width)).toEqual({ x: 540, y: 300 });
    expect(sourceOf(cropped, 100, 100, SCREEN.width)).toEqual({ x: 640, y: 400 });
    expect(sourceOf(cropped, 199, 199, SCREEN.width)).toEqual({ x: 739, y: 499 });
  });

  it('reports the origin a clamped crop was taken from', () => {
    const { png, rect } = cropScreenshot(paint(SCREEN.width, SCREEN.height), 4, 7);
    const cropped = PNG.sync.read(png);

    // The click is at (4, 7) of the crop, not at its center. That offset is
    // exactly what `rect` exists to make recoverable — nothing downstream
    // should re-derive the clamp.
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(sourceOf(cropped, 4, 7, SCREEN.width)).toEqual({ x: 4, y: 7 });
  });

  it('crops a desktop smaller than 200x200 to itself', () => {
    const { png, rect } = cropScreenshot(paint(64, 48), 30, 20);
    const cropped = PNG.sync.read(png);

    expect(rect).toEqual({ x: 0, y: 0, width: 64, height: 48 });
    expect(cropped.width).toBe(64);
    expect(cropped.height).toBe(48);
  });

  it('refuses an oversize declaration before decoding it', () => {
    const bomb = Buffer.concat([paint(1, 1).subarray(0, 16), Buffer.alloc(8)]);
    bomb.writeUInt32BE(30_000, 16);
    bomb.writeUInt32BE(30_000, 20);

    expect(() => cropScreenshot(bomb, 0, 0)).toThrow(/decode cap/);
  });
});
