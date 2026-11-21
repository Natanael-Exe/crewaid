import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClientMessage, RFB_PROTOCOL_VERSION, ServerMessage } from './rfb-protocol.js';
import { RfbUpstream, type ServerMessageMeta } from './rfb-upstream.js';

/**
 * M2-BE-06 — the upstream handshake and update pump.
 *
 * Driven over an in-memory duplex rather than a socket (the `wsClient.ts`
 * seam). The behaviour worth testing is ordering and partial reads: RFB has no
 * framing and no request ids, so "one request in flight" and "which update
 * answers which request" are invariants the code maintains by hand, and a real
 * socket would only make them harder to observe.
 */

/** A socket whose peer is the test: `feed()` plays server bytes, `written` records ours. */
class FakeSocket extends Duplex {
  readonly written: Buffer[] = [];
  stalled = false;

  override _read(): void {
    /* pushed by feed() */
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, done: (e?: Error) => void): void {
    this.written.push(Buffer.from(chunk));
    if (!this.stalled) done();
  }

  feed(...chunks: Buffer[]): void {
    for (const chunk of chunks) this.push(chunk);
  }

  /** Every client message we sent, by its RFB type byte. */
  typesWritten(): number[] {
    return this.written.filter((b) => b.length > 0).map((b) => b.readUInt8(0));
  }

  requests(): { incremental: boolean }[] {
    return this.written
      .filter((b) => b.readUInt8(0) === ClientMessage.framebufferUpdateRequest && b.length === 10)
      .map((b) => ({ incremental: b.readUInt8(1) === 1 }));
  }
}

const serverInit = (width = 1280, height = 800, name = 'crewaid'): Buffer => {
  const head = Buffer.alloc(24);
  head.writeUInt16BE(width, 0);
  head.writeUInt16BE(height, 2);
  head.writeUInt32BE(name.length, 20);
  return Buffer.concat([head, Buffer.from(name, 'ascii')]);
};

const securityTypes = (...types: number[]) => Buffer.from([types.length, ...types]);
const securityResult = (status = 0) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(status, 0);
  return b;
};
const bell = () => Buffer.from([ServerMessage.bell]);
/** A minimal but structurally real FramebufferUpdate: one tight fill rectangle. */
const update = (): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUInt8(ServerMessage.framebufferUpdate, 0);
  header.writeUInt16BE(1, 2);
  const rect = Buffer.alloc(12);
  rect.writeUInt16BE(4, 4);
  rect.writeUInt16BE(4, 6);
  rect.writeInt32BE(7, 8);
  return Buffer.concat([header, rect, Buffer.from([0x80]), Buffer.alloc(3)]);
};

const version = () => Buffer.from(RFB_PROTOCOL_VERSION, 'ascii');
const tick = () => new Promise((resolve) => setImmediate(resolve));

interface Harness {
  socket: FakeSocket;
  upstream: RfbUpstream;
  messages: { message: Buffer; meta: ServerMessageMeta }[];
  closes: (Error | null)[];
  ready: { widthPx: number; heightPx: number }[];
}

function harness(quality = 6): Harness {
  const socket = new FakeSocket();
  const messages: Harness['messages'] = [];
  const closes: Harness['closes'] = [];
  const ready: Harness['ready'] = [];
  const upstream = new RfbUpstream({
    host: '127.0.0.1',
    port: 5900,
    quality,
    connect: () => socket,
  });
  upstream.onMessage((message, meta) => messages.push({ message, meta }));
  upstream.onClose((reason) => closes.push(reason));
  upstream.onReady((geometry) => ready.push(geometry));
  return { socket, upstream, messages, closes, ready };
}

/** Play a complete, successful handshake. */
async function handshake(h: Harness): Promise<void> {
  h.socket.feed(version());
  await tick();
  h.socket.feed(securityTypes(1));
  await tick();
  h.socket.feed(securityResult());
  await tick();
  h.socket.feed(serverInit());
  await tick();
}

