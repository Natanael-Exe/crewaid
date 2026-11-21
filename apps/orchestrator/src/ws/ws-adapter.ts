import type { IncomingMessage } from 'node:http';
import { auth } from '../auth/better-auth.js';

/**
 * The WS handshake check.
 *
 * Single endpoint: `ws://<host>/ws?token=<session token>`. The token is the
 * same `Session.token` the REST guard accepts as a bearer — one credential,
 * two transports — so signing out of one signs out of both.
 *
 * Why the token is in the query string, still
 *
 * A WebSocket handshake cannot carry an `Authorization` header from a browser
 * API, which is why D-025 carved this out as the one place a credential
 * travels in a URL. That has not changed; what changed is WHAT travels there.
 * A session token is revocable and expiring, where `ORCH_API_TOKEN` was a
 * process-wide secret that could only be rotated by a restart — so the same
 * URL exposure now costs one session rather than the whole deployment.
 *
 * Still during the upgrade
 *
 * Called from `CrewaidWsAdapter.create`'s `verifyClient`, so a bad credential is
 * answered with a real HTTP 401 and never becomes a WebSocket. This could not
 * become a post-connect check: a client that connects and is then closed
 * cannot tell "rejected" from "the server went away", and the 401 is the only
 * answer that says which.
 *
 * It is ASYNCHRONOUS now, because a session is a row rather than a string
 * comparison. `ws` supports that — `verifyClient`'s callback form exists
 * precisely so the verdict can arrive later — and the Upgrade is held until it
 * does.
 */
export type WsHandshakeVerdict =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly token: string;
      readonly expiresAt: Date;
    }
  | { readonly ok: false; readonly status: 401 };

const REFUSED = { ok: false, status: 401 } as const;

/** Extract `?token=` without assuming the URL is well formed. */
function tokenFrom(request: IncomingMessage): string | null {
  try {
    const value = new URL(request.url ?? '', 'ws://localhost').searchParams.get('token');
    return value === null || value === '' ? null : value;
  } catch {
    return null;
  }
}

export async function verifyWsHandshake(request: IncomingMessage): Promise<WsHandshakeVerdict> {
  const token = tokenFrom(request);
  if (token === null) return REFUSED;

  // Handed to Better Auth as a bearer rather than looked up directly: the
  // bearer plugin signs the raw value and resolves it through the same code
  // path `AuthGuard` uses, so the socket and REST cannot disagree about what
  // counts as a valid session. A direct `session.findUnique` here would be a
  // second implementation of authentication, and the two would drift the first
  // time either grew a rule.
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
  } catch {
    // A database that cannot answer must refuse the handshake rather than
    // admit it. This is the one path where failing open would be silent.
    return REFUSED;
  }

  if (session === null) return REFUSED;
  return {
    ok: true,
    userId: session.user.id,
    token,
    expiresAt: new Date(session.session.expiresAt),
  };
}

/**
 * The verdict, carried from `verifyClient` to `handleConnection`.
 *
 * `ws` hands the SAME `IncomingMessage` to both, so the socket can be
 * registered as its owner without the gateway re-reading the session — which
 * would mean two lookups per connection and, worse, a window where the two
 * could disagree about who just connected.
 *
 * A WeakMap rather than a property on the request: nothing else has a reason
 * to see this, and the entry goes when the request object does.
 */
const admitted = new WeakMap<IncomingMessage, { userId: string; token: string; expiresAt: Date }>();

export function rememberHandshake(
  request: IncomingMessage,
  verdict: Extract<WsHandshakeVerdict, { ok: true }>,
): void {
  admitted.set(request, {
    userId: verdict.userId,
    token: verdict.token,
    expiresAt: verdict.expiresAt,
  });
}

export function recallHandshake(
  request: IncomingMessage,
): { userId: string; token: string; expiresAt: Date } | undefined {
  return admitted.get(request);
}
