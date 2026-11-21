import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { MemoryResponseSchema, type MemoryRow } from '@crewaid/shared';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import { signIn } from './auth-fixture.js';

/**
 * CC-36 / D-080 — `GET /memory` over the real stack.
 *
 * The route exists because D-073 took something away: an operator used to be
 * able to open `/home/bot/shared/MEMORY.md` in the seat and read it, and
 * moving the memory into Postgres removed that. A memory nobody can inspect
 * is a black box exactly when a bot is confidently wrong.
 *
 * Real HTTP, real AuthGuard, real controller, real database — a service-level
 * call would prove none of the wiring. A FOREIGN user's rows exist throughout
 * and must never appear: an ownership assertion against nothing is not one.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);
let TOKEN: string;
const FOREIGN_USER = `usr_cc36_${RUN_ID}`;

let app: INestApplication;
let prisma: PrismaService;
/** The signed-in user this suite acts as, and owns its rows with. */
let ACTOR: string;
let botA: string;
let botB: string;
let foreignBot: string;

async function makeBot(userId: string, name: string): Promise<string> {
  const bot = await prisma.bot.create({
    data: {
      userId,
      name,
      role: 'fixture',
      avatarColor: '#8B6F47',
      systemPrompt: '',
      modelId: 'default',
    },
  });
  return bot.id;
}

