import { SetMetadata } from '@nestjs/common';

/**
 * The resource families fenced by D-010.
 *
 * Each name maps to exactly one ownership relation in OwnershipService. The
 * two are kept in step by the compiler rather than by review: the service's
 * lookup record is `satisfies Record<OwnedResourceKind, …>`, so a family
 * declared here without a relation — or a relation without a family — fails
 * the build.
 */
export const OWNED_RESOURCE_KINDS = [
  // The chat delivery routes name the bot itself.
  'bot',
  'skill',
  'skillRun',
  'recording',
  'attachment',
  'mcpServer',
  'routine',
  // V1-05 / D-082. A connection is owned directly; a model is owned through
  // its connection, which is why it is a separate family rather than a param
  // on the same one — the guard must walk the relation, not assume the id in
  // the path is a connection.
  'providerConnection',
  'providerModel',
  // D-131. A group is owned directly, like a connection.
  'botGroup',
  // D-134. Work records are owned directly by their `userId`.
  'project',
  'goal',
  'task',
  'taskSeries',
  'deliverable',
  // D-222. A call is owned directly by its `userId`.
  'voiceCall',
  // D-241 Step 5. A local harness connector is owned directly by its `userId`.
  'localConnector',
] as const;

export type OwnedResourceKind = (typeof OWNED_RESOURCE_KINDS)[number];

/** Reflector key. Not exported for general use — the guard is the only reader. */
export const OWNED_RESOURCE = 'crewaid:owned-resource';

export interface OwnedResourceSpec {
  readonly kind: OwnedResourceKind;
  readonly param: string;
}

/**
 * Fences a route behind ResourceOwnershipGuard.
 *
 * `param` names the route parameter carrying the resource id, so a nested
 * route declares what it owns rather than the guard inferring it from a URL
 * shape: `@OwnedResource('skillRun', 'runId')` on `skills/:id/runs/:runId`.
 *
 * Declaring ownership on the handler is what removes the guard's need to know
 * any URL at all. The previous shape kept a regex table, a lookup switch and a
 * path-family predicate that all had to agree, and every route added in M3–M8
 * had to be entered in three places or be silently unguarded.
 *
 * A direct-by-id route that carries neither this decorator nor an entry in the
 * exemption list fails `ownership-route-coverage.test.ts` — the fence is a
 * build failure, not a 404 discovered in production.
 */
export const OwnedResource = (kind: OwnedResourceKind, param = 'id') =>
  SetMetadata<string, OwnedResourceSpec>(OWNED_RESOURCE, { kind, param });
