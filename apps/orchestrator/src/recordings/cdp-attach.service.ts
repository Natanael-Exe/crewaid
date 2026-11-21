import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { SeatService } from '../sandbox/seat.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox.provider.js';
import { openCdpConnection, type CdpConnection } from './cdp-connection.js';
import { computerOfBot } from '../sandbox/attached-computer.js';

/**
 * The browser half of capture: attach to Chrome's CDP endpoint for the
 * duration of a recording.
 *
 * What "attached" means
 *
 * A connection is resolved, opened and PROVEN — one command round-trips on it
 * before it counts. The WebSocket handshake alone proves something accepted an
 * upgrade; on this path the socket travels through a Docker port mapping and a
 * TCP relay inside the sandbox, and a relay that mangles an upgrade still
 * completes a handshake. A first successful `Browser.getVersion` is the
 * smallest thing that can only be true of a live CDP speaker.
 *
 * Why it is attached for the recording, not per use
 *
 * §6/M4 says "attach... for the duration of a recording", and the duration is
 * the recording row's: attached at `start`, detached on every path that ends
 * one — stop, either ceiling, discard, a start that failed after attaching,
 * and process shutdown. The alternative — connecting when something first
 * needs the browser — would decide the connection is available at a moment
 * that has nothing to do with the recording, and a recording that never
 * touches the browser would still pay a connect.
 *
 * Why nothing here can fail a recording
 *
 * Every failure degrades to "no CDP for this recording": logged, reported
 * once to the lifecycle — which records it on the row as
 * `Recording.cdpAvailable = false` — and returned as `null` from
 * `connectionFor`. The X11 tee is untouched by any of it, which is what
 * The degradation clause asks for, and nothing about the degradation is
 * pushed to the operator: the lifecycle is told, not the user. The inverse
 * — a recording that fails because Chrome was slow, busy or absent — would
 * make the recorder least reliable on exactly the bot that needs recording
 * most, the one whose browser is broken.
 *
 * Why the endpoint is resolved here and never cached
 *
 * The provider hands out a URL plus optional headers, and the headers
 * must travel with the connection that URL was issued for. That rules out
 * assembling an address from `Sandbox.cdpPort` — the resolve goes through
 * `getPortEndpoint` every time. There is nothing to cache: one attach happens
 * per recording, and the idle sweep refuses to stop a sandbox whose bot has a
 * `RECORDING` row, so the port cannot move while one is open.
 */

/** The endpoint a CDP attach needs: a URL plus whatever headers it requires. */
interface CdpEndpoint {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** One recording's attach attempt, in flight or settled. */
interface Attachment {
  readonly recordingId: string;
  /** Set by `detach`: a connection that settles afterwards closes itself. */
  detached: boolean;
  connection: CdpConnection | null;
  /** The attach in flight; resolves `null` rather than rejecting. */
  settled: Promise<CdpConnection | null>;
}

/**
 * Told once that a recording has no CDP connection — the attach never
 * landed, or the socket dropped mid-recording. Called at most
 * once per recording, from whichever of the two moments arrives; the
 * recording continues at the X11 layer either way, and nothing about it is
 * pushed to the operator.
 */
export type CdpUnavailableListener = (botId: string, recordingId: string) => void;

@Injectable()
export class CdpAttachService implements OnModuleDestroy {
  private readonly logger = new Logger(CdpAttachService.name);

  /**
   * How long any one phase of an attach may take — resolving the endpoint,
   * the `/json/version` discovery, the WebSocket handshake, the proving
   * command.
   *
   * A ceiling per phase rather than for the whole attach, because the phases
   * fail for different reasons and a recording should not wait out a second
   * deadline after the first one already fired. Three seconds is generous
   * against a healthy sandbox (every phase is a loopback round trip) and
   * short enough that a stop racing an attach is not held hostage by it.
   */
  static readonly TIMEOUT_MS = 3_000;

  private readonly attachments = new Map<string, Attachment>();

  /**
   * The lifecycle's record of a degraded recording.
   * `RecordingsService` registers in its constructor — this service does not
   * import it back, and it does not need to know who is listening either.
   * Same slot, same reasoning, as the tee's `limitListener`.
   */
  private unavailableListener: CdpUnavailableListener | null = null;

  // Explicit tokens: vitest/esbuild emits no design:paramtypes, so type-based
  // DI resolution silently fails in the integration suite.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(SeatService) private readonly seats: SeatService,
  ) {}

