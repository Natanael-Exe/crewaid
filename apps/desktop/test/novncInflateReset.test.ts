import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants, createDeflate } from 'node:zlib';
import { describe, expect, it } from 'vitest';

interface NovncInflator {
  setInput(data: Uint8Array | null): void;
  inflate(expected: number): Uint8Array;
  reset(): void;
}

type NovncInflatorCtor = new () => NovncInflator;

/**
 * Flush one chunk through a live zlib deflate stream using Z_SYNC_FLUSH, the
 * way Tight encoders frame consecutive rectangles on a persistent stream.
 */
function deflateChunk(stream: ReturnType<typeof createDeflate>, data: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const parts: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      parts.push(chunk);
    };
    const onError = (error: Error): void => {
      stream.off('data', onData);
      reject(error);
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.write(data);
    stream.flush(constants.Z_SYNC_FLUSH, () => {
      stream.off('data', onData);
      stream.off('error', onError);
      resolvePromise(Buffer.concat(parts));
    });
  });
}

describe('@novnc/novnc Inflate.reset() sliding window patch', () => {
  it('restores the sliding window after reset so multi-rectangle Tight streams keep decoding', async () => {
    const inflatorUrl = pathToFileURL(
      resolve(import.meta.dirname, '../node_modules/@novnc/novnc/core/inflator.js'),
    ).href;
    const mod = (await import(inflatorUrl)) as { default: NovncInflatorCtor };
    const inflator = new mod.default();

    // Non-trivial bytes that repeat across consecutive sync-flushed chunks so
    // the second chunk emits LZ77 back-references into the first chunk's window.
    const block = Buffer.alloc(4096);
    for (let i = 0; i < block.length; i += 1) block[i] = (i * 31 + (i >> 3)) & 0xff;

    // Stream 1: allocate and populate the sliding window.
    const firstStream = createDeflate();
    const s1c1 = await deflateChunk(firstStream, block);
    const s1c2 = await deflateChunk(firstStream, block);
    firstStream.end();

    inflator.setInput(s1c1);
    expect(Buffer.from(inflator.inflate(block.length))).toEqual(block);
    inflator.setInput(null);
    inflator.setInput(s1c2);
    expect(Buffer.from(inflator.inflate(block.length))).toEqual(block);
    inflator.setInput(null);

    // Simulates TightDecoder handling encodeTightReset() (0x8f) on reconnect.
    inflator.reset();

    // Stream 2: without the updatewindow fix, reset() leaves state.window
    // non-null while zeroing state.wsize, so s2c1 writes 0 bytes into the
    // sliding window and s2c2 throws "zlib inflate failed" ("invalid distance
    // too far back").
    const secondStream = createDeflate();
    const s2c1 = await deflateChunk(secondStream, block);
    const s2c2 = await deflateChunk(secondStream, block);
    secondStream.end();

    inflator.setInput(s2c1);
    expect(Buffer.from(inflator.inflate(block.length))).toEqual(block);
    inflator.setInput(null);
    inflator.setInput(s2c2);
    expect(Buffer.from(inflator.inflate(block.length))).toEqual(block);
    inflator.setInput(null);
  });
});
