import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  SCREEN_GATEWAY_PATH,
  SCREEN_GATEWAY_PORT,
  type ScreenGrantResponse,
  type ScreenStreamEndpoint,
} from '@crewaid/shared';
import { SCREEN_TICKET_TTL_MS } from '@crewaid/screen-stream';

import { StructuredLogger } from '../logging/structured-logger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox.provider.js';
import { SeatService } from '../sandbox/seat.service.js';
import { computerOfBot } from '../sandbox/attached-computer.js';
import { ScreenTicketService } from './screen-ticket.service.js';

/**
 * `POST /bots/:id/screen/grant` — what lets one viewer open one stream of a
 * bot's desktop.
 *
 * The route's `@OwnedResource` marker has already tied the bot to the caller;
 * this decides the rest. Only a RUNNING computer gets a grant, and getting one
 * changes nothing about the computer: the panel opening is not a reason to
 * wake it (D-039 §16), so a stopped one is refused and the viewer shows the
 * stopped state it already knows how to show.
 *
 * Where the stream is served
 *
 * Where the provider can expose a port of the computer privately, the grant
 * points at the computer's own screen gateway, and the pixels never cross this
 * process: the gateway is told this process's ticket key, and the viewer gets
 * the provider's address with its access token in it. Elsewhere the grant
 * points here, at `/ws/screen`.
 */
@Injectable()
export class ScreenGrantService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeatService) private readonly seats: SeatService,
    @Inject(ScreenTicketService) private readonly tickets: ScreenTicketService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  async grant(botId: string, now: number = Date.now()): Promise<ScreenGrantResponse> {
    const started = performance.now();
    const sandbox = await computerOfBot(this.prisma, botId, {
      state: true,
      sessionId: true,
      widthPx: true,
      heightPx: true,
    });
    if (sandbox === null || sandbox.state !== 'RUNNING' || sandbox.sessionId === null) {
      throw new ConflictException({
        statusCode: 409,
        code: SCREEN_NOT_RUNNING_CODE,
        message: 'This computer is not running. Open it to see its screen.',
      });
    }
    const sessionId = sandbox.sessionId;

    // The seat is made here rather than when the stream connects, so a grant
    // names a port that exists — and so the seat's x11vnc is restarted if it
    // died, before anyone dials it. A direct grant also needs the gateway told
    // its key and its address made. The address waits on the key, because only
    // a gateway that expires its viewers may be sent a direct ticket.
    // Each is timed — as when it finished, counted from the grant's start —
    // because a grant is much of what stands between a click on a bot and its
    // picture, and the log line below is how to see which part to shorten.
    const provider = this.provider;
    const took: Record<'seatMs' | 'keyMs' | 'accessMs', number | null> = {
      seatMs: null,
      keyMs: null,
      accessMs: null,
    };
    const timed = async <T>(part: keyof typeof took, work: Promise<T>): Promise<T> => {
      const value = await work;
      took[part] = Math.round(performance.now() - started);
      return value;
    };
    const [seat, direct] = await Promise.all([
      timed(
        'seatMs',
        this.seats.ensureSeat(sessionId, botId, {
          widthPx: sandbox.widthPx,
          heightPx: sandbox.heightPx,
        }),
      ),
      provider.screenAccess === undefined
        ? Promise.resolve(null)
        : timed(
            'keyMs',
            this.seats.publishScreenKey(sessionId, {
              publicKey: this.tickets.publicKey,
              session: sessionId,
            }),
          ).then((expiresViewers) =>
            expiresViewers && provider.screenAccess
              ? timed('accessMs', provider.screenAccess({ sessionId, port: SCREEN_GATEWAY_PORT }))
              : null,
          ),
    ]);

    let exp = now + SCREEN_TICKET_TTL_MS;
    let endpoint: ScreenStreamEndpoint = { kind: 'orchestrator' };
    if (direct !== null) {
      const url = new URL(direct.url);
      url.pathname = SCREEN_GATEWAY_PATH;
      endpoint = { kind: 'direct', url: url.toString() };
      // Whichever closes first decides when the grant stops opening anything.
      exp = Math.min(exp, direct.expiresAt);
    }
    const ticket = this.tickets.sign(
      {
        v: 1,
        aud: 'crewaid-screen',
        session: sessionId,
        botId,
        port: seat.rfbPort,
        exp,
        jti: randomUUID(),
      },
      endpoint.kind,
    );
    this.logger.info('screen.grant', {
      botId,
      endpoint: endpoint.kind,
      totalMs: Math.round(performance.now() - started),
      ...took,
    });
    return { endpoint, ticket, expiresAt: new Date(exp).toISOString() };
  }
}

/** The grant's refusal: nothing to stream, and opening the panel must not wake it. */
export const SCREEN_NOT_RUNNING_CODE = 'SCREEN_NOT_RUNNING';
