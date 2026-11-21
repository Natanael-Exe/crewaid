import { z } from 'zod';
import { CuidSchema } from './primitives.js';
import type { Edition } from './enums.js';
import { API_PREFIX } from './rest.js';

/**
 * The auth boundary.
 *
 * Every handler reads `principal.userId` rather than assuming a single user,
 * which is what made V1-08 a guard swap instead of a sweep across every
 * endpoint: the shape below did not move when a static token was replaced by a
 * Better Auth session, only what fills it in.
 */

export const PrincipalSchema = z.object({
  userId: CuidSchema,
  /** v1: `['*']`. */
  scopes: z.array(z.string()).min(1),
});
export type Principal = z.infer<typeof PrincipalSchema>;

/** The wildcard scope granted to the v1 singleton principal. */
export const SCOPE_ALL = '*' as const;

/**
 * Where Better Auth's own route tree is mounted.
 *
 * Under the REST prefix with everything else, so an install has ONE address to
 * configure and the WebSocket has one origin to trust. Both sides read it
 * from here: the orchestrator passes it to `betterAuth({ basePath })`, and the
 * desktop builds its sign-in and exchange URLs from it. A literal on either
 * side would be a second place to change it — and getting it wrong on the
 * desktop produces a 404 from a server that is working perfectly.
 */
export const AUTH_BASE_PATH = `${API_PREFIX}/auth`;

/**
 * The desktop sign-in contract (v1-11, d-088)
 *
 * The strings both halves of the sign-in flow have to agree on, in the one
 * package allowed to be the source of truth for a wire shape. The orchestrator
 * builds the sign-in page and its trusted origin from them; the Electron main
 * process builds the protocol registration and the callback check from them.
 *
 * A copy on either side that drifts does not fail as a mismatch anyone can
 * read. It fails as a callback that never arrives — which looks exactly like a
 * browser that did nothing, and sends the next person to debug the browser.
 */

/**
 * The custom protocol each edition's desktop registers, and the only scheme a
 * sign-in callback may arrive on.
 *
 * One per edition because both apps can be installed on the same machine, and
 * an OS hands a scheme to whichever app registered it last: with one shared
 * scheme, signing in to the self-hosted app could open the cloud one, which
 * holds no verifier for that code. Asked by edition rather than exported as
 * constants so no caller can reach for a scheme without saying which product
 * it is.
 *
 * Single-label rather than the reverse-DNS form RFC 8252 §7.1 recommends,
 * because this product has no domain to reverse and spelling one out would be
 * a claim about ownership that is not true. What that notation prevents is a
 * scheme collision, and a collision here is not a credential leak: the deep
 * link carries an authorization code that is worthless without the PKCE
 * verifier, which never leaves the main process's memory (RFC 8252 §8.1). An
 * app that steals the scheme receives a string it cannot spend.
 */
const DESKTOP_AUTH_SCHEMES: Readonly<Record<Edition, string>> = {
  cloud: 'crewaid',
  selfhosted: 'crewaid-selfhosted',
};

export function desktopAuthScheme(edition: Edition): string {
  return DESKTOP_AUTH_SCHEMES[edition];
}

/** The one path a callback may land on. Anything else is refused unread. */
export const DESKTOP_AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * The full deep link, written once.
 *
 * `crewaid://auth/callback` — the scheme is registered non-standard, so a URL
 * parser reports `auth` as the host and `/callback` as the path, and the
 * validation rejoins the two before comparing. Deriving the string here is
 * what stops the page that sends it and the handler that checks it from ever
 * disagreeing about a slash.
 */
export function desktopAuthDeepLink(edition: Edition): string {
  return `${desktopAuthScheme(edition)}:/${DESKTOP_AUTH_CALLBACK_PATH}`;
}

/**
 * The origin the desktop's own requests announce, and therefore the one extra
 * entry `trustedOrigins` needs.
 *
 * The exchange at `/electron/token` is a cross-origin POST from a native app:
 * it carries `Origin: crewaid:/`, and Better Auth's CSRF check refuses an origin
 * it was never told about. That check having an allowlist rather than a
 * same-origin rule is the whole reason this flow can work at all.
 */
export function desktopAuthOrigin(edition: Edition): string {
  return `${desktopAuthScheme(edition)}:/`;
}

/**
 * Which client an authorization code may be minted for.
 *
 * The server plugin refuses to transfer a session to any other `client_id`,
 * and this also names the cookie the browser bounce reads
 * (`better-auth.crewaid-desktop`).
 */
export const DESKTOP_AUTH_CLIENT_ID = 'crewaid-desktop';