describe('RfbUpstream handshake', () => {
  it('completes RFB 3.8 and reports the geometry ServerInit declared', async () => {
    const h = harness();
    await handshake(h);

    expect(h.ready).toEqual([{ widthPx: 1280, heightPx: 800 }]);
    expect(h.upstream.isStreaming).toBe(true);
    expect(h.upstream.screen).toEqual({ widthPx: 1280, heightPx: 800 });

    // Version echo, security choice, ClientInit, then SetPixelFormat before
    // SetEncodings — the format has to be pinned before the server encodes
    // anything, or the first update arrives in its native format.
    const types = h.socket.typesWritten();
    expect(types.slice(0, 3)).toEqual([0x52, 1, 1]); // 'R' of "RFB ...", None, shared
    expect(types.slice(3, 5)).toEqual([ClientMessage.setPixelFormat, ClientMessage.setEncodings]);
  });

  it('sends its version before the server greets, and checks the server’s when it lands', async () => {
    const h = harness();
    // Nothing fed yet: x11vnc's library greets a client that has spoken at
    // once, and otherwise waits for a WebSocket client that never comes.
    expect(Buffer.concat(h.socket.written).toString('ascii')).toBe(RFB_PROTOCOL_VERSION);
    await handshake(h);
    expect(h.ready).toHaveLength(1);
    // Said once: the server's greeting is checked, not answered again.
    const said = Buffer.concat(h.socket.written).toString('latin1');
    expect(said.split(RFB_PROTOCOL_VERSION)).toHaveLength(2);
  });

  it('survives a handshake delivered one byte at a time', async () => {
    // A real socket splits wherever it likes; the phase machine must not
    // assume a read boundary lines up with a protocol field.
    const h = harness();
    const all = Buffer.concat([version(), securityTypes(1), securityResult(), serverInit()]);
    for (const byte of all) {
      h.socket.feed(Buffer.from([byte]));
      await tick();
    }
    expect(h.upstream.isStreaming).toBe(true);
    expect(h.ready).toHaveLength(1);
  });

  it('refuses a protocol version it does not speak', async () => {
    const h = harness();
    h.socket.feed(Buffer.from('RFB 003.003\n', 'ascii'));
    await tick();
    expect(h.closes[0]?.message).toMatch(/speaks only/);
    expect(h.upstream.isStreaming).toBe(false);
  });

  it('names the missing credential path when the server wants a password', async () => {
    const h = harness();
    h.socket.feed(version());
    await tick();
    h.socket.feed(securityTypes(2)); // VNC auth only
    await tick();
    expect(h.closes[0]?.message).toMatch(/-nopw/);
  });

  it('surfaces the server’s own reason when it refuses the connection', async () => {
    const h = harness();
    h.socket.feed(version());
    await tick();
    const reason = 'too many clients';
    const length = Buffer.alloc(4);
    length.writeUInt32BE(reason.length, 0);
    h.socket.feed(Buffer.concat([Buffer.from([0]), length, Buffer.from(reason, 'ascii')]));
    await tick();
    expect(h.closes[0]?.message).toMatch(/too many clients/);
  });

  it('reports a rejected security result rather than hanging', async () => {
    const h = harness();
    h.socket.feed(version());
    await tick();
    h.socket.feed(securityTypes(1));
    await tick();
    h.socket.feed(securityResult(1));
    await tick();
    expect(h.closes[0]?.message).toMatch(/rejected security type None/);
  });
});

