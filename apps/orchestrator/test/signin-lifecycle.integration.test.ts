import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth } from '../src/auth/better-auth.js';
import { setMagicLinkSender } from '../src/auth/magic-link-email.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

vi.hoisted(() => {
  vi.stubEnv('RESEND_API_KEY', 'test-local-delivery');
  vi.stubEnv('MAGIC_LINK_FROM', 'login@test.invalid');
});

/**
 * V1-15 — what happens to a sign-in after it has happened.
 *
 * ── WHY REPLAY IS FIRST ─────────────────────────────────────────────────────
 *
 * A magic link that works twice is a shareable password. It is also the
 * failure that looks most like success when tested by hand: you click the
 * link, you are signed in, everything works. The second click is the one
 * nobody performs, and it is the whole of the difference between a
 * one-time credential and a permanent one sitting in an inbox — forwardable,
 * synced to other devices, indexed by the mail provider.
 *
 * ── WHAT EXPIRY IS TESTED AGAINST ───────────────────────────────────────────
 *
 * Not the clock. A test that waited five minutes would be five minutes of CI
 * for one boolean, and a test that mocked `Date` would prove the mock works.
 * The row's own `expiresAt` is moved into the past instead, which is the state
 * the server will actually be in — and the check under test is the one that
 * reads that column.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let app: INestApplication;
let prisma: PrismaService;

const BASE_PATH = auth.options.basePath;
const ORIGIN = new URL(process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000').origin;
const createdEmails: string[] = [];

type Jar = Map<string, string>;

function absorb(jar: Jar, response: Response): void {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (value === '' || /max-age=0\b/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Ask for a magic link and hand back the URL that was "emailed". */
async function requestMagicLink(): Promise<{ url: string; email: string; jar: Jar }> {
  const jar: Jar = new Map();
  const email = `v115_${RUN_ID}_${randomUUID().slice(0, 8)}@test.invalid`;
  createdEmails.push(email);

  let delivered: string | undefined;
  setMagicLinkSender({
    send: ({ url }) => {
      delivered = url;
      return Promise.resolve();
    },
  });

  const response = await auth.handler(
    new Request(`${ORIGIN}${BASE_PATH}/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, callbackURL: `${ORIGIN}/` }),
    }),
  );
  expect(response.status).toBe(200);
  absorb(jar, response);
  expect(delivered, 'no magic link was sent').toBeTypeOf('string');
  return { url: delivered as string, email, jar };
}

function follow(url: string, jar: Jar): Promise<Response> {
  return auth.handler(new Request(url, { headers: { cookie: cookieHeader(jar) } }));
}

/** The session token a completed sign-in leaves in the cookie jar. */
function sessionTokenOf(jar: Jar): string | undefined {
  for (const [name, value] of jar) {
    if (name.endsWith('session_token')) return decodeURIComponent(value).split('.')[0];
  }
  return undefined;
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'V1-15 — the sign-in lifecycle',
  () => {
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();
      prisma = app.get(PrismaService);
    });

    afterEach(() => {
      setMagicLinkSender(undefined);
    });

    afterAll(async () => {
      if (prisma !== undefined && createdEmails.length > 0) {
        await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
      }
      await app?.close();
    });

    it('refuses a magic link the second time it is followed', async () => {
      // THE ONE THE NOTE ASKS FOR FIRST. The first click is the control — a
      // link that never worked would "fail on replay" just as convincingly.
      const { url, jar, email } = await requestMagicLink();

      const token = new URL(url).searchParams.get('token');
      expect(token).toBeTruthy();
      const verification = await prisma.verification.findFirstOrThrow({
        where: { value: { contains: email } },
      });
      expect(verification.identifier).not.toContain(token!);
      expect(verification.value).not.toContain(token!);

      const first = await follow(url, jar);
      absorb(jar, first);
      expect(sessionTokenOf(jar), 'the first click did not sign anybody in').toBeTypeOf('string');

      const sessionsAfterFirst = await prisma.session.count({
        where: { user: { email } },
      });
      expect(sessionsAfterFirst).toBe(1);

      // Second click, same link, from a browser that never saw the first.
      const replayed = await follow(url, new Map());
      expect(replayed.headers.getSetCookie().join(';')).not.toMatch(/session_token=[^;]/);

      // And no second session was minted — the assertion that survives a
      // redirect-shaped answer, because a 302 to an error page and a 302 to a
      // success page look the same from the status code alone.
      expect(await prisma.session.count({ where: { user: { email } } })).toBe(1);

      // ── THE CONTROL FOR THE CONTROL ────────────────────────────────────────
      //
      // The replay above was followed with an EMPTY cookie jar, so "refused"
      // could mean "the token was spent" or it could mean "this browser had no
      // cookies". A fresh link through the same empty-jar path settles it: if
      // that signs somebody in, the jar was never what refused the replay.
      const fresh = await requestMagicLink();
      const cold = await follow(fresh.url, new Map());
      const coldJar: Jar = new Map();
      absorb(coldJar, cold);
      expect(sessionTokenOf(coldJar), 'a cold browser cannot follow a link at all').toBeTypeOf(
        'string',
      );
    });

    it('refuses a magic link once its own row says it has expired', async () => {
      const { url, jar, email } = await requestMagicLink();

      // Aged in the database rather than waited out. `magicLink({ expiresIn:
      // 60 * 5 })` is the policy; this is the state the server is in once it
      // has elapsed.
      const aged = await prisma.verification.updateMany({
        where: { expiresAt: { gt: new Date() } },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      expect(aged.count).toBeGreaterThan(0);

      const response = await follow(url, jar);
      expect(response.headers.getSetCookie().join(';')).not.toMatch(/session_token=[^;]/);
      expect(await prisma.session.count({ where: { user: { email } } })).toBe(0);
    });

    it('gives a magic link five minutes, not the default hour', async () => {
      // THE POLICY, not the mechanism. The case above ages a row and proves
      // the EXPIRY CHECK works; it would pass just as well with
      // `expiresIn` left at Better Auth's default of an hour. This is what
      // `magicLink({ expiresIn: 60 * 5 })` actually buys, and it is a config
      // line somebody could relax without any test noticing.
      //
      // A link is a bearer credential sitting in an inbox: forwardable, often
      // synced to another device, indexed by the mail provider. The default
      // hour is an hour in which a forwarded thread is an account takeover.
      const before = Date.now();
      await requestMagicLink();
      const row = await prisma.verification.findFirstOrThrow({
        orderBy: { createdAt: 'desc' },
      });

      const lifetimeMs = row.expiresAt.getTime() - before;
      expect(lifetimeMs).toBeGreaterThan(4 * 60_000);
      expect(lifetimeMs).toBeLessThanOrEqual(6 * 60_000);
    });

    it('gives a session a week, so a desktop is not signed out mid-week', async () => {
      // The other half of the same argument, pointing the opposite way.
      // Revocation — not expiry — is what ends a compromised session, and
      // V1-09 makes it bite at the next frame; a short absolute expiry would
      // sign people out for no security gain.
      const { url, jar } = await requestMagicLink();
      const before = Date.now();
      absorb(jar, await follow(url, jar));
      const token = sessionTokenOf(jar) as string;

      const session = await prisma.session.findUniqueOrThrow({ where: { token } });
      const lifetimeDays = (session.expiresAt.getTime() - before) / 86_400_000;
      expect(lifetimeDays).toBeGreaterThan(6);
      expect(lifetimeDays).toBeLessThanOrEqual(8);
    });

    it('ends access the moment the session row is revoked', async () => {
      const { url, jar } = await requestMagicLink();
      absorb(jar, await follow(url, jar));
      const token = sessionTokenOf(jar);
      expect(token).toBeTypeOf('string');

      const server = request(app.getHttpServer());
      await server
        .get('/api/v1/models')
        .set('Authorization', `Bearer ${token as string}`)
        .expect(200);

      await prisma.session.deleteMany({ where: { token: token as string } });

      // No restart, no cache to expire: the guard reads the row per request.
      await server
        .get('/api/v1/models')
        .set('Authorization', `Bearer ${token as string}`)
        .expect(401);
    });

    it('survives a desktop restart, because the session is a row and not a process', async () => {
      // "Restart" is the honest shape of it: nothing in the orchestrator knows
      // the client went away, and the same token presented by a brand-new
      // connection has to keep working — otherwise closing a laptop would sign
      // people out.
      const { url, jar } = await requestMagicLink();
      absorb(jar, await follow(url, jar));
      const token = sessionTokenOf(jar) as string;

      for (const attempt of [1, 2, 3]) {
        // A fresh supertest agent each time: no keep-alive, no shared state,
        // which is as close to a relaunched app as this process can get.
        await request(app.getHttpServer())
          .get('/api/v1/models')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(attempt).toBeGreaterThan(0);
      }
    });

    it('keeps two accounts apart on one orchestrator, and revokes one without the other', async () => {
      // ACCOUNT SWITCHING, which on a shared install is two people rather than
      // one person twice — and the orchestrator cannot tell the difference, so
      // it must not try.
      const first = await requestMagicLink();
      absorb(first.jar, await follow(first.url, first.jar));
      const firstToken = sessionTokenOf(first.jar) as string;

      const second = await requestMagicLink();
      absorb(second.jar, await follow(second.url, second.jar));
      const secondToken = sessionTokenOf(second.jar) as string;

      expect(firstToken).not.toBe(secondToken);

      const whoIs = async (token: string): Promise<string> => {
        const session = await auth.api.getSession({
          headers: new Headers({ authorization: `Bearer ${token}` }),
        });
        return session?.user.email ?? '';
      };
      expect(await whoIs(firstToken)).toBe(first.email);
      expect(await whoIs(secondToken)).toBe(second.email);

      await prisma.session.deleteMany({ where: { token: firstToken } });

      expect(await whoIs(firstToken)).toBe('');
      // The control: revoking one session is not a global sign-out.
      expect(await whoIs(secondToken)).toBe(second.email);
    });

    it('signs out at the server, so the token stops working everywhere', async () => {
      // The desktop's Sign out posts this with its bearer. Clearing the local
      // copy alone would leave a live row that anything holding a copy could
      // still spend — which is the one thing "sign out" is for.
      const { url, jar } = await requestMagicLink();
      absorb(jar, await follow(url, jar));
      const token = sessionTokenOf(jar) as string;

      const response = await auth.handler(
        new Request(`${ORIGIN}${BASE_PATH}/sign-out`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: '{}',
        }),
      );
      expect(response.status).toBe(200);

      expect(await prisma.session.count({ where: { token } })).toBe(0);
      await request(app.getHttpServer())
        .get('/api/v1/models')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  },
);
