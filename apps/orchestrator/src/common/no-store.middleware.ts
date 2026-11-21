import { Injectable, type NestMiddleware } from '@nestjs/common';

type CacheableResponse = { setHeader(name: string, value: string): void };
type NextFunction = () => void;

/**
 * Marks every response uncacheable.
 *
 * Express answers a GET with a weak `ETag` and no `Cache-Control`, which
 * leaves the freshness decision entirely to the user agent. Chromium — the
 * renderer's network stack — reads that as permission to store the body and
 * to serve it later without asking this server anything. Two consequences,
 * both of which have happened:
 *
 * - A `GET /bots` body cached before a column existed is replayed after the
 * column ships. The client parses its own contract, fails, and reports that
 * the server sent a response it cannot read. The database is correct, the
 * server is correct, and nothing short of deleting the browser profile
 * recovers it — which is a very long way from the symptom.
 * - A transcript outlives the row it came from, so a message list can be
 * older than the database it claims to be showing.
 *
 * `no-store` refuses the copy outright, which is the honest description of
 * these bodies: per-user, bearer-authenticated, and mutable. It also keeps
 * them out of Chromium's on-disk cache, which is plaintext — an authenticated
 * response has no business being readable there.
 *
 * Applied as middleware rather than an interceptor so it runs before routing:
 * a guard rejection and an error body are no more cacheable than a 200, and
 * an interceptor never sees the ones that fail before the handler.
 */
@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  use(_request: unknown, response: CacheableResponse, next: NextFunction): void {
    response.setHeader('Cache-Control', 'no-store');
    next();
  }
}
