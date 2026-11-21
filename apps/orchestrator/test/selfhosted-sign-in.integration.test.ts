import { randomBytes, randomUUID } from 'node:crypto';
import { base64Url } from '@better-auth/utils/base64';
import { generateCodeChallenge } from 'better-auth/oauth2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESKTOP_AUTH_CLIENT_ID, desktopAuthOrigin } from '@crewaid/shared';
import { auth as cloudAuth, createAuth } from '../src/auth/better-auth.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * D-152 — a self-hosted server signs in with email and password, through the
 * same desktop code handoff as the hosted one.
 *
 * The handoff itself is `desktop-sign-in.integration.test.ts`'s subject. What
 * is new here is that a PASSWORD sign-in and sign-up mint the code at all —
 * the electron plugin's after-hook decides that by path, and nothing in this
 * repo asserted it for `/sign-in/email` and `/sign-up/email` — and that each
 * edition offers exactly its own methods and trusts exactly its own app.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

const selfHosted = createAuth('selfhosted');
const BASE_PATH = selfHosted.options.basePath;
const ORIGIN = new URL(process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000').origin;
const REDIRECT_COOKIE = `better-auth.${DESKTOP_AUTH_CLIENT_ID}`;
const PASSWORD = 'correct horse battery staple';

let prisma: PrismaService;
const createdEmails: string[] = [];

type Pkce = { readonly state: string; readonly verifier: string; readonly challenge: string };
type Instance = { readonly handler: (request: Request) => Promise<Response> };

async function newPkce(): Promise<Pkce> {
  const verifier = base64Url.encode(randomBytes(32), { padding: false });
  return { state: randomUUID(), verifier, challenge: await generateCodeChallenge(verifier) };
}

function newEmail(): string {
  const email = `d152_${RUN_ID}_${randomUUID().slice(0, 8)}@test.invalid`;
  createdEmails.push(email);
  return email;
}

function signInUrl(path: string, pkce: Pkce): string {
  const url = new URL(`${ORIGIN}${BASE_PATH}${path}`);
  url.searchParams.set('client_id', DESKTOP_AUTH_CLIENT_ID);
  url.searchParams.set('state', pkce.state);
  url.searchParams.set('code_challenge', pkce.challenge);
  return url.toString();
}

/** POST from the sign-in page, as the browser sends it. */
function postFromPage(
  instance: Instance,
  path: string,
  pkce: Pkce,
  body: Record<string, unknown>,
): Promise<Response> {
  return instance.handler(
    new Request(signInUrl(path, pkce), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  );
}

/** The code the page would bounce to the app, read from the cookie the response set. */
function codeFrom(response: Response): { identifier: string; state: string } | undefined {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    if (!pair.startsWith(`${REDIRECT_COOKIE}=`)) continue;
    const value = pair.slice(REDIRECT_COOKIE.length + 1);
    return JSON.parse(new TextDecoder().decode(base64Url.decode(decodeURIComponent(value)))) as {
      identifier: string;
      state: string;
    };
  }
  return undefined;
}

/**
 * Spend a code as the Electron main process does. With a cookie, so Better
 * Auth's origin check actually runs (it skips cookieless requests) — the
 * branch a second sign-in on the same machine takes.
 */
function exchange(code: { identifier: string; state: string }, pkce: Pkce, origin: string) {
  return selfHosted.handler(
    new Request(`${ORIGIN}${BASE_PATH}/electron/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie: 'better-auth.session_token=stale-value-from-a-previous-sign-in',
      },
      body: JSON.stringify({
        token: code.identifier,
        state: code.state,
        code_verifier: pkce.verifier,
      }),
    }),
  );
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'D-152 — self-hosted sign-in is email and password, handed to the desktop as a code',
  () => {
    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
    });

    afterAll(async () => {
      if (prisma !== undefined) {
        if (createdEmails.length > 0) {
          await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
        }
        await prisma.$disconnect();
      }
    });

    it('signs up with a password and hands the desktop a code it can spend', async () => {
      const pkce = await newPkce();
      const email = newEmail();

      const signedUp = await postFromPage(selfHosted, '/sign-up/email', pkce, {
        name: 'Ada',
        email,
        password: PASSWORD,
      });
      expect(signedUp.status).toBe(200);
      const code = codeFrom(signedUp);
      expect(code, `sign-up set no ${REDIRECT_COOKIE} cookie`).toBeDefined();

      const response = await exchange(code!, pkce, desktopAuthOrigin('selfhosted'));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { token: string; user: { email: string } };
      expect(body.user.email).toBe(email);
      const session = await prisma.session.findUnique({ where: { token: body.token } });
      expect(session).not.toBeNull();
    });

    it('signs back in with the password, and refuses a wrong one without minting a code', async () => {
      const email = newEmail();
      const first = await newPkce();
      expect(
        (
          await postFromPage(selfHosted, '/sign-up/email', first, {
            name: 'Ada',
            email,
            password: PASSWORD,
          })
        ).status,
      ).toBe(200);

      const wrong = await newPkce();
      const refused = await postFromPage(selfHosted, '/sign-in/email', wrong, {
        email,
        password: 'not the password',
      });
      expect(refused.status).toBe(401);
      expect(codeFrom(refused)).toBeUndefined();

      const again = await newPkce();
      const signedIn = await postFromPage(selfHosted, '/sign-in/email', again, {
        email,
        password: PASSWORD,
      });
      expect(signedIn.status).toBe(200);
      const code = codeFrom(signedIn);
      expect(code).toBeDefined();
      expect((await exchange(code!, again, desktopAuthOrigin('selfhosted'))).status).toBe(200);
    });

    it('trusts the self-hosted app as an origin and not the cloud one', async () => {
      // THE CASE THAT FAILS IF `trustedOrigins` stops following the edition.
      // A self-hosted server that trusted `crewaid:/` would accept exchanges
      // from the cloud app, which never started this sign-in.
      const pkce = await newPkce();
      const signedUp = await postFromPage(selfHosted, '/sign-up/email', pkce, {
        name: 'Ada',
        email: newEmail(),
        password: PASSWORD,
      });
      const code = codeFrom(signedUp);
      expect(code).toBeDefined();

      expect((await exchange(code!, pkce, desktopAuthOrigin('cloud'))).status).toBe(403);
      expect((await exchange(code!, pkce, desktopAuthOrigin('selfhosted'))).status).toBe(200);
    });

    it('offers no magic link and no social sign-in, even when their settings are present', async () => {
      // The suite's environment configures neither, so this pins the routes'
      // absence; that the settings are IGNORED when present is the
      // `signInMethods` branch, which returns before reading them into config.
      const pkce = await newPkce();
      const magic = await postFromPage(selfHosted, '/sign-in/magic-link', pkce, {
        email: newEmail(),
      });
      expect(magic.status).toBe(404);

      const social = await postFromPage(selfHosted, '/sign-in/social', pkce, {
        provider: 'google',
      });
      expect(social.status).not.toBe(200);
    });

    it('leaves the hosted server without passwords', async () => {
      // The other half of the edition split: `cloudAuth` is the process's own
      // instance, booted as `cloud` by the suite's environment.
      const pkce = await newPkce();
      const signUp = await postFromPage(cloudAuth, '/sign-up/email', pkce, {
        name: 'Ada',
        email: newEmail(),
        password: PASSWORD,
      });
      expect(signUp.status).toBe(400);
      expect(codeFrom(signUp)).toBeUndefined();
    });
  },
);

/**
 * Where a self-hosted server is reached decides whether its cookies can be
 * `Secure`, not `NODE_ENV`. The orchestrator image runs as production, and a
 * home or office install is often plain http on a LAN address — where a browser
 * silently drops a `Secure` cookie, so the desktop's one-time code (handed over
 * in a cookie that inherits the session cookie's attributes) never reaches the
 * page and sign-in fails after a successful sign-up.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'D-152 — a self-hosted server sets Secure cookies only when it is served over https',
  () => {
    const saved = { url: process.env['BETTER_AUTH_URL'], env: process.env['NODE_ENV'] };

    afterAll(async () => {
      if (createdEmails.length > 0) {
        const cleanup = new PrismaService();
        await cleanup.$connect();
        await cleanup.user.deleteMany({ where: { email: { in: createdEmails } } });
        await cleanup.$disconnect();
      }
    });

    /** A production self-hosted instance at `base`, and the handoff cookie a sign-up sets there. */
    async function handoffCookieAt(base: string): Promise<string | undefined> {
      process.env['BETTER_AUTH_URL'] = base;
      process.env['NODE_ENV'] = 'production';
      let instance: Instance;
      try {
        instance = createAuth('selfhosted');
      } finally {
        process.env['BETTER_AUTH_URL'] = saved.url;
        process.env['NODE_ENV'] = saved.env;
      }
      const pkce = await newPkce();
      const url = new URL(`${base}${BASE_PATH}/sign-up/email`);
      url.searchParams.set('client_id', DESKTOP_AUTH_CLIENT_ID);
      url.searchParams.set('state', pkce.state);
      url.searchParams.set('code_challenge', pkce.challenge);
      const response = await instance.handler(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: base },
          body: JSON.stringify({ name: 'Ada', email: newEmail(), password: PASSWORD }),
        }),
      );
      expect(response.status).toBe(200);
      return response.headers.getSetCookie().find((raw) => raw.startsWith(`${REDIRECT_COOKIE}=`));
    }

    it('hands the code over in a cookie a browser keeps on a plain-http LAN address', async () => {
      const cookie = await handoffCookieAt('http://192.168.1.20:3000');
      expect(cookie, 'no handoff cookie was set').toBeDefined();
      expect(cookie).not.toMatch(/;\s*secure/i);
    });

    it('keeps the hosted server Secure in production, whatever its URL says', () => {
      // The hosted service is https; a misconfigured http URL must not quietly
      // downgrade its session cookies.
      process.env['BETTER_AUTH_URL'] = 'http://api.crewaid.example';
      process.env['NODE_ENV'] = 'production';
      try {
        expect(createAuth('cloud').options.advanced?.useSecureCookies).toBe(true);
      } finally {
        process.env['BETTER_AUTH_URL'] = saved.url;
        process.env['NODE_ENV'] = saved.env;
      }
    });

    it('still marks it Secure when the server is served over https', async () => {
      const cookie = await handoffCookieAt('https://crewaid.home.example');
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/;\s*secure/i);
    });
  },
);