  /**
   * Begin the attach for a recording. Returns immediately — the connect is in
   * flight from here, and nothing in the recording path waits on it.
   */
  attach(botId: string, recordingId: string): void {
    const existing = this.attachments.get(botId);
    if (existing !== undefined) {
      if (existing.recordingId === recordingId) return;
      // A slot can only survive a recording that ended without detaching —
      // e.g. a settle path that failed after capture stopped. Replacing it
      // self-heals; keeping it would silently degrade EVERY later recording
      // for this bot to X11-only, with nothing in any log to say why.
      this.logger.warn(
        `bot ${botId}: replacing a CDP attach left over from recording ${existing.recordingId}`,
      );
      void this.detach(botId);
    }
    const attachment: Attachment = {
      recordingId,
      detached: false,
      connection: null,
      settled: Promise.resolve(null),
    };
    this.attachments.set(botId, attachment);
    attachment.settled = this.connect(botId, attachment);
  }

  /** Register the lifecycle's record of a degraded recording. See `unavailableListener`. */
  onUnavailable(listener: CdpUnavailableListener): void {
    this.unavailableListener = listener;
  }

  /**
   * The connection attached for this recording, or `null` — the seam the
   * later M4 tasks (capture script, navigation events) reach the browser
   * through. Awaits an attach still in flight, so a caller that has just
   * started a recording is not told "nothing there" about a connection that
   * is milliseconds away; a connection that dropped in the meantime answers
   * `null`, which is the truth.
   */
  async connectionFor(botId: string, recordingId: string): Promise<CdpConnection | null> {
    const attachment = this.attachments.get(botId);
    if (attachment === undefined || attachment.recordingId !== recordingId) return null;
    await attachment.settled;
    return attachment.connection;
  }

  /**
   * Close the browser side of a recording's capture. Idempotent, never
   * rejects, and safe to call for a bot that never attached.
   *
   * It AWAITS an attach still in flight before closing, which is what makes
   * teardown watertight: a stop that raced the connect would otherwise leave
   * a socket open for the life of the process.
   */
  async detach(botId: string, recordingId?: string): Promise<void> {
    const attachment = this.attachments.get(botId);
    if (attachment === undefined) return;
    if (recordingId !== undefined && attachment.recordingId !== recordingId) return;
    this.attachments.delete(botId);
    attachment.detached = true;
    const connection = attachment.connection ?? (await attachment.settled);
    attachment.connection = null;
    if (connection !== null) await connection.close();
  }

  /**
   * A process that is going away leaves no sockets behind. Closing here is
   * enough: a recording interrupted by shutdown is settled `FAILED` by the
   * boot reconciliation and would have to attach again to capture anything.
   */
  async onModuleDestroy(): Promise<void> {
    for (const botId of [...this.attachments.keys()]) await this.detach(botId);
  }

  /**
   * Resolve, open, prove, and hand the connection to its slot. Resolves
   * `null` on any failure — it never rejects, because every caller is on a
   * path where a missing browser is a degradation and not an error.
   */
  private async connect(botId: string, attachment: Attachment): Promise<CdpConnection | null> {
    try {
      const endpoint = await this.endpointFor(botId);
      const url = await this.debuggerUrl(endpoint);
      const connection = await openCdpConnection({
        url,
        headers: endpoint.headers,
        handshakeTimeoutMs: CdpAttachService.TIMEOUT_MS,
        commandTimeoutMs: CdpAttachService.TIMEOUT_MS,
        onListenerError: (error, source) => {
          this.logger.warn(
            `recording ${attachment.recordingId}: a CDP listener (${source}) failed: ` +
              `${describe(error)}`,
          );
        },
      });
      try {
        await connection.send('Browser.getVersion');
      } catch (error: unknown) {
        await connection.close();
        throw error;
      }
      // A detach that landed while this was connecting has already deleted
      // the slot; the connection it never saw must not outlive it.
      if (attachment.detached || connection.closed) {
        await connection.close();
        return null;
      }
      attachment.connection = connection;
      connection.onClose(() => {
        this.dropped(botId, attachment, connection);
      });
      this.logger.log(
        `recording ${attachment.recordingId}: attached to Chrome CDP for bot ${botId}`,
      );
      return connection;
    } catch (error: unknown) {
      this.logger.warn(
        `recording ${attachment.recordingId}: Chrome CDP attach for bot ${botId} failed: ` +
          `${describe(error)}. The recording continues at the X11 layer.`,
      );
      this.reportUnavailable(botId, attachment);
      return null;
    }
  }

