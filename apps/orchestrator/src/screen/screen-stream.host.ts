import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, type WebSocket } from 'ws';
import { SCREEN_STREAM_TICKET_PARAM, type ScreenTicketClaims } from '@crewaid/shared';
import {
  MIN_QUALITY,
  qualityFromQuery,
  SCREEN_STREAM_MAX_CLIENT_FRAME_BYTES,
  ScreenStreamHub,
  serveScreenViewer,
  type ScreenUpstream,
} from '@crewaid/screen-stream';

import { PrismaService } from '../prisma/prisma.service.js';
import { computerOfBot } from '../sandbox/attached-computer.js';
import { SeatRfbConnector } from './seat-rfb.connector.js';
import { ScreenTicketService } from './screen-ticket.service.js';

/**
 * The orchestrator's own screen stream route, `/ws/screen` — the endpoint a
 * grant points at when the computer cannot serve its viewers itself.
 *
 * The pixels pass through this process here, read over the provider's tunnel
 * exactly as the input path reads nothing, and the stream behaves exactly as
 * the one a computer serves: same hub, same pacing, same wire.
 *
 * The socket is mounted on the WebSocket adapter's HTTP server (see
 * `CrewaidWsAdapter`) but authenticated differently: by the grant's ticket,
 * never by the session token, so a stream URL that leaks into a log opens
 * nothing a minute later — and nothing at all after its first use.
 */
@Injectable()
export class ScreenStreamHost implements OnModuleDestroy {
  /** Mounted by the WS adapter; never listening on its own. */
  readonly server: WebSocketServer;
  private readonly logger = new Logger(ScreenStreamHost.name);
  private readonly hub: ScreenStreamHub;
  /** Claims checked at the Upgrade, handed to the connection that follows it. */
  private readonly admitted = new WeakMap<IncomingMessage, ScreenTicketClaims>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeatRfbConnector) private readonly connector: SeatRfbConnector,
    @Inject(ScreenTicketService) private readonly tickets: ScreenTicketService,
  ) {
    this.hub = new ScreenStreamHub({
      logger: this.logger,
      connect: (botId) => this.connect(botId),
    });
    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: SCREEN_STREAM_MAX_CLIENT_FRAME_BYTES,
      // Runs during the HTTP Upgrade, so a bad ticket is a real 401 before a
      // socket exists (D-024's rule for WebSocket, kept here).
      verifyClient: (info: { req: IncomingMessage }, done: (ok: boolean, code?: number) => void) =>
        done(this.admit(info.req), 401),
    });
    this.server.on('error', (error: Error) => {
      this.logger.error(`screen stream server error: ${error.message}`);
    });
    this.server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      // This server bypasses Nest's socket bindings, including its error
      // handler. Bind before the lookup can yield or the viewer can send.
      socket.on('error', (error: Error) => {
        this.logger.warn(`screen stream socket error: ${error.message}`);
      });
      void this.serve(socket, request).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`screen stream could not open: ${reason}`);
        socket.close(1011, 'The display could not be opened.');
      });
    });
  }

  /** Test seam and operational read: how many seats this process is streaming. */
  streamCount(): number {
    return this.hub.streamCount();
  }

  onModuleDestroy(): void {
    this.hub.close();
    this.server.close();
  }

  private admit(request: IncomingMessage): boolean {
    const ticket = requestUrl(request).searchParams.get(SCREEN_STREAM_TICKET_PARAM) ?? '';
    const verdict = this.tickets.redeem(ticket);
    if (!verdict.ok) {
      // The reason stays in this log; the viewer learns only "unauthorized".
      this.logger.warn(`screen stream refused: ${verdict.reason}`);
      return false;
    }
    this.admitted.set(request, verdict.claims);
    return true;
  }

  private async serve(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const claims = this.admitted.get(request);
    if (claims === undefined) {
      socket.close(1008, 'unauthorized');
      return;
    }
    // A ticket names the computer it was granted for. One replaced since —
    // stopped and started again — is a different desktop, and the viewer
    // should ask again rather than be shown it under an old grant.
    const quality = qualityFromQuery(requestUrl(request).searchParams);
    await serveScreenViewer({
      hub: this.hub,
      key: claims.botId,
      expiresAt: claims.exp,
      socket,
      quality,
      logger: this.logger,
      refuse: async () => {
        const sandbox = await computerOfBot(this.prisma, claims.botId, { sessionId: true });
        return sandbox?.sessionId === claims.session ? undefined : 'SCREEN_NOT_RUNNING';
      },
    });
  }

  /**
   * The seat's x11vnc, for a stream that is opening or recovering. Null once
   * the computer is not running: a stream must never be what wakes it.
   */
  private async connect(botId: string): Promise<ScreenUpstream | null> {
    const sandbox = await computerOfBot(this.prisma, botId, {
      state: true,
      sessionId: true,
      widthPx: true,
      heightPx: true,
    });
    if (sandbox === null || sandbox.state !== 'RUNNING' || sandbox.sessionId === null) return null;
    const { upstream } = await this.connector.open({
      sessionId: sandbox.sessionId,
      botId,
      geometry: { widthPx: sandbox.widthPx, heightPx: sandbox.heightPx },
      // The stream sets its own quality before the handshake finishes.
      quality: MIN_QUALITY,
    });
    return upstream;
  }
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://screen.invalid');
}
