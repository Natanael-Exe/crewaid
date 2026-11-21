import { randomBytes, randomUUID } from 'node:crypto';
import { base64Url } from '@better-auth/utils/base64';
import { generateCodeChallenge } from 'better-auth/oauth2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DESKTOP_AUTH_CLIENT_ID, desktopAuthOrigin } from '@crewaid/shared';
import { auth } from '../src/auth/better-auth.js';
import { setMagicLinkSender } from '../src/auth/magic-link-email.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

vi.hoisted(() => {
  vi.stubEnv('RESEND_API_KEY', 'test-local-delivery');
  vi.stubEnv('MAGIC_LINK_FROM', 'login@test.invalid');
});

/**
 * V1-11 — the browser hands back a code, and only a code (D-088).
 *
 * ── WHAT IS ACTUALLY BEING PROVED ───────────────────────────────────────────
 *
 * A native app cannot hold the session an identity provider creates: the
 * provider redirects a BROWSER, and the cookie lands there. So the flow has to
 * carry something back across that gap, and the entire security of V1-11 is
 * the claim that what crosses is worth nothing on its own.
 *
 * These cases hold it to that. The code is minted in a browser, spent from
 * somewhere else entirely, and every way of spending it wrongly is tried:
 * without the verifier, with the wrong verifier, with someone else's state,
 * twice, and from an origin nobody trusted. Each of those is a shape an
 * attacker holding a stolen callback URL actually has.
 *
 * ── WHY THE MAGIC LINK IS THE VEHICLE ───────────────────────────────────────
 *
 * The transfer works identically for Google, GitHub and a magic link — it
 * hangs off Better Auth's `newSession`, not off which provider produced it.
 * The magic link is the only one of the three a test can drive end to end
 * without an identity provider on the network, and `magic-link-email.ts`
 * already has the seam (`setMagicLinkSender`) to read the link instead of
 * delivering it.
 *
 * V1-15 owns the lifecycle suite — link replay, revocation, restart. This is
 * narrower on purpose: it is about the EXCHANGE that V1-11 adds.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

const BASE_PATH = auth.options.basePath;
const DESKTOP_AUTH_ORIGIN = desktopAuthOrigin('cloud');
const ORIGIN = new URL(process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000').origin;
const SIGN_IN_PAGE = `${ORIGIN}${BASE_PATH}/electron/sign-in`;
const REDIRECT_COOKIE = `better-auth.${DESKTOP_AUTH_CLIENT_ID}`;

let prisma: PrismaService;
const createdEmails: string[] = [];

/** The cookies a browser would be holding, as one header value. */
type Jar = Map<string, string>;

