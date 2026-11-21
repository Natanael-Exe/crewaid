import { readFile } from 'node:fs/promises';
import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import {
  SCREEN_GATEWAY_PATH,
  SCREEN_STREAM_TICKET_PARAM,
  ScreenSeatBindingSchema,
  type ScreenTicketClaims,
} from '@crewaid/shared';
import {
  importScreenTicketPublicKey,
  MIN_QUALITY,
  qualityFromQuery,
  RfbUpstream,
  SCREEN_STREAM_MAX_CLIENT_FRAME_BYTES,
  ScreenStreamHub,
  serveScreenViewer,
  verifyScreenTicket,
  type ScreenLogger,
  type ScreenUpstreamFactory,
} from '@crewaid/screen-stream';

import { PersistentTicketReplays } from './ticket-replays.js';
import {
  resolveScreenSeat,
  sameSeat,
  SeatBoundUpstream,
  type ResolveScreenSeat,
} from './seat-upstream.js';

/**
 * A computer serving its own screens.
 *
 * Runs inside the sandbox image, on loopback, behind the provider's private
 * preview — so a viewer must hold the preview's token to reach it at all, and
 * then a ticket the orchestrator signed to be served. The pixels go from here
 * straight to the viewer; the orchestrator sees none of them.
 *
 * What it serves is the same stream the orchestrator serves (`@crewaid/screen-
 * stream`), read from each seat's x11vnc on this machine's loopback: same
 * pacing, same wire, so the app cannot tell the two apart.
 *
 * It never forwards input. A viewer here has no way to type into the desktop:
 * keyboard and pointer go through the orchestrator, where seat control and
 * the recording tee decide what reaches it.
 */
export class ScreenGateway {
  readonly server: Server;
  private readonly sockets: WebSocketServer;
  private readonly hub: ScreenStreamHub;
  private readonly replays: PersistentTicketReplays;
  private readonly resolveSeat: ResolveScreenSeat;
  private readonly pending = new Set<Duplex>();
  private closing = false;

