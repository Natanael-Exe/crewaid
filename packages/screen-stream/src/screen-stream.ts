import { encodeTightReset, MIN_QUALITY } from './rfb-protocol.js';
import { AdaptiveQuality } from './screen-quality.js';
import {
  DeliveryLine,
  SCREEN_MAX_UPDATES_IN_FLIGHT,
  type DeliveredUpdate,
} from './screen-delivery.js';
import type { ServerMessageMeta } from './rfb-upstream.js';
import type { ScreenUpstream } from './screen-upstream.js';
import type { ScreenLogger } from './logger.js';
import type { ScreenStreamErrorCode } from '@crewaid/shared';

/**
 * One seat's desktop, read once from x11vnc and fanned out to every viewer.
 * No transcoding: the bytes a viewer receives are the bytes
 * x11vnc produced, sliced only at message boundaries.
 *
 * The same class runs wherever a stream is served — on the orchestrator, and
 * inside the computer itself — so a viewer cannot tell the two apart, and the
 * pacing below is written once.
 *
 * Why viewers are not attached immediately
 *
 * RFB updates are deltas against the framebuffer a viewer already has. A
 * viewer that joins mid-stream has none, so the first thing it receives must
 * be a whole-screen repaint — otherwise it decodes a delta against pixels it
 * never saw and the picture is wrong in a way that never corrects itself,
 * because later deltas only touch what changed.
 *
 * A late viewer needs fresh compression dictionaries as well as pixels.
 * Replace the upstream on a late join and precede its full repaint with a
 * Tight reset for all viewers. Existing viewers briefly pause while the
 * replacement handshakes; there is still only one active upstream.
 *
 * Quality
 *
 * The stream is shared, so its quality is the MAXIMUM any viewer asked for.
 * The bytes are pulled from x11vnc once and fanned out, so a viewer wanting a
 * coarse thumbnail costs nothing extra by receiving a better image — while
 * clamping to the lowest request would degrade the operator's full-screen view
 * because a thumbnail happened to be open. Nobody is served worse than they
 * asked, except where the line cannot carry it (`AdaptiveQuality`).
 *
 * Paced to delivery
 *
 * The upstream keeps one request in flight, which bounds what x11vnc sends
 * THIS process. It says nothing about the viewer, whose line is usually far
 * slower: sending each update without waiting fills every buffer on the way.
 * Measured on a 1 Mbit/s line with 700 ms of latency: 3 MB queued and a 1.7 s
 * round trip, so a scroll appeared seconds late.
 *
 * So after each update the stream sends every viewer it delivered to a MARK,
 * and counts the update as on its way until each has ACKED it. A mark travels
 * in order with the data, so an ack means the updates before it reached that
 * viewer — the viewer itself, not a proxy on the way, which is why this is not
 * a WebSocket ping. The stream asks x11vnc for the next update while that
 * window has room — at most `SCREEN_MAX_UPDATES_IN_FLIGHT`, and no more bytes
 * than the line carries without queueing (`DeliveryLine`) — and otherwise
 * waits for an ack. Nothing is dropped: requests are incremental, so x11vnc
 * folds every change made meanwhile into the next update — a slow viewer sees
 * fewer frames, never a broken one. Every viewer of a stream shares the
 * slowest one's pace, and a viewer that never answers is cut after
 * `SCREEN_DELIVERY_TIMEOUT_MS`.
 *
 * Why an empty stream is closed
 *
 * The bot keeps working while nobody watches, so a connection kept open for
 * nobody keeps reading a changing desktop. A returning viewer could not use it
 * anyway: Tight's zlib dictionaries carry everything sent on the old
 * connection, so a late joiner replaces it. The last viewer leaving therefore
 * closes the upstream outright. Input does not travel here, so nothing else
 * depends on this connection staying up.
 */
export class ScreenStream {
  private readonly viewers = new Map<ScreenViewer, ViewerState>();
  private upstream: ScreenUpstream | null = null;
  private closed = false;
  private resetPending = true;
  private opening: Promise<void> | null = null;
  private goneFn: (() => void) | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private recovering = false;
  /** True while the pump waits for room in the delivery window. */
  private held = false;
  private deliveryTimer: NodeJS.Timeout | null = null;
  private markSeq = 0;
  /** The quality last sent upstream, so an unchanged one is not renegotiated. */
  private appliedQuality: number | null = null;
  /** A quality change arrived while the window was full; its repaint waits for room. */
  private repaintOnRelease = false;
  /** Updates on their way to the viewers, oldest first. */
  private rounds: Round[] = [];
  private readonly line = new DeliveryLine();
  private readonly adaptive = new AdaptiveQuality();

