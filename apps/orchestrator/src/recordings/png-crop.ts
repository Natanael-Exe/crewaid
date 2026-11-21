import { PNG } from 'pngjs';

/**
 * The 200x200 crop PRD §6/M3 stores on every button-down.
 *
 * Pure, and deliberately separate from the service that fetches and stores
 * one: the geometry is where every edge case lives — a click in a corner, a
 * click outside the framebuffer, a desktop smaller than the crop — and none of
 * those need a bridge, a sandbox, or a file to be decided.
 */

/** "a 200x200 px crop centered on the click point". */
export const CROP_PX = 200;

/**
 * The largest screenshot this will decode, in pixels.
 *
 * The PNG comes from inside the sandbox, which runs model-driven and
 * user-driven software and is the one component of this system explicitly
 * treated as untrusted. A decoder sizes its output buffer from the
 * dimensions the FILE declares, so a small, valid, highly compressible PNG
 * claiming 30000x30000 expands to gigabytes of RGBA in the orchestrator's
 * heap — the classic decompression bomb, and here it would take down the
 * process that supervises every other bot.
 *
 * The bridge's own 25 MiB cap does not help: that bounds the compressed bytes,
 * and the ratio is the attack. So dimensions are read from IHDR and judged
 * BEFORE any pixel buffer is allocated. 4096x4096 is far above any desktop
 * §5.1 provisions (1280x800) and above 4K, while capping the decoded buffer at
 * about 64 MiB.
 */
export const MAX_SCREENSHOT_PIXELS = 4096 * 4096;

/** Matches the bridge's own `MAX_SCREENSHOT_BYTES`; see `bridge.py`. */
export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signature (8) + length (4) + "IHDR" (4) + width (4) + height (4). */
const IHDR_MINIMUM_BYTES = 24;

/** Where a crop was taken from, in framebuffer pixels. */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The window a crop is taken from, given where the user clicked.
 *
 * Why the window is clamped rather than padded
 *
 * A click within 100 px of an edge cannot have 200x200 of framebuffer around
 * it. Keeping it centered would mean padding the difference, and padding is
 * not neutral: the crop exists to be shown to a model (§6/M3 sends "up to 8
 * screenshot crops from the most ambiguous clicks"), and a black band along
 * one side reads as screen content — a dark sidebar, a letterboxed video —
 * rather than as absence. Sliding the window inside the framebuffer instead
 * keeps all 200x200 pixels real. The click is still inside the crop, just not
 * at its center, which is why the origin is recorded on the event: nothing
 * downstream should have to re-derive this arithmetic to locate the click.
 *
 * The coordinates are not assumed to be on-screen. The validator
 * deliberately does not clamp them — an out-of-range pointer is legal RFB that
 * x11vnc handles — so this is the layer that has the geometry to decide.
 */
export function cropWindow(
  clickX: number,
  clickY: number,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  const width = Math.min(CROP_PX, imageWidth);
  const height = Math.min(CROP_PX, imageHeight);
  return {
    x: clampOrigin(clickX, width, imageWidth),
    y: clampOrigin(clickY, height, imageHeight),
    width,
    height,
  };
}

function clampOrigin(click: number, extent: number, limit: number): number {
  // Rounded once, at the end. Every value here indexes a pixel array —
  // `PNG.bitblt` takes an offset, not a coordinate — so the result has to be a
  // whole number whatever the caller passes, and rounding the inputs
  // separately would leave the clamp free to put a fraction back from `limit`.
  const ideal = click - extent / 2;
  return Math.round(Math.max(0, Math.min(ideal, limit - extent)));
}

/** The dimensions a PNG declares, read without decoding it. */
export interface PngHeader {
  readonly width: number;
  readonly height: number;
}

/**
 * Read IHDR, the first chunk of every PNG (RFC 2083 REST.1), and refuse
 * anything this will not decode.
 *
 * Separate from `cropScreenshot` so the size gate can be tested for what it
 * REFUSES without constructing a bomb: the whole point is that the refusal
 * happens before allocation, and a test that had to allocate to prove it would
 * be testing the thing the gate exists to prevent.
 */
export function readPngHeader(png: Buffer): PngHeader {
  if (png.length > MAX_SCREENSHOT_BYTES) {
    throw new Error(`screenshot is ${png.length} bytes, over the ${MAX_SCREENSHOT_BYTES} cap`);
  }
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('screenshot is not a PNG');
  }
  // Separate from the signature check, and it earns its place: a truncated
  // response can carry a valid signature and a real "IHDR" and still stop
  // before the height, where `readUInt32BE` throws a RangeError that says
  // nothing about screenshots. The two failures want different sentences.
  if (png.length < IHDR_MINIMUM_BYTES) {
    throw new Error(`screenshot is truncated: ${png.length} bytes cannot hold an IHDR chunk`);
  }
  if (png.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error('screenshot has no IHDR chunk where PNG requires one');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error(`screenshot declares an empty ${width}x${height} framebuffer`);
  }
  // Area, not a bound per axis. What is being bounded is the decoded buffer,
  // and that is proportional to width x height — so a per-axis rule tight
  // enough to bound it (4096 each) would also refuse shapes that cost nothing,
  // like a 8192x100 strip. Judging the product bounds the memory without
  // having an opinion about the shape.
  if (width * height > MAX_SCREENSHOT_PIXELS) {
    throw new Error(
      `screenshot declares ${width}x${height}, over the ${MAX_SCREENSHOT_PIXELS}-pixel decode cap`,
    );
  }
  return { width, height };
}

/** A crop and the framebuffer window it came from. */
export interface Crop {
  readonly png: Buffer;
  readonly rect: CropRect;
}

/**
 * Decode a screenshot, cut the window around the click, and re-encode it.
 *
 * Throws on anything malformed rather than returning a placeholder: the caller
 * turns a failure into "this event has no screenshot", which is a state the
 * trace already models (`screenshotKey` is nullable, set on clicks only), and
 * a stand-in image would be indistinguishable from a real one to the model
 * that reads it.
 */
export function cropScreenshot(png: Buffer, clickX: number, clickY: number): Crop {
  // Judged before the decoder allocates anything. There is deliberately no
  // second check afterwards: the decoder sizes its buffer from the same IHDR
  // field this just read, out of the same bytes, so there is no gap between
  // the two for a cross-check to sit in — only an untestable branch.
  readPngHeader(png);
  const source = PNG.sync.read(png);
  const rect = cropWindow(clickX, clickY, source.width, source.height);
  const destination = new PNG({ width: rect.width, height: rect.height });
  PNG.bitblt(source, destination, rect.x, rect.y, rect.width, rect.height, 0, 0);
  return { png: PNG.sync.write(destination), rect };
}
