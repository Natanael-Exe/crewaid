import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import { TurnSummarySchema } from '@crewaid/shared';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { conversationIdOf } from './turn-fixtures.js';

/**
 * `GET /bots/:id/turns?limit=` (§4.1) over the real stack: real HTTP, the real
 * AuthGuard and controller, and turn rows seeded with controlled timestamps.
 *
 * The route was declared in `API_ROUTES` and implemented by no controller, so
 * every request to it answered 404 — which is also what an ownership refusal
 * answers. The first case here is therefore a PRESENCE: the caller's own bot
 * answers 200 with its turns, and only then does a foreign bot's 404 mean
 * anything (`two-user-isolation` drives the same pair).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let app: INestApplication;
let prisma: PrismaService;
let actor: SignedInUser;
let stranger: SignedInUser;
let botId: string;
let strangerBotId: string;

const TurnsResponse = z.array(TurnSummarySchema);

async function bot(userId: string, label: string): Promise<string> {
  const row = await prisma.bot.create({
    data: {
      userId,
      name: `turns-${label}-${RUN_ID}`,
      role: 'fixture',
      avatarColor: '#8B6F47',
      systemPrompt: '',
    },
  });
  return row.id;
}

async function seedTurn(forBot: string, startedAt: string, stepIndex: number): Promise<string> {
  const row = await prisma.agentTurn.create({
    data: {
      botId: forBot,
      conversationId: await conversationIdOf(prisma, forBot),
      triggerMessageId: `msg_${randomUUID()}`,
      status: 'completed',
      startedAt: new Date(startedAt),
      endedAt: new Date(startedAt),
      stepIndex,
      steps: Array.from({ length: stepIndex }, (_, index) => ({ index })),
      inputTokens: 100 * stepIndex,
      outputTokens: 10 * stepIndex,
    },
  });
  return row.id;
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'GET /bots/:id/turns — recent turns with step counts and usage (real db, real http)',
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
      actor = await signIn(prisma, { label: `turns_${RUN_ID}` });
      stranger = await signIn(prisma, { label: `turns_stranger_${RUN_ID}` });
      botId = await bot(actor.userId, 'mine');
      strangerBotId = await bot(stranger.userId, 'theirs');
    });

    afterAll(async () => {
      if (prisma !== undefined) {
        await prisma.bot.deleteMany({ where: { id: { in: [botId, strangerBotId] } } });
        if (actor !== undefined) await signOutAndDelete(prisma, actor.userId);
        if (stranger !== undefined) await signOutAndDelete(prisma, stranger.userId);
      }
      await app?.close();
    });

    it('answers the caller’s own turns, newest first, in the §4.1 shape', async () => {
      const older = await seedTurn(botId, '2026-01-01T10:00:00.000Z', 2);
      const newer = await seedTurn(botId, '2026-01-02T10:00:00.000Z', 5);
      // A stranger's turn in the same window, which must never appear.
      await seedTurn(strangerBotId, '2026-01-03T10:00:00.000Z', 1);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/bots/${botId}/turns`)
        .set(actor.headers)
        .expect(200);

      const turns = TurnsResponse.parse(response.body);
      expect(turns.map((turn) => turn.id)).toEqual([newer, older]);
      expect(turns.map((turn) => turn.stepCount)).toEqual([5, 2]);
      expect(turns[0]).toMatchObject({ botId, inputTokens: 500, outputTokens: 50 });
      // The orchestrator's bookkeeping stays off the wire.
      expect(Object.keys(response.body[0] as object)).not.toContain('activeKey');
    });

    it('honours limit and refuses one outside the schema', async () => {
      const limited = await request(app.getHttpServer())
        .get(`/api/v1/bots/${botId}/turns?limit=1`)
        .set(actor.headers)
        .expect(200);
      expect(TurnsResponse.parse(limited.body)).toHaveLength(1);

      await request(app.getHttpServer())
        .get(`/api/v1/bots/${botId}/turns?limit=0`)
        .set(actor.headers)
        .expect(400);
    });

    it('answers 404 for another account’s bot, and for one that does not exist', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/bots/${strangerBotId}/turns`)
        .set(actor.headers)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/bots/cm${RUN_ID}doesnotexist/turns`)
        .set(actor.headers)
        .expect(404);
    });
  },
);