  /**
   * The socket died while the recording was still open. Nothing re-attaches:
   * a replacement connection started from here would race the detach that is
   * already on its way, and the answer is not a reconnect — the
   * recording continues at the X11 layer, the row is marked
   * `cdpAvailable = false` through the listener below, and the
   * operator is told neither.
   */
  private dropped(botId: string, attachment: Attachment, connection: CdpConnection): void {
    // A close this service performed is not a drop, and by then the slot
    // either no longer holds this connection or is gone entirely.
    if (attachment.connection !== connection) return;
    attachment.connection = null;
    this.logger.warn(
      `recording ${attachment.recordingId}: the CDP connection to bot ${botId} dropped; ` +
        'the rest of this recording captures at the X11 layer only',
    );
    this.reportUnavailable(botId, attachment);
  }

  /**
   * Tell the lifecycle this recording runs X11-only.
   *
   * Fire-and-forget and exception-proof: the failure paths that call it are
   * documented never to reject into the recording, and a listener that
   * throws must not turn a degradation into an attach failure. One report
   * per recording — both callers are one-shot by construction.
   */
  private reportUnavailable(botId: string, attachment: Attachment): void {
    const listener = this.unavailableListener;
    if (listener === null) return;
    try {
      listener(botId, attachment.recordingId);
    } catch (error: unknown) {
      this.logger.warn(
        `recording ${attachment.recordingId}: the CDP-unavailable listener failed: ` +
          `${describe(error)}`,
      );
    }
  }

  /**
   * `Sandbox` row → session → this bot's SEAT's CDP port.
   *
   * The port is the seat's, not the machine's. Under the window seat every bot
   * shared the machine's browser and a capture had to filter targets down to
   * the bot's own window; a seat is now a browser of its own, so the endpoint
   * is the filter and the machine's port holds only the launch window no bot
   * works in — capturing it would record nothing the operator is doing.
   *
   * It never CREATES a seat: a recording that opened a desktop because someone
   * pressed record would put a screen on the machine as a side effect of
   * observing it. A bot with no seat has no browser to capture, and the
   * recording continues at the X11 layer.
   *
   * Unscoped for the same reason the click-screenshot path is: this is reached
   * from a recording that an owner-scoped `start` created, on a bot id taken
   * from that recording's own row — never from a request. `sessionId` falls
   * back to the bot id exactly as the lifecycle does.
   */
  private async endpointFor(botId: string): Promise<CdpEndpoint> {
    const sandbox = await computerOfBot(this.prisma, botId, { sessionId: true });
    if (sandbox === null) throw new Error(`bot ${botId} has no sandbox`);
    const sessionId = sandbox.sessionId ?? botId;
    const session = await this.provider.attachSession({ sessionId });
    if (session === null) throw new Error(`no container is attached to session ${sessionId}`);
    const seat = await this.seats.seatFor(sessionId, botId);
    if (seat === null) throw new Error(`bot ${botId} has no seat to capture`);
    // And it never STARTS one. A seat's browser is launched on demand,
    // and a recording that launched it would change what the bot is running by
    // observing it — the same reason this has never created a seat. A bot that
    // has not browsed has nothing for CDP to capture, which the caller already
    // degrades to the X11 layer.
    if (!seat.browserReady) {
      throw new Error(`bot ${botId} has no browser open on its seat yet`);
    }
    const endpoint = await session.getPortEndpoint({ port: seat.cdpPort });
    return { url: endpoint.url, headers: { ...endpoint.headers } };
  }

  /**
   * `/json/version` names the WebSocket Chrome answers CDP on.
   *
   * Chrome builds that URL from the `Host` header it was reached by — through
   * the sandbox's TCP relay that is the published address, but only because
   * the relay forwards the header unchanged, which is nobody's contract.
   * Inside the sandbox the same request would name Chrome's own loopback
   * bind, an address this process cannot reach and must not connect to with
   * endpoint-scoped headers in hand. So: keep the path Chrome named, take the
   * address from the endpoint. That is the one address this process can
   * reach, and the one the headers were issued for.
   */
  private async debuggerUrl(endpoint: CdpEndpoint): Promise<string> {
    const response = await fetch(`${endpoint.url}/json/version`, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(CdpAttachService.TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`/json/version answered ${response.status}`);
    const reported = readDebuggerUrl(await response.json());
    if (reported === null) throw new Error('/json/version named no webSocketDebuggerUrl');
    const target = new URL(reported);
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      throw new Error(`/json/version named ${target.protocol} where a WebSocket URL was expected`);
    }
    target.host = new URL(endpoint.url).host;
    return target.toString();
  }
}

/**
 * Pull `webSocketDebuggerUrl` out of a `/json/version` body. The sandbox is
 * the untrusted side of this connection, so the body is a value to
 * inspect, not a shape to assume.
 */
function readDebuggerUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)['webSocketDebuggerUrl'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
