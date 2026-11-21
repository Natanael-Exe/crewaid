import {
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Principal } from '@crewaid/shared';
import { OwnershipService } from './ownership.service.js';
import { OWNED_RESOURCE, type OwnedResourceSpec } from './owned-resource.decorator.js';

type RequestWithPrincipal = {
  principal?: Principal;
  params?: Record<string, string | undefined>;
};

/**
 * Ownership fence for D-010's direct-by-ID routes.
 *
 * AuthGuard remains the authentication boundary and runs first as APP_GUARD;
 * this one answers a narrower question — may THIS principal touch THIS row.
 *
 * The guard knows no URLs. A route declares what it owns with
 * `@OwnedResource(kind, param)` and the guard reads that off the handler, so
 * adding a route family in M3–M8 touches the handler and the finder record,
 * both of which the compiler checks. What it replaced was a regex route table,
 * a lookup switch and a path-family predicate that had to be kept in agreement
 * by hand.
 *
 * Routes with no marker pass through: WS and non-HTTP contexts, unparameterised
 * collections, and the bot-scoped families that scope inside their service
 * instead. That is a fail-open shape, so the fence that used to be a runtime
 * 404 on an unrecognised direct-resource path now lives in
 * `ownership-route-coverage.test.ts`, which walks the real route table and
 * fails the build when a parameterised route carries neither a marker nor a
 * written exemption.
 */
@Injectable()
export class ResourceOwnershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly ownership: OwnershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    // Handler first, then controller: a class-level marker sets the family for
    // every route on it, and a handler may still narrow to its own parameter.
    const spec = this.reflector.getAllAndOverride<OwnedResourceSpec | undefined>(OWNED_RESOURCE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (spec === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;
    if (principal === undefined) {
      throw new UnauthorizedException('Principal required');
    }

    const resourceId = request.params?.[spec.param];
    if (resourceId === undefined || resourceId === '') {
      // A marker naming a parameter the route does not carry is a wiring
      // mistake, but it must not fail open — the route is fenced, so refuse.
      throw new NotFoundException('Resource not found');
    }

    const resource = await this.ownership.findOwned(spec.kind, principal.userId, resourceId);
    if (resource === null) {
      throw new NotFoundException('Resource not found');
    }
    return true;
  }
}
