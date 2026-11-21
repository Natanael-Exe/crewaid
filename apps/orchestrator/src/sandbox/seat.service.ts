import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { RemoteSeatLease } from '../screen/seat-control.js';
import { SeatControlService } from '../screen/seat-control.service.js';
import { SANDBOX_PORTS } from '@crewaid/sandbox-core';
import { StructuredLogger } from '../logging/structured-logger.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox.provider.js';
import { IdentityService } from './identity.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { computerOfBot } from './attached-computer.js';

/**
 * Resolve a bot's private desktop on its user's shared computer.
 *
 * The bridge owns live seat/profile reservations; a database mirror would
 * disagree after a bridge or server restart. Durable login selection lives
 * separately in the bot row and is reconciled when a seat is requested.
 * Allocation and teardown serialize per bot here and under the bridge lock.
 */

/** One bot's screen, as the machine describes it. */
export interface Seat {
  readonly seatId: string;
  readonly botId: string;
  /**
   * The X display this seat owns, e.g. `:10`.
   *
   * Carried for diagnosis rather than for dialling: nothing outside the machine
   * can open an X connection, and everything the orchestrator reaches a seat
   * through is a port. It is what makes a log line about a seat answerable by
   * `DISPLAY=:10 wmctrl -l` inside the container.
   */
  readonly display: string;
  /**
   * The D-Bus session address this seat's desktop runs on.
   *
   * A seat starts its own session bus — the machine's is a different session,
   * and `plank` is the measured example of a D-Bus singleton that silently
   * does nothing when a second desktop joins the wrong one. Anything that
   * runs a command ON this seat (a bot's `shell`, its skills) has to carry
   * this address, or it starts a GUI process into a session the desktop it
   * was told to draw on is not part of.
   *
   * Optional since a machine's image may predate the field; a caller that
   * finds it absent clears the inherited session bus.
   */
  readonly dbusAddress?: string;
  /** The port INSIDE the machine; the screen transport resolves it through the provider. */
  readonly rfbPort: number;
  /**
   * This seat's own CDP port.
   *
   * A seat is a whole browser on its own `--user-data-dir`, so the endpoint IS
   * the scope: every target on this port belongs to this bot. That replaces the
   * window filter M4's capture needed when one browser served every seat — the
   * `targetId`/`windowId` pair existed to pick one bot's window out of a shared
   * Chrome, and there is no longer a shared Chrome to pick out of.
   */
  readonly cdpPort: number;
  /**
   * Whether a browser is actually listening on `cdpPort` yet.
   *
   * A seat is a desktop and its browser costs about two thirds of what the
   * seat costs, so it is not started with the display — a bot that never
   * browses never pays for one. `ensureBrowser` is what makes this true, and a
   * caller that needs CDP calls it rather than dialling and discovering.
   */
  readonly browserReady: boolean;
  /** The bridge-issued launch generation; zero until Chrome is first launched. */
  readonly browserGeneration: number;
  /** The actual profile selected by the bridge, including named shared logins. */
  readonly profile: string;
  readonly identityRevision: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * How long a call into the machine may take before it is abandoned.
 *
 * Generous rather than tight: creating a seat now starts an X server, a session
 * bus, a window manager, a dock, a whole browser and an x11vnc, and waits for
 * CDP to answer on a `--user-data-dir` it may be opening for the first time
 * (D-060). A machine under load can take seconds over that. What this bounds is the pathological case — a socket
 * accepted by a container that has stopped answering — not a slow one.
 */
const BRIDGE_TIMEOUT_MS = 30_000;

export class SeatError extends Error {
  constructor(
    message: string,
    readonly holderBotId?: string,
  ) {
    super(message);
    this.name = 'SeatError';
  }
}

/** The geometry a seat is created with. R8 fixes it for the seat's lifetime. */
export interface SeatGeometry {
  readonly widthPx: number;
  readonly heightPx: number;
}

type BridgeSeat = {
  seatId?: unknown;
  botId?: unknown;
  display?: unknown;
  dbusAddress?: unknown;
  rfbPort?: unknown;
  cdpPort?: unknown;
  browserReady?: unknown;
  browserGeneration?: unknown;
  profile?: unknown;
  identityRevision?: unknown;
  width?: unknown;
  height?: unknown;
};

/**
 * One seat off the bridge's JSON, or nothing.
 *
 * A `safeParse`-shaped read rather than a cast, for the same reason
 * `TurnEventBus` parses before it broadcasts: this is a payload from another
 * process, and a seat with a missing port would otherwise reach the RFB proxy
 * as `NaN` and fail there instead of here.
 */
function readSeat(value: unknown): Seat | null {
  if (typeof value !== 'object' || value === null) return null;
  const seat = value as BridgeSeat;
  if (typeof seat.seatId !== 'string' || seat.seatId === '') return null;
  if (typeof seat.botId !== 'string' || seat.botId === '') return null;
  if (typeof seat.display !== 'string' || seat.display === '') return null;
  if (typeof seat.profile !== 'string' || seat.profile === '') return null;
  if (
    seat.identityRevision !== undefined &&
    (typeof seat.identityRevision !== 'number' ||
      !Number.isSafeInteger(seat.identityRevision) ||
      seat.identityRevision < 0)
  )
    return null;
  if (
    typeof seat.browserGeneration !== 'number' ||
    !Number.isSafeInteger(seat.browserGeneration) ||
    seat.browserGeneration < 0 ||
    (seat.browserReady === true && seat.browserGeneration === 0)
  )
    return null;
  if (typeof seat.rfbPort !== 'number' || !Number.isInteger(seat.rfbPort)) return null;
  if (typeof seat.cdpPort !== 'number' || !Number.isInteger(seat.cdpPort)) return null;
  if (typeof seat.width !== 'number' || typeof seat.height !== 'number') return null;
  return {
    seatId: seat.seatId,
    botId: seat.botId,
    display: seat.display,
    // Optional on purpose: an image older than this field still answers a
    // `seats` call, and a caller that needs a bus address falls back to the
    // empty address rather than borrowing the machine’s session.
    ...(typeof seat.dbusAddress === 'string' && seat.dbusAddress !== ''
      ? { dbusAddress: seat.dbusAddress }
      : {}),
    rfbPort: seat.rfbPort,
    cdpPort: seat.cdpPort,
    browserReady: seat.browserReady === true,
    browserGeneration: seat.browserGeneration,
    profile: seat.profile,
    identityRevision: typeof seat.identityRevision === 'number' ? seat.identityRevision : 0,
    widthPx: seat.width,
    heightPx: seat.height,
  };
}

@Injectable()
export class SeatService {
  /**
   * One in-flight allocation per bot.
   *
   * Not a cache of the ANSWER: a seat can be closed, and a machine can be
   * replaced, so a remembered port would outlive the window it names. What is
   * shared is only the request that is currently out, which is what stops a
   * turn and a §4.3 subscribe arriving together from asking twice.
   */
  private readonly inFlight = new Map<string, Promise<Seat>>();
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(IdentityService) private readonly identities: IdentityService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeatControlService) private readonly control?: SeatControlService,
  ) {}

  /**
   * This bot's seat on the machine, creating one if it has none.
   *
   * `geometry` is the size the seat is fixed at, and the caller owns it
   * because R8 protects the framebuffer a CLIENT is streaming: the
   * orchestrator knows the dimensions a client already cached, and the
   * machine — which has no idea what anyone cached — must not default.
   */
  async ensureSeat(sessionId: string, botId: string, geometry: SeatGeometry): Promise<Seat> {
    const pending = this.inFlight.get(botId);
    if (pending !== undefined) return pending;
    const request = this.serial(botId, () => this.allocate(sessionId, botId, geometry)).finally(
      () => {
        this.inFlight.delete(botId);
      },
    );
    this.inFlight.set(botId, request);
    return request;
  }

  /**
   * Make sure this bot's seat has a browser running, and answer the seat.
   *
   * Separate from `ensureSeat` on purpose. Opening a screen must not
   * start a browser — that is the cost this decision removes — and a recording
   * must not start one either, because observing a bot would then change what
   * the bot is running. So the two needs are two calls, and only the callers
   * that genuinely need CDP make this one.
   *
   * Idempotent on the machine's side under the same lock seat creation uses, so
   * two tool calls arriving together cannot each launch a Chrome on one
   * profile — the second would delegate into the first and the turn would drive
   * a window nobody is watching.
   */
  async ensureBrowser(sessionId: string, botId: string): Promise<Seat> {
    return this.serial(botId, async () => {
      const existing = await this.seatFor(sessionId, botId);
      if (existing === null) throw new SeatError('This bot has no seat to start a browser on.');
      const current = await this.allocate(sessionId, botId, existing);
      const answer = await this.bridge<{ seat?: unknown }>(sessionId, '/seats/browser', {
        body: { botId, identityRevision: current.identityRevision },
        timeoutMs: 60_000,
      });
      const seat = answer === null ? null : readSeat(answer.seat);
      if (
        seat === null ||
        !seat.browserReady ||
        seat.botId !== botId ||
        seat.profile !== current.profile ||
        seat.identityRevision !== current.identityRevision
      ) {
        throw new SeatError(
          `the machine did not answer with the selected browser for bot ${botId}`,
        );
      }
      const selection = await this.identities.selectionFor(botId);
      if (
        selection.revision !== seat.identityRevision ||
        (selection.profile ?? botId) !== seat.profile
      ) {
        throw new SeatError(
          'The login selection changed while the browser opened. Retry with a fresh observation.',
        );
      }
      return seat;
    });
  }

  private serial<T>(botId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(botId) ?? Promise.resolve();
    const request = previous.catch(() => undefined).then(run);
    this.mutations.set(botId, request);
    void request
      .finally(() => {
        if (this.mutations.get(botId) === request) this.mutations.delete(botId);
      })
      .catch(() => undefined);
    return request;
  }

  private async allocate(sessionId: string, botId: string, geometry: SeatGeometry): Promise<Seat> {
    // Two reads that do not depend on each other — the login selection is the
    // database's, the seat is the machine's — and every screen grant waits on
    // both, so neither waits on the other.
    const [selection, existing] = await Promise.all([
      this.identities.selectionFor(botId),
      this.seatFor(sessionId, botId),
    ]);
    const profile = selection.profile;
    const wanted = profile ?? botId;
    let found = existing;
    if (
      found !== null &&
      (found.profile !== wanted || found.identityRevision !== selection.revision)
    ) {
      await this.closeSeat(sessionId, found, selection.revision);
      found = null;
    }
    if (found !== null) {
      // R8: a seat the machine already has keeps the size it was created
      // with, whatever this caller asked for. Resizing it is the one thing a
      // seat may never do, and the machine would refuse anyway — its window's
      // geometry is pinned. Reporting the mismatch is what turns that into
      // something an operator can see rather than a stream that looks wrong.
      if (found.widthPx !== geometry.widthPx || found.heightPx !== geometry.heightPx) {
        this.logger.warn('seat.geometry.differs', {
          botId,
          seatWidthPx: found.widthPx,
          seatHeightPx: found.heightPx,
          askedWidthPx: geometry.widthPx,
          askedHeightPx: geometry.heightPx,
        });
      }
      return found;
    }

    // Reconcile durable selection on every attach, including a crash after grant but before close.
    const created = await this.bridge<{ seat?: unknown }>(sessionId, '/seats', {
      body: {
        botId,
        identityRevision: selection.revision,
        ...(profile !== null && { profile }),
        width: geometry.widthPx,
        height: geometry.heightPx,
      },
    }).catch(async (error: unknown) => {
      if (error instanceof SeatError && error.holderBotId !== undefined) {
        const name = await this.identities.holderNameFor(botId, error.holderBotId);
        throw new SeatError(
          name === null
            ? 'This shared login is already in use. Release it from its current bot before retrying.'
            : `This shared login is in use by ${name}. Open that bot’s screen, hand control back, and choose Release shared login.`,
        );
      }
      throw error;
    });
    const seat = created === null ? null : readSeat(created.seat);
    if (
      seat === null ||
      seat.botId !== botId ||
      seat.profile !== wanted ||
      seat.identityRevision !== selection.revision
    ) {
      throw new SeatError(`the machine did not return the selected seat for bot ${botId}`);
    }
    const latest = await this.identities.selectionFor(botId);
    if (latest.revision !== selection.revision || latest.profile !== profile) {
      throw new SeatError('The login selection changed during seat allocation. Retry.');
    }
    this.logger.info('seat.created', {
      botId,
      seatId: seat.seatId,
      // Which profile a seat opened on is the one thing about it an operator
      // may need to reconstruct after the fact: it is the difference between a
      // bot's own browser state and a session shared with its siblings.
      ...(profile !== null && { profile }),
      rfbPort: seat.rfbPort,
      widthPx: seat.widthPx,
      heightPx: seat.heightPx,
    });
    return seat;
  }

  /**
   * This bot's seat, or nothing — without creating one.
   *
   * The read half on its own, for callers that must not cause a window to
   * open. Capture is the reason it exists: a recording should bind to the
   * screen a bot already has, and a recording that CREATED one would put a
   * window on the machine because someone pressed record.
   */
  async seatFor(sessionId: string, botId: string): Promise<Seat | null> {
    const existing = await this.bridge<{ seat?: unknown }>(
      sessionId,
      `/seats?botId=${encodeURIComponent(botId)}`,
      { allow404: true },
    );
    const seat = existing === null ? null : readSeat(existing.seat);
    if (seat !== null && seat.botId !== botId)
      throw new SeatError('The machine answered for another bot.');
    return seat;
  }

  /** A memoized driver cannot keep acting after selection, revocation or replacement. */
  async assertCurrentBrowser(sessionId: string, botId: string, opened: Seat): Promise<void> {
    const selection = await this.identities.selectionFor(botId);
    const live = await this.seatFor(sessionId, botId);
    if (
      live === null ||
      !live.browserReady ||
      live.seatId !== opened.seatId ||
      live.browserGeneration !== opened.browserGeneration ||
      live.profile !== opened.profile ||
      selection.revision !== opened.identityRevision ||
      (selection.profile ?? botId) !== opened.profile
    ) {
      throw new SeatError(
        'STALE_REFERENCE: this browser or login grant changed. Reconnect and read the page again.',
      );
    }
  }

  /** The bridge owns replay admission even if an orchestrator restarted mid-run. */
  async prepareHuman(
    sessionId: string,
    botId: string,
    leaseMs: number,
    drainMs: number,
  ): Promise<RemoteSeatLease> {
    const token = randomUUID();
    const path = `/seats/control?botId=${encodeURIComponent(botId)}`;
    const request = async (body: unknown, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<void> => {
      const answer: unknown = await this.bridge(sessionId, path, { body, timeoutMs });
      if (
        typeof answer !== 'object' ||
        answer === null ||
        !('ok' in answer) ||
        answer.ok !== true
      ) {
        throw new SeatError('the computer did not acknowledge its replay fence');
      }
    };
    const release = () => request({ action: 'release', token });
    try {
      await request(
        { action: 'take', token, leaseMs, drainMs },
        Math.min(2_147_483_647, drainMs + 2_000),
      );
    } catch (error) {
      // The reply can be lost after the bridge grants. Release this token only.
      void release().catch(() => undefined);
      throw error;
    }
    return { renew: () => request({ action: 'renew', token, leaseMs }), release };
  }

  /** Close a bot's seat, if it has one. Idempotent. */
  async releaseSeat(sessionId: string, botId: string, onlyShared = false): Promise<boolean> {
    return this.serial(botId, async () => {
      const seat = await this.seatFor(sessionId, botId);
      if (seat === null || (onlyShared && seat.profile === botId)) return false;
      const selection = await this.identities.selectionFor(botId);
      await this.closeSeat(sessionId, seat, selection.revision);
      return true;
    });
  }

  private async closeSeat(sessionId: string, seat: Seat, revision: number): Promise<void> {
    await this.bridge(sessionId, `/seats/${encodeURIComponent(seat.seatId)}/close`, {
      body: { identityRevision: revision },
      allow404: true,
    });
    this.control?.seats.seatEnded(seat.botId);
    this.logger.info('seat.closed', { botId: seat.botId, seatId: seat.seatId });
  }

  /**
   * Close this bot's seat, resolving its machine from the bot's own row.
   *
   * The session-shaped callers above are given one because they already hold
   * it; this is for a caller that holds only a bot id — M5-BE-27's identity
   * switch, which runs inside a turn and must close the window the bot has
   * before the next one can open on a different profile.
   *
   * Providers key the runtime by the shared computer id before a session id
   * is recorded. A release never starts a stopped computer.
   */
  async releaseSeatForBot(botId: string, onlyShared = false): Promise<boolean> {
    const computer = await computerOfBot(this.prisma, botId, {
      id: true,
      sessionId: true,
      state: true,
    });
    if (computer === null || computer.state !== 'RUNNING') return false;
    return this.releaseSeat(computer.sessionId ?? computer.id, botId, onlyShared);
  }

  /**
   * D-223: tell the machine's screen gateway which key signs its tickets, and
   * which computer it is. Not a secret — the key can only verify — and sent
   * before every direct grant, because a machine forgets it when it restarts
   * and this process makes a new key when it does.
   */
  async publishScreenKey(
    sessionId: string,
    key: { readonly publicKey: string; readonly session: string },
  ): Promise<boolean> {
    const reply = await this.bridge<{ expiresViewers?: boolean }>(sessionId, '/screen/key', {
      body: key,
      allow404: true,
    });
    return reply?.expiresViewers === true;
  }

  private async bridge<T>(
    sessionId: string,
    path: string,
    options: { body?: unknown; allow404?: boolean; timeoutMs?: number } = {},
  ): Promise<T | null> {
    const session = await this.provider.attachSession({ sessionId });
    if (session === null) {
      throw new SeatError(`no container is attached to session ${sessionId}`);
    }
    const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });

    // D-012: an endpoint may carry headers that must be SENT when connecting,
    // and the decision names the bridge calls specifically. Dropping them does
    // not fail as a missing header — it fails as a refused or hung connection,
    // which reads as a broken sandbox rather than a caller that ignored the
    // contract. `screen.service.ts` refuses such an endpoint outright because
    // RFB is raw TCP with nowhere to put a header; this is HTTP, so it can
    // simply send them.
    const headers: Record<string, string> = { ...endpoint.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    // Bounded, because the caller cannot recover from an unbounded one. A
    // connection that is accepted and never answered would otherwise pin this
    // bot's in-flight allocation forever, and every later caller queues behind
    // it — the single failure that map cannot clear, since it only clears when
    // the request settles. Retrying after a timeout is safe: the bridge's
    // create is idempotent on the bot's label, so a retry that races a request
    // which did land returns the same seat rather than opening a second window.
    const response = await fetch(new URL(path, endpoint.url), {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? BRIDGE_TIMEOUT_MS),
      ...(options.body === undefined
        ? { method: 'GET' }
        : { method: 'POST', body: JSON.stringify(options.body) }),
    });
    if (response.status === 404 && options.allow404 === true) return null;
    if (!response.ok) {
      // The bridge's own detail, which names what it could not do — a machine
      // out of seat ports says so, and that is the difference between "this
      // bot has no screen" and "this machine is full".
      const detail = await response.text().catch(() => '');
      let holderBotId: string | undefined;
      try {
        const body: unknown = JSON.parse(detail);
        if (
          typeof body === 'object' &&
          body !== null &&
          'holderBotId' in body &&
          typeof body.holderBotId === 'string' &&
          body.holderBotId.length <= 64
        ) {
          holderBotId = body.holderBotId;
        }
      } catch {
        /* A non-JSON refusal still remains a refusal. */
      }
      throw new SeatError(
        `the machine refused ${path} with ${response.status}: ${detail.slice(0, 200)}`,
        holderBotId,
      );
    }
    return (await response.json()) as T;
  }
}
