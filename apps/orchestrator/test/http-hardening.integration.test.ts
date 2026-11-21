import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { holdsNul } from '../src/common/http-hardening.middleware.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { FakeProvider } from './sandbox-fakes.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe('holdsNul', () => {
  it('finds U+0000 in any string or key, however deep, and nothing else', () => {
    expect(holdsNul({ a: ['x', { b: 'y\u0000' }] })).toBe(true);
    expect(holdsNul({ ['k\u0000']: 1 })).toBe(true);
    expect(holdsNul({ a: ['x', { b: 'y' }], n: 1, t: true, z: null })).toBe(false);
    expect(holdsNul(undefined)).toBe(false);
    // Deeper than any call stack: the walk is iterative.
    let deep: unknown = 'end\u0000';
    for (let depth = 0; depth < 200_000; depth += 1) deep = [deep];
    expect(holdsNul(deep)).toBe(true);
  });
});

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'HTTP hardening (booted app)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let actor: SignedInUser;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const { PrismaService: PrismaServiceClass } = await import('../src/prisma/prisma.service.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();
      prisma = app.get(PrismaServiceClass);
      actor = await signIn(prisma, { label: 'hardening' });
    });

    afterAll(async () => {
      if (prisma !== undefined && actor !== undefined) {
        await signOutAndDelete(prisma, actor.userId).catch(() => undefined);
      }
      await app?.close();
    });

    it('sends the hardening headers and does not name its framework', async () => {
      for (const res of [
        await request(app.getHttpServer()).get('/api/v1/bots').set(actor.headers),
        await request(app.getHttpServer()).get('/api/v1/bots'),
        await request(app.getHttpServer()).get('/health'),
      ]) {
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['x-powered-by']).toBeUndefined();
      }
    });

    it('refuses a NUL in the path, the query or a JSON body as a bad request, not a 500', async () => {
      // Presence first: the same routes answer normally without one.
      expect(
        (await request(app.getHttpServer()).get('/api/v1/bots').set(actor.headers)).status,
      ).toBe(200);

      const path = await request(app.getHttpServer()).get('/api/v1/bots/a%00b').set(actor.headers);
      expect(path.status).toBe(400);
      const query = await request(app.getHttpServer())
        .get('/api/v1/search?q=a%00b')
        .set(actor.headers);
      expect(query.status).toBe(400);
      const body = await request(app.getHttpServer())
        .post('/api/v1/bots')
        .set(actor.headers)
        .send({ name: 'Nul\u0000', role: 'R', avatarColor: '#123456', systemPrompt: 'x' });
      expect(body.status).toBe(400);
      expect(await prisma.bot.count({ where: { userId: actor.userId } })).toBe(0);
    });

    it('takes a write on a session cookie only from this server’s own origin', async () => {
      // The cookie a browser holds after signing in, signed the way Better
      // Auth signs it, so the guard resolves the same session the bearer does.
      const secret = process.env['BETTER_AUTH_SECRET'] ?? '';
      const signature = createHmac('sha256', secret).update(actor.token).digest('base64');
      const cookie = `better-auth.session_token=${encodeURIComponent(`${actor.token}.${signature}`)}`;
      const ownOrigin = new URL(process.env['BETTER_AUTH_URL'] ?? '').origin;
      const bot = (name: string) => ({
        name,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });

      // A read on the cookie still works: this is about writes a page could forge.
      expect(
        (await request(app.getHttpServer()).get('/api/v1/bots').set('Cookie', cookie)).status,
      ).toBe(200);

      for (const origin of [undefined, 'http://evil.test', 'null']) {
        const forged = request(app.getHttpServer()).post('/api/v1/bots').set('Cookie', cookie);
        if (origin !== undefined) forged.set('Origin', origin);
        expect((await forged.send(bot('forged'))).status).toBe(403);
      }
      expect(await prisma.bot.count({ where: { userId: actor.userId, name: 'forged' } })).toBe(0);

      const own = await request(app.getHttpServer())
        .post('/api/v1/bots')
        .set('Cookie', cookie)
        .set('Origin', ownOrigin)
        .send(bot('own-origin'));
      expect(own.status).toBe(201);
      const bearer = await request(app.getHttpServer())
        .post('/api/v1/bots')
        .set(actor.headers)
        .set('Origin', 'http://evil.test')
        .send(bot('bearer'));
      expect(bearer.status).toBe(201);
      await prisma.bot.deleteMany({ where: { userId: actor.userId } });
    });
  },
);
