import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { WebSocket } from 'ws';

import { PrismaService } from '../prisma/prisma.service.js';
import { sendBounded } from '../ws/ws-limits.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { SandboxActivityService } from '../sandbox/sandbox-activity.service.js';
import { SeatService, type Seat } from '../sandbox/seat.service.js';
import { RecordingTeeService } from '../recordings/recording-tee.service.js';
import { stampWireVersion, ServerFrameSchema, type ServerFrame } from '@crewaid/shared';
import { MIN_QUALITY, SCREEN_RECOVERY_DELAYS_MS } from '@crewaid/screen-stream';
import { SeatControlService } from './seat-control.service.js';
import { validateClientInput } from './rfb-input.js';
import type { ScreenUpstream } from './screen-upstream.port.js';
import { SeatRfbConnector } from './seat-rfb.connector.js';
import { computerOfBot } from '../sandbox/attached-computer.js';

/**
 * Who watches each bot's screen over WebSocket, and the one way their keyboard and
 * pointer reach its desktop.
 *
 * The pixels are not here. They travel on a stream socket of their own
 * (`screen-stream.ts` in the contract, `ScreenStreamHost` or a gateway inside
 * the computer), so a watcher here is a socket that may send `screen.input`
 * and ask for `screen.control` — nothing more is read from the desktop.
 *
 * One input connection per seat
 *
 * Each watched seat has one RFB connection to its x11vnc that never asks for a
 * framebuffer update, so it carries keystrokes and pointer events one way and
 * nothing but the odd Bell or clipboard message back. Every watcher's input
 * goes down it, after seat control lets it through and the recording tee has
 * seen it.
 *
 * Why an unwatched connection is kept
 *
 * Closing the panel does not end the seat. Keeping the connection costs no
 * reads — it requests nothing — and it keeps the first contact a one-off:
 * the first time this process reaches a display it lets go of anything a
 * holder had down before a restart, and doing that on every reopen would also
 * send the pointer to the corner while the bot works. It goes when its upstream
 * does, which is when the computer stops.
 */
@Injectable()
export class ScreenService implements OnModuleDestroy {
  private readonly logger = new Logger(ScreenService.name);

  private readonly requests = new WeakMap<WebSocket, Map<string, object>>();

