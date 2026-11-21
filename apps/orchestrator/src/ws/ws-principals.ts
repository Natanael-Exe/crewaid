import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';
import type { Principal } from '@crewaid/shared';
import { auth } from '../auth/better-auth.js';

/**
 * Who each open socket is, and whether they still are.
 *
 * The handshake authenticates once. A socket then lives for hours, so "who is
 * this" cannot be answered from the handshake alone — a session revoked at
 * 10:05 must not keep driving a desktop until the client happens to reconnect.
 * The requirement is that interactive access ends at the NEXT FRAME rather
 * than the next reconnect, and this is where that is enforced.
 *
 * Why a revalidation window, and what it costs
 *
 * Re-reading the session row on literally every frame would be correct and
 * unaffordable: `screen.input` is a binary frame per mouse move, so a busy
 * desktop would issue tens of database queries a second per viewer to learn
 * something that changes maybe once a week.
 *
 * So the answer is memoised for `REVALIDATE_MS`, and the frames split by what
 * they cost:
 *
 * - A CONTROL frame — cancel, approval, subscribe — passes `fresh: true` and
 * always re-reads. These are one-per-human-action, so "the next frame" is
 * literally true for everything an operator can do.
 * - `screen.input` uses the window. A revoked session keeps moving a mouse for
 * at most `REVALIDATE_MS` and cannot start, cancel, approve or subscribe to
 * anything in that time.
 *
 * EXPIRY is exact regardless, because `expiresAt` is a timestamp this already
 * holds: it is checked in memory on every frame with no query at all. Only
 * revocation — a row someone deleted — needs the read.
 */
const REVALIDATE_MS = 1_000;

/** How long a socket outlives a session store it cannot read. */
export const FAIL_OPEN_GRACE_MS = 30_000;

type SocketSession = {
  readonly principal: Principal;
  readonly token: string;
  /** From the session row; checked on every frame without a query. */
  expiresAt: number;
  /** When the row was last actually read. */
  checkedAt: number;
};

@Injectable()
export class WsPrincipals {
  /**
   * Weak, so a closed socket's entry goes when the socket does. An explicit
   * `delete` on close would work too and would be one more thing to remember
   * in a path that already has `screens.detach` and `turnEvents.remove`.
   */
  private readonly sessions = new WeakMap<WebSocket, SocketSession>();

  /**
   * A field with a default rather than a constructor parameter: Nest reads
   * `design:paramtypes` and would try to inject `Function`, which fails at
   * boot with a resolution error naming an argument nobody wrote.
   */
  private clock: () => number = () => Date.now();

  /** Test seam: drive the revalidation window without waiting on a real one. */
  useClockForTests(clock: () => number): void {
    this.clock = clock;
  }

  private now(): number {
    return this.clock();
  }

  /** Record the handshake's verdict for the socket it admitted. */
  register(client: WebSocket, userId: string, token: string, expiresAt: Date): void {
    this.sessions.set(client, {
      principal: { userId, scopes: ['*'] },
      token,
      expiresAt: expiresAt.getTime(),
      checkedAt: this.now(),
    });
  }

  /**
   * The principal this socket may act as, or null if it may not any more.
   *
   * Null means the caller must stop: answer the frame and close the socket.
   * It never falls back to a default user — there is no such thing now, and a
   * fallback here would be the one place a revoked session kept working.
   */
  async principalFor(
    client: WebSocket,
    options: { readonly fresh?: boolean } = {},
  ): Promise<Principal | null> {
    const held = this.sessions.get(client);
    if (held === undefined) return null;

    const now = this.now();
    // Free, and exact: a session cannot outlive its own timestamp even inside
    // the revalidation window.
    if (held.expiresAt <= now) {
      this.sessions.delete(client);
      return null;
    }

    const due = options.fresh === true || now - held.checkedAt >= REVALIDATE_MS;
    if (!due) return held.principal;

    let session: Awaited<ReturnType<typeof auth.api.getSession>>;
    try {
      session = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${held.token}` }),
      });
    } catch {
      // A database blip must not sign everybody out mid-turn. The socket keeps
      // the principal it already proved, and the next frame tries again. But
      // only for a blip: a session deleted just before an outage would
      // otherwise keep working until its own expiry, a week away. Past
      // `FAIL_OPEN_GRACE_MS` since the row was last read, nothing vouches for
      // the socket any more, and it is refused like a revoked one.
      if (now - held.checkedAt > FAIL_OPEN_GRACE_MS) {
        this.sessions.delete(client);
        return null;
      }
      return held.principal;
    }

    if (session === null) {
      this.sessions.delete(client);
      return null;
    }

    held.expiresAt = new Date(session.session.expiresAt).getTime();
    held.checkedAt = now;
    // The row can name a different user only if a token were reissued to
    // somebody else, which Better Auth does not do — but reading it back is
    // free and the alternative is trusting a cached id forever.
    return session.user.id === held.principal.userId
      ? held.principal
      : { userId: session.user.id, scopes: ['*'] };
  }

  /**
   * The account this socket receives frames for, or null once it may not.
   *
   * Synchronous and query-free, because it is asked once per socket per
   * outgoing frame — a streamed reply is hundreds of those. It checks only
   * what needs no read: that the socket was admitted and that its session has
   * not passed its own expiry. Revocation needs the row, so it is
   * `principalFor`'s, reached for listening sockets by the gateway's sweep.
   */
  currentUserId(client: WebSocket): string | null {
    const held = this.sessions.get(client);
    if (held === undefined) return null;
    if (held.expiresAt <= this.now()) {
      this.sessions.delete(client);
      return null;
    }
    return held.principal.userId;
  }

  /** Drop a socket's session, for a close path that wants to be explicit. */
  forget(client: WebSocket): void {
    this.sessions.delete(client);
  }
}