function absorb(jar: Jar, response: Response): void {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    // An expiry in the past is a deletion, and treating it as a value is how a
    // "cleared" cookie keeps working in a test long after it stops working in
    // a browser.
    if (value === '' || /max-age=0\b/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** What the desktop generates before it opens a browser, and keeps to itself. */
type Pkce = { readonly state: string; readonly verifier: string; readonly challenge: string };

async function newPkce(): Promise<Pkce> {
  const verifier = base64Url.encode(randomBytes(32), { padding: false });
  return { state: randomUUID(), verifier, challenge: await generateCodeChallenge(verifier) };
}

function signInUrl(path: string, pkce: Pkce, clientId = DESKTOP_AUTH_CLIENT_ID): string {
  const url = new URL(`${ORIGIN}${BASE_PATH}${path}`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('state', pkce.state);
  url.searchParams.set('code_challenge', pkce.challenge);
  return url.toString();
}

/**
 * Drive a whole browser sign-in and return the code it would bounce.
 *
 * Deliberately a real round trip through `auth.handler`: the code is minted by
 * an after-hook on the verification response, so a fixture that wrote the
 * `verification` row directly would prove the exchange and skip the half that
 * decides WHETHER a code is minted at all.
 */
async function signInThroughBrowser(
  pkce: Pkce,
  options: { readonly clientId?: string } = {},
): Promise<{ readonly identifier: string; readonly state: string; readonly email: string }> {
  const jar: Jar = new Map();
  const email = `v111_${RUN_ID}_${randomUUID().slice(0, 8)}@test.invalid`;
  createdEmails.push(email);

  let delivered: string | undefined;
  setMagicLinkSender({
    send: ({ url }) => {
      delivered = url;
      return Promise.resolve();
    },
  });

  const requested = await auth.handler(
    new Request(signInUrl('/sign-in/magic-link', pkce, options.clientId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, callbackURL: SIGN_IN_PAGE }),
    }),
  );
  expect(requested.status).toBe(200);
  absorb(jar, requested);
  expect(delivered, 'no magic link was sent').toBeTypeOf('string');

  // The person clicks the link in the same browser, which is what carries the
  // transfer cookie set above back to the server.
  const verified = await auth.handler(
    new Request(delivered as string, { headers: { cookie: cookieHeader(jar) } }),
  );
  absorb(jar, verified);

  const blob = jar.get(REDIRECT_COOKIE);
  expect(blob, `no ${REDIRECT_COOKIE} cookie was set`).toBeTypeOf('string');
  const decoded = JSON.parse(
    new TextDecoder().decode(base64Url.decode(decodeURIComponent(blob as string))),
  ) as { identifier: string; state: string };
  return { ...decoded, email };
}

/**
 * Spend a code the way the Electron main process does.
 *
 * `cookie` is not decoration. Better Auth runs its origin check only on
 * requests that carry one (`validateOrigin`: `if (!(forceValidate ||
 * useCookies)) return`), and `@better-auth/electron/client` keeps a jar and
 * sends it — so a FIRST sign-in on a fresh install skips the check and a
 * SECOND one, with the previous session still in the jar, does not. Passing it
 * explicitly is how these cases exercise the branch a real second sign-in
 * takes rather than the one a first sign-in happens to miss.
 */
function exchange(
  body: Record<string, unknown>,
  options: { readonly origin?: string; readonly cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: options.origin ?? DESKTOP_AUTH_ORIGIN,
  };
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  return auth.handler(
    new Request(`${ORIGIN}${BASE_PATH}/electron/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** What the client's jar holds after an earlier sign-in on this machine. */
const STALE_JAR = 'better-auth.session_token=stale-value-from-a-previous-sign-in';

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'V1-11 — a browser sign-in becomes a desktop session',
  () => {
    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
    });

    afterEach(() => {
      setMagicLinkSender(undefined);
    });

    afterAll(async () => {
      if (prisma !== undefined) {
        // By email, because these users are created BY the sign-in rather than
        // by the fixture — the flow under test is the thing that makes them.
        if (createdEmails.length > 0) {
          await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
        }
        await prisma.$disconnect();
      }
    });

    it('exchanges the code for a session token belonging to the signed-in user', async () => {
      const pkce = await newPkce();
      const { identifier, state, email } = await signInThroughBrowser(pkce);

      const response = await exchange({
        token: identifier,
        state,
        code_verifier: pkce.verifier,
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        token: string;
        user: { id: string; email: string };
      };
      expect(body.user.email).toBe(email);

      // The point of the whole flow: what comes back is the credential §4.4
      // already accepts, so nothing downstream changes shape.
      const session = await prisma.session.findUnique({ where: { token: body.token } });
      expect(session?.userId).toBe(body.user.id);
    });

    it('refuses the code without the verifier that was never transmitted', async () => {
      // THE CASE THE WHOLE DESIGN EXISTS FOR. Someone who intercepts the deep
      // link — a rogue app registering the same scheme, a shoulder-surfed
      // URL — holds everything in this request except the verifier, which only
      // ever lived in the main process's memory (RFC 8252 §8.1).
      const pkce = await newPkce();
      const { identifier, state } = await signInThroughBrowser(pkce);
      const other = await newPkce();

      const response = await exchange({ token: identifier, state, code_verifier: other.verifier });
      expect(response.status).toBe(400);
    });

    it('refuses a code spent against a different sign-in attempt', async () => {
      // Two sign-ins in flight. The code from the first, presented with the
      // second's state, must not be spendable: the binding is per attempt, not
      // per user, or two overlapping sign-ins become one interchangeable pair.
      const first = await newPkce();
      const second = await newPkce();
      const { identifier } = await signInThroughBrowser(first);
      await signInThroughBrowser(second);

      const response = await exchange({
        token: identifier,
        state: second.state,
        code_verifier: first.verifier,
      });
      expect(response.status).toBe(400);
    });

    it('refuses the same code a second time', async () => {
      // Single use, and it has to be single use at the SERVER: the desktop
      // clears the cookie, but a cleared cookie is a client-side promise and
      // the code is already out of the browser by then.
      const pkce = await newPkce();
      const { identifier, state } = await signInThroughBrowser(pkce);
      const body = { token: identifier, state, code_verifier: pkce.verifier };

      expect((await exchange(body)).status).toBe(200);
      expect((await exchange(body)).status).toBe(404);
    });

    it('accepts the desktop scheme as an origin, which is the one thing trustedOrigins buys', async () => {
      // THE CASE THAT FAILS IF `trustedOrigins` LOSES THE SCHEME, and it fails
      // only on a re-sign-in — the first one on a fresh install carries no
      // cookie and never reaches the check. That asymmetry is why this is
      // asserted rather than assumed: the bug would ship green.
      const pkce = await newPkce();
      const { identifier, state } = await signInThroughBrowser(pkce);

      const response = await exchange(
        { token: identifier, state, code_verifier: pkce.verifier },
        { cookie: STALE_JAR },
      );
      expect(response.status).toBe(200);
    });

    it('refuses the exchange from an origin nobody trusted', async () => {
      // The other half: the allowlist has to still be an allowlist. A web page
      // that got hold of a code cannot spend it from its own origin.
      const pkce = await newPkce();
      const { identifier, state } = await signInThroughBrowser(pkce);

      const response = await exchange(
        { token: identifier, state, code_verifier: pkce.verifier },
        { origin: 'https://not-crewaid.example', cookie: STALE_JAR },
      );
      expect(response.status).toBe(403);
    });

    it('mints no code for a sign-in that did not come from the desktop', async () => {
      // A plain browser sign-in — someone visiting the orchestrator directly —
      // must not leave an authorization code lying in a cookie. The client id
      // is what separates the two, and it is checked server-side.
      const pkce = await newPkce();
      await expect(signInThroughBrowser(pkce, { clientId: 'some-other-app' })).rejects.toThrow();
    });

    it('serves the sign-in page unauthenticated, and says not to cache it', async () => {
      const response = await auth.handler(new Request(SIGN_IN_PAGE));

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-store');
      // The URL of this page carries the state and the PKCE challenge.
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('leaves the schema alone — the code is a verification row', async () => {
      // The plugin contributes no `schema`, so `@better-auth/cli generate`
      // emits nothing new and no migration is owed. Asserted against the
      // database rather than by reading the plugin, because the failure this
      // guards against is a table that was never created.
      const pkce = await newPkce();
      const { identifier } = await signInThroughBrowser(pkce);

      const row = await prisma.verification.findFirst({
        where: { identifier: `electron:${identifier}` },
      });
      expect(row).not.toBeNull();
      expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  },
);