describe('RfbUpstream update pump', () => {
  it('keeps exactly one request in flight', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume();
    await tick();
    expect(h.socket.requests()).toHaveLength(1);

    // Asking again while one is outstanding must not queue a second: RFB has
    // no request ids, so two in flight make "which update answered which"
    // unanswerable.
    h.upstream.resume();
    h.upstream.resume();
    await tick();
    expect(h.socket.requests()).toHaveLength(1);

    h.socket.feed(update());
    await tick();
    expect(h.socket.requests()).toHaveLength(2);
  });

  it('marks only the update that answered a non-incremental request', async () => {
    const h = harness();
    await handshake(h);

    h.upstream.requestFullRepaint();
    await tick();
    expect(h.socket.requests()[0]?.incremental).toBe(false);

    h.socket.feed(update());
    await tick();
    expect(h.messages[0]?.meta.fullRepaint).toBe(true);

    // The pump continues incrementally, and those are NOT whole screens.
    h.socket.feed(update());
    await tick();
    expect(h.messages[1]?.meta.fullRepaint).toBe(false);
    expect(h.socket.requests()[1]?.incremental).toBe(true);
  });

  it('defers a full repaint until the outstanding request is answered', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume();
    await tick();
    expect(h.socket.requests()).toEqual([{ incremental: true }]);

    h.upstream.requestFullRepaint();
    await tick();
    // Still one: the flag waits rather than racing a second request.
    expect(h.socket.requests()).toHaveLength(1);

    h.socket.feed(update());
    await tick();
    expect(h.socket.requests()[1]?.incremental).toBe(false);
  });

  it('does not treat an unsolicited Bell as an answer or a repaint', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.requestFullRepaint();
    await tick();

    h.socket.feed(bell());
    await tick();
    expect(h.messages[0]?.meta.fullRepaint).toBe(false);
    // Nor as an update: the screen stream paces on updates, and a Bell must not
    // make it wait for a viewer's confirmation.
    expect(h.messages[0]?.meta.update).toBe(false);
    // The full request is still outstanding, so no new request was sent...
    expect(h.socket.requests()).toHaveLength(1);

    // ...and the update that does answer it is still marked as the repaint.
    h.socket.feed(update());
    await tick();
    expect(h.messages[1]?.meta.fullRepaint).toBe(true);
    expect(h.messages[1]?.meta.update).toBe(true);
  });

  it('forwards message bytes verbatim, sliced only at boundaries', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume();
    await tick();

    const first = update();
    const second = update();
    // Delivered as one chunk containing two messages plus a partial third.
    h.socket.feed(Buffer.concat([first, second, first.subarray(0, 5)]));
    await tick();

    expect(h.messages.map((m) => m.message.length)).toEqual([first.length, second.length]);
    expect(Buffer.concat(h.messages.map((m) => m.message))).toEqual(Buffer.concat([first, second]));
  });

  it('stops requesting when paused, and resumes where it left off', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume();
    await tick();
    h.upstream.pause();
    h.socket.feed(update());
    await tick();
    expect(h.socket.requests()).toHaveLength(1);

    h.upstream.resume();
    await tick();
    expect(h.socket.requests()).toHaveLength(2);
  });

  it('sends no next request when paused from inside the message callback', async () => {
    // The screen stream holds the pump for a slow viewer from within this
    // callback; the request that would follow the update must not go out.
    const h = harness();
    h.upstream.onMessage(() => h.upstream.pause());
    await handshake(h);
    h.upstream.resume();
    await tick();
    h.socket.feed(update());
    await tick();
    expect(h.socket.requests()).toHaveLength(1);
  });

  it('renegotiates quality with one SetEncodings and a repaint', async () => {
    const h = harness();
    await handshake(h);
    const before = h.socket.written.length;

    h.upstream.setQuality(9);
    await tick();
    const sent = h.socket.written.slice(before);
    expect(sent.some((b) => b.readUInt8(0) === ClientMessage.setEncodings)).toBe(true);
    expect(h.socket.requests().at(-1)?.incremental).toBe(false);

    // Setting the same quality again is a no-op, not another round trip.
    const after = h.socket.written.length;
    h.upstream.setQuality(9);
    await tick();
    expect(h.socket.written).toHaveLength(after);
  });

  it('reports a desynchronising server instead of forwarding garbage', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume();
    await tick();

    // An encoding we never advertised: its length is uncomputable, so every
    // following byte would be misread.
    const header = Buffer.alloc(4);
    header.writeUInt8(ServerMessage.framebufferUpdate, 0);
    header.writeUInt16BE(1, 2);
    const rect = Buffer.alloc(12);
    rect.writeInt32BE(5, 8);
    h.socket.feed(Buffer.concat([header, rect]));
    await tick();

    expect(h.closes[0]?.message).toMatch(/never advertised/);
    expect(h.messages).toHaveLength(0);
  });

  it('reports a remote close even without a socket error', async () => {
    const h = harness();
    await handshake(h);
    h.socket.destroy();
    await tick();
    expect(h.closes[0]?.message).toMatch(/closed unexpectedly/);
  });
});