function get(path: string) {
  return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${TOKEN}`);
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'CC-36 — GET /memory (real db, real http)',
  () => {
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();

      prisma = app.get(PrismaService);
      // V1-08: a real session for a real user. The suite owns its rows with
      // ACTOR, so nothing here depends on a user somebody else seeded.
      ({ token: TOKEN, userId: ACTOR } = await signIn(prisma, { label: 'memory' }));
      await prisma.user.upsert({
        where: { id: ACTOR },
        create: { id: ACTOR, name: 'Test User', email: `${ACTOR}@test.invalid` },
        update: {},
      });
      await prisma.user.upsert({
        where: { id: FOREIGN_USER },
        create: { id: FOREIGN_USER, name: 'Test User', email: `${FOREIGN_USER}@test.invalid` },
        update: {},
      });

      botA = await makeBot(ACTOR, `cc36-a-${RUN_ID}`);
      botB = await makeBot(ACTOR, `cc36-b-${RUN_ID}`);
      foreignBot = await makeBot(FOREIGN_USER, `cc36-foreign-${RUN_ID}`);

      // Distinct, explicit timestamps. createMany in one call gives every row
      // the SAME updatedAt, and a list where every key is equal is sorted
      // under any ordering — so the ordering assertion below would pass
      // whichever direction the query used. (Caught by mutation: reversing
      // the orderBy changed nothing.)
      const at = (n: number): Date => new Date(Date.UTC(2026, 0, n, 12, 0, 0));
      await prisma.memory.createMany({
        data: [
          {
            userId: ACTOR,
            botId: null,
            kind: 'PREFERENCE',
            source: 'TOLD',
            text: `global-${RUN_ID}`,
            createdAt: at(1),
            updatedAt: at(1),
          },
          {
            userId: ACTOR,
            botId: botA,
            kind: 'CONVENTION',
            source: 'TOLD',
            text: `a-own-${RUN_ID}`,
            createdAt: at(2),
            updatedAt: at(2),
          },
          {
            userId: ACTOR,
            botId: botB,
            kind: 'CONVENTION',
            source: 'TOLD',
            text: `b-own-${RUN_ID}`,
            createdAt: at(3),
            updatedAt: at(3),
          },
          {
            userId: ACTOR,
            botId: null,
            kind: 'FACT',
            source: 'DISTILLED',
            status: 'CANDIDATE',
            text: `candidate-${RUN_ID}`,
            createdAt: at(4),
            updatedAt: at(4),
          },
          {
            userId: ACTOR,
            botId: null,
            kind: 'FACT',
            source: 'TOLD',
            status: 'FORGOTTEN',
            text: `erased-${RUN_ID}`,
            createdAt: at(5),
            updatedAt: at(5),
          },
          {
            userId: ACTOR,
            botId: null,
            kind: 'CONVENTION',
            source: 'OBSERVED',
            text: `observed-${RUN_ID}`,
            createdAt: at(6),
            updatedAt: at(6),
            sourceRef: 'https://example.invalid/page',
          },
          {
            userId: FOREIGN_USER,
            botId: foreignBot,
            kind: 'FACT',
            source: 'TOLD',
            text: `foreign-${RUN_ID}`,
            createdAt: at(7),
            updatedAt: at(7),
          },
        ],
      });
    });

    afterAll(async () => {
      await prisma.memory.deleteMany({ where: { userId: { in: [ACTOR, FOREIGN_USER] } } });
      await prisma.bot.deleteMany({ where: { id: { in: [botA, botB, foreignBot] } } });
      await prisma.user.delete({ where: { id: FOREIGN_USER } });
      await app.close();
    });

    async function rows(query = ''): Promise<MemoryRow[]> {
      const response = await get(`/api/v1/memory${query}`).expect(200);
      // Parsed through the shared schema: a 2xx whose body does not conform
      // is a contract defect, and the only place that can be caught is here.
      const parsed = MemoryResponseSchema.safeParse(response.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      return parsed.success ? parsed.data.rows : [];
    }

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer()).get('/api/v1/memory').expect(401);
    });

    it('returns this user’s memory, parsed by the shared schema', async () => {
      const texts = (await rows()).map((r) => r.text);
      expect(texts).toContain(`global-${RUN_ID}`);
      expect(texts).toContain(`a-own-${RUN_ID}`);
      expect(texts).toContain(`b-own-${RUN_ID}`);
    });

    it('never returns another user’s memory — R7', async () => {
      // The foreign row exists (asserted first), so this absence means
      // something.
      const planted = await prisma.memory.findMany({ where: { userId: FOREIGN_USER } });
      expect(planted, 'the fixture never wrote the foreign row').toHaveLength(1);

      expect((await rows()).map((r) => r.text)).not.toContain(`foreign-${RUN_ID}`);
    });

    it('narrows to one bot’s view: its own plus the global memory', async () => {
      // "What does THIS bot know" is the question an operator is asking, and
      // the answer is the scope the bot itself is shown — not only its
      // private rows.
      const texts = (await rows(`?botId=${botA}`)).map((r) => r.text);
      expect(texts).toContain(`a-own-${RUN_ID}`);
      expect(texts).toContain(`global-${RUN_ID}`);
      expect(texts).not.toContain(`b-own-${RUN_ID}`);
    });

    it('hides superseded and forgotten rows by default', async () => {
      expect((await rows()).map((r) => r.text)).not.toContain(`erased-${RUN_ID}`);
    });

    it('returns them when asked, because "what did it replace" is the second question', async () => {
      expect((await rows('?includeInactive=true')).map((r) => r.text)).toContain(
        `erased-${RUN_ID}`,
      );
    });

    it('carries the provenance that says WHY a row is there', async () => {
      // status and source on the wire are the point. "The bot thinks X" and
      // "a model guessed X and nobody confirmed it" look identical without
      // them, and telling them apart is the whole reason to look.
      const all = await rows();
      const candidate = all.find((r) => r.text === `candidate-${RUN_ID}`);
      expect(candidate?.status).toBe('CANDIDATE');
      expect(candidate?.source).toBe('DISTILLED');

      const observed = all.find((r) => r.text === `observed-${RUN_ID}`);
      expect(observed?.source).toBe('OBSERVED');
      expect(observed?.sourceRef).toBe('https://example.invalid/page');
    });

    it('returns newest first', async () => {
      // An operator opening this is usually asking what just CHANGED, not
      // what has been true longest.
      const all = await rows('?includeInactive=true');
      const times = all.map((r) => Date.parse(r.updatedAt));
      const sorted = [...times].sort((a, b) => b - a);
      expect(times).toEqual(sorted);
    });

    it('refuses a malformed query rather than guessing', async () => {
      // `includeInactive` is a real enum on the wire. `botId` is not shape-
      // checked beyond length — CuidSchema is deliberately loose repo-wide —
      // so an unknown id is an OWNERSHIP question, asserted below.
      await get('/api/v1/memory?includeInactive=perhaps').expect(400);
    });

    it('404s for a bot that does not exist', async () => {
      // Not 200-with-the-global-memory. That would say "this bot knows these
      // things" about a bot that does not exist, which is the wrong kind of
      // wrong to hand someone who came here to find out what a bot believes.
      await get('/api/v1/memory?botId=cc36missingbotid').expect(404);
    });

    it('404s for another user’s bot, exactly like an absent one', async () => {
      // Same status for absent and foreign, so the response cannot be used to
      // discover which bot ids exist (bots.service.ts sets the precedent).
      await get(`/api/v1/memory?botId=${foreignBot}`).expect(404);
    });
  },
);