  private readonly links = new Map<string, InputLink>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeatRfbConnector) private readonly connector: SeatRfbConnector,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(SandboxActivityService) private readonly activity: SandboxActivityService,
    @Inject(RecordingTeeService) private readonly recorder: RecordingTeeService,
    @Inject(SeatService) private readonly seats: SeatService,
    /**
     * Who may drive each seat. Last, and optional, so a suite that
     * builds this without it can still observe, but input fails closed rather than using a shifted
     * argument; the app always provides it.
     */
    @Inject(SeatControlService)
    private readonly seatControl?: SeatControlService,
  ) {
    seatControl?.bindIo({
      prepareHuman: async (botId, leaseMs, drainMs) => {
        const sessionId = this.links.get(botId)?.sessionId;
        if (sessionId === undefined) throw new ScreenError('This screen has no live computer.');
        return this.seats.prepareHuman(sessionId, botId, leaseMs, drainMs);
      },
      forward: (botId, rfb) => {
        this.links.get(botId)?.forwardInput(rfb);
      },
      broadcast: (botId, stateFor) => {
        for (const client of this.links.get(botId)?.clients() ?? []) {
          this.sendFrame(client, 'screen.control.state', botId, stateFor(client));
        }
      },
      refuse: (socket, botId, refusal) => {
        for (const client of this.links.get(botId)?.clients() ?? []) {
          if (client === socket) this.sendFrame(client, 'error', botId, refusal);
        }
      },
    });
  }

  /**
   * WebSocket `screen.control`. Only a socket watching the seat may ask
   * for it; the answer reaches every watcher as `screen.control.state`.
   */
  async control(
    client: WebSocket,
    botId: string,
    request: Parameters<SeatControlService['seats']['control']>[2],
  ): Promise<void> {
    const link = this.links.get(botId);
    if (link === undefined || !link.has(client)) {
      throw new ScreenError(`not subscribed to the screen of bot ${botId}`);
    }
    if (this.seatControl === undefined) throw new ScreenError('seat control is not available');
    await this.seatControl.seats.control(client, botId, request);
  }

  /** One §4.2 JSON frame to one socket, valid or not sent at all. */
  private sendFrame(
    client: WebSocket,
    type: ServerFrame['type'],
    botId: string,
    payload: unknown,
  ): void {
    const frame = ServerFrameSchema.safeParse({
      id: randomUUID(),
      type,
      botId,
      ts: Date.now(),
      payload,
    });
    if (!frame.success) {
      this.logger.warn(`screen frame ${type} for bot ${botId} did not validate; not sent`);
      return;
    }
    if (client.readyState === OPEN)
      sendBounded(client, JSON.stringify(stampWireVersion(frame.data)));
  }

  /**
   * §4.2 `screen.subscribe`. Resolves the bot through its owner first (R7):
   * the socket is authenticated, but a socket is not an authorisation to
   * drive an arbitrary bot's desktop.
   */
  async subscribe(userId: string, client: WebSocket, botId: string): Promise<void> {
    const requests = this.requests.get(client) ?? new Map<string, object>();
    this.requests.set(client, requests);
    const request = {};
    requests.set(botId, request);

    try {
      const bot = await this.prisma.bot.findFirst({
        where: { id: botId, userId },
        select: { id: true },
      });
      if (bot === null) throw new ScreenError('Bot not found');

      const sandbox = await computerOfBot(this.prisma, botId, {
        state: true,
        sessionId: true,
        widthPx: true,
        heightPx: true,
      });
      if (sandbox === null || sandbox.state !== 'RUNNING') {
        // Not an error the client should retry blindly: §4.1 start is what makes
        // a screen exist, and saying so beats a connection timeout.
        throw new ScreenError(
          `sandbox for bot ${botId} is ${sandbox?.state ?? 'STOPPED'}; start it before subscribing`,
        );
      }

      if (client.readyState !== OPEN || requests.get(botId) !== request) return;
      const link = this.links.get(botId) ?? this.newLink(botId);
      this.links.set(botId, link);
      link.add(client);

      try {
        await link.ensureUpstream(() =>
          this.openUpstream(sandbox.sessionId ?? botId, botId, link, {
            widthPx: sandbox.widthPx,
            heightPx: sandbox.heightPx,
          }),
        );
      } catch (error: unknown) {
        if (requests.get(botId) === request) link.remove(client);
        this.settle(botId, link);
        throw error;
      }
      if (this.seatControl !== undefined) {
        // A new watcher learns who drives before its first frame of input.
        this.sendFrame(
          client,
          'screen.control.state',
          botId,
          this.seatControl.seats.stateFor(client, botId),
        );
      }
    } finally {
      if (requests.get(botId) === request) requests.delete(botId);
    }
  }

  /**
   * §4.2 `screen.input` (M2-BE-07, R6). One validated RFB client message on
   * its way to one sandbox's x11vnc.
   *
   * Why there is no database read here
   *
   * `subscribe` already resolved this bot through its owner, and a socket is
   * only among a link's watchers because that check passed. Membership IS the
   * authorisation, so an unsubscribed socket is refused before anything else
   * happens and a subscribed one costs zero queries — which matters on a path
   * that carries every mouse move the operator makes.
   *
   * The refusal is the same sentence whether the bot is unknown, someone
   * else's, or simply not subscribed: all three are "you are not watching
   * this screen", and distinguishing them would leak which bots exist over a
   * channel that never had to answer that question.
   */
  input(client: WebSocket, botId: string, rfb: Uint8Array, epoch?: number): void {
    const link = this.links.get(botId);
    if (link === undefined || !link.has(client)) {
      throw new ScreenError(`not subscribed to the screen of bot ${botId}`);
    }

    const verdict = validateClientInput(rfb);
    if (!verdict.ok) throw new ScreenError(verdict.reason);

    if (!link.acceptsInput) {
      throw new ScreenError(`the screen stream for bot ${botId} is not connected`);
    }

    // Watching is not driving. Only the socket holding the seat gets
    // through, and what it holds down is recorded so a hand-back can let go.
    if (this.seatControl === undefined)
      throw new ScreenError('Seat control is unavailable.', 'SEAT_UNAVAILABLE');
    const refused = this.seatControl.seats.input(client, botId, verdict.event, epoch);
    if (refused !== null) throw new ScreenError(refused.message, refused.code);

    // The tee: when the bot has an active Recording, the decoded
    // event is written to the recording pipeline BEFORE the forward.
    //
    // The order is the contract's, and it is the safe one of the two. Teeing
    // first can only ever record an event the desktop did not receive — a
    // recording one event longer than the session, which the compiler reads as
    // one extra step. Forwarding first would allow the opposite: an event the
    // desktop acted on that the trace does not contain, so the generated skill
    // reproduces a sequence that never happened and the failure appears at the
    // step AFTER the missing one. The tee neither throws nor awaits, so this
    // costs the forward nothing.
    this.recorder.tee(botId, verdict.event);

    if (!link.forwardInput(rfb)) {
      throw new ScreenError(`the screen stream for bot ${botId} is not connected`);
    }

    // Manual takeover is work, and this is the only place it is visible.
    // Note that SUBSCRIBING is deliberately not marked: a rail thumbnail is
    // open for as long as the app is, and D-031 forbids watching from keeping
    // compute alive. Only a message the operator actually sent, and only after
    // it reached the desktop, counts. The call coalesces writes relative to
    // the configured idle deadline so this stays the zero-query hot path.
    this.activity.touch(botId);
  }

  /** §4.2 `screen.unsubscribe`. */
  unsubscribe(client: WebSocket, botId: string): void {
    this.requests.get(client)?.delete(botId);
    // A holder that stops watching cannot keep driving.
    this.seatControl?.seats.unsubscribed(client, botId);
    const link = this.links.get(botId);
    if (link === undefined) return;
    link.remove(client);
    this.settle(botId, link);
  }

  /**
   * A closed socket is an unsubscribe from everything it was watching. Without
   * this a dead socket stays a watcher, and seat-control frames keep being
   * written to it — the leak is invisible because neither side errors.
   */
  detach(client: WebSocket): void {
    this.requests.get(client)?.clear();
    this.seatControl?.seats.detached(client);
    for (const [botId, link] of [...this.links]) {
      if (!link.has(client)) continue;
      link.remove(client);
      this.settle(botId, link);
    }
  }

  onModuleDestroy(): void {
    this.seatControl?.seats.dispose();
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }

  /** Test seam and operational read: how many sockets are watching a bot. */
  subscriberCount(botId: string): number {
    return this.links.get(botId)?.size ?? 0;
  }

  /**
   * How many seats this process holds an input connection for.
   *
   * Distinct from `subscriberCount`, which reads 0 both for a bot with no
   * watchers and for a bot with no connection at all — so it cannot see an
   * entry that outlived its upstream, which is the leak worth watching now
   * that an unwatched connection is kept.
   */
  streamCount(): number {
    return this.links.size;
  }

  private newLink(botId: string): InputLink {
    const link: InputLink = new InputLink(botId, this.logger, this.events, async () => {
      // A reconnect must never wake a stopped/stopping computer.
      const sandbox = await computerOfBot(this.prisma, botId, {
        state: true,
        sessionId: true,
        widthPx: true,
        heightPx: true,
      });
      if (sandbox === null || sandbox.state !== 'RUNNING') return null;
      link.seat = undefined;
      return this.openUpstream(sandbox.sessionId ?? botId, botId, link, sandbox);
    });
    // A link whose upstream is gone has nothing left to keep alive, and
    // holding the entry would leak one object per bot for the process's life.
    link.onGone(() => {
      this.forget(botId, link);
      // The seat's display went with its connection: control ends there.
      this.seatControl?.seats.seatEnded(botId);
    });
    // The first time this process reaches the display, anything a
    // holder had down before a restart is let go of. Not at subscribe: the
    // connection is still handshaking there, and the key-ups would be dropped.
    link.onConnected(() => this.seatControl?.seats.firstContact(botId));
    link.onDisconnected(() => this.seatControl?.seats.seatEnded(botId));
    return link;
  }

  private forget(botId: string, link: InputLink): void {
    if (this.links.get(botId) === link) this.links.delete(botId);
  }

  /** Drop a link that has neither watchers nor a connection worth keeping. */
  private settle(botId: string, link: InputLink): void {
    if (link.size > 0) return;
    if (!link.isConnected || link.isRecovering) {
      // Nothing to keep: the subscribe failed before a socket existed, the
      // upstream is already gone, or a reconnect would be for nobody.
      link.close();
      this.forget(botId, link);
    }
  }

  /**
   * The RFB connection this bot's input goes down: its seat's x11vnc, asked
   * for nothing but kept for input (see the class comment).
   */
  private async openUpstream(
    sessionId: string,
    botId: string,
    link: InputLink,
    geometry: { widthPx: number; heightPx: number },
  ): Promise<ScreenUpstream> {
    // The seat is resolved once per link, not once per subscribe: a link's
    // lifetime is exactly the window in which its seat is valid, and it keeps
    // an HTTP call into the machine off the path a second watcher takes.
    const { upstream, seat } = await this.connector.open({
      sessionId,
      botId,
      geometry,
      quality: MIN_QUALITY,
      seat: link.seat,
    });
    link.seat = seat;
    link.sessionId = sessionId;
    return upstream;
  }
}

