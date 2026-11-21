import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '@crewaid/shared';

/**
 * Injects the request's resolved Principal.
 *
 * AuthGuard authenticates the request and attaches `request.principal` before
 * the handler runs. This decorator only reads it so authentication stays in
 * one place.
 * a test bootstrap may populate `request.principal` directly.
 *
 * If request.principal is missing, the guard did not run; that is a 500-class
 * configuration error, not a 401 — fail loudly.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const request = ctx.switchToHttp().getRequest<{ principal?: Principal }>();
    if (request.principal === undefined) {
      throw new Error('request.principal is undefined — AuthGuard did not run on this route');
    }
    return request.principal;
  },
);