  constructor(
    /** Names the stream in log lines; never parsed. */
    private readonly label: string,
    private readonly logger: ScreenLogger,
    /**
     * Opens a replacement after the upstream failed. Null means the seat is
     * gone on purpose — its computer stopped — and the stream ends quietly.
     */
    private readonly reopen: () => Promise<ScreenUpstream | null>,
  ) {}

  get size(): number {
    return this.viewers.size;
  }

  /** Fired once, when the stream has ended and holds nothing worth keeping. */
  onGone(fn: () => void): void {
    this.goneFn = fn;
  }

  /**
   * The effective stream quality: the best any viewer asked for, capped by
   * what the slowest viewer's line carries (`AdaptiveQuality`).
   */
  get quality(): number {
    return Math.min(this.requestedQuality, this.adaptive.cap);
  }

  /** The best any viewer asked for. */
  get requestedQuality(): number {
    let best = MIN_QUALITY;
    for (const viewer of this.viewers.values()) best = Math.max(best, viewer.quality);
    return best;
  }

  has(viewer: ScreenViewer): boolean {
    return this.viewers.has(viewer);
  }

  add(viewer: ScreenViewer, quality: number): void {
    const existing = this.viewers.get(viewer);
    if (existing !== undefined) {
      existing.quality = quality;
    } else {
      this.viewers.set(viewer, { quality, attached: false });
    }
  }

  /** A viewer asked for another quality: the expand/collapse of D-037. */
  setQuality(viewer: ScreenViewer, quality: number): void {
    const state = this.viewers.get(viewer);
    if (state === undefined) return;
    state.quality = quality;
    this.applyQuality();
  }

  remove(viewer: ScreenViewer): void {
    if (!this.viewers.delete(viewer)) return;
    if (this.viewers.size === 0) {
      this.close(null);
      this.goneFn?.();
      return;
    }
    this.settleRounds();
    this.applyQuality();
  }

  /** Connect once, even if several viewers arrive while the socket opens. */
  async ensureUpstream(open: () => Promise<ScreenUpstream>): Promise<void> {
    if (this.closed || this.recovering) return;
    if (this.upstream !== null) {
      if (this.resetPending || [...this.viewers.values()].every((viewer) => viewer.attached)) {
        this.applyQuality();
        this.applyRate();
        return;
      }
      // A full repaint does not reset Tight's persistent zlib dictionaries.
      // Replace the connection for a late join, then reset every decoder before
      // its first full update. This also avoids waiting forever for an idle
      // server to answer an outstanding incremental request.
      const previous = this.upstream;
      this.upstream = null;
      previous.close();
      this.resetPending = true;
      for (const viewer of this.viewers.values()) viewer.attached = false;
    }
    if (this.opening !== null) return this.opening;

    this.opening = (async () => {
      const upstream = await open();
      if (this.closed) {
        upstream.close();
        return;
      }
      this.bind(upstream);
    })();

    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  /**
   * An ack: the updates marked up to `seq` have reached this viewer. A mark
   * travels in order with the data, so acking one confirms every update sent
   * to this viewer before it too.
   */
  acked(viewer: ScreenViewer, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq > this.markSeq) return;
    for (const round of this.rounds) {
      if (round.seq > seq) break;
      round.waiting.delete(viewer);
    }
    this.settleRounds();
  }

  applyQuality(): void {
    if (this.upstream === null || this.quality === this.appliedQuality) return;
    this.appliedQuality = this.quality;
    this.renegotiate(this.quality, true);
  }

  /**
   * End the stream. `ending` is what each viewer is told on the way out; null
   * closes them without a word — the caller already said why, or nobody is
   * left to tell.
   */
  close(ending: ScreenStreamEnding | null): void {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.retryTimer = null;
    this.stableTimer = null;
    this.clearDeliveryTimer();
    this.held = false;
    this.rounds = [];
    this.recovering = false;
    const previous = this.upstream;
    this.upstream = null;
    previous?.close();
    const viewers = [...this.viewers.keys()];
    this.viewers.clear();
    for (const viewer of viewers) viewer.end(ending);
  }

