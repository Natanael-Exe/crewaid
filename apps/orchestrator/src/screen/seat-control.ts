import type {
  ScreenControlPayload,
  ScreenControlStatePayload,
  SeatControlRefusalCode,
} from '@crewaid/shared';
import type { RfbInputEvent } from './rfb-input.js';

/**
 * Who may drive a bot's seat, and when the bot must wait.
 *
 * One state machine per seat, in memory and never persisted (D-163 §4). The
 * orchestrator is the only authority: a viewer's own idea of whether it is
 * in control grants nothing, and watching a seat is never permission to
 * drive it.
 *
 * agent ──take──▶ draining ──in-flight reaches 0──▶ human
 * ▲ │ drain deadline passes, or │ release, lease expiry,
 * │ │ the requester goes away │ holder closes or stops
 * └───────────────┴───────────────────────────────┘ watching: hand-back
 *
 * A hand-back releases every key and button the server saw held, raises the
 * epoch, and requires the bot to look before it acts on what is on screen.
 * This file does no I/O itself; the screen service gives it a port.
 */

/** A viewer, compared by identity: the socket that took control is the holder. */
export type SeatSocket = object;

export type SeatRefusal = {
  readonly code: SeatControlRefusalCode;
  readonly message: string;
};

/** What the state machine needs from the screen, and nothing else. */
export type RemoteSeatLease = {
  readonly renew: () => Promise<void>;
  readonly release: () => Promise<void>;
};

export type SeatIo = {
  /** Confirm that replays already running inside the sandbox have drained. */
  readonly prepareHuman?: (
    botId: string,
    leaseMs: number,
    drainMs: number,
  ) => Promise<RemoteSeatLease>;
  /** Send RFB client bytes to the seat's display, as the operator's input would go. */
  readonly forward: (botId: string, rfb: Uint8Array) => void;
  /** Send each subscriber of the seat its own view of the state. */
  readonly broadcast: (
    botId: string,
    stateFor: (socket: SeatSocket) => ScreenControlStatePayload,
  ) => void;
  /** Tell one socket its request was refused. */
  readonly refuse: (socket: SeatSocket, botId: string, refusal: SeatRefusal) => void;
};

export type SeatControlConfig = {
  readonly drainMs: number;
  readonly leaseMs: number;
  readonly agentWaitMs: number;
  readonly now?: () => number;
};

/** How a tool call relates to the seat (D-169's admission table). */
export type SeatActionKind =
  /** Acts on what is on screen: refused until the bot has looked after a hand-back. */
  | 'targeted'
  /** Acts on the seat without targeting what is shown (navigate, shell, a login). */
  | 'untargeted'
  /** Changes which profile the seat uses; drains other actions first. */
  | 'exclusive';

export type SeatAdmission =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly refusal: SeatRefusal };

type Seat = {
  mode: 'agent' | 'draining' | 'human';
  epoch: number;
  observationRequired: boolean;
  holder: SeatSocket | null;
  leaseExpiresAt: number | null;
  drainDeadline: number | null;
  inFlight: number;
  exclusive: boolean;
  exclusiveWaiters: number;
  pendingRemote: object | null;
  remoteLease: RemoteSeatLease | null;
  heldKeys: Set<number>;
  buttonMask: number;
  pointer: { x: number; y: number };
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Set<() => void>;
};

/** RFB client message types (RFC 6143 §7.5). */
const KEY_EVENT = 4;
const POINTER_EVENT = 5;

/**
 * Keysyms released on first contact after a restart, when nobody knows what
 * the last holder had down: both Shifts, Controls, Metas, Alts and Supers.
 */
const MODIFIER_KEYSYMS = [
  0xffe1, 0xffe2, 0xffe3, 0xffe4, 0xffe7, 0xffe8, 0xffe9, 0xffea, 0xffeb, 0xffec,
] as const;

