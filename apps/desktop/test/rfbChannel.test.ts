import { describe, expect, it } from 'vitest';
import { SCREEN_PIXEL_FORMAT } from '@crewaid/shared';
import {
  hasFramebufferRectangles,
  PROTOCOL_VERSION,
  RfbChannel,
} from '../src/renderer/screen/rfbChannel';

/**
 * M2-FE-01 — the channel noVNC attaches to instead of a VNC socket.
 *
 * Everything here is bytes in, bytes out, which is the point: the alternative
 * to a synthetic handshake is reimplementing Tight, and the alternative to
 * testing it at this level is a DOM.
 */
function harness(options: { widthPx?: number; heightPx?: number } = {}) {
  const errors: string[] = [];
  const input: Uint8Array[] = [];
  const channel = new RfbChannel({
    widthPx: options.widthPx ?? 1280,
    heightPx: options.heightPx ?? 800,
    name: 'quill',
    onProtocolError: (reason) => errors.push(reason),
    onInput: (message) => input.push(message),
  });
  const received: Uint8Array[] = [];
  channel.onmessage = (event) => received.push(new Uint8Array(event.data));
  let opened = 0;
  channel.onopen = () => {
    opened += 1;
  };
  let closed = 0;
  channel.onclose = () => {
    closed += 1;
  };
  return {
    channel,
    received,
    errors,
    input,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    /** Play the client half of the handshake, as noVNC would. */
    async handshake(): Promise<void> {
      channel.start();
      await flush();
      channel.send(ascii(PROTOCOL_VERSION));
      await flush();
      channel.send(new Uint8Array([1]));
      await flush();
      channel.send(new Uint8Array([1]));
      await flush();
    },
  };
}

/** Let the channel's queued deliveries run; see `emit` for why they queue. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/**
 * A SetEncodings carrying REAL encoding numbers, including the negative
 * pseudo-encodings noVNC always asks for.
 *
 * The values matter: a body of zeros re-parses as a run of well-formed
 * SetPixelFormat messages, so a shim that mis-sized this message would consume
 * exactly the same number of bytes by accident and look correct.
 */
const NOVNC_ENCODINGS = [1, 7, 0, -32 + 6, -256 + 6, -223, -224];
const setEncodings = (encodings: readonly number[] = NOVNC_ENCODINGS): Uint8Array => {
  const bytes = new Uint8Array(4 + encodings.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 2);
  view.setUint16(2, encodings.length);
  encodings.forEach((encoding, index) => view.setInt32(4 + index * 4, encoding));
  return bytes;
};
const setPixelFormat = (): Uint8Array => {
  const bytes = new Uint8Array(20);
  bytes[0] = 0;
  return bytes;
};
const updateRequest = (): Uint8Array => {
  const bytes = new Uint8Array(10);
  bytes[0] = 3;
  return bytes;
};
const keyEvent = (down: number, keysym: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 4);
  view.setUint8(1, down);
  view.setUint32(4, keysym);
  return bytes;
};
const pointerEvent = (mask: number, x: number, y: number): Uint8Array => {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 5);
  view.setUint8(1, mask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return bytes;
};

