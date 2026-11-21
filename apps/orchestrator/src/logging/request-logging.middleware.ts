import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { StructuredLogger, type CorrelationFields } from './structured-logger.js';

type CorrelationRequest = {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
};
type CorrelationResponse = {
  statusCode: number;
  on(event: 'finish', callback: () => void): void;
};
type NextFunction = () => void;

function requestPath(request: CorrelationRequest): string {
  const raw = request.originalUrl ?? request.url ?? '/';
  return raw.split('?')[0] ?? '/';
}

function botIdFromPath(path: string): string | null {
  const match = path.match(/^\/api\/v1\/bots\/([^/]+)/);
  return match?.[1] ?? null;
}

/**
 * Seeds request-scoped correlation and emits lifecycle records without bodies.
 *
 * Correlation is what the SERVER knows about a request, never what the request
 * says about itself: a header naming a bot or a run is any caller's to set,
 * and a log that files a request under the run it claims is a log anyone can
 * point at somebody else's run. The bot comes from the route; the request id
 * is minted here, so the two lifecycle records of one request can be paired.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(private readonly logger: StructuredLogger) {}

  use(request: CorrelationRequest, response: CorrelationResponse, next: NextFunction): void {
    const path = requestPath(request);
    const fields: CorrelationFields = { botId: botIdFromPath(path) };
    const requestId = randomUUID();

    const requestLogger = this.logger.child(fields);
    requestLogger.info('request.start', { requestId, method: request.method, path });
    response.on('finish', () => {
      requestLogger.info('request.complete', {
        requestId,
        method: request.method,
        path,
        statusCode: response.statusCode,
      });
    });
    next();
  }
}
