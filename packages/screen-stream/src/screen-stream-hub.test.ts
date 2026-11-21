import { constants, deflateSync, inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeTightReset, type ScreenGeometry } from './rfb-protocol.js';
import type { ServerMessageMeta } from './rfb-upstream.js';
import type { ScreenUpstream, ScreenUpstreamOptions } from './screen-upstream.js';
import {
  SCREEN_DELIVERY_TIMEOUT_MS,
  SCREEN_VIEWER_MAX_BUFFERED_BYTES,
  type ScreenStreamEnding,
  type ScreenViewer,
} from './screen-stream.js';
import { ScreenNotRunningError, ScreenStreamHub } from './screen-stream-hub.js';
import { SILENT_SCREEN_LOGGER } from './logger.js';

/**
 * The stream's fan-out and pacing, through the hub both hosts use.
 *
 * Every guarantee here is bookkeeping — how many connections exist, who
 * receives which bytes, when the pump may ask for more, what quality the
 * shared stream settles on — so a fake upstream and a fake viewer prove it
 * without a desktop. Ownership and computer state are the hosts' business and
 * are tested with them.
 */

const KEY = 'bot-1';

class FakeUpstream implements ScreenUpstream {
  isStreaming = true;
  screen: ScreenGeometry | null = { widthPx: 1280, heightPx: 800 };
  quality: number;
  closed = false;
  fullRepaintRequests = 0;
  /** Ordered log of pump calls; the ORDER is what a decoder depends on. */
  readonly calls: string[] = [];
  readonly qualityChanges: { quality: number; repaint: boolean }[] = [];

  private messageFn: ((m: Buffer, meta: ServerMessageMeta) => void) | null = null;
  private closeFn: ((reason: Error | null) => void) | null = null;
  private readyFn: ((geometry: ScreenGeometry) => void) | null = null;

  constructor(readonly options: ScreenUpstreamOptions) {
    this.quality = options.quality;
  }

  onReady(fn: (geometry: ScreenGeometry) => void): void {
    this.readyFn = fn;
  }
  onMessage(fn: (m: Buffer, meta: ServerMessageMeta) => void): void {
    this.messageFn = fn;
  }
  onClose(fn: (reason: Error | null) => void): void {
    this.closeFn = fn;
  }
  resume(minRequestIntervalMs = 0): void {
    this.calls.push(`resume:${minRequestIntervalMs}`);
  }
  pause(): void {
    this.calls.push('pause');
  }
  requestFullRepaint(): void {
    this.fullRepaintRequests += 1;
    this.calls.push('fullRepaint');
  }
  setQuality(quality: number, repaint = true): void {
    this.quality = quality;
    this.qualityChanges.push({ quality, repaint });
  }
  sendInput(): boolean {
    throw new Error('a screen stream never forwards input');
  }
  close(): void {
    this.closed = true;
  }

  /** Drive the stream the way a real connection would. */
  ready(): void {
    this.readyFn?.(this.screen ?? { widthPx: 1280, heightPx: 800 });
  }
  emit(bytes: string | Buffer, fullRepaint: boolean): void {
    this.messageFn?.(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'ascii'), {
      fullRepaint,
      update: true,
    });
  }
  /** An unsolicited server message (Bell, ServerCutText): not an update. */
  messageOnly(bytes: string): void {
    this.messageFn?.(Buffer.from(bytes, 'ascii'), { fullRepaint: false, update: false });
  }
  drop(reason: Error | null): void {
    this.isStreaming = false;
    this.closeFn?.(reason);
  }
}

/** Records what the stream sends one viewer, and acks the way the app does. */
class FakeViewer implements ScreenViewer {
  isOpen = true;
  bufferedBytes = 0;
  readonly frames: Buffer[] = [];
  readonly marks: number[] = [];
  /** The app acks each mark as it arrives; a test holds the ack back by turning this off. */
  autoAck = true;
  terminated = false;
  ended: ScreenStreamEnding | null | undefined = undefined;

  constructor(private readonly hub: ScreenStreamHub) {}