  /** Full speed while anyone is watching; a held pump resumes on an ack instead. */
  private applyRate(): void {
    if (this.held || this.viewers.size === 0) return;
    this.upstream?.resume(0);
  }

  /**
   * Send a new quality upstream. Its repaint is a request the pump does not
   * make and is never rate-limited, so sent while the window is full it would
   * put a whole screen on the way past the window; it waits for room instead.
   */
  private renegotiate(quality: number, repaint: boolean): void {
    if (this.held && repaint) {
      this.upstream?.setQuality(quality, false);
      this.repaintOnRelease = true;
      return;
    }
    this.upstream?.setQuality(quality, repaint);
  }

  private onReady(upstream: ScreenUpstream): void {
    const screen = upstream.screen;
    this.logger.log(
      `screen stream ${this.label} up` +
        (screen === null ? '' : ` at ${screen.widthPx}x${screen.heightPx}`),
    );
    // The full repaint goes FIRST, and the order is load-bearing.
    //
    // `applyRate` starts the pump, and a pump started before anything asks for
    // a repaint sends an INCREMENTAL request. Its update is then dropped for
    // want of an attached viewer — but x11vnc has already advanced its Tight
    // zlib dictionaries producing it. The reset sent before the real repaint
    // resets the VIEWER's streams only, so from there the two ends disagree
    // about dictionary state and every later rectangle fails to inflate. The
    // viewer connects, draws nothing, and reports "zlib inflate failed" — with
    // no sign of trouble anywhere on this side.
    //
    // Requesting the repaint first leaves `awaitingUpdate` set, so the
    // `applyRate` below records the rate without issuing a second request.
    if (this.viewers.size > 0) upstream.requestFullRepaint();
    this.applyRate();
  }

  private bind(upstream: ScreenUpstream): void {
    // A hold belongs to the connection it paused. The new one starts pumping,
    // and its first update is paced like any other. What was learned about
    // the viewers' line stays: a new connection to the machine does not change it.
    this.clearDeliveryTimer();
    this.held = false;
    this.repaintOnRelease = false;
    this.rounds = [];
    this.upstream = upstream;
    upstream.setQuality(this.quality);
    this.appliedQuality = this.quality;
    // A replaced connection can deliver a queued close/data callback. It no
    // longer owns this stream and must not tear down its successor.
    upstream.onMessage((message, meta) => {
      if (this.upstream === upstream) this.fanOut(message, meta);
    });
    upstream.onReady(() => {
      if (this.upstream === upstream) this.onReady(upstream);
    });
    upstream.onClose((reason) => {
      if (this.upstream === upstream) this.onUpstreamClosed(reason);
    });
  }

  private onUpstreamClosed(reason: Error | null): void {
    this.upstream = null;
    this.resetPending = true;
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    for (const viewer of this.viewers.values()) viewer.attached = false;
    if (reason === null || this.viewers.size === 0) {
      this.close(null);
      this.goneFn?.();
      return;
    }
    this.logger.warn(`screen stream ${this.label} lost its upstream: ${reason.message}`);
    this.scheduleRecovery(reason);
  }