/** One seat's input connection and the sockets watching it. */
class InputLink {
  sessionId: string | undefined;
  /**
   * The bot's seat, resolved on the first upstream this link opens. Held here
   * rather than in `SeatService` because a remembered seat must not outlive
   * the thing that can make it stale, and a link and its machine die together.
   */
  seat: Seat | undefined;
  private readonly watchers = new Set<WebSocket>();
  private upstream: ScreenUpstream | null = null;
  private closed = false;
  private opening: Promise<void> | null = null;
  private goneFn: (() => void) | null = null;
  private connectedFn: (() => void) | null = null;
  private disconnectedFn: (() => void) | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private recovering = false;

  constructor(
    private readonly botId: string,
    private readonly logger: Logger,
    private readonly events: TurnEventBus,
    private readonly reopen: () => Promise<ScreenUpstream | null>,
  ) {}

  get size(): number {
    return this.watchers.size;
  }

  /** Whether there is still a connection worth keeping alive. */
  get isConnected(): boolean {
    return this.upstream !== null || this.recovering;
  }

  get isRecovering(): boolean {
    return this.recovering;
  }

  get acceptsInput(): boolean {
    return this.upstream?.isStreaming === true && !this.recovering;
  }

  onGone(fn: () => void): void {
    this.goneFn = fn;
  }

