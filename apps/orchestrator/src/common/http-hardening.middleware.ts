import { BadRequestException, Injectable, type NestMiddleware } from '@nestjs/common';

type HardenedRequest = { originalUrl?: string; url?: string; body?: unknown };
type HardenedResponse = {
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
};
type NextFunction = () => void;

/**
 * The response headers every answer carries, and the one input no route can
 * store.
 *
 * Headers: these bodies are JSON for an API client, plus a few pages a person
 * opens in a browser (sign-in, the MCP callback), and none of them is meant to
 * be sniffed into another type, framed by another site, or to leak its URL —
 * which can hold a state or a code — to wherever a link on it goes. A page
 * that needs more sets its own policy on top. `X-Powered-By` names the
 * framework to anyone who asks and helps nobody who is entitled to know.
 *
 * NUL: Postgres refuses U+0000 in `text` and `jsonb` alike, so a route that
 * passes one through answers with Prisma's 500 and a stack trace in the log —
 * for what is a malformed request. It is refused here as one, from the URL
 * (path and query) or from a parsed JSON body, before any handler runs.
 */
@Injectable()
export class HttpHardeningMiddleware implements NestMiddleware {
  use(request: HardenedRequest, response: HardenedResponse, next: NextFunction): void {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.removeHeader('X-Powered-By');

    if (urlHasNul(request.originalUrl ?? request.url ?? '') || holdsNul(request.body)) {
      throw new BadRequestException('The request contains a NUL character.');
    }
    next();
  }
}

function urlHasNul(url: string): boolean {
  return url.includes('\u0000') || /%00/i.test(url);
}

/**
 * Whether a parsed JSON body holds U+0000 in any key or string. Iterative: a
 * body is whatever the client nested, and a recursive walk is a stack it
 * chooses the depth of.
 */
export function holdsNul(body: unknown): boolean {
  const pending: unknown[] = [body];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (value.includes('\u0000')) return true;
    } else if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
    } else if (typeof value === 'object' && value !== null && !Buffer.isBuffer(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (key.includes('\u0000')) return true;
        pending.push(entry);
      }
    }
  }
  return false;
}