export class SeatControl {
  private readonly seats = new Map<string, Seat>();
  private readonly contacted = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly io: SeatIo,
    private readonly config: SeatControlConfig,
  ) {
    this.now = config.now ?? Date.now;
  }

  // Viewers

  /** `screen.control`. The caller has already checked the socket watches this seat. */
  control(socket: SeatSocket, botId: string, request: ScreenControlPayload): void | Promise<void> {
    const seat = this.seat(botId);
    switch (request.action) {
      case 'take':
        return this.take(seat, socket, botId);
      case 'renew':
        return this.renew(seat, socket, botId, request.epoch);
      case 'release':
        return this.release(seat, socket, botId, request.epoch);
    }
  }

  /**
   * One operator input on its way to the display. Returns a refusal for a
   * socket that does not hold the seat; for the holder, records what is held
   * so a hand-back can let go of it.
   */
  input(
    socket: SeatSocket,
    botId: string,
    event: RfbInputEvent,
    epoch?: number,
  ): SeatRefusal | null {
    const seat = this.seat(botId);
    if (seat.mode !== 'human' || seat.holder !== socket) {
      return refusal('NOT_CONTROLLER', 'Take control of this screen before using it.');
    }
    if (epoch !== seat.epoch)
      return refusal('STALE_EPOCH', 'That input belongs to a control lease that has ended.');
    if (event.kind === 'key') {
      if (event.down) seat.heldKeys.add(event.keysym);
      else seat.heldKeys.delete(event.keysym);
    } else {
      seat.buttonMask = event.buttonMask;
      seat.pointer = { x: event.x, y: event.y };
    }
    return null;
  }

  /** A socket stopped watching a seat; if it held or was taking it, that ends. */
  unsubscribed(socket: SeatSocket, botId: string): void {
    const seat = this.seats.get(botId);
    if (seat === undefined || seat.holder !== socket) return;
    if (seat.mode === 'human') this.handBack(seat, botId);
    else if (seat.mode === 'draining') this.toAgent(seat, botId);
  }

  /** A socket closed, or its session was revoked: it lets go of everything. */
  detached(socket: SeatSocket): void {
    for (const botId of [...this.seats.keys()]) this.unsubscribed(socket, botId);
  }

  /** The seat's display or browser stopped or was replaced: control ends with it. */
  seatEnded(botId: string): void {
    this.contacted.delete(botId);
    const seat = this.seats.get(botId);
    if (seat === undefined) return;
    if (seat.mode === 'human') this.handBack(seat, botId);
    else if (seat.mode === 'draining') this.toAgent(seat, botId);
    else {
      seat.epoch += 1;
      seat.observationRequired = true;
      this.broadcast(botId);
    }
  }

  agentStateFor(botId: string): { epoch: number; mode: 'agent' | 'draining' | 'human' } {
    const seat = this.seat(botId);
    return { epoch: seat.epoch, mode: seat.mode };
  }

  /** The state as one socket should see it: the holder is `self`, `other`, or nobody. */
  stateFor(socket: SeatSocket, botId: string): ScreenControlStatePayload {
    const seat = this.seat(botId);
    const holder = seat.holder === null ? null : seat.holder === socket ? 'self' : 'other';
    const base = { botId, epoch: seat.epoch, observationRequired: seat.observationRequired };
    switch (seat.mode) {
      case 'agent':
        return { ...base, mode: 'agent', holder: null };
      case 'draining':
        return {
          ...base,
          mode: 'draining',
          holder: holder ?? 'other',
          drainDeadline: seat.drainDeadline ?? this.now(),
        };
      case 'human':
        return {
          ...base,
          mode: 'human',
          holder: holder ?? 'other',
          leaseExpiresAt: seat.leaseExpiresAt ?? this.now(),
        };
    }
  }

  /**
   * The first time this process reaches a seat's display. A restart lost what
   * the last holder had down, so every modifier and button is let go: a key
   * still held from before the crash would type into everything the bot does.
   */
  firstContact(botId: string): void {
    if (this.contacted.has(botId)) return;
    this.contacted.add(botId);
    for (const keysym of MODIFIER_KEYSYMS) this.io.forward(botId, keyEvent(keysym, false));
    this.io.forward(botId, pointerEvent(0, 0, 0));
  }

  // The bot

  /**
   * Admit one of the bot's seat actions, waiting while a person drives.
   *
   * The wait is not a step and a cancel ends it. A targeted action after a
   * hand-back is refused until the bot has looked, because what it is about
   * to click was decided before someone else moved things.
   */
  async admit(botId: string, kind: SeatActionKind, signal?: AbortSignal): Promise<SeatAdmission> {
    return this.admitAction(botId, kind, signal, true);
  }

  /** An authenticated operator may release a login without authorizing a screen target. */
  async admitIdentityRelease(botId: string): Promise<SeatAdmission> {
    return this.admitAction(botId, 'exclusive', undefined, false);
  }

  /** Teaching is allowed during human control, but cannot start across a profile transition. */
  admitRecordingStart(botId: string): SeatAdmission {
    const seat = this.seat(botId);
    if (seat.exclusive || seat.exclusiveWaiters > 0) {
      return {
        ok: false,
        refusal: refusal(
          'DRAIN_TIMEOUT',
          'A login change is in progress. Retry teaching after it finishes.',
        ),
      };
    }
    seat.inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        seat.inFlight -= 1;
        for (const wake of [...seat.waiters]) wake();
        if (seat.mode === 'draining' && seat.inFlight === 0) void this.prepareGrant(seat, botId);
      },
    };
  }

  private async admitAction(
    botId: string,
    kind: SeatActionKind,
    signal: AbortSignal | undefined,
    needsObservation: boolean,
  ): Promise<SeatAdmission> {
    const seat = this.seat(botId);
    const deadline = this.now() + this.config.agentWaitMs;
    const exclusive = kind === 'exclusive';
    if (exclusive) seat.exclusiveWaiters += 1;
    try {
      while (
        seat.mode !== 'agent' ||
        seat.exclusive ||
        (exclusive ? seat.inFlight > 0 : seat.exclusiveWaiters > 0)
      ) {
        const freed = await this.waitForAgent(seat, signal, Math.max(0, deadline - this.now()));
        if (!freed) {
          return {
            ok: false,
            refusal: refusal(
              seat.mode === 'agent' ? 'DRAIN_TIMEOUT' : 'HUMAN_IN_CONTROL',
              'The screen or a running action is still in use. Hand it back or wait for the action to finish.',
            ),
          };
        }
      }
      if (signal?.aborted === true)
        return {
          ok: false,
          refusal: refusal('SEAT_UNAVAILABLE', 'The seat action was cancelled.'),
        };
      if (needsObservation && seat.observationRequired) {
        return {
          ok: false,
          refusal: refusal(
            'OBSERVATION_REQUIRED',
            'This screen may have changed since you last looked. Take a screenshot or read the page, then act.',
          ),
        };
      }
      seat.inFlight += 1;
      if (exclusive) seat.exclusive = true;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          seat.inFlight -= 1;
          if (exclusive) seat.exclusive = false;
          for (const wake of [...seat.waiters]) wake();
          if (seat.mode === 'draining' && seat.inFlight === 0) void this.prepareGrant(seat, botId);
        },
      };
    } finally {
      if (exclusive) {
        seat.exclusiveWaiters -= 1;
        for (const wake of [...seat.waiters]) wake();
      }
    }
  }

  /** The bot looked at the seat while it had it: its next action may target the screen. */
  observed(botId: string, epoch = this.seat(botId).epoch): void {
    const seat = this.seat(botId);
    if (seat.mode === 'agent' && seat.epoch === epoch && seat.observationRequired) {
      seat.observationRequired = false;
      this.broadcast(botId);
    }
  }

  /** Only a successful read begun in this same agent epoch can authorize actions. */
  beginObservation(botId: string): () => void {
    const seat = this.seat(botId);
    const epoch = seat.epoch;
    const agent = seat.mode === 'agent';
    return () => {
      if (agent) this.observed(botId, epoch);
    };
  }

  dispose(): void {
    for (const [botId, seat] of this.seats) {
      if (seat.mode === 'human') this.handBack(seat, botId);
      else this.toAgent(seat, botId);
    }
    this.seats.clear();
    this.contacted.clear();
  }

  // Transitions

  private take(seat: Seat, socket: SeatSocket, botId: string): void | Promise<void> {
    if (seat.holder === socket) return;
    if (seat.mode !== 'agent') {
      this.io.refuse(
        socket,
        botId,
        refusal('NOT_CONTROLLER', 'Someone else is using this screen right now.'),
      );
      return;
    }
    seat.mode = 'draining';
    seat.holder = socket;
    seat.drainDeadline = this.now() + this.config.drainMs;
    this.schedule(seat, this.config.drainMs, () => {
      if (seat.mode !== 'draining' || seat.holder !== socket) return;
      // Exclusivity is never claimed for a seat that did not drain.
      this.io.refuse(
        socket,
        botId,
        refusal('DRAIN_TIMEOUT', 'The bot did not finish its current step in time. Try again.'),
      );
      this.toAgent(seat, botId);
    });
    if (seat.inFlight === 0) return this.prepareGrant(seat, botId);
    else this.broadcast(botId);
  }

  private renew(
    seat: Seat,
    socket: SeatSocket,
    botId: string,
    epoch: number,
  ): void | Promise<void> {
    const refused = this.checkHolder(seat, socket, epoch);
    if (refused !== null) return this.io.refuse(socket, botId, refused);
    if (seat.mode !== 'human') return;
    if (seat.remoteLease !== null) return this.renewRemote(seat, socket, botId, epoch);
    this.extendLease(seat, botId, this.now() + this.config.leaseMs);
  }

  private async renewRemote(
    seat: Seat,
    socket: SeatSocket,
    botId: string,
    epoch: number,
  ): Promise<void> {
    const lease = seat.remoteLease;
    const expiresAt = this.now() + this.config.leaseMs;
    try {
      await lease?.renew();
      if (
        seat.mode === 'human' &&
        seat.holder === socket &&
        seat.epoch === epoch &&
        seat.remoteLease === lease
      ) {
        if (expiresAt <= this.now()) this.handBack(seat, botId);
        else this.extendLease(seat, botId, expiresAt);
      }
    } catch {
      if (
        seat.mode === 'human' &&
        seat.holder === socket &&
        seat.epoch === epoch &&
        seat.remoteLease === lease
      ) {
        this.io.refuse(
          socket,
          botId,
          refusal('SEAT_UNAVAILABLE', 'The computer could not renew control. Take control again.'),
        );
        this.handBack(seat, botId);
      }
    }
  }

  private extendLease(seat: Seat, botId: string, expiresAt: number): void {
    seat.leaseExpiresAt = expiresAt;
    this.schedule(seat, Math.max(0, expiresAt - this.now()), () => this.handBack(seat, botId));
    this.broadcast(botId);
  }

  private release(seat: Seat, socket: SeatSocket, botId: string, epoch: number): void {
    const refused = this.checkHolder(seat, socket, epoch);
    if (refused !== null) return this.io.refuse(socket, botId, refused);
    if (seat.mode === 'human') this.handBack(seat, botId);
    else this.toAgent(seat, botId);
  }

  /** A late renew or release from a holder that has been superseded changes nothing. */
  private checkHolder(seat: Seat, socket: SeatSocket, epoch: number): SeatRefusal | null {
    if (seat.holder !== socket) {
      return refusal('NOT_CONTROLLER', 'You are not in control of this screen.');
    }
    if (epoch !== seat.epoch) {
      return refusal('STALE_EPOCH', 'That control has already ended. Take control again.');
    }
    return null;
  }

  private prepareGrant(seat: Seat, botId: string): void | Promise<void> {
    if (seat.pendingRemote !== null) return;
    if (this.io.prepareHuman === undefined) return this.grant(seat, botId);
    const prepare = {};
    seat.pendingRemote = prepare;
    const holder = seat.holder;
    const expiresAt = this.now() + this.config.leaseMs;
    this.broadcast(botId);
    return this.io
      .prepareHuman(
        botId,
        this.config.leaseMs,
        Math.max(1, (seat.drainDeadline ?? this.now()) - this.now()),
      )
      .then((remote) => {
        if (
          seat.pendingRemote !== prepare ||
          seat.mode !== 'draining' ||
          seat.holder !== holder ||
          expiresAt <= this.now()
        ) {
          void remote.release().catch(() => undefined);
          return;
        }
        seat.pendingRemote = null;
        seat.remoteLease = remote;
        this.grant(seat, botId, expiresAt);
      })
      .catch(() => {
        if (seat.pendingRemote !== prepare || seat.mode !== 'draining' || seat.holder !== holder)
          return;
        if (holder !== null)
          this.io.refuse(
            holder,
            botId,
            refusal(
              'SEAT_UNAVAILABLE',
              'The computer could not confirm exclusive control. Try again.',
            ),
          );
        this.toAgent(seat, botId);
      });
  }

  private grant(seat: Seat, botId: string, expiresAt = this.now() + this.config.leaseMs): void {
    seat.mode = 'human';
    seat.epoch += 1;
    seat.drainDeadline = null;
    this.extendLease(seat, botId, expiresAt);
  }

  /** Control returns to the bot: let go of what is held, and make it look first. */
  private handBack(seat: Seat, botId: string): void {
    for (const keysym of seat.heldKeys) this.io.forward(botId, keyEvent(keysym, false));
    seat.heldKeys.clear();
    if (seat.buttonMask !== 0) {
      this.io.forward(botId, pointerEvent(0, seat.pointer.x, seat.pointer.y));
      seat.buttonMask = 0;
    }
    seat.epoch += 1;
    seat.observationRequired = true;
    this.toAgent(seat, botId);
  }

  private toAgent(seat: Seat, botId: string): void {
    seat.pendingRemote = null;
    const remote = seat.remoteLease;
    seat.remoteLease = null;
    // A failed release remains fenced at the bridge until its bounded expiry.
    if (remote !== null) void remote.release().catch(() => undefined);
    seat.mode = 'agent';
    seat.holder = null;
    seat.leaseExpiresAt = null;
    seat.drainDeadline = null;
    this.schedule(seat, null, () => undefined);
    this.broadcast(botId);
    for (const wake of [...seat.waiters]) wake();
  }

  private waitForAgent(
    seat: Seat,
    signal: AbortSignal | undefined,
    remaining: number,
  ): Promise<boolean> {
    if (signal?.aborted === true || remaining <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (freed: boolean) => {
        seat.waiters.delete(wake);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(freed);
      };
      const wake = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), remaining);
      seat.waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private schedule(seat: Seat, ms: number | null, fire: () => void): void {
    if (seat.timer !== null) clearTimeout(seat.timer);
    seat.timer = ms === null ? null : setTimeout(fire, ms);
  }

  private broadcast(botId: string): void {
    this.io.broadcast(botId, (socket) => this.stateFor(socket, botId));
  }

  private seat(botId: string): Seat {
    let seat = this.seats.get(botId);
    if (seat === undefined) {
      // A seat this process has not seen may have been driven by a person
      // before a restart, so the bot looks before it targets anything.
      seat = {
        mode: 'agent',
        epoch: 0,
        observationRequired: true,
        holder: null,
        leaseExpiresAt: null,
        drainDeadline: null,
        inFlight: 0,
        exclusive: false,
        exclusiveWaiters: 0,
        pendingRemote: null,
        remoteLease: null,
        heldKeys: new Set(),
        buttonMask: 0,
        pointer: { x: 0, y: 0 },
        timer: null,
        waiters: new Set(),
      };
      this.seats.set(botId, seat);
    }
    return seat;
  }
}

function refusal(code: SeatControlRefusalCode, message: string): SeatRefusal {
  return { code, message };
}

function keyEvent(keysym: number, down: boolean): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, KEY_EVENT);
  view.setUint8(1, down ? 1 : 0);
  view.setUint32(4, keysym);
  return bytes;
}

function pointerEvent(mask: number, x: number, y: number): Uint8Array {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, POINTER_EVENT);
  view.setUint8(1, mask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return bytes;
}