  /** Fired each time an upstream finishes its handshake and can take input. */
  onConnected(fn: () => void): void {
    this.connectedFn = fn;
  }

  onDisconnected(fn: () => void): void {
    this.disconnectedFn = fn;
  }

  /** Every socket watching this seat, for a frame each of them is owed. */
  clients(): WebSocket[] {
    return [...this.watchers];
  }

  has(client: WebSocket): boolean {
    return this.watchers.has(client);
  }

  add(client: WebSocket): void {
    this.watchers.add(client);
  }

  remove(client: WebSocket): void {
    this.watchers.delete(client);
  }

  /** Connect once, even if several watchers arrive while the socket opens. */
  async ensureUpstream(open: () => Promise<ScreenUpstream>): Promise<void> {
    if (this.closed || this.recovering || this.upstream !== null) return;
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

  /** `false` when no upstream is attached, which is a dropped keystroke. */
  forwardInput(bytes: Uint8Array): boolean {
    return this.upstream?.sendInput(bytes) ?? false;
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.retryTimer = null;
    this.stableTimer = null;
    this.recovering = false;
    const previous = this.upstream;
    this.upstream = null;
    previous?.close();
    this.watchers.clear();
  }

  private bind(upstream: ScreenUpstream): void {
    this.upstream = upstream;
    // Nothing the desktop sends here matters: the link never asks for an
    // update, so all that can arrive is a Bell or a clipboard change.
    upstream.onMessage(() => undefined);
    // A replaced connection can deliver a queued callback. It no longer owns
    // this link and must not tear down its successor.
    upstream.onReady(() => {
      if (this.upstream !== upstream) return;
      this.recovering = false;
      // A brief handshake followed by another failure is still the same
      // outage. Only a sustained connection earns a fresh retry budget.
      if (this.stableTimer !== null) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.retries = 0;
        this.stableTimer = null;
      }, 30_000).unref();
      this.connectedFn?.();
    });
    upstream.onClose((reason) => {
      if (this.upstream === upstream) this.onUpstreamClosed(reason);
    });
  }

  private onUpstreamClosed(reason: Error | null): void {
    this.disconnectedFn?.();
    this.upstream = null;
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    if (reason === null || this.watchers.size === 0) {
      this.close();
      this.goneFn?.();
      return;
    }
    this.logger.warn(`screen input for bot ${this.botId} lost its upstream: ${reason.message}`);
    this.scheduleRecovery(reason);
  }

  private scheduleRecovery(reason: Error): void {
    if (this.closed) return;
    const delay = SCREEN_RECOVERY_DELAYS_MS[this.retries++];
    if (delay === undefined) {
      this.events.emitError(
        this.botId,
        'SCREEN_STREAM_LOST',
        'The display could not reconnect. Reopen the computer to try again.',
      );
      this.close();
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
        // The lifecycle's sandbox.state event explains an intentional stop.
        this.close();
        this.goneFn?.();
        return;
      }
      this.bind(upstream);
      // Keep the recovery flag through the handshake, so input is refused as
      // "not connected" rather than written into a connection still starting.
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : reason;
      this.logger.warn(`screen input reconnect for bot ${this.botId} failed: ${failure.message}`);
      this.scheduleRecovery(failure);
    }
  }
}

/** ws's numeric OPEN state, named rather than repeated as a literal 1. */
const OPEN = 1;

/** A subscribe that cannot be honoured. The gateway turns this into §4.2 `error`. */
export class ScreenError extends Error {
  /**
   * @param code A D-163 refusal code when a seat refused the request, so the
   *   gateway answers with it rather than a generic validation error.
   */
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ScreenError';
  }
}
