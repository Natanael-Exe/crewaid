import { describe, expect, it } from 'vitest';
import {
  decodeScreenInputFrame,
  encodeScreenBinaryFrame,
  encodeScreenInputFrame,
} from './screen.js';

describe('lease-bound screen input', () => {
  const event = new Uint8Array([4, 1, 0, 0, 0, 0, 0, 97]);
  it('round trips an epoch and keeps RFB bytes unchanged', () => {
    expect(decodeScreenInputFrame(encodeScreenInputFrame('bot', 12345, event))).toEqual({
      ok: true,
      frame: { botId: 'bot', epoch: 12345, rfb: event },
    });
  });
  it('rejects the old input envelope and truncated or unsafe epochs', () => {
    expect(decodeScreenInputFrame(encodeScreenBinaryFrame('bot', event)).ok).toBe(false);
    expect(decodeScreenInputFrame(encodeScreenBinaryFrame('bot', new Uint8Array(9))).ok).toBe(
      false,
    );
    const body = new Uint8Array(9);
    new DataView(body.buffer).setBigUint64(0, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    body[8] = 5;
    expect(decodeScreenInputFrame(encodeScreenBinaryFrame('bot', body)).ok).toBe(false);
    expect(() => encodeScreenInputFrame('bot', 0, event)).toThrow();
    expect(() => encodeScreenInputFrame('bot', 1, new Uint8Array())).toThrow();
  });
});