  private scheduleRecovery(reason: Error): void {
    if (this.closed) return;
    const delay = SCREEN_RECOVERY_DELAYS_MS[this.retries++];
    if (delay === undefined) {
      this.close({
        code: 'SCREEN_STREAM_LOST',
        message: 'The display could not reconnect. Reopen the computer to try again.',
      });
      this.goneFn?.();
      return;
    }
    this.recovering = true;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.recover(reason);
    }, delay).unref();
  }

  private async recover(reason: Error): Promise<void> {
    try {
      const upstream = await this.reopen();
      if (this.closed) {
        upstream?.close();
        return;
      }
      if (upstream === null) {
        this.close({ code: 'SCREEN_NOT_RUNNING', message: 'The computer is no longer running.' });
        this.goneFn?.();
        return;
      }
      this.bind(upstream);
      // Keep the recovery flag through the handshake, so a joining viewer
      // cannot open a competing connection while this one is still starting.
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : reason;
      this.logger.warn(`screen reconnect for ${this.label} failed: ${failure.message}`);
      this.scheduleRecovery(failure);
    }
  }

  private fanOut(message: Buffer, meta: ServerMessageMeta): void {
    const reset = meta.fullRepaint && this.resetPending;
    if (reset) {
      this.resetPending = false;
      this.recovering = false;
      // A brief handshake followed by another failure is still the same
      // outage. Only a sustained connection earns a fresh retry budget.
      if (this.stableTimer !== null) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.retries = 0;
        this.stableTimer = null;
      }, 30_000).unref();
    }
    for (const [viewer, state] of this.viewers) {
      if (!state.attached) {
        // Pending viewers wait for a whole screen; see the class comment.
        if (!meta.fullRepaint) continue;
        state.attached = true;
      }
      if (reset) this.send(viewer, encodeTightReset());
      this.send(viewer, message);
    }
    if (meta.update) this.awaitDelivery(message.length);
  }

  /**
   * Mark this update for every viewer it reached, count it as on its way until
   * each has acked, and hold the pump when that fills the window (see the
   * class comment).
   *
   * Runs inside the upstream's message callback, before it schedules the next
   * request, so a `pause` here means that request is never sent — and no
   * pause means it is sent at once, before any viewer has this update.
   */
  private awaitDelivery(bytes: number): void {
    const seq = ++this.markSeq;
    const waiting = new Set<ScreenViewer>();
    for (const [viewer, state] of this.viewers) {
      if (!state.attached || !viewer.isOpen) continue;
      try {
        viewer.sendMark(seq);
        waiting.add(viewer);
      } catch {
        // A viewer that cannot be marked cannot hold the stream either.
      }
    }
    if (waiting.size === 0) return;
    this.rounds.push({
      seq,
      bytes,
      sentAt: Date.now(),
      lineWasIdle: this.rounds.length === 0,
      waiting,
    });
    if (this.rounds.length === 1) this.armDeliveryTimer();
    if (this.hasRoom) return;
    this.held = true;
    this.upstream?.pause();
  }

  /**
   * Whether the pump may ask for another update before the viewers confirm
   * the ones on their way. The request counts as one of them.
   */
  private get hasRoom(): boolean {
    if (this.rounds.length === 0) return true;
    if (this.rounds.length >= SCREEN_MAX_UPDATES_IN_FLIGHT) return false;
    let bytes = 0;
    for (const round of this.rounds) bytes += round.bytes;
    return bytes < this.line.budgetBytes;
  }

  /**
   * The oldest update has not reached every viewer in
   * `SCREEN_DELIVERY_TIMEOUT_MS`.
   *
   * Sending more would put more updates in flight to a viewer that has not
   * taken the ones it has — the backlog pacing exists to prevent. So a silent
   * viewer is never sent past the window. Alone, the stream keeps waiting:
   * nothing piles up, and the late ack, when it comes, reads as a very slow
   * delivery. Beside viewers that did confirm, it is cut, so it cannot freeze
   * the stream for them; its client reconnects.
   */
  private onDeliveryTimeout(): void {
    const oldest = this.rounds[0];
    if (oldest === undefined) return;
    const silent = [...oldest.waiting].filter((viewer) => viewer.isOpen);
    let confirmed = false;
    for (const [viewer, state] of this.viewers) {
      if (state.attached && viewer.isOpen && !oldest.waiting.has(viewer)) confirmed = true;
    }
    if (silent.length > 0 && !confirmed) return;
    for (const viewer of silent) {
      this.logger.warn(
        `screen viewer of ${this.label} confirmed nothing for ${SCREEN_DELIVERY_TIMEOUT_MS} ms; disconnecting it`,
      );
      viewer.terminate('confirmed nothing in time');
    }
    this.settleRounds();
  }

  /**
   * Retire every update that has reached all of its viewers, oldest first,
   * learning from each, and resume the pump if that made room. A viewer that
   * left or closed is no longer waited for.
   */
  private settleRounds(): void {
    const now = Date.now();
    let retired = false;
    for (let oldest = this.rounds[0]; oldest !== undefined; oldest = this.rounds[0]) {
      for (const viewer of oldest.waiting) {
        if (!this.viewers.has(viewer) || !viewer.isOpen) oldest.waiting.delete(viewer);
      }
      if (oldest.waiting.size > 0) break;
      this.rounds.shift();
      retired = true;
      this.adapt(oldest, now);
    }
    if (retired) this.armDeliveryTimer();
    if (this.held && this.hasRoom) this.release();
  }

  /** Resume the pump: the window has room again. */
  private release(): void {
    this.held = false;
    if (this.repaintOnRelease) {
      this.repaintOnRelease = false;
      this.upstream?.requestFullRepaint();
    }
    this.applyRate();
  }

  /**
   * Feed one delivered update to the line's estimate and to `AdaptiveQuality`,
   * and renegotiate when the line calls for it. A change applies from the next
   * update x11vnc encodes.
   */
  private adapt(update: DeliveredUpdate, deliveredAt: number): void {
    const transferMs = this.line.delivered(update, deliveredAt);
    if (transferMs === null || this.upstream === null) return;
    const before = this.quality;
    const change = this.adaptive.record(update.bytes, transferMs, this.requestedQuality);
    if (change === null || this.quality === before) return;
    this.logger.log(
      `screen quality for ${this.label}: ${before} -> ${this.quality} ` +
        `(a ${update.bytes}-byte update took ${transferMs} ms to transfer)`,
    );
    this.appliedQuality = this.quality;
    this.renegotiate(this.quality, change.direction === 'up');
  }

  /** Time out the oldest update on its way, if there is one. */
  private armDeliveryTimer(): void {
    this.clearDeliveryTimer();
    const oldest = this.rounds[0];
    if (oldest === undefined) return;
    const due = Math.max(0, oldest.sentAt + SCREEN_DELIVERY_TIMEOUT_MS - Date.now());
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = null;
      this.onDeliveryTimeout();
    }, due).unref();
  }

  private clearDeliveryTimer(): void {
    if (this.deliveryTimer !== null) clearTimeout(this.deliveryTimer);
    this.deliveryTimer = null;
  }

  private send(viewer: ScreenViewer, message: Uint8Array): void {
    if (!viewer.isOpen) return;
    // Never drop individual deltas: a slow viewer must reconnect with fresh
    // decoder state. Bound its queue so it cannot exhaust this process's
    // memory. Pacing keeps queues far below this, so reaching it means a
    // viewer that stopped reading.
    if (viewer.bufferedBytes > SCREEN_VIEWER_MAX_BUFFERED_BYTES) {
      this.logger.warn(
        `screen viewer of ${this.label} fell ${viewer.bufferedBytes} bytes behind; disconnecting it`,
      );
      viewer.terminate('fell too far behind');
      return;
    }
    viewer.sendRfb(message);
  }
}