  constructor(private readonly options: ScreenGatewayOptions) {
    this.replays = new PersistentTicketReplays(`${options.keyFile}.used`);
    this.resolveSeat = options.resolveSeat ?? resolveScreenSeat;
    const createUpstream: ScreenUpstreamFactory =
      options.createUpstream ?? ((upstream) => new RfbUpstream(upstream));
    this.hub = new ScreenStreamHub({
      logger: options.logger,
      connect: async (key) => {
        try {
          const seat = ScreenSeatBindingSchema.parse(JSON.parse(key));
          if (!sameSeat(await this.resolveSeat(seat.botId), seat)) {
            this.hub.end(key, {
              code: 'SCREEN_NOT_RUNNING',
              message: 'The bot no longer owns this seat.',
            });
            return null;
          }
          return new SeatBoundUpstream(
            createUpstream({
              host: '127.0.0.1',
              port: seat.rfbPort,
              quality: MIN_QUALITY,
              logger: options.logger,
            }),
            seat,
            this.resolveSeat,
          );
        } catch (error: unknown) {
          // A late join has already replaced the old connection. End every
          // viewer of this generation instead of leaving the older ones idle.
          this.hub.end(key, {
            code: 'SCREEN_STREAM_LOST',
            message: 'The display could not be opened.',
          });
          throw error;
        }
      },
    });
    this.sockets = new WebSocketServer({
      noServer: true,
      maxPayload: SCREEN_STREAM_MAX_CLIENT_FRAME_BYTES,
    });
    this.sockets.on('error', (error: Error) =>
      options.logger.warn(`screen socket server error: ${error.message}`),
    );
    this.server = createServer((request, response) => {
      const healthy = request.url === '/health' && request.method === 'GET';
      response.writeHead(healthy ? 200 : 404, { 'content-type': 'text/plain' });
      response.end(healthy ? 'ok' : '');
    });
    this.server.on('error', (error: Error) =>
      options.logger.warn(`screen gateway server error: ${error.message}`),
    );
    this.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', (error: Error) => {
        options.logger.warn(`screen upgrade socket error: ${error.message}`);
        socket.destroy();
      });
      this.pending.add(socket);
      socket.once('close', () => this.pending.delete(socket));
      void this.upgrade(request, socket, head).catch((error: unknown) => {
        options.logger.warn(
          `screen upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!socket.destroyed) refuse(socket, 503);
      });
    });
  }

  listen(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  /** The port it listens on; for a test that asked for any. */
  get port(): number {
    const address = this.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.hub.close();
    for (const socket of this.pending) socket.destroy();
    for (const client of this.sockets.clients) client.terminate();
    this.sockets.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://gateway.invalid');
    } catch {
      refuse(socket, 400);
      return;
    }
    if (this.closing) {
      refuse(socket, 503);
      return;
    }
    if (url.pathname !== SCREEN_GATEWAY_PATH) {
      refuse(socket, 404);
      return;
    }
    const claims = await this.admit(url.searchParams.get(SCREEN_STREAM_TICKET_PARAM) ?? '');
    if (socket.destroyed || this.closing) return;
    if (claims === null) {
      refuse(socket, 401);
      return;
    }
    const seat = await this.resolveSeat(claims.botId);
    if (socket.destroyed || this.closing) return;
    if (seat === null || seat.botId !== claims.botId || seat.rfbPort !== claims.port) {
      refuse(socket, 401);
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (viewer) => {
      this.pending.delete(socket);
      viewer.on('error', (error: Error) =>
        this.options.logger.warn(`screen viewer error: ${error.message}`),
      );
      void serveScreenViewer({
        hub: this.hub,
        key: JSON.stringify(seat),
        expiresAt: claims.exp,
        ...(this.options.now ? { now: this.options.now } : {}),
        socket: viewer,
        quality: qualityFromQuery(url.searchParams),
        logger: this.options.logger,
      }).catch((error: unknown) => {
        this.options.logger.warn(
          `screen viewer failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        viewer.close(1011, 'The display could not be opened.');
      });
    });
  }

  /**
   * A ticket this gateway may serve: signed by the orchestrator's current key,
   * live, granted for THIS computer and for one of its seats, and not seen
   * before. The reason for a refusal stays in the log.
   */
  private async admit(ticket: string): Promise<ScreenTicketClaims | null> {
    const key = await readScreenKey(this.options.keyFile);
    if (key === null) {
      this.options.logger.warn('screen stream refused: no key has been delivered yet');
      return null;
    }
    const verdict = verifyScreenTicket(ticket, key.publicKey, this.options.now?.() ?? Date.now());
    if (!verdict.ok) {
      this.options.logger.warn(`screen stream refused: ${verdict.reason}`);
      return null;
    }
    const { claims } = verdict;
    if (claims.session !== key.session) {
      this.options.logger.warn('screen stream refused: the ticket is for another computer');
      return null;
    }
    if (claims.port < SEAT_RFB_PORTS.first || claims.port > SEAT_RFB_PORTS.last) {
      this.options.logger.warn(`screen stream refused: port ${claims.port} is not a seat`);
      return null;
    }
    if (!(await this.replays.claim(claims, this.options.now?.() ?? Date.now()))) {
      this.options.logger.warn('screen stream refused: the ticket was already used');
      return null;
    }
    return claims;
  }
}

export interface ScreenGatewayOptions {
  /** Where the bridge writes the orchestrator's key (`screen_key.py`). */
  readonly keyFile: string;
  readonly logger: ScreenLogger;
  /** Seam for tests; defaults to a real RFB connection. */
  readonly createUpstream?: ScreenUpstreamFactory;
  /** Resolves the bridge's current immutable seat identity, without creating one. */
  readonly resolveSeat?: ResolveScreenSeat;
  readonly now?: () => number;
}

/** Bot seats only; the machine's own desktop has no bot to grant access to. */
export const SEAT_RFB_PORTS = { first: 5901, last: 5916 } as const;

/** Must match `SCREEN_KEY_FILENAME` in the agent bridge's `screen_key.py`. */
export const SCREEN_KEY_FILENAME = 'crewaid-screen-ticket.json';

/**
 * The key file, read on every upgrade: it is small, and a key the orchestrator
 * replaced — after it restarted — must apply to the very next viewer.
 */
async function readScreenKey(path: string): Promise<{
  readonly publicKey: ReturnType<typeof importScreenTicketPublicKey>;
  readonly session: string;
} | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('publicKey' in parsed) ||
      !('session' in parsed) ||
      typeof parsed.publicKey !== 'string' ||
      typeof parsed.session !== 'string'
    ) {
      return null;
    }
    return { publicKey: importScreenTicketPublicKey(parsed.publicKey), session: parsed.session };
  } catch {
    return null;
  }
}

/** Answer an Upgrade with a plain HTTP refusal, before any socket exists. */
function refuse(socket: Duplex, status: number): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
