import { computerId } from './computer-fixtures.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { HealthResponseSchema } from '@crewaid/shared';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { FakeProvider } from './sandbox-fakes.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * GET /health — the §4.1 readiness body (CC-02), exercised against the live
 * compose stack (Postgres + Redis) and the live Docker daemon.
 *
 * The M1 suite pinned "liveness only, no DB dependency"; CC-02 is the ruling
 * that replaces it with §4.1's `{ status, db, redis, docker, sandboxes }`.
 * What does NOT change is liveness semantics, and that is what the first
 * tests re-pin: the route answers HTTP 200 unauthenticated, with a correct
 * token, and with a wrong one — and a dependency being down is a value in the
 * body, never a failed probe.
 *
 * `docker` and `redis` are compared against an INDEPENDENT probe of each
 * dependency (the daemon's own /_ping, a raw PING on the wire), not against
 * the app's own helper: asserting that two copies of the same code agree
 * would prove nothing about the wiring this suite exists to check.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';

/** The daemon's own ping — the oracle the app's docker:true must match. */
function dockerDaemonAnswers(): Promise<boolean> {
  const dockerHost = process.env['DOCKER_HOST'];
  const options: RequestOptions = { path: '/_ping', method: 'GET' };
  if (dockerHost !== undefined && dockerHost.startsWith('tcp://')) {
    const parsed = new URL(dockerHost);
    options.host = parsed.hostname;
    options.port = parsed.port === '' ? 2375 : Number(parsed.port);
  } else {
    options.socketPath =
      dockerHost !== undefined && dockerHost.startsWith('unix://')
        ? dockerHost.slice('unix://'.length)
        : '/var/run/docker.sock';
  }
  return new Promise<boolean>((resolve) => {
    const req = httpRequest(options, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(1_500, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** A raw PING on the wire — the oracle the app's redis:true must match. */
function redisAnswers(): Promise<boolean> {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url.trim() === '') return Promise.resolve(false);
  let host: string;
  let port: number;
  let auth = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port === '' ? 6379 : Number(parsed.port);
    if (parsed.password !== '') {
      const args = [
        'AUTH',
        ...(parsed.username === '' ? [] : [decodeURIComponent(parsed.username)]),
        decodeURIComponent(parsed.password),
      ];
      auth =
        `*${args.length}\r\n` +
        args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('');
    }
  } catch {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let buffer = '';
    socket.setTimeout(1_500, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
    socket.on('connect', () => socket.write(auth + '*1\r\n$4\r\nPING\r\n'));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('+PONG')) {
        socket.destroy();
        resolve(true);
      } else if (buffer.includes('-')) {
        socket.destroy();
        resolve(false);
      }
    });
  });
}

function entryFor(body: unknown, botId: string): unknown {
  const sandboxes = (body as { sandboxes?: Array<{ botId: string }> }).sandboxes ?? [];
  return sandboxes.find((entry) => entry.botId === botId);
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'GET /health (readiness, §4.1 body · §4.4 exempt · CC-02)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let actor: SignedInUser;
    const createdBotIds: string[] = [];

    async function createBot(): Promise<{ id: string }> {
      const bot = await prisma.bot.create({
        data: {
          userId: actor.userId,
          name: `cc02-${randomUUID().slice(0, 8)}`,
          role: 'R',
          avatarColor: '#123456',
          systemPrompt: 'x',
        },
      });
      await prisma.sandbox.create({
        data: {
          id: bot.id,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).userId,
          bots: { connect: { id: bot.id } },
        },
      });
      createdBotIds.push(bot.id);
      return bot;
    }

    let supervisor: { close(): Promise<void> } | null = null;

    beforeAll(async () => {
      process.env['ORCH_API_TOKEN'] = 'test-health-guard-token';
      // D-200: the orchestrator reaches Docker only through the supervisor, so
      // this run gives it one — and `docker` is then the daemon's own answer.
      supervisor = await (
        await import('@crewaid/sandbox-supervisor')
      ).useTestSupervisor({
        SANDBOX_NETWORK: `crewaid-health-${randomUUID()}`,
      });
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const { PrismaService: PrismaServiceClass } = await import('../src/prisma/prisma.service.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      // Required whenever AppModule boots: WsGateway needs the §4.2 adapter
      // before init, or SocketModule falls back to socket.io and hard-exits.
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1');
      await app.init();
      prisma = app.get(PrismaServiceClass);
      actor = await signIn(prisma, { label: 'health' });
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
    });

    afterAll(async () => {
      delete process.env['ORCH_API_TOKEN'];
      if (supervisor !== null) {
        await supervisor.close();
        delete process.env['SANDBOX_SUPERVISOR_URL'];
        delete process.env['SANDBOX_SUPERVISOR_SECRET'];
      }
      if (prisma !== undefined) {
        await prisma.bot
          .deleteMany({ where: { id: { in: createdBotIds } } })
          .catch(() => undefined);
        await signOutAndDelete(prisma, actor.userId).catch(() => undefined);
      }
      await app?.close();
    });

    it('answers 200 with no token and a body that IS the §4.1 schema', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health');
      expect(res.status).toBe(200);
      const parsed = HealthResponseSchema.safeParse(res.body);
      if (!parsed.success) {
        throw new Error(
          `health body fails HealthResponseSchema: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
      // The live facts this run's probes must have observed.
      expect(parsed.data.db).toBe(true);
      expect(parsed.data.docker).toBe(await dockerDaemonAnswers());
      expect(parsed.data.redis).toBe(await redisAnswers());
      // The §4.1 status ladder, checked against the same response's fields.
      const expected = !parsed.data.db
        ? 'down'
        : parsed.data.redis && parsed.data.docker
          ? 'ok'
          : 'degraded';
      expect(parsed.data.status).toBe(expected);
    });

    it('stays reachable with a WRONG token — the exempt path never consults credentials', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('authorization', 'Bearer definitely-wrong-token');
      expect(res.status).toBe(200);
      expect(HealthResponseSchema.safeParse(res.body).success).toBe(true);
    });

    it('stays reachable with a garbage header', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('authorization', 'garbage-not-a-scheme');
      expect(res.status).toBe(200);
    });

    it('reports every sandbox row with its state — a stopped one is not a sick one', async () => {
      const bot = await createBot();
      const res = await request(app.getHttpServer()).get('/api/v1/health').set(actor.headers);
      expect(res.status).toBe(200);
      expect(entryFor(res.body, bot.id)).toMatchObject({
        botId: bot.id,
        state: 'STOPPED',
        healthy: false,
      });
    });

    it('lists a sandbox to its owner only — never to an anonymous caller or another user', async () => {
      const bot = await createBot();
      const own = await request(app.getHttpServer()).get('/api/v1/health').set(actor.headers);
      expect(entryFor(own.body, bot.id)).toBeDefined();

      const anonymous = await request(app.getHttpServer()).get('/api/v1/health');
      expect(anonymous.status).toBe(200);
      expect((anonymous.body as { sandboxes: unknown[] }).sandboxes).toEqual([]);

      const stranger = await signIn(prisma, { label: 'health-stranger' });
      try {
        const other = await request(app.getHttpServer())
          .get('/api/v1/health')
          .set(stranger.headers);
        expect(other.status).toBe(200);
        expect(entryFor(other.body, bot.id)).toBeUndefined();
      } finally {
        await signOutAndDelete(prisma, stranger.userId);
      }
    });

    it('answers rather than failing when a RUNNING row has no container behind it', async () => {
      const bot = await createBot();
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, bot.id) },
        data: { state: 'RUNNING', sessionId: `missing-${bot.id}` },
      });
      const res = await request(app.getHttpServer()).get('/api/v1/health').set(actor.headers);
      expect(res.status).toBe(200);
      // No container carries that session id, so the live probe must say so —
      // and a daemon that cannot answer is likewise not a healthy sandbox.
      expect(entryFor(res.body, bot.id)).toMatchObject({ state: 'RUNNING', healthy: false });
    });
  },
);

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'GET /health sandbox entries (sandbox module, faked provider)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let actor: SignedInUser;
    let provider: FakeProvider;
    let botId: string;
    const createdBotIds: string[] = [];

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { SandboxModule } = await import('../src/sandbox/sandbox.module.js');
      const { HealthModule } = await import('../src/health/health.module.js');
      const { SANDBOX_PROVIDER } = await import('../src/sandbox/sandbox.provider.js');
      const { PrismaService: PrismaServiceClass } = await import('../src/prisma/prisma.service.js');
      provider = new FakeProvider();
      const moduleRef = await Test.createTestingModule({
        imports: [SandboxModule, HealthModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1');
      await app.init();
      prisma = app.get(PrismaServiceClass);
      actor = await signIn(prisma, { label: 'health' });
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
    });

    afterAll(async () => {
      if (prisma !== undefined) {
        await prisma.bot
          .deleteMany({ where: { id: { in: createdBotIds } } })
          .catch(() => undefined);
        await signOutAndDelete(prisma, actor.userId).catch(() => undefined);
      }
      await app?.close();
    });

    beforeEach(async () => {
      provider.reset();
      const bot = await prisma.bot.create({
        data: {
          userId: actor.userId,
          name: `cc02-fake-${randomUUID().slice(0, 8)}`,
          role: 'R',
          avatarColor: '#123456',
          systemPrompt: 'x',
        },
      });
      botId = bot.id;
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
        },
      });
      createdBotIds.push(botId);
    });

    it('reports a RUNNING sandbox as healthy only when its bridge answers', async () => {
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { state: 'RUNNING', sessionId: 'cc02-bridge' },
      });

      provider.healthBySession.set('cc02-bridge', { ok: true });
      let res = await request(app.getHttpServer()).get('/api/v1/health').set(actor.headers);
      expect(entryFor(res.body, botId)).toMatchObject({ state: 'RUNNING', healthy: true });

      provider.healthBySession.set('cc02-bridge', { ok: false, reason: 'bridge 503' });
      res = await request(app.getHttpServer()).get('/api/v1/health').set(actor.headers);
      expect(entryFor(res.body, botId)).toMatchObject({ state: 'RUNNING', healthy: false });
    });

    it('does not probe a stopped sandbox, and never calls it healthy', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').set(actor.headers);
      expect(entryFor(res.body, botId)).toMatchObject({ state: 'STOPPED', healthy: false });
      expect(provider.healthCallsFor(botId)).toBe(0);
    });

    it('reports an unreachable daemon as an unhealthy sandbox, not a failed route', async () => {
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { state: 'RUNNING', sessionId: 'cc02-daemon-down' },
      });
      provider.failHealthFor.add('cc02-daemon-down');
      const res = await request(app.getHttpServer()).get('/api/v1/health').set(actor.headers);
      expect(res.status).toBe(200);
      expect(entryFor(res.body, botId)).toMatchObject({ state: 'RUNNING', healthy: false });
    });
  },
);
