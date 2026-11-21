import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ChatQuerySchema, WIRE_VERSION, type ChatQuery, type Principal } from '@crewaid/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { auth } from '../auth/better-auth.js';
import { runEventSseResponse } from '../agent/persistence/run-event-sse.js';
import { ChatDeliveryService } from './chat-delivery.service.js';
import { ChatSendService } from './chat-send.service.js';

/**
 * Comments keep idle proxies from cutting a long tail, and each one re-reads
 * the session, so a revoked or expired session stops receiving within this
 * interval — the same bound the WebSocket's revocation sweep uses.
 */
const KEEP_ALIVE_MS = 15_000;
/** both sides of a chat route state the contract version they speak. */
const WIRE_VERSION_HEADER = 'x-crewaid-wire-version';

/** Resolves when the socket can take more, or when the client went away. */
function drained(res: ServerResponse, req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      req.off('close', done);
      resolve();
    };
    res.once('drain', done);
    req.once('close', done);
  });
}

@Controller('bots/:id')
export class ChatDeliveryController {
  constructor(
    @Inject(ChatDeliveryService) private readonly delivery: ChatDeliveryService,
    @Inject(ChatSendService) private readonly send: ChatSendService,
  ) {}

  /**
   * `POST /bots/:id/chat`: admit a user turn or an approval answer,
   * then stream the run that answers it.
   *
   * The response is a reader of the run's durable log, replayed from its start
   * and then tailed — the same reader the join serves, so a disconnect here is
   * a disconnect of a reader and the run goes on. A deferred message has no run
   * of its own yet and gets a stream that closes with no events.
   */
  @Post('chat')
  @OwnedResource('bot')
  async send_(
    @Param('id') botId: string,
    @Body() body: unknown,
    @CurrentUser() principal: Principal,
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    this.assertWireVersion(req, res);
    const params = await this.send.parse(body);
    const admitted = await this.send.admit(principal.userId, botId, params);
    if (admitted.kind === 'deferred') {
      // Valid SSE with nothing in it: the message is stored, and the run that
      // answers it announces itself with `run.started`.
      res.statusCode = 202;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('X-Accel-Buffering', 'no');
      res.end();
      return;
    }
    await this.stream(principal.userId, botId, admitted.runId, '-1', req, res);
  }

  /**
   * `GET /bots/:id/chat` ( §3.2). With `runId`: replay strictly after the
   * offset, then tail; a closed stream is a disconnect and the run and
   * its log go on. With `threadId`: hydrate the transcript, active run and
   * pending interrupts.
   */
  @Get('chat')
  @OwnedResource('bot')
  async read(
    @Param('id') botId: string,
    @Query(new ZodValidationPipe(ChatQuerySchema)) query: ChatQuery,
    @CurrentUser() principal: Principal,
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    this.assertWireVersion(req, res);
    if (!('runId' in query)) {
      const hydrated = await this.delivery.hydrate(
        principal.userId,
        botId,
        query.threadId,
        new Request(new URL(req.url ?? '/', 'http://orchestrator.internal')),
      );
      res.statusCode = hydrated.status;
      hydrated.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(await hydrated.text());
      return;
    }
    const header = req.headers['last-event-id'];
    const offset = query.offset ?? (typeof header === 'string' && header !== '' ? header : '-1');
    await this.stream(principal.userId, botId, query.runId, offset, req, res);
  }

  /**
   * A client built against another contract fails plainly here, rather than
   * half-parsing a stream it does not understand.
   */
  private assertWireVersion(req: IncomingMessage, res: ServerResponse): void {
    const declared = req.headers[WIRE_VERSION_HEADER];
    if (declared !== undefined && declared !== String(WIRE_VERSION))
      throw new HttpException(
        { code: 'WIRE_VERSION_UNSUPPORTED', supported: WIRE_VERSION },
        426, // Upgrade Required; Nest names no constant for it.
      );
    res.setHeader(WIRE_VERSION_HEADER, String(WIRE_VERSION));
  }

  /**
   * One reader loop for both routes, so keep-alives, session re-reads and
   * drain backpressure cannot differ between sending a turn and rejoining one.
   */
  private async stream(
    userId: string,
    botId: string,
    runId: string,
    offset: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const log = await this.delivery.join(userId, botId, runId, offset);
    const response = runEventSseResponse(log);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.flushHeaders();
    const body = response.body;
    if (body === null) {
      res.end();
      return;
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    let open = true;
    const stop = () => {
      open = false;
      void reader.cancel().catch(() => undefined);
    };
    req.once('close', stop);
    const keepAlive = setInterval(() => {
      void auth.api
        .getSession({ headers: fromNodeHeaders(req.headers) })
        .then((session) => {
          if (session === null) stop();
          else if (open) res.write(': keep-alive\n\n');
        })
        // A database blip must not end every tail; the next interval retries.
        .catch(() => undefined);
    }, KEEP_ALIVE_MS);
    keepAlive.unref();
    try {
      while (open) {
        const { done, value } = await reader.read();
        if (done) break;
        // Each read is one whole SSE frame, so a keep-alive never splits one.
        // Bounded backpressure: a slow client stops this loop reading the log
        // rather than growing a buffer; the producer never waits on a reader.
        if (!res.write(value)) await drained(res, req);
      }
    } catch {
      // A reader error ends this join only; the producer is not attached to it.
    } finally {
      clearInterval(keepAlive);
      req.off('close', stop);
      res.end();
    }
  }
}