  sendRfb(message: Uint8Array): void {
    this.frames.push(Buffer.from(message));
  }
  sendMark(seq: number): void {
    this.marks.push(seq);
    if (this.autoAck) queueMicrotask(() => this.ack(seq));
  }
  /** Ack a mark, the way the app does once the updates before it arrived. */
  ack(seq = this.marks.at(-1) ?? 0): void {
    this.hub.acked(KEY, this, seq);
  }
  terminate(): void {
    this.isOpen = false;
    this.terminated = true;
  }
  end(ending: ScreenStreamEnding | null): void {
    this.isOpen = false;
    this.ended = ending;
  }
  /** What a decoder would read, with the Tight resets left out. */
  get pictures(): string[] {
    return this.frames.filter((frame) => !frame.equals(encodeTightReset())).map(String);
  }
}

const THUMBNAIL = 3;
const FULLSCREEN = 9;

/** An update too large to share the unmeasured line with another: a scroll, not a caret. */
const BUSY = Buffer.alloc(20_000, 7);

/**
 * One basic-Tight rectangle carrying `pixels` through a real zlib stream,
 * sync-flushed as a Tight encoder does, so the dictionary carries into the
 * next rectangle — which is what every reset assertion here exists to check.
 */
function tightFrame(pixels: Buffer): Buffer {
  const compressed = deflateSync(pixels, { finishFlush: constants.Z_SYNC_FLUSH });
  expect(compressed.length).toBeLessThan(128);
  const header = Buffer.alloc(18);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(4, 8);
  header.writeUInt16BE(4, 10);
  header.writeInt32BE(7, 12);
  header[17] = compressed.length;
  return Buffer.concat([header, compressed]);
}

/**
 * A minimal Tight decoder backed by real zlib: a stream that restarted its
 * dictionaries without telling the viewer throws here rather than quietly
 * producing the wrong pixels.
 */
function tightDecode(messages: readonly Buffer[]): Buffer {
  let history = Buffer.alloc(0);
  let pixels = Buffer.alloc(0);
  for (const message of messages) {
    if ((message[16]! & 1) !== 0) history = Buffer.alloc(0);
    if (message[16]! >> 4 === 8) continue;
    history = Buffer.concat([history, message.subarray(18)]);
    pixels = inflateSync(history, { finishFlush: constants.Z_SYNC_FLUSH });
  }
  return pixels;
}