/**
 * One viewer of a stream, as the stream needs to know it. Implemented over a
 * WebSocket by each host; the stream never touches a socket itself.
 */
export interface ScreenViewer {
  /** False once its transport closed; the stream stops waiting for it. */
  readonly isOpen: boolean;
  /** Bytes queued on its transport and not yet handed to the network. */
  readonly bufferedBytes: number;
  /** One complete RFB server message, as a binary frame. */
  sendRfb(message: Uint8Array): void;
  /** Ask the viewer to ack everything sent before this point. */
  sendMark(seq: number): void;
  /** Cut a viewer that fell behind or stopped acking; its client reconnects. */
  terminate(reason: string): void;
  /** Close normally, telling the viewer why when there is something to say. */
  end(ending: ScreenStreamEnding | null): void;
}

/** What a viewer is told when its stream ends on the server's side. */
export interface ScreenStreamEnding {
  readonly code: ScreenStreamErrorCode;
  readonly message: string;
}

interface ViewerState {
  quality: number;
  /** False until a full repaint has been forwarded to this viewer. */
  attached: boolean;
}

/** One update on its way to the viewers, until each acks the mark sent after it. */
interface Round extends DeliveredUpdate {
  readonly seq: number;
  /** The viewers yet to ack. */
  readonly waiting: Set<ScreenViewer>;
}

/**
 * How long the stream waits for a viewer to confirm an update before carrying
 * on without it. Long enough for a whole-screen update over a slow, distant
 * line (a few seconds at 1 Mbit/s); short enough that a viewer that never
 * answers slows the stream rather than freezing it.
 */
export const SCREEN_DELIVERY_TIMEOUT_MS = 10_000;

/** A viewer this far behind is cut rather than buffered for. */
export const SCREEN_VIEWER_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Bounded transport recovery; never a computer wake or an unbounded loop. */
export const SCREEN_RECOVERY_DELAYS_MS = [250, 1_000, 3_000] as const;
