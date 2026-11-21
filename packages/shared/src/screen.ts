/**
 * §4.3 binary screen framing — the envelope around every `screen.input`
 * payload.
 *
 * Why an envelope exists at all
 *
 * WebSocket carries `screen.input` as a BINARY WebSocket frame, not a JSON
 * envelope, so it does not get the `botId` field every other frame has. One
 * socket watches up to six bots — `screen.subscribe` is per-bot — and a click
 * has to be routed to exactly one sandbox: guessing from the socket's most
 * recent subscription would silently type into the wrong bot's desktop the
 * moment a second subscription exists.
 *
 * So input carries the smallest possible prefix — a length byte and the bot
 * id — and the RFB message itself follows untouched. Pixels need none: they
 * travel on a stream socket per bot (`screen-stream.ts`), which already says
 * whose desktop it is.
 *
 * Wire format
 *
 * byte 0 bot id length in bytes, 1..64
 * bytes 1..n bot id, UTF-8
 * bytes n+1.. the RFB message, verbatim
 *
 * One RFB message per frame. Concatenating several would save a header on a
 * drag and cost the receiver a second framing layer to find their boundaries.
 *
 * Ratified as D-035; its frame half was retired when pixels left WebSocket.
 */

/** Matches `CuidSchema`'s ceiling, so any legal id fits in the length byte. */
export const SCREEN_FRAME_MAX_BOT_ID_BYTES = 64;

/** The RFB payload after the header. */
export interface ScreenBinaryFrame {
  readonly botId: string;
  readonly rfb: Uint8Array;
}

export type ScreenBinaryFrameResult =
  | { readonly ok: true; readonly frame: ScreenBinaryFrame }
  | { readonly ok: false; readonly reason: string };

/**
 * Wrap one RFB message for a bot. Throws rather than returning a result: a
 * caller that cannot supply a legal bot id has a bug, not bad input.
 */
export function encodeScreenBinaryFrame(botId: string, rfb: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(botId);
  if (id.length === 0 || id.length > SCREEN_FRAME_MAX_BOT_ID_BYTES) {
    throw new RangeError(
      `botId must be 1..${SCREEN_FRAME_MAX_BOT_ID_BYTES} bytes, got ${id.length}`,
    );
  }
  if (rfb.length === 0) throw new RangeError('an RFB message is at least one byte');

  const frame = new Uint8Array(1 + id.length + rfb.length);
  frame[0] = id.length;
  frame.set(id, 1);
  frame.set(rfb, 1 + id.length);
  return frame;
}

/**
 * Unwrap a frame received from the network. Returns a reason rather than
 * throwing, because the sender is a peer: every failure here is something the
 * other side must be told about, not an exception to unwind on.
 */
export function decodeScreenBinaryFrame(bytes: Uint8Array): ScreenBinaryFrameResult {
  if (bytes.length === 0) return { ok: false, reason: 'binary screen frame is empty' };

  const idLength = bytes[0] as number;
  if (idLength === 0) return { ok: false, reason: 'binary screen frame carries no bot id' };
  if (idLength > SCREEN_FRAME_MAX_BOT_ID_BYTES) {
    return {
      ok: false,
      reason:
        `bot id length ${idLength} exceeds the ${SCREEN_FRAME_MAX_BOT_ID_BYTES}-byte maximum; ` +
        'this is not a §4.3 binary screen frame',
    };
  }
  // Strictly greater: an id with no RFB message after it is a header, not a
  // frame, and forwarding a zero-length write upstream would be a silent no-op.
  if (bytes.length <= 1 + idLength) {
    return { ok: false, reason: 'binary screen frame carries no RFB message after its bot id' };
  }

  // `fatal` so a truncated or invalid UTF-8 id is refused here rather than
  // becoming a U+FFFD that matches no bot and reads as "not subscribed".
  let botId: string;
  try {
    botId = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(1, 1 + idLength));
  } catch {
    return { ok: false, reason: 'bot id in the binary screen frame is not valid UTF-8' };
  }

  return { ok: true, frame: { botId, rfb: bytes.subarray(1 + idLength) } };
}

/**
 * The pixel format the §4.3 screen stream is encoded in.
 *
 * Lives here because it is a wire shape both ends must agree on, and the two
 * ends cannot check each other: the orchestrator pins it with SetPixelFormat,
 * and the renderer's noVNC channel SWALLOWS noVNC's own SetPixelFormat (that
 * message configures an upstream connection one viewer does not own — see
 * D-036). So noVNC decodes using the format it asked for while the wire
 * carries the format the orchestrator chose, and nothing at runtime would
 * report a disagreement.
 *
 * The shifts are the part that bites, and they are not a preference:
 *
 *   - noVNC's Raw decoder blits the 4-byte pixels straight into a canvas RGBA
 *     buffer, forcing only alpha. Byte 0 must therefore be red, and 32bpp
 *     little-endian puts the LOWEST-shifted channel in byte 0 — so redShift
 *     must be 0.
 *   - Tight hides the mistake. RFC 6143 fixes TPIXEL at R,G,B whatever the
 *     shifts say, so Tight rectangles decode correctly either way. Measured
 *     against x11vnc in the §5 image: the same desktop pixel reads [21,34,51]
 *     as a Tight fill under both settings, while the Raw bytes reverse to
 *     [51,34,21] under redShift 16.
 *
 * x11vnc's own native format is redShift 16 (also measured), so pinning this
 * does change bytes on the wire. That cost buys the difference between a
 * correct picture and one where *some* rectangles have red and blue swapped,
 * intermittently, depending on which encoding the server picked.
 */
export const SCREEN_PIXEL_FORMAT = {
  bitsPerPixel: 32,
  depth: 24,
  bigEndian: 0,
  trueColour: 1,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 0,
  greenShift: 8,
  blueShift: 16,
} as const;

/** Client input carries the lease epoch before its unchanged RFB bytes. */
export function encodeScreenInputFrame(botId: string, epoch: number, rfb: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(epoch) || epoch <= 0)
    throw new RangeError('a seat epoch must be a positive safe integer');
  const body = new Uint8Array(8 + rfb.length);
  new DataView(body.buffer).setBigUint64(0, BigInt(epoch));
  body.set(rfb, 8);
  if (rfb.length === 0) throw new RangeError('an RFB message is at least one byte');
  return encodeScreenBinaryFrame(botId, body);
}

export function decodeScreenInputFrame(
  bytes: Uint8Array,
):
  | { readonly ok: true; readonly frame: ScreenBinaryFrame & { readonly epoch: number } }
  | { readonly ok: false; readonly reason: string } {
  const decoded = decodeScreenBinaryFrame(bytes);
  if (!decoded.ok) return decoded;
  const body = decoded.frame.rfb;
  if (body.length <= 8)
    return { ok: false, reason: 'screen input carries no lease epoch and RFB event' };
  const rawEpoch = new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(0);
  if (rawEpoch === 0n || rawEpoch > BigInt(Number.MAX_SAFE_INTEGER))
    return { ok: false, reason: 'screen input epoch is invalid' };
  return {
    ok: true,
    frame: { botId: decoded.frame.botId, epoch: Number(rawEpoch), rfb: body.subarray(8) },
  };
}