describe('ScreenStreamHub', () => {
  let opened: FakeUpstream[];
  /** What `connect` answers: an upstream while running, null once the computer stopped. */
  let running: boolean;
  let connect: (key: string) => Promise<ScreenUpstream | null>;
  let hub: ScreenStreamHub;

  const latest = (): FakeUpstream => {
    const upstream = opened.at(-1);
    if (upstream === undefined) throw new Error('no upstream was opened');
    return upstream;
  };
  const viewer = (): FakeViewer => new FakeViewer(hub);

  beforeEach(() => {
    opened = [];
    running = true;
    connect = () => {
      if (!running) return Promise.resolve(null);
      const upstream = new FakeUpstream({ host: '127.0.0.1', port: 5901, quality: 0 });
      opened.push(upstream);
      return Promise.resolve(upstream);
    };
    hub = new ScreenStreamHub({ logger: SILENT_SCREEN_LOGGER, connect: (key) => connect(key) });
  });

  afterEach(() => {
    hub.close();
    vi.useRealTimers();
  });

  describe('one connection per seat', () => {
    it('opens a single upstream no matter how many viewers arrive at once', async () => {
      await Promise.all([
        hub.attach(KEY, viewer(), 3),
        hub.attach(KEY, viewer(), 5),
        hub.attach(KEY, viewer(), 1),
      ]);
      // ONE RFB connection per seat. Three would triple the load on x11vnc and
      // give three viewers three different framebuffers.
      expect(opened).toHaveLength(1);
      expect(hub.viewerCount(KEY)).toBe(3);
    });

    it('closes the upstream when the last viewer leaves', async () => {
      const a = viewer();
      const b = viewer();
      await hub.attach(KEY, a, 4);
      await hub.attach(KEY, b, 4);
      latest().ready();
      // Two viewers attached before the first repaint share one connection.
      expect(opened).toHaveLength(1);

      hub.detach(KEY, a);
      expect(latest().closed).toBe(false);

      // The bot keeps working with nobody watching, so a kept connection keeps
      // reading a changing desktop; a returning viewer would replace it anyway.
      hub.detach(KEY, b);
      expect(latest().closed).toBe(true);
      expect(hub.streamCount()).toBe(0);
    });

    it('forgets a stream whose upstream ends without a fault, and opens afresh', async () => {
      const client = viewer();
      await hub.attach(KEY, client, 4);
      latest().ready();
      latest().drop(null);
      expect(hub.streamCount()).toBe(0);
      expect(client.ended).toBeNull();

      await hub.attach(KEY, viewer(), 4);
      expect(opened).toHaveLength(2);
    });

    it('closes an upstream whose last viewer left while it was being opened', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = connect;
      connect = async (key) => {
        await gate;
        return open(key);
      };
      const client = viewer();
      const pending = hub.attach(KEY, client, 5);
      hub.detach(KEY, client);
      release();
      await pending;
      expect(hub.viewerCount(KEY)).toBe(0);
      expect(latest().closed).toBe(true);
    });
  });

  describe('attaching a viewer (the full-repaint rule)', () => {
    it('withholds updates until a whole screen arrives, then forwards verbatim', async () => {
      const client = viewer();
      await hub.attach(KEY, client, 6);
      const upstream = latest();
      upstream.ready();

      // An incremental update is a delta against a framebuffer this viewer has
      // never had. Forwarding it paints wrong pixels no later update corrects.
      upstream.emit('delta-1', false);
      expect(client.frames).toHaveLength(0);

      upstream.emit('WHOLE-SCREEN', true);
      expect(client.pictures).toEqual(['WHOLE-SCREEN']);
      upstream.emit('delta-2', false);
      expect(client.pictures).toEqual(['WHOLE-SCREEN', 'delta-2']);
    });

    it('sends the RFB message itself, with no envelope', async () => {
      const client = viewer();
      await hub.attach(KEY, client, 6);
      latest().ready();
      latest().emit('WHOLE-SCREEN', true);
      // A stream socket carries one seat; the bytes after the reset are x11vnc's.
      expect(client.frames.at(-1)?.toString()).toBe('WHOLE-SCREEN');
    });

    it('replaces the upstream and resets both decoders for a late joiner', async () => {
      const early = viewer();
      await hub.attach(KEY, early, 6);
      const upstream = latest();
      upstream.ready();
      upstream.emit('FULL', true);
      upstream.emit('d1', false);
      expect(early.pictures).toEqual(['FULL', 'd1']);

      const late = viewer();
      await hub.attach(KEY, late, 6);
      expect(upstream.closed).toBe(true);
      const replacement = latest();
      replacement.ready();
      replacement.emit('d2', false);
      expect(late.frames).toHaveLength(0);
      expect(early.pictures).toEqual(['FULL', 'd1']);

      replacement.emit('FULL-2', true);
      expect(late.frames[0]).toEqual(encodeTightReset());
      expect(early.frames.at(-2)).toEqual(encodeTightReset());
      expect(late.pictures).toEqual(['FULL-2']);
      expect(early.pictures).toEqual(['FULL', 'd1', 'FULL-2']);
    });

    it('lets old and new viewers inflate a fresh Tight stream after joining', async () => {
      const early = viewer();
      await hub.attach(KEY, early, 6);
      latest().ready();
      latest().emit(tightFrame(Buffer.alloc(48, 42)), true);
      const late = viewer();
      await hub.attach(KEY, late, 6);
      latest().ready();
      latest().emit(tightFrame(Buffer.alloc(48, 93)), true);
      for (const client of [early, late]) {
        expect(tightDecode(client.frames)).toEqual(Buffer.alloc(48, 93));
      }
    });

    it('cuts a slow viewer instead of buffering unbounded deltas', async () => {
      const client = viewer();
      await hub.attach(KEY, client, 6);
      latest().ready();
      latest().emit('FULL', true);
      const delivered = client.frames.length;
      client.bufferedBytes = SCREEN_VIEWER_MAX_BUFFERED_BYTES + 1;
      latest().emit('delta', false);
      expect(client.terminated).toBe(true);
      expect(client.frames).toHaveLength(delivered);
    });

    it('asks for the repaint before starting the pump', async () => {
      await hub.attach(KEY, viewer(), 6);
      latest().ready();
      // Starting the pump first sends an INCREMENTAL request whose update is
      // dropped for want of an attached viewer — after x11vnc already advanced
      // its zlib dictionaries producing it. The two ends then disagree and
      // every later rectangle fails to inflate.
      expect(latest().calls[0]).toBe('fullRepaint');
    });

    it('asks for a repaint when a viewer joins an already-running stream', async () => {
      await hub.attach(KEY, viewer(), 6);
      const upstream = latest();
      upstream.ready();
      upstream.emit('FULL', true);

      await hub.attach(KEY, viewer(), 6);
      expect(upstream.closed).toBe(true);
      latest().ready();
      expect(latest().fullRepaintRequests).toBe(1);
    });
  });

  describe('pacing to delivery (D-218, acked marks)', () => {
    it('asks for the next update before the viewer acks the last, up to three', async () => {
      // Waiting for every ack held a distant viewer to one frame per round
      // trip, and left no request at x11vnc for the keystroke typed meanwhile.
      const client = viewer();
      client.autoAck = false;
      await hub.attach(KEY, client, 6);
      const upstream = latest();
      upstream.ready();
      upstream.emit('FULL', true);
      expect(upstream.calls).not.toContain('pause');
      upstream.emit('caret', false);
      expect(upstream.calls).not.toContain('pause');
      upstream.emit('word', false);
      expect(client.marks).toHaveLength(3);
      expect(upstream.calls.at(-1)).toBe('pause');

      // One ack confirms its update and every one before it.
      client.ack(client.marks[0]);
      expect(upstream.calls.at(-1)).toBe('resume:0');
      upstream.emit('line', false);
      expect(upstream.calls.at(-1)).toBe('pause');
      client.ack();
      expect(upstream.calls.at(-1)).toBe('resume:0');
    });

    it('marks each update after its bytes, so an ack covers what came before it', async () => {
      const client = viewer();
      client.autoAck = false;
      await hub.attach(KEY, client, 6);
      latest().ready();
      latest().emit('FULL', true);
      latest().emit('caret', false);
      expect(client.marks).toEqual([1, 2]);
      expect(client.pictures).toEqual(['FULL', 'caret']);
    });

    it('holds the pump while the bytes on the way exceed what the line carries', async () => {
      const client = viewer();
      client.autoAck = false;
      await hub.attach(KEY, client, 6);
      latest().ready();
      latest().emit(BUSY, true);
      expect(client.marks).toHaveLength(1);
      expect(latest().calls.at(-1)).toBe('pause');

      // A quality change must not restart the pump before the viewer acked.
      const upstream = latest();
      hub.setQuality(KEY, client, 9);
      expect(latest()).toBe(upstream);
      expect(upstream.calls.at(-1)).toBe('pause');

      // An ack for a mark never sent confirms nothing.
      client.ack(99);
      expect(upstream.calls.at(-1)).toBe('pause');

      client.ack();
      expect(upstream.calls.at(-1)).toBe('resume:0');
    });

    it('lets several busy updates through a fast, distant line once it is measured', async () => {
      const client = viewer();
      client.autoAck = false;
      await hub.attach(KEY, client, 6);
      latest().ready();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      latest().emit('F', true); // small: calibrates the line's latency
      vi.advanceTimersByTime(185);
      client.ack();
      latest().emit(Buffer.alloc(200_000, 1), false);
      vi.advanceTimersByTime(185 + 200); // 1,000 bytes/ms: 185 KB on the way at once
      client.ack();
      const upstream = latest();
      upstream.calls.length = 0;
      upstream.emit(Buffer.alloc(60_000, 2), false);
      upstream.emit(Buffer.alloc(60_000, 3), false);
      expect(upstream.calls).not.toContain('pause');
      upstream.emit(Buffer.alloc(60_000, 4), false);
      expect(upstream.calls.at(-1)).toBe('pause');
    });

    it('paces every viewer of a stream to the slowest one', async () => {
      const fast = viewer();
      const slow = viewer();
      fast.autoAck = false;
      slow.autoAck = false;
      await hub.attach(KEY, fast, 6);
      latest().ready();
      latest().emit(BUSY, true);
      fast.ack();
      await hub.attach(KEY, slow, 6);
      latest().ready();
      latest().emit(BUSY, true);
      expect(latest().calls.at(-1)).toBe('pause');

      fast.ack();
      expect(latest().calls.at(-1)).toBe('pause');
      slow.ack();
      expect(latest().calls.at(-1)).toBe('resume:0');
    });

    it('does not wait for an unsolicited message, or for a viewer that leaves', async () => {
      const stays = viewer();
      const leaves = viewer();
      stays.autoAck = false;
      leaves.autoAck = false;
      await hub.attach(KEY, stays, 6);
      await hub.attach(KEY, leaves, 6);
      latest().ready();
      latest().messageOnly('bell');
      expect(stays.marks).toHaveLength(0);
      latest().emit(BUSY, true);
      stays.ack();
      expect(latest().calls.at(-1)).toBe('pause');
      hub.detach(KEY, leaves);
      expect(latest().calls.at(-1)).toBe('resume:0');
    });

    it('lowers the quality for a viewer whose updates arrive slowly, without a repaint', async () => {
      // A whole-screen repaint is the last thing a slow line needs.
      const client = viewer();
      client.autoAck = false;
      await hub.attach(KEY, client, 9);
      latest().ready();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      latest().emit('F', true); // small: calibrates the line's latency
      vi.advanceTimersByTime(200);
      client.ack();
      const repaintsBefore = latest().fullRepaintRequests;
      latest().emit(Buffer.alloc(200_000, 1), false);
      vi.advanceTimersByTime(1_700); // 1.5 s of transfer
      client.ack();
      expect(latest().quality).toBe(7);
      expect(latest().qualityChanges.at(-1)).toEqual({ quality: 7, repaint: false });
      expect(latest().fullRepaintRequests).toBe(repaintsBefore);
      expect(latest().calls.at(-1)).toBe('resume:0');
    });

    it('never sends past the window to a lone viewer that stops acking', async () => {
      // Carrying on after a timeout put one more unconfirmed update in flight
      // every time it fired: the backlog pacing exists to prevent.
      const client = viewer();
      client.autoAck = false;
      await hub.attach(KEY, client, 6);
      latest().ready();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      latest().emit('FULL', true);
      latest().emit('caret', false);
      latest().emit('word', false);
      vi.advanceTimersByTime(SCREEN_DELIVERY_TIMEOUT_MS * 3);
      expect(latest().calls.at(-1)).toBe('pause');
      expect(client.isOpen).toBe(true);
      // The late ack, when it comes, releases the stream.
      client.ack();
      expect(latest().calls.at(-1)).toBe('resume:0');
    });

    it('cuts a silent viewer that holds up viewers who keep up', async () => {
      const silent = viewer();
      const live = viewer();
      silent.autoAck = false;
      live.autoAck = false;
      await hub.attach(KEY, silent, 6);
      latest().ready();
      latest().emit('FULL', true);
      silent.ack();
      await hub.attach(KEY, live, 6);
      latest().ready();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      latest().emit(BUSY, true);
      live.ack();
      expect(latest().calls.at(-1)).toBe('pause');
      vi.advanceTimersByTime(SCREEN_DELIVERY_TIMEOUT_MS + 1);
      expect(silent.terminated).toBe(true);
      expect(live.isOpen).toBe(true);
      expect(latest().calls.at(-1)).toBe('resume:0');
    });

    it('holds a quality change’s repaint until the window has room', async () => {
      // The repaint request is never rate-limited: sent while the window was
      // full, it put another whole screen on the way.
      const client = viewer();
      client.autoAck = false;
      await hub.attach(KEY, client, 3);
      latest().ready();
      latest().emit(BUSY, true);
      const repaints = latest().fullRepaintRequests;
      hub.setQuality(KEY, client, 9);
      expect(latest().quality).toBe(9);
      expect(latest().qualityChanges.at(-1)).toEqual({ quality: 9, repaint: false });
      expect(latest().fullRepaintRequests).toBe(repaints);
      client.ack();
      expect(latest().fullRepaintRequests).toBe(repaints + 1);
    });
  });

  describe('quality on a shared stream', () => {
    it('settles on the highest quality any viewer asked for', async () => {
      await hub.attach(KEY, viewer(), 1);
      expect(latest().quality).toBe(1);
      // Pulled once and fanned out, so the thumbnail costs nothing extra by
      // receiving a better image; clamping to it would degrade the full view.
      const full = viewer();
      await hub.attach(KEY, full, 9);
      expect(latest().quality).toBe(9);
    });

    it('drops back when the demanding viewer leaves', async () => {
      const low = viewer();
      const high = viewer();
      await hub.attach(KEY, low, 2);
      await hub.attach(KEY, high, 8);
      expect(latest().quality).toBe(8);
      hub.detach(KEY, high);
      expect(latest().quality).toBe(2);
    });

    it('preserves the upstream and decoder history across expand and collapse', async () => {
      const client = viewer();
      await hub.attach(KEY, client, THUMBNAIL);
      const upstream = latest();
      upstream.ready();
      upstream.emit(tightFrame(Buffer.alloc(48, 42)), true);
      const initialFrames = [...client.frames];

      for (const quality of [FULLSCREEN, THUMBNAIL, FULLSCREEN, THUMBNAIL]) {
        // The viewer changes quality without reconnecting, so neither end
        // loses its compression dictionary during a presentation change.
        hub.setQuality(KEY, client, quality);
        expect(latest()).toBe(upstream);
        expect(opened).toHaveLength(1);
        expect(upstream.closed).toBe(false);
        expect(upstream.quality).toBe(quality);
        expect(hub.viewerCount(KEY)).toBe(1);
        expect(client.frames).toEqual(initialFrames);
        expect(tightDecode(client.frames)).toEqual(Buffer.alloc(48, 42));
      }
    });
  });

  describe('refusals', () => {
    it('refuses a computer that is not running, leaving nothing registered', async () => {
      running = false;
      await expect(hub.attach(KEY, viewer(), 5)).rejects.toBeInstanceOf(ScreenNotRunningError);
      expect(hub.streamCount()).toBe(0);
    });

    it('leaves no half-registered viewer when opening the upstream fails', async () => {
      connect = () => Promise.reject(new Error('no sandbox container is attached'));
      await expect(hub.attach(KEY, viewer(), 5)).rejects.toThrow(/no sandbox container/);
      expect(hub.viewerCount(KEY)).toBe(0);
      expect(hub.streamCount()).toBe(0);
    });
  });

  describe('losing the upstream', () => {
    it('tells its viewers after three unsuccessful reconnects, without looping forever', async () => {
      const client = viewer();
      await hub.attach(KEY, client, 5);
      latest().ready();
      latest().drop(new Error('container went away'));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await vi.waitFor(() => expect(opened).toHaveLength(attempt + 2), { timeout: 4500 });
        latest().drop(new Error('container went away'));
      }
      await vi.waitFor(() => expect(client.ended).toBeDefined());
      expect(client.ended?.code).toBe('SCREEN_STREAM_LOST');
      expect(client.ended?.message).toMatch(/could not reconnect/);
      expect(hub.streamCount()).toBe(0);
    }, 10_000);

    it('recovers viewers with fresh dictionaries and ignores callbacks from the old connection', async () => {
      const client = viewer();
      await hub.attach(KEY, client, 5);
      const upstream = latest();
      upstream.ready();
      upstream.emit(tightFrame(Buffer.alloc(48, 42)), true);
      upstream.drop(new Error('transport lost'));
      expect(hub.viewerCount(KEY)).toBe(1);
      await vi.waitFor(() => expect(opened).toHaveLength(2));
      const replacement = latest();
      replacement.ready();
      upstream.drop(new Error('late close'));
      upstream.emit('stale bytes', true);
      replacement.emit(tightFrame(Buffer.alloc(48, 77)), true);
      expect(hub.viewerCount(KEY)).toBe(1);
      expect(tightDecode(client.frames)).toEqual(Buffer.alloc(48, 77));
    });

    it('ends the stream, saying so, when the computer was stopped meanwhile', async () => {
      const client = viewer();
      await hub.attach(KEY, client, 5);
      latest().ready();
      running = false;
      latest().drop(new Error('RFB upstream closed unexpectedly'));
      await vi.waitFor(() => expect(client.ended).toBeDefined());
      // Not "lost": reconnecting would only fail again, and must never wake it.
      expect(client.ended?.code).toBe('SCREEN_NOT_RUNNING');
      expect(opened).toHaveLength(1);
    });

    it('cancels pending recovery when its last viewer leaves', async () => {
      const client = viewer();
      await hub.attach(KEY, client, 5);
      latest().ready();
      latest().drop(new Error('transport lost'));
      hub.detach(KEY, client);
      expect(hub.viewerCount(KEY)).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(opened).toHaveLength(1);
    });
  });
});
