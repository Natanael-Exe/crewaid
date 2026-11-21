import { describe, expect, it } from 'vitest';

import {
  KEY_EVENT_BYTES,
  POINTER_EVENT_BYTES,
  validateClientInput,
} from '../src/screen/rfb-input.js';

/**
 * M2-BE-07 / M2-QA-07 — the §4.3 inbound validator.
 *
 * The interesting cases are all refusals: this gate is the only thing between
 * a hostile or buggy client and the SHARED upstream every other viewer of that
 * desktop is reading from.
 */
const keyEvent = (down: number, keysym: number): Uint8Array => {
  const bytes = new Uint8Array(KEY_EVENT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 4);
  view.setUint8(1, down);
  view.setUint32(4, keysym);
  return bytes;
};

const pointerEvent = (mask: number, x: number, y: number): Uint8Array => {
  const bytes = new Uint8Array(POINTER_EVENT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 5);
  view.setUint8(1, mask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return bytes;
};

describe('RFB inbound validator (§4.3)', () => {
  describe('accepts the two forwarded types', () => {
    it('decodes a KeyEvent (t4)', () => {
      // 0xFF0D is XK_Return — a keysym above 0x7FFF, so a signed read here
      // would produce a negative and the recording tee would store nonsense.
      const verdict = validateClientInput(keyEvent(1, 0xff0d));
      expect(verdict).toEqual({ ok: true, event: { kind: 'key', down: true, keysym: 0xff0d } });
    });

    it('decodes a key release', () => {
      const verdict = validateClientInput(keyEvent(0, 0x61));
      expect(verdict.ok && verdict.event).toEqual({ kind: 'key', down: false, keysym: 0x61 });
    });

    it('treats any non-zero down-flag as pressed, as RFC 6143 specifies', () => {
      // Rejecting 2 here would refuse a conformant client for no benefit.
      const verdict = validateClientInput(keyEvent(2, 0x61));
      expect(verdict.ok && verdict.event).toEqual({ kind: 'key', down: true, keysym: 0x61 });
    });

    it('decodes a PointerEvent (t5)', () => {
      const verdict = validateClientInput(pointerEvent(0b1, 1279, 799));
      expect(verdict).toEqual({
        ok: true,
        event: { kind: 'pointer', buttonMask: 1, x: 1279, y: 799 },
      });
    });

    it('accepts coordinates outside the framebuffer rather than guessing geometry', () => {
      // Legal RFB that x11vnc clamps itself. Clamping here would need the
      // screen size, which would couple a pure validator to a live stream.
      const verdict = validateClientInput(pointerEvent(0, 65535, 65535));
      expect(verdict.ok && verdict.event).toEqual({
        kind: 'pointer',
        buttonMask: 0,
        x: 65535,
        y: 65535,
      });
    });

    it('accepts every button in the mask, including scroll buttons 4-7', () => {
      const verdict = validateClientInput(pointerEvent(0xff, 10, 10));
      expect(verdict.ok && verdict.event).toEqual({
        kind: 'pointer',
        buttonMask: 0xff,
        x: 10,
        y: 10,
      });
    });
  });

  describe('rejects every other client message type', () => {
    it.each([
      ['SetPixelFormat', 0, 20],
      ['SetEncodings', 2, 12],
      ['FramebufferUpdateRequest', 3, 10],
      ['ClientCutText', 6, 16],
    ])('refuses %s (t%i), which would corrupt the shared upstream', (_name, type, length) => {
      const bytes = new Uint8Array(length);
      bytes[0] = type;
      const verdict = validateClientInput(bytes);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toMatch(new RegExp(`type ${type} is not forwarded`));
    });

    it('refuses an unassigned type', () => {
      const verdict = validateClientInput(new Uint8Array([250, 0, 0, 0, 0, 0]));
      expect(verdict.ok).toBe(false);
    });
  });

  describe('rejects truncated and oversized frames (M2-QA-07)', () => {
    it.each([1, 2, 5, 7])('refuses a %i-byte KeyEvent', (length) => {
      const verdict = validateClientInput(keyEvent(1, 0x61).subarray(0, length));
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      if (length === 1) expect(verdict.reason).toMatch(/truncated KeyEvent/);
    });

    it.each([1, 3, 5])('refuses a %i-byte PointerEvent', (length) => {
      const verdict = validateClientInput(pointerEvent(1, 4, 4).subarray(0, length));
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toMatch(/truncated PointerEvent|not forwarded/);
    });

    it('refuses a valid PointerEvent with anything appended', () => {
      // The whole point of an EXACT length: a well-formed event followed by a
      // SetPixelFormat is precisely what a "long enough" check forwards, and
      // that one desyncs the scanner for every viewer, permanently.
      const smuggled = new Uint8Array([...pointerEvent(1, 4, 4), 0, ...new Uint8Array(19)]);
      const verdict = validateClientInput(smuggled);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toMatch(/oversized PointerEvent: expected exactly 6 bytes, got 26/);
    });

    it('refuses a valid KeyEvent with a trailing byte', () => {
      const padded = new Uint8Array([...keyEvent(1, 0x61), 0]);
      const verdict = validateClientInput(padded);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toMatch(/oversized KeyEvent/);
    });

    it('refuses an empty frame', () => {
      const verdict = validateClientInput(new Uint8Array(0));
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toMatch(/at least one byte/);
    });
  });

  it('reads the message at its own offset inside a larger buffer', () => {
    // The decoder receives a subarray of the received WS frame, not a fresh
    // allocation. A DataView built on `.buffer` without honouring byteOffset
    // would silently read the envelope header instead of the message.
    const envelope = new Uint8Array([3, 65, 66, 67, ...pointerEvent(1, 7, 9)]);
    const verdict = validateClientInput(envelope.subarray(4));
    expect(verdict.ok && verdict.event).toEqual({ kind: 'pointer', buttonMask: 1, x: 7, y: 9 });
  });
});
