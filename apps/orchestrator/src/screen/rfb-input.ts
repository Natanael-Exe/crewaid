import { ClientMessage } from '@crewaid/screen-stream';

/**
 * The §4.3 inbound validator — pure, no I/O.
 *
 * `screen.input` frames are "validated as well-formed `PointerEvent`
 * (type 5) or `KeyEvent` (type 4), then forwarded". This is that gate, and it
 * is a real fence rather than a formality.
 *
 * Why only two message types
 *
 * The RFB connection this writes into is SHARED. One upstream serves every
 * subscriber watching that sandbox, and the proxy's own state machine depends
 * on being the only thing that ever configures it. Each of the four client
 * messages we do not forward would break something specific:
 *
 * - SetPixelFormat (0) changes bits-per-pixel out from under the scanner.
 * TPIXEL is 3 bytes only for the 32bpp true-colour format the proxy pins;
 * one of these desyncs `scanServerMessage` on the next Tight rectangle,
 * and a desync is not recoverable — the boundary is lost for good.
 * - SetEncodings (2) can offer an encoding the scanner cannot measure
 * (LastRect, ZRLE, DesktopSize), with the same permanent result.
 * - FramebufferUpdateRequest (3) breaks the one-request-in-flight invariant.
 * RFB has no request ids, so a second outstanding request makes the
 * `fullRepaint` bit a guess — and that bit is the only thing keeping a
 * late subscriber from decoding deltas against pixels it never had.
 * - ClientCutText (6) pushes attacker-chosen text into the sandbox
 * clipboard, which the agent can then paste. §4.3 asks for input
 * forwarding, not for a clipboard channel.
 *
 * So the damage is not "a bad frame is ignored" — it is one malformed or
 * hostile frame permanently corrupting the stream for every other viewer of
 * that desktop. Refusing anything but t4/t5 is what makes the multiplex safe.
 *
 * Why one message per frame
 *
 * The length must be EXACT: not merely long enough. Trailing bytes after a
 * well-formed event are the same attack wearing a prefix — a valid PointerEvent
 * followed by a SetPixelFormat is what a length-only check forwards.
 *
 * What it deliberately does not check
 *
 * Padding bytes and the KeyEvent down-flag are read but not constrained.
 * RFC 6143 leaves padding undefined on receipt and says only that a non-zero
 * down-flag means "pressed", so rejecting either would refuse conformant
 * clients to no benefit — neither can steer the server. Coordinates are not
 * clamped to the framebuffer either: an out-of-range pointer is legal RFB
 * that x11vnc handles, and clamping here would need geometry this file has no
 * business knowing.
 */

/** RFC 6143 §7.5.4 — type, down-flag, 2 padding, keysym. */
export const KEY_EVENT_BYTES = 8;
/** RFC 6143 §7.5.5 — type, button-mask, x, y. */
export const POINTER_EVENT_BYTES = 6;

/**
 * The decoded event. Returned rather than discarded because §4.3's tee ("every
 * validated inbound event is also written to the recording pipeline") needs the
 * fields, not the bytes, and this is the one place they are already parsed.
 */
export type RfbInputEvent =
  | { readonly kind: 'key'; readonly down: boolean; readonly keysym: number }
  | {
      readonly kind: 'pointer';
      readonly buttonMask: number;
      readonly x: number;
      readonly y: number;
    };

export type RfbInputVerdict =
  | { readonly ok: true; readonly event: RfbInputEvent }
  | { readonly ok: false; readonly reason: string };

export function validateClientInput(bytes: Uint8Array): RfbInputVerdict {
  if (bytes.length === 0) return refuse('an RFB client message is at least one byte');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);

  switch (type) {
    case ClientMessage.keyEvent: {
      const sized = requireExactly(bytes.length, KEY_EVENT_BYTES, 'KeyEvent');
      if (sized !== null) return sized;
      return {
        ok: true,
        event: { kind: 'key', down: view.getUint8(1) !== 0, keysym: view.getUint32(4) },
      };
    }
    case ClientMessage.pointerEvent: {
      const sized = requireExactly(bytes.length, POINTER_EVENT_BYTES, 'PointerEvent');
      if (sized !== null) return sized;
      return {
        ok: true,
        event: {
          kind: 'pointer',
          buttonMask: view.getUint8(1),
          x: view.getUint16(2),
          y: view.getUint16(4),
        },
      };
    }
    default:
      // Naming the type is worth it: the client author's next question is
      // always "which one did I send", and t0/t2/t3/t6 are all things a
      // general-purpose RFB client library emits on its own.
      return refuse(
        `RFB client message type ${type} is not forwarded; §4.3 accepts only ` +
          `KeyEvent (${ClientMessage.keyEvent}) and PointerEvent (${ClientMessage.pointerEvent})`,
      );
  }
}

function requireExactly(actual: number, expected: number, name: string): RfbInputVerdict | null {
  if (actual === expected) return null;
  const how = actual < expected ? 'truncated' : 'oversized';
  return refuse(`${how} ${name}: expected exactly ${expected} bytes, got ${actual}`);
}

function refuse(reason: string): RfbInputVerdict {
  return { ok: false, reason };
}