describe('RfbUpstream request rate (M2-BE-08, §4.3)', () => {
  // `Date` too, because the scheduler compares the last request's timestamp
  // against the interval; faking only the timer would make every gap look
  // already elapsed. `setImmediate` stays real so `tick()` still drains the
  // socket the way the rest of this file does.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const KEEPALIVE = 1_000;

  it('waits out the interval before asking for the next update', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume(KEEPALIVE);
    expect(h.socket.requests()).toHaveLength(1);

    h.socket.feed(update());
    await tick();
    expect(h.messages).toHaveLength(1);

    // Without this the pump would answer every update by asking for the next
    // one at once, which is exactly the full-rate read §4.3 caps when nobody
    // is watching.
    expect(h.socket.requests()).toHaveLength(1);

    vi.advanceTimersByTime(KEEPALIVE);
    expect(h.socket.requests()).toHaveLength(2);
  });

  it('is a ceiling, not a floor: a quiet desktop costs no requests at all', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume(KEEPALIVE);

    // An incremental request goes unanswered until something moves, and only
    // one is ever in flight — so a sandbox nobody is using produces no timer
    // wakeups and no traffic, however long it sits there.
    vi.advanceTimersByTime(10 * KEEPALIVE);
    expect(h.socket.requests()).toHaveLength(1);
  });

  it('lets a subscriber arriving mid-gap skip the rest of it', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume(KEEPALIVE);
    h.socket.feed(update());
    await tick();
    expect(h.socket.requests()).toHaveLength(1);

    // Reopening a panel must not cost up to a second of stale screen.
    h.upstream.resume(0);
    expect(h.socket.requests()).toHaveLength(2);
  });

  it('does not make a full repaint wait for the keepalive interval', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume(KEEPALIVE);
    h.socket.feed(update());
    await tick();

    h.upstream.requestFullRepaint();
    const requests = h.socket.requests();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.incremental).toBe(false);
  });

  it('cancels a pending keepalive when the pump is paused', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume(KEEPALIVE);
    h.socket.feed(update());
    await tick();

    h.upstream.pause();
    vi.advanceTimersByTime(5 * KEEPALIVE);
    expect(h.socket.requests()).toHaveLength(1);
  });

  it('cancels the pending keepalive on close rather than leaving it to fire', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.resume(KEEPALIVE);
    h.socket.feed(update());
    await tick();
    expect(vi.getTimerCount()).toBe(1);

    // Asserting on the timer, not on `requests()`: a closed upstream refuses
    // to write anyway, so a leaked timer would still look like a pass. It is
    // unref'd and so cannot hold the process open — what it would leak is a
    // pointless wakeup and a closure over a dead connection, once per
    // connection the proxy ever opens.
    h.upstream.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('RfbUpstream inbound input (M2-BE-07)', () => {
  const pointer = Buffer.from([ClientMessage.pointerEvent, 1, 0x02, 0x80, 0x01, 0x90]);

  it('writes a validated client message to the socket unchanged', async () => {
    const h = harness();
    await handshake(h);
    const before = h.socket.written.length;

    expect(h.upstream.sendInput(pointer)).toBe(true);
    await tick();

    // §4.3 forwards the operator's bytes; it does not re-encode them.
    expect(h.socket.written.slice(before)).toEqual([pointer]);
  });

  it('bounds queued input and reports a stalled upstream', async () => {
    const h = harness();
    await handshake(h);
    h.socket.stalled = true;

    // The peer stops consuming writes while the operator keeps sending input.
    // Use real Duplex buffering so ignoring backpressure grows the queue.
    let refused = false;
    for (let index = 0; index < 12_000; index++) {
      if (!h.upstream.sendInput(pointer)) {
        refused = true;
        break;
      }
    }

    expect(refused).toBe(true);
    expect(h.socket.writableLength).toBeLessThanOrEqual(64 * 1024);
    expect(h.socket.destroyed).toBe(true);
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0]?.message).toMatch(/input queue/);
    expect(h.upstream.sendInput(pointer)).toBe(false);
  });

  it('refuses to write before the handshake completes', () => {
    // Sending a PointerEvent mid-handshake would be read as ProtocolVersion
    // or a security choice, and the connection would never recover.
    const h = harness();
    expect(h.upstream.sendInput(pointer)).toBe(false);
    expect(h.socket.typesWritten()).not.toContain(ClientMessage.pointerEvent);
  });

  it('reports a dropped keystroke rather than throwing on a dead link', async () => {
    const h = harness();
    await handshake(h);
    h.upstream.close();

    // A high-rate path: a closed stream is something the caller reports to
    // the client, not an exception that unwinds a fan-out.
    expect(h.upstream.sendInput(pointer)).toBe(false);
  });
});
