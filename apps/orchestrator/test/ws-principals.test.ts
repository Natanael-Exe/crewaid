import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

/**
 * Importing `WsPrincipals` reaches `better-auth.ts`, which builds a Prisma
 * client at module scope and throws without `DATABASE_URL`. Nothing here
 * connects: every case below is decided before any session lookup, which is
 * precisely what is being tested.
 */
process.env['DATABASE_URL'] ??= 'postgresql://unused:unused@127.0.0.1:1/never-connected';

/**
 * V1-09 — the decisions `WsPrincipals` makes WITHOUT reading the database.
 *
 * `ws-session.integration.test.ts` drives real sockets and covers revocation,
 * which needs a row to delete. These are the two rules that never reach the
 * database at all, and they are the ones a live-socket suite cannot isolate:
 *
 * 1. EXPIRY is a timestamp, so it is enforced in memory on every frame. A
 *    falsification pass showed this was unproven — removing the check broke
 *    nothing, because the integration case for an expired session is refused
 *    by the HANDSHAKE and never reaches this class. That gap is what this
 *    suite exists for.
 * 2. The revalidation WINDOW is what makes `screen.input` affordable: inside
 *    it the answer is reused, and a case that could not tell reuse from a
 *    fresh read would not be testing the thing that costs the queries.
 *
 * Both run with no Postgres, so they also hold on the checkouts where the
 * integration suite silently skips.
 */
describe('WsPrincipals (V1-09, no database)', () => {
  const TOKEN = 'sess_unit_token';
  const OWNER = 'usr_ws_principals_owner';

  /** A stand-in socket: nothing here sends, it is only a map key. */
  function socket(): WebSocket {
    return {} as WebSocket;
  }

  async function subject(): Promise<{
    principals: InstanceType<typeof import('../src/ws/ws-principals.js').WsPrincipals>;
    setNow: (ms: number) => void;
  }> {
    const { WsPrincipals } = await import('../src/ws/ws-principals.js');
    const principals = new WsPrincipals();
    let now = 1_000_000;
    principals.useClockForTests(() => now);
    return { principals, setNow: (ms) => void (now = ms) };
  }

  it('answers with the principal the handshake proved', async () => {
    const { principals } = await subject();
    const client = socket();
    principals.register(client, OWNER, TOKEN, new Date(2_000_000));

    await expect(principals.principalFor(client)).resolves.toEqual({
      userId: OWNER,
      scopes: ['*'],
    });
  });

  it('refuses a socket it never admitted', async () => {
    const { principals } = await subject();
    // No fallback to a default user: there is no such thing now, and a
    // fallback here would be the one place an unauthenticated socket acted.
    await expect(principals.principalFor(socket())).resolves.toBeNull();
  });

  it('refuses the moment the session expires, without reading anything', async () => {
    const { principals, setNow } = await subject();
    const client = socket();
    principals.register(client, OWNER, TOKEN, new Date(1_000_500));

    // Asserted against a presence: the same socket answers a moment earlier,
    // so what is measured is the expiry rather than a registration that never
    // worked.
    await expect(principals.principalFor(client)).resolves.not.toBeNull();

    setNow(1_000_500);
    // Exactly at the boundary. An expiry that is `<` rather than `<=` keeps a
    // session alive for the millisecond it was supposed to end on, which is a
    // difference nobody notices until it is the rule being relied on.
    await expect(principals.principalFor(client)).resolves.toBeNull();

    // A DB-free path throughout: if this reached `getSession` the placeholder
    // DATABASE_URL above would fail the call, and these would not resolve.
  });

  it('stays expired once expired, even when asked again', async () => {
    const { principals, setNow } = await subject();
    const client = socket();
    principals.register(client, OWNER, TOKEN, new Date(1_000_500));
    setNow(1_001_000);

    await expect(principals.principalFor(client)).resolves.toBeNull();
    // The entry is dropped on the first refusal, so the second answer comes
    // from "unknown socket" rather than from the expiry check. Same verdict,
    // and the point is that nothing reinstates it.
    await expect(principals.principalFor(client)).resolves.toBeNull();
  });

  it('reuses the answer inside the revalidation window', async () => {
    const { principals, setNow } = await subject();
    const client = socket();
    principals.register(client, OWNER, TOKEN, new Date(9_000_000));

    // The window is what makes `screen.input` affordable. Reaching the
    // database here would throw on the placeholder URL, so a resolved
    // principal IS the evidence that no read happened.
    setNow(1_000_999);
    await expect(principals.principalFor(client)).resolves.toEqual({
      userId: OWNER,
      scopes: ['*'],
    });
  });

  it('forgets a socket on request', async () => {
    const { principals } = await subject();
    const client = socket();
    principals.register(client, OWNER, TOKEN, new Date(9_000_000));
    await expect(principals.principalFor(client)).resolves.not.toBeNull();

    principals.forget(client);
    await expect(principals.principalFor(client)).resolves.toBeNull();
  });

  it('rides out a session store it cannot read for a blip, not for an outage', async () => {
    const { auth } = await import('../src/auth/better-auth.js');
    const { FAIL_OPEN_GRACE_MS } = await import('../src/ws/ws-principals.js');
    const unreadable = vi
      .spyOn(auth.api, 'getSession')
      .mockRejectedValue(new Error('database unreachable'));
    try {
      const { principals, setNow } = await subject();
      const client = socket();
      principals.register(client, OWNER, TOKEN, new Date(9_000_000_000));

      setNow(1_000_000 + FAIL_OPEN_GRACE_MS);
      await expect(principals.principalFor(client, { fresh: true })).resolves.toEqual({
        userId: OWNER,
        scopes: ['*'],
      });
      expect(unreadable).toHaveBeenCalled();

      setNow(1_000_000 + FAIL_OPEN_GRACE_MS + 1);
      await expect(principals.principalFor(client, { fresh: true })).resolves.toBeNull();
      // ...and stays refused once the store answers again: nothing reinstates it.
      unreadable.mockRestore();
      await expect(principals.principalFor(client)).resolves.toBeNull();
    } finally {
      unreadable.mockRestore();
    }
  });
});
