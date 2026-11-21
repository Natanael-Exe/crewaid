import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * V1-08 — a session, not a shared secret.
 *
 * These cases go through the real guard chain over real HTTP, because the
 * thing being replaced was never the comparison — it was WHO the comparison
 * resolved to. A unit test of `canActivate` with a hand-built context proves
 * the branch and not the swap: that the principal reaching a handler is the
 * session's own owner, that a second user is a different principal on the same
 * running server, and that revoking one ends access without touching the other
 * are all properties of the wiring.
 *
 * `GET /api/v1/models` is the probe route throughout. It is guarded like
 * everything else, it needs no fixture rows, and V1-06 made its answer
 * owner-scoped — so it reports which user the request resolved to rather than
 * merely whether it was allowed.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let app: INestApplication;
let prisma: PrismaService;
let actor: SignedInUser;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'V1-08 — the orchestrator authenticates a Better Auth session',
  () => {
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      // AppModule carries WsGateway; without the §4.2 adapter SocketModule
      // falls back to socket.io and hard-exits during init.
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();

      prisma = app.get(PrismaService);
      actor = await signIn(prisma, { label: `v108_${RUN_ID}` });
    });

    afterAll(async () => {
      if (prisma !== undefined && actor !== undefined) {
        await signOutAndDelete(prisma, actor.userId);
      }
      await app?.close();
    });

    it('serves a request carrying a live session token', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/models')
        .set(actor.headers)
        .expect(200);

      expect(response.body).toHaveProperty('models');
    });

    it('refuses a request with no credential at all', async () => {
      await request(app.getHttpServer()).get('/api/v1/models').expect(401);
    });

    it('refuses a token that is not a session', async () => {
      // The shape the old guard accepted: a secret from configuration rather
      // than a row. Nothing issued it, so nothing can resolve it to a user.
      await request(app.getHttpServer())
        .get('/api/v1/models')
        .set('Authorization', 'Bearer orch-api-token-style-shared-secret')
        .expect(401);
    });

    it('refuses a well-formed token belonging to no row', async () => {
      // Same shape as a real one, so this separates "looks wrong" from
      // "is not in the database" — a guard that only pattern-matched the
      // token would pass the previous case and fail here.
      const forged = `sess_${randomUUID()}${randomUUID().replace(/-/g, '')}`;
      await request(app.getHttpServer())
        .get('/api/v1/models')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('refuses an expired session, and says nothing different about it', async () => {
      const expiring = await signIn(prisma, { label: `expired_${RUN_ID}` });
      try {
        await prisma.session.updateMany({
          where: { userId: expiring.userId },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });

        await request(app.getHttpServer()).get('/api/v1/models').set(expiring.headers).expect(401);
      } finally {
        await signOutAndDelete(prisma, expiring.userId);
      }
    });

    it('stops serving a session the moment its row is deleted', async () => {
      const revoked = await signIn(prisma, { label: `revoked_${RUN_ID}` });
      try {
        // Asserted against a presence: the same token on the same server
        // answered a moment ago, so the 401 below is the revocation and not a
        // token that never worked.
        await request(app.getHttpServer()).get('/api/v1/models').set(revoked.headers).expect(200);

        await prisma.session.deleteMany({ where: { userId: revoked.userId } });

        await request(app.getHttpServer()).get('/api/v1/models').set(revoked.headers).expect(401);
      } finally {
        await signOutAndDelete(prisma, revoked.userId);
      }
    });

    it('resolves two sessions on one server to two different principals', async () => {
      // THE PROPERTY THE STATIC TOKEN COULD NOT HAVE. ORCH_API_TOKEN made
      // "which user is this" a question with one answer for the whole process.
      const other = await signIn(prisma, { label: `other_${RUN_ID}` });
      try {
        const connection = await prisma.providerConnection.create({
          data: { userId: other.userId, kind: 'OPENAI', name: `other-${RUN_ID}` },
        });
        await prisma.providerModel.create({
          data: {
            connectionId: connection.id,
            upstreamModelId: 'gpt-4o-mini',
            label: `Other's model ${RUN_ID}`,
            contextWindow: 128000,
          },
        });

        const theirs = await request(app.getHttpServer())
          .get('/api/v1/models')
          .set(other.headers)
          .expect(200);
        const mine = await request(app.getHttpServer())
          .get('/api/v1/models')
          .set(actor.headers)
          .expect(200);

        const labels = (body: unknown): string[] =>
          ((body as { models?: Array<{ label?: string }> }).models ?? []).map((m) => m.label ?? '');

        expect(labels(theirs.body)).toContain(`Other's model ${RUN_ID}`);
        expect(labels(mine.body)).not.toContain(`Other's model ${RUN_ID}`);
      } finally {
        await signOutAndDelete(prisma, other.userId);
      }
    });

    it('leaves the sign-in routes reachable without a session', async () => {
      // Signing in cannot require being signed in. Any answer but 401 proves
      // the guard stood aside; Better Auth decides what the answer is.
      const response = await request(app.getHttpServer()).get('/api/v1/auth/session');
      expect(response.status).not.toBe(401);
    });

    it('hands Better Auth the QUERY STRING, not just the path', async () => {
      // Mounting middleware rewrites `req.url` to the un-consumed remainder,
      // and `toNodeHandler` builds the request it answers from `req.url` — so
      // a mount that looks correct can still deliver every request stripped of
      // its query. That breaks exactly one thing: OAuth. `get-session` takes
      // no parameters and answers 200 either way, which is why mounting alone
      // is not enough to assert.
      //
      // The callback reads `state` from the query and redirects to
      // `error=state_not_found` when it is absent. Sending one and still being
      // told it is missing is the signature of a dropped query string.
      const response = await request(app.getHttpServer()).get(
        '/api/v1/auth/callback/google?state=probe-state&code=probe-code',
      );

      expect(response.status).toBe(302);
      expect(response.headers['location']).not.toContain('state_not_found');
    });

    it('actually MOUNTS the Better Auth route tree', async () => {
      // `status !== 401` above is satisfied by a 404, and for the whole of
      // V1 that is what it was passing on: `setGlobalPrefix` rewrites
      // middleware paths too, so a `forRoutes` path that spelled the prefix
      // out bound the tree at `/api/v1/api/v1/auth/*` and every sign-in route
      // answered Nest's 404. The middleware never ran, so nothing logged an
      // error either.
      //
      // These assert a BETTER AUTH answer rather than the absence of a
      // particular failure. `/ok` is the library's own liveness route and
      // `get-session` returns 200 with a null body for a caller it does not
      // recognise — an answer no unmounted route can produce.
      const ok = await request(app.getHttpServer()).get('/api/v1/auth/ok');
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true });

      const session = await request(app.getHttpServer()).get('/api/v1/auth/get-session');
      expect(session.status).toBe(200);
      expect(session.body).toBeNull();
    });

    it('keeps GET /health exempt', async () => {
      // `/health` and not `/api/v1/health`: this bootstrap mirrors production
      // and excludes it from the global prefix, so the prefixed form is a 404
      // rather than an unauthenticated 200 — which is why the guard answers
      // for both spellings but only one is reachable here.
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  },
);