describe('RfbChannel handshake', () => {
  it('does not speak before start, so noVNC can install its handlers first', async () => {
    const h = harness();
    expect(h.received).toHaveLength(0);
    expect(h.opened).toBe(0);

    // `new RFB(...)` attaches the handlers inside the constructor, so anything
    // emitted from ours would be delivered to null.
    h.channel.start();
    expect(h.opened).toBe(1);
    await flush();
    expect(new TextDecoder().decode(h.received[0])).toBe(PROTOCOL_VERSION);
  });

  it('reports CONNECTING until start, so noVNC does not open it itself', async () => {
    const h = harness();
    // noVNC's `_connect` calls `_socketOpen()` directly when the channel is
    // already open. Reporting OPEN here means it opens once by itself and
    // again on our `onopen`, and the second arrives mid-handshake — noVNC
    // fails the connection and never draws anything.
    expect(h.channel.readyState).toBe(0);
    h.channel.start();
    expect(h.channel.readyState).toBe(1);
  });

  it('offers exactly one security type, None', async () => {
    const h = harness();
    h.channel.start();
    await flush();
    h.channel.send(ascii(PROTOCOL_VERSION));
    await flush();
    expect([...(h.received[1] as Uint8Array)]).toEqual([1, 1]);
  });

  it('answers the security choice with an OK SecurityResult', async () => {
    const h = harness();
    h.channel.start();
    await flush();
    h.channel.send(ascii(PROTOCOL_VERSION));
    await flush();
    h.channel.send(new Uint8Array([1]));
    await flush();
    expect([...(h.received[2] as Uint8Array)]).toEqual([0, 0, 0, 0]);
  });

  it('declares the geometry it was given and the pinned pixel format', async () => {
    const h = harness({ widthPx: 1280, heightPx: 800 });
    await h.handshake();
    const init = h.received[3] as Uint8Array;
    const view = new DataView(init.buffer, init.byteOffset, init.byteLength);

    expect(view.getUint16(0)).toBe(1280);
    expect(view.getUint16(2)).toBe(800);
    expect(view.getUint8(4)).toBe(SCREEN_PIXEL_FORMAT.bitsPerPixel);
    expect(view.getUint8(5)).toBe(SCREEN_PIXEL_FORMAT.depth);
    expect(view.getUint8(7)).toBe(SCREEN_PIXEL_FORMAT.trueColour);
    expect(view.getUint16(8)).toBe(SCREEN_PIXEL_FORMAT.redMax);
    // The shifts are the whole reason this constant is shared: noVNC decodes
    // Raw by blitting wire bytes into canvas RGBA, so byte 0 must be red.
    expect(view.getUint8(14)).toBe(SCREEN_PIXEL_FORMAT.redShift);
    expect(view.getUint8(15)).toBe(SCREEN_PIXEL_FORMAT.greenShift);
    expect(view.getUint8(16)).toBe(SCREEN_PIXEL_FORMAT.blueShift);
    expect(view.getUint32(20)).toBe(init.length - 24);
    expect(h.channel.isStreaming).toBe(true);
  });

  it('survives a handshake arriving one byte at a time', async () => {
    // noVNC flushes its own queue; nothing guarantees a whole message per call.
    const h = harness();
    h.channel.start();
    await flush();
    for (const byte of ascii(PROTOCOL_VERSION)) h.channel.send(new Uint8Array([byte]));
    await flush();
    h.channel.send(new Uint8Array([1]));
    await flush();
    h.channel.send(new Uint8Array([1]));
    await flush();
    expect(h.channel.isStreaming).toBe(true);
    expect(h.received).toHaveLength(4);
  });

  it('never delivers a reply from inside the send that caused it', async () => {
    const h = harness();
    let insideSend = false;
    let reentered = false;
    const inner = h.channel.onmessage;
    h.channel.onmessage = (event) => {
      if (insideSend) reentered = true;
      inner?.(event);
    };

    h.channel.start();
    await flush();
    insideSend = true;
    h.channel.send(ascii(PROTOCOL_VERSION));
    insideSend = false;

    // The whole handshake used to run inside this one call. noVNC's receive
    // queue is being mutated by the outer frame at that point, so the nested
    // read left it inconsistent and the handshake simply stopped after the
    // security list — no error, no picture. A real WebSocket cannot do this,
    // because delivery is always a separate task.
    expect(reentered).toBe(false);
    await flush();
    expect(h.received).toHaveLength(2);
  });

  it('refuses a security type it never offered', async () => {
    const h = harness();
    h.channel.start();
    await flush();
    h.channel.send(ascii(PROTOCOL_VERSION));
    await flush();
    h.channel.send(new Uint8Array([2]));
    await flush();
    expect(h.errors[0]).toMatch(/security type 2/);
    expect(h.channel.readyState).toBe(3);
  });
});

