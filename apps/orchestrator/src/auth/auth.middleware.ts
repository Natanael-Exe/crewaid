import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './better-auth.js';

/**
 * Mounts Better Auth's own HTTP surface under `/api/v1/auth`.
 *
 * Middleware rather than a controller, because Better Auth answers a whole
 * route TREE — sign-in per provider, the OAuth callbacks, session read,
 * sign-out, magic-link verification — and the set changes with the plugin
 * list. A controller would be a hand-maintained mirror of that list, and the
 * failure mode of falling behind it is a 404 on a callback URL that an
 * identity provider has already redirected a person to.
 *
 * It does NOT call `next()`. The handler writes the response itself, and
 * Nest has no controller on these paths — calling through would 404 a request
 * that was already answered.
 *
 * Why the global body parser can stay on
 *
 * Better Auth's own NestJS guidance says to boot with `bodyParser: false`,
 * because the classic Express recipe mounts the handler ahead of
 * `express.json()` and a parsed body leaves the raw stream drained. That is a
 * real failure on older releases and it is why the community Nest package
 * exists. It does not apply here: `better-call@1.4.0` — the HTTP layer Better
 * Auth builds on — checks whether the stream is still readable and falls back
 * to re-serialising `req.body` when it is not (`getRequest` in
 * `adapters/node/request.ts`). Turning the parser off app-wide to satisfy this
 * one route tree would mean re-adding parsers by hand everywhere else,
 * including the D-022 upload path where Multer's limits are the contract.
 *
 * Pinned exactly (M0-07), so that fallback cannot disappear in a patch bump
 * without the lockfile diff showing it.
 *
 * But a re-serialised body is not the body that was sent
 *
 * That fallback is `JSON.stringify(req.body)`, which carries the same data in
 * different bytes. A sign-in does not care; Stripe's webhook does, because
 * Stripe signs the exact bytes it sent and the plugin verifies that signature
 * over what it reads. So when Nest kept the raw bytes (`rawBody: true`
 * in `main.ts`) they are handed on as a string, which `better-call` passes
 * through untouched — every route in the tree gets the body exactly as sent.
 */
@Injectable()
export class BetterAuthMiddleware implements NestMiddleware {
  private readonly handler = toNodeHandler(auth);

  async use(
    req: IncomingMessage & { rawBody?: Buffer; body?: unknown },
    res: ServerResponse,
  ): Promise<void> {
    if (Buffer.isBuffer(req.rawBody)) req.body = req.rawBody.toString('utf8');
    await this.handler(req, res);
  }
}
