import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createAuth } from '../src/auth/better-auth.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * D-152/D-156/D-238 — the AGPL core has no billing surface.
 *
 * Billing, the included models, calls and the cloud's admin and Stripe
 * plugins live in `ee/` and are added by `CloudAppModule`. The core's
 * `AppModule` must carry none of them: the routes must not exist at all, not
 * exist and refuse. The presence they are measured against is the Enterprise
 * suite `ee/billing.integration.test.ts`, which boots the cloud root with
 * Stripe configured and gets 200s from the same paths.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

describe('D-238 — the core builds neither the admin nor the Stripe plugin', () => {
  it('builds a self-hosted instance without either', () => {
    const selfhosted = createAuth('selfhosted');
    expect('listUsers' in selfhosted.api).toBe(false);
    expect('stripeWebhook' in selfhosted.api).toBe(false);
  });

  it('builds a cloud instance without either when nothing registered them', () => {
    const cloud = createAuth('cloud');
    expect('listUsers' in cloud.api).toBe(false);
    expect('stripeWebhook' in cloud.api).toBe(false);
  });
});

let app: INestApplication;
let prisma: PrismaService;
let actor: SignedInUser;

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'D-238 — the core application has no billing routes',
  () => {
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication({ rawBody: true });
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();
      prisma = app.get(PrismaService);
      actor = await signIn(prisma, { label: `d156_absent_${RUN_ID}` });
    });

    afterAll(async () => {
      if (prisma !== undefined && actor !== undefined) {
        await signOutAndDelete(prisma, actor.userId);
      }
      await app?.close();
    });

    it('answers 404 on every billing route, for a signed-in caller', async () => {
      const server = app.getHttpServer();
      await request(server).get('/api/v1/billing').set(actor.headers).expect(404);
      await request(server)
        .post('/api/v1/billing/checkout')
        .set(actor.headers)
        .send({ plan: 'starter' })
        .expect(404);
      await request(server).post('/api/v1/billing/portal').set(actor.headers).expect(404);
    });

    it('has no call routes either (D-222)', async () => {
      const server = app.getHttpServer();
      await request(server).get('/api/v1/calls/allowance').set(actor.headers).expect(404);
      await request(server)
        .patch('/api/v1/calls/clxcall0000000000000001a')
        .set(actor.headers)
        .send({ ended: true })
        .expect(404);
    });

    it('gives no account the included models (D-157)', async () => {
      await request(app.getHttpServer()).get('/api/v1/models').set(actor.headers).expect(200);
      expect(
        await prisma.providerConnection.count({ where: { userId: actor.userId, kind: 'CREWAID' } }),
      ).toBe(0);
    });

    it('has no Stripe webhook to post to', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/stripe/webhook')
        .set('Content-Type', 'application/json')
        .send('{}')
        .expect(404);
    });
  },
);