describe('RfbChannel client messages', () => {
  it('swallows the three configuration messages noVNC sends after ServerInit', async () => {
    const h = harness();
    await h.handshake();
    const before = h.received.length;

    // Each of these configures the shared upstream. D-036 refuses them at the
    // server; forwarding them would reconfigure the stream under every other
    // viewer of this desktop.
    h.channel.send(setPixelFormat());
    h.channel.send(setEncodings());
    h.channel.send(updateRequest());
    await flush();

    expect(h.received).toHaveLength(before);
    // The client half of D-036: these three are not merely unanswered, they
    // are never handed to the input path either. A shim that forwarded them
    // would reconfigure the upstream for every other viewer of this desktop.
    expect(h.input).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.channel.isStreaming).toBe(true);
  });

  it('does not forward ClientCutText, whatever its length claims', async () => {
    const h = harness();
    await h.handshake();
    // D-036 refuses type 6 at the server because it is a clipboard channel
    // into the sandbox, not input. Nothing here may offer it one either.
    const paste = new Uint8Array([6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69]);
    h.channel.send(paste);

    expect(h.input).toEqual([]);
    expect(h.errors).toEqual([]);
    // Positive control: the stream is still aligned, so the refusal above was
    // a deliberate swallow rather than a length this shim mismeasured.
    h.channel.send(pointerEvent(0, 1, 2));
    expect(h.input).toHaveLength(1);
  });

  it('consumes several messages delivered in one flush', async () => {
    const h = harness();
    await h.handshake();
    const batch = new Uint8Array([...setPixelFormat(), ...setEncodings(), ...updateRequest()]);
    h.channel.send(batch);
    // Nothing left over: a miscounted length here desynchronises every message
    // after it, and the next real one would be read at the wrong offset.
    expect(h.errors).toEqual([]);
    h.channel.send(updateRequest());
    expect(h.errors).toEqual([]);
  });

  it('holds a partial message until the rest arrives', async () => {
    const h = harness();
    await h.handshake();
    const encodings = setEncodings();
    h.channel.send(encodings.subarray(0, 7));
    h.channel.send(encodings.subarray(7));
    h.channel.send(updateRequest());
    expect(h.errors).toEqual([]);
  });

  it('forwards complete key and pointer events as separate messages', async () => {
    const h = harness();
    await h.handshake();
    const key = keyEvent(1, 0x61);
    const pointer = pointerEvent(1, 640, 400);

    // Websock may flush several queued RFB messages in one send. The binary
    // WS contract requires the channel to recover their exact boundaries.
    h.channel.send(new Uint8Array([...key, ...pointer]));

    expect(h.input.map((message) => [...message])).toEqual([[...key], [...pointer]]);
    expect(h.errors).toEqual([]);
  });

  it('does not forward input until the whole fixed-size message arrives', async () => {
    const h = harness();
    await h.handshake();
    const key = keyEvent(0, 0xff0d);

    h.channel.send(key.subarray(0, 3));
    expect(h.input).toEqual([]);
    h.channel.send(key.subarray(3));

    expect(h.input).toHaveLength(1);
    expect([...(h.input[0] as Uint8Array)]).toEqual([...key]);
  });

  it('does not read a variable-length message before its length arrives', async () => {
    const h = harness();
    await h.handshake();
    // Only the type byte and one padding byte: the count is not readable yet.
    h.channel.send(new Uint8Array([2, 0]));
    expect(h.errors).toEqual([]);
    h.channel.send(new Uint8Array([0, 1, 0, 0, 0, 7]));
    expect(h.errors).toEqual([]);
    // Positive control: the stream is still aligned afterwards.
    h.channel.send(updateRequest());
    expect(h.errors).toEqual([]);
    expect(h.channel.isStreaming).toBe(true);
  });

  it('fails loudly on a client message it cannot size', async () => {
    const h = harness();
    await h.handshake();
    // Nothing else can arrive — noVNC only sends the extended messages after a
    // server confirms the pseudo-encoding, and this shim never does — so the
    // stream position is unknown from here and guessing would render garbage.
    h.channel.send(new Uint8Array([250, 0, 0, 0]));
    expect(h.errors[0]).toMatch(/unsupported RFB client message type 250/);
    expect(h.channel.readyState).toBe(3);
  });

  it('cannot ask the server to resize the display (R8)', async () => {
    const h = harness();
    await h.handshake();
    const before = h.received.length;

    // SetDesktopSize (RFC 6143 extension, client message 251) is the only way
    // a VNC client can change the framebuffer, and R8 forbids it outright.
    // `VIEWER_DISPLAY_POLICY` keeps noVNC from producing one — but the reason
    // R8 cannot be violated from this renderer at all is structural: the
    // channel is a DEAD END for client messages. Nothing noVNC writes reaches
    // x11vnc, so even a misconfigured viewer stops here rather than
    // renegotiating a size for every other subscriber of this desktop.
    const setDesktopSize = new Uint8Array(24);
    setDesktopSize[0] = 251;
    h.channel.send(setDesktopSize);
    await flush();

    expect(h.received).toHaveLength(before);
    expect(h.errors[0]).toMatch(/unsupported RFB client message type 251/);
  });
});

describe('RfbChannel frame delivery', () => {
  it('distinguishes a paintable update from keepalives and other messages', () => {
    expect(hasFramebufferRectangles(new Uint8Array([0, 0, 0, 1]))).toBe(true);
    expect(hasFramebufferRectangles(new Uint8Array([0, 0, 0, 0]))).toBe(false);
    expect(hasFramebufferRectangles(new Uint8Array([2, 0, 0, 1]))).toBe(false);
    expect(hasFramebufferRectangles(new Uint8Array([0, 0, 1]))).toBe(false);
  });

  it('passes a forwarded server message through untouched', async () => {
    const h = harness();
    await h.handshake();
    const before = h.received.length;
    const message = new Uint8Array([0, 0, 0, 1, 9, 9]);
    h.channel.deliver(message);
    await flush();
    expect([...(h.received[before] as Uint8Array)]).toEqual([...message]);
  });

  it('drops frames that arrive before the handshake finishes', async () => {
    // noVNC has no framebuffer yet and no decoder state; handing it an update
    // here is a parse error inside the library rather than a missing frame.
    const h = harness();
    h.channel.start();
    h.channel.deliver(new Uint8Array([0, 0, 0, 1]));
    await flush();
    expect(h.received).toHaveLength(1);
  });

  it('never hands over the neighbouring bytes of a shared buffer', async () => {
    const h = harness();
    await h.handshake();
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    h.channel.deliver(backing.subarray(2, 5));
    await flush();

    // The frames arrive as views into one WS payload. Passing `.buffer` would
    // give noVNC the whole payload and it would read past its own message.
    const delivered = h.received.at(-1) as Uint8Array;
    expect([...delivered]).toEqual([3, 4, 5]);
    expect(delivered.byteLength).toBe(3);
  });

  it('stops delivering once closed', async () => {
    const h = harness();
    await h.handshake();
    h.channel.close();
    const before = h.received.length;
    h.channel.deliver(new Uint8Array([0, 0, 0, 1]));
    await flush();
    expect(h.received).toHaveLength(before);
    expect(h.closed).toBe(1);
  });
});
