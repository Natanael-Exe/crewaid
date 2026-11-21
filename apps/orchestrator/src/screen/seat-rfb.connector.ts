import { Inject, Injectable, Logger } from '@nestjs/common';

import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox.provider.js';
import { SeatService, type Seat } from '../sandbox/seat.service.js';
import {
  RFB_UPSTREAM_FACTORY,
  type ScreenUpstream,
  type ScreenUpstreamFactory,
} from './screen-upstream.port.js';

/**
 * Opens an RFB connection to one bot's seat, through whatever the provider
 * offers for reaching a port inside the computer.
 *
 * A machine is shared and its screen is not, so the
 * connection is to the bot's SEAT — its own display with its own x11vnc — and
 * not the machine's whole desktop. The seat is created on demand, here, for
 * the same reason the computer is: a bot nobody is watching and that
 * has run no browser tool should cost no window. Asking for it again also
 * restarts a seat's x11vnc that died, which is what a reconnect relies on.
 *
 * The size comes from the MACHINE's row because that is the geometry every
 * viewer has already cached — R8 fixes a framebuffer for its lifetime.
 */
@Injectable()
export class SeatRfbConnector {
  private readonly upstreamLogger = new Logger('RfbUpstream');

  constructor(
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(RFB_UPSTREAM_FACTORY) private readonly createUpstream: ScreenUpstreamFactory,
    @Inject(SeatService) private readonly seats: SeatService,
  ) {}

  /**
   * @param seat A seat this caller already resolved for the same computer, to
   * keep an HTTP call into the machine off a second connection's path.
   */
  async open(options: {
    readonly sessionId: string;
    readonly botId: string;
    readonly geometry: { readonly widthPx: number; readonly heightPx: number };
    readonly quality: number;
    readonly seat?: Seat | undefined;
  }): Promise<{ readonly upstream: ScreenUpstream; readonly seat: Seat }> {
    const { sessionId, botId } = options;
    const session = await this.provider.attachSession({ sessionId });
    if (session === null) {
      throw new SeatConnectionError(`no sandbox container is attached to session ${sessionId}`);
    }

    const seat = options.seat ?? (await this.seats.ensureSeat(sessionId, botId, options.geometry));
    const endpoint = await session.getPortEndpoint({ port: seat.rfbPort });

    // D-012: the endpoint may carry headers that must be sent when connecting.
    // RFB is a raw TCP protocol with nowhere to put them, so a provider that
    // returns headers needs a tunnelling transport this connector does not
    // have. Connecting anyway would fail as a refused socket or a hung
    // handshake — exactly the "looks like a sandbox or networking fault" D-012
    // warns about.
    const headers = endpoint.headers;
    if (headers !== undefined && Object.keys(headers).length > 0) {
      throw new SeatConnectionError(
        `the RFB endpoint for session ${sessionId} requires headers ` +
          `[${Object.keys(headers).join(', ')}], which a raw TCP connection cannot send (D-012). ` +
          'This provider needs a tunnelling screen transport.',
      );
    }

    const { hostname, port } = new URL(endpoint.url);
    const upstream = this.createUpstream({
      host: hostname,
      port: Number(port),
      quality: options.quality,
      logger: this.upstreamLogger,
    });
    return { upstream, seat };
  }
}

/** A seat that cannot be reached; the message says which way it failed. */
export class SeatConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeatConnectionError';
  }
}
