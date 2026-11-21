import { AUTH_BASE_PATH } from '@crewaid/shared';

/**
 * Is there an orchestrator at this address at all?
 *
 * One UNAUTHENTICATED round trip, which is the only kind available before a
 * session exists — and the state both callers care about most, because it is
 * the one a first run is in.
 *
 * `{basePath}/get-session` is the route for it: Better Auth answers it without
 * credentials (200 with a null body for an unknown caller), so a reply proves
 * an orchestrator is listening without proving anything about this install's
 * right to use it. It is also the exact route `SignInController.status` uses,
 * so a reachable verdict here and a working sign-in cannot disagree about
 * which address was reached.
 *
 * Not `GET /models`: it is authenticated, so signed out it can only ever
 * answer 401 — which reads as "that address rejected this token" about a
 * token that was never sent.
 *
 * Returns the HTTP status, or `'unreachable'` when the request never
 * completed. `addressVerdict` turns that into a sentence; keeping the two
 * apart is what lets the verdict be tested without a network.
 */
export async function probeReachable(baseUrl: string): Promise<'unreachable' | number> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${AUTH_BASE_PATH}/get-session`, {
      method: 'GET',
    });
    return response.status;
  } catch {
    return 'unreachable';
  }
}
