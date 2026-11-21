import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { UsageResponseSchema, type UsageRow } from '@crewaid/shared';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import { signIn } from './auth-fixture.js';
import { conversationIdOf } from './turn-fixtures.js';

/**
 * CC-04 — `GET /usage?from=&to=` over the real stack (PRD §7.1).
 *
 * The contract is rows and status codes, so this suite goes through real HTTP,
 * the real AuthGuard, the real controller and a real database: a service-level
 * call would prove none of the wiring. The turn rows are seeded directly with
 * controlled `startedAt` timestamps and D-009(3) counters, which is what lets
 * the window edges (exactly `from`T00:00Z, exactly `to`T23:59:59.999Z, one
 * millisecond beyond either side) be asserted exactly rather than inferred
 * from turns created "just now". Ownership is proven the same way the other
 * integration suites prove it: a foreign user's rows exist in the same window
 * and must never appear.
 *
 * The window is far in the past so it can never collide with rows other
 * suites create during a shared-database run.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);
let TOKEN: string;
const BOT_PREFIX = `cc04-${RUN_ID}`;
/** Not the singleton: rows this principal must never reach. */
const FOREIGN_USER = `usr_cc04_${RUN_ID}`;

/** The window under test: both dates inclusive, as UTC calendar days. */
const FROM = '2026-09-01';
const TO = '2026-09-02';

let app: INestApplication;
let prisma: PrismaService;
/** The signed-in user this suite acts as, and owns its rows with. */
let ACTOR: string;
let botA: string;
let botB: string;
let botC: string;
let botD: string;
let botE: string;
let botF: string;
let foreignBot: string;

interface Counters {
  input: number;
  output: number;
  cachedInput?: number;
  cacheCreation?: number;
  /** CC-12: the billing identity a settled turn records; absent = legacy/no model. */
  modelId?: string;
}

async function seedTurn(botId: string, startedAt: string, counters: Counters): Promise<void> {
  await prisma.agentTurn.create({
    data: {
      botId,
      conversationId: await conversationIdOf(prisma, botId),
      triggerMessageId: `msg_${randomUUID()}`,
      startedAt: new Date(startedAt),
      inputTokens: counters.input,
      outputTokens: counters.output,
      cachedInputTokens: counters.cachedInput ?? 0,
      cacheCreationTokens: counters.cacheCreation ?? 0,
      ...(counters.modelId !== undefined && { modelId: counters.modelId }),
    },
  });
}

function sortedRows(rows: UsageRow[]): UsageRow[] {
  return [...rows].sort((a, b) =>
    a.botId === b.botId ? a.day.localeCompare(b.day) : a.botId.localeCompare(b.botId),
  );
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'CC-04 — GET /usage: daily token-spend rollup (real db, real http)',
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
      // AppModule carries WsGateway; without the §4.2 adapter the socket
      // module hard-exits during init (same boot as the other HTTP suites).
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();

      prisma = app.get(PrismaService);
      // V1-08: a real session for a real user. The suite owns its rows with
      // ACTOR, so nothing here depends on a user somebody else seeded.
      ({ token: TOKEN, userId: ACTOR } = await signIn(prisma, { label: 'usage' }));
      await prisma.user.upsert({
        where: { id: FOREIGN_USER },
        create: {
          id: FOREIGN_USER,
          name: 'Test User',
          email: `usage-api-${RUN_ID}@test.local`,
        },
        update: {},
      });

      const createBot = (userId: string, suffix: string) =>
        prisma.bot.create({
          data: {
            userId,
            name: `${BOT_PREFIX}-${suffix}`,
            role: 'usage rollup test',
            avatarColor: '#8B6F47',
            systemPrompt: 'test',
          },
        });
      botA = (await createBot(ACTOR, 'a')).id;
      botB = (await createBot(ACTOR, 'b')).id;
      botC = (await createBot(ACTOR, 'c')).id;
      botD = (await createBot(ACTOR, 'd')).id;
      botE = (await createBot(ACTOR, 'e')).id;
      botF = (await createBot(ACTOR, 'f')).id;
      foreignBot = (await createBot(FOREIGN_USER, 'foreign')).id;

      // botA: both window edges and the millisecond just before the window.
      await seedTurn(botA, '2026-09-01T00:00:00.000Z', {
        input: 10,
        output: 4,
        cachedInput: 2,
        cacheCreation: 1,
      });
      await seedTurn(botA, '2026-09-01T23:59:59.999Z', { input: 5, output: 3 });
      await seedTurn(botA, '2026-09-02T00:00:00.000Z', { input: 7, output: 2 });
      await seedTurn(botA, '2026-08-31T23:59:59.999Z', { input: 100, output: 100 });
      // botB: one turn inside, one millisecond past the end of the window.
      await seedTurn(botB, '2026-09-01T12:00:00.000Z', { input: 1, output: 1 });
      await seedTurn(botB, '2026-09-03T00:00:00.000Z', { input: 9, output: 9 });
      // botC: only ever spends outside the window below.
      await seedTurn(botC, '2026-08-30T12:00:00.000Z', { input: 11, output: 11 });
      // The foreign user's turn falls INSIDE the window every other case uses.
      await seedTurn(foreignBot, '2026-09-01T06:00:00.000Z', { input: 50, output: 50 });

      // CC-12: a separate window (far from every other case) for the money
      // cases. mock-provider rates: input $2/M, output $6/M.
      // botD — priced spend across two days: 1M input + 1M output = $8, then
      // a quarter-million input = $0.50.
      await seedTurn(botD, '2026-08-10T01:00:00.000Z', {
        input: 1_000_000,
        output: 0,
        modelId: 'mock-provider:mock-model',
      });
      await seedTurn(botD, '2026-08-10T02:00:00.000Z', {
        input: 0,
        output: 1_000_000,
        modelId: 'mock-provider:mock-model',
      });
      await seedTurn(botD, '2026-08-11T01:00:00.000Z', {
        input: 250_000,
        output: 0,
        modelId: 'mock-provider:mock-model',
      });
      // botE — measured spend that cannot be priced: no recorded identity on
      // one day, a recorded key with no catalog entry on the next.
      await seedTurn(botE, '2026-08-10T01:00:00.000Z', { input: 1_000, output: 0 });
      await seedTurn(botE, '2026-08-11T01:00:00.000Z', {
        input: 2_000,
        output: 0,
        modelId: 'anthropic:claude-9-imaginary',
      });
      // botF — a turn that measured nothing: a real $0, whatever the model.
      await seedTurn(botF, '2026-08-10T01:00:00.000Z', { input: 0, output: 0 });
    });

    afterAll(async () => {
      // Cascades clean up this suite's bots and their turns; the foreign user
      // exists only for the ownership case.
      await prisma?.bot
        .deleteMany({ where: { userId: ACTOR, name: { startsWith: BOT_PREFIX } } })
        .catch(() => undefined);
      await prisma?.user.deleteMany({ where: { id: FOREIGN_USER } }).catch(() => undefined);
      await app?.close();
    });

    const at = (path: string) =>
      request(app.getHttpServer()).get(path).set('authorization', `Bearer ${TOKEN}`);

    it('rolls the window up per bot and UTC day, inclusive of both dates', async () => {
      const res = await at(`/api/v1/usage?from=${FROM}&to=${TO}`);

      expect(res.status).toBe(200);
      const parsed = UsageResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      // The contract fields per row: the two token counters, plus CC-12's
      // money. The cache counters stay in the ledger (the cost table bills
      // them separately) and are not on this wire shape.
      for (const row of parsed.data.rows) {
        expect(Object.keys(row).sort()).toEqual([
          'botId',
          'day',
          'estimatedCostUsd',
          'inputTokens',
          'outputTokens',
        ]);
      }

      expect(sortedRows(parsed.data.rows)).toEqual(
        sortedRows([
          // The two turns of Sep 1 sum; the Sep 2 turn buckets alone; the turn
          // one millisecond before the window is out. These seeds carry no
          // billing identity (pre-CC-12 rows): spend is measured, cost is
          // unpriceable — null, never a fabricated 0.
          {
            botId: botA,
            day: '2026-09-01',
            inputTokens: 15,
            outputTokens: 7,
            estimatedCostUsd: null,
          },
          {
            botId: botA,
            day: '2026-09-02',
            inputTokens: 7,
            outputTokens: 2,
            estimatedCostUsd: null,
          },
          {
            botId: botB,
            day: '2026-09-01',
            inputTokens: 1,
            outputTokens: 1,
            estimatedCostUsd: null,
          },
        ]),
      );
    });

    it('never returns a foreign user’s spend, in any window', async () => {
      const res = await at(`/api/v1/usage?from=${FROM}&to=${TO}`);

      expect(res.status).toBe(200);
      const botIds = (res.body as { rows: UsageRow[] }).rows.map((row) => row.botId);
      expect(botIds).not.toContain(foreignBot);
    });

    it('proves the exclusions were the window, not lost rows', async () => {
      const res = await at(`/api/v1/usage?from=2026-08-30&to=2026-09-03`);

      expect(res.status).toBe(200);
      const rows = sortedRows((res.body as { rows: UsageRow[] }).rows);

      // The rows the narrower window excluded are present — weighted correctly.
      expect(rows).toContainEqual({
        botId: botA,
        day: '2026-08-31',
        inputTokens: 100,
        outputTokens: 100,
        estimatedCostUsd: null,
      });
      expect(rows).toContainEqual({
        botId: botB,
        day: '2026-09-03',
        inputTokens: 9,
        outputTokens: 9,
        estimatedCostUsd: null,
      });
      expect(rows).toContainEqual({
        botId: botC,
        day: '2026-08-30',
        inputTokens: 11,
        outputTokens: 11,
        estimatedCostUsd: null,
      });
      // ...and the foreign rows are still absent with the window wide open.
      expect(rows.map((row) => row.botId)).not.toContain(foreignBot);
    });

    it('rejects an inverted range with 400, not a silent empty answer', async () => {
      const res = await at(`/api/v1/usage?from=2026-09-02&to=2026-09-01`);

      expect(res.status).toBe(400);
    });

    it('rejects missing and malformed parameters with 400', async () => {
      const missing = await at(`/api/v1/usage`);
      expect(missing.status).toBe(400);

      const malformed = await at(`/api/v1/usage?from=01-09-2026&to=2026-09-30`);
      expect(malformed.status).toBe(400);
    });

    it('requires the bearer token like every other route', async () => {
      const res = await request(app.getHttpServer()).get(`/api/v1/usage?from=${FROM}&to=${TO}`);

      expect(res.status).toBe(401);
    });

    describe('CC-12 — money beside the tokens', () => {
      it('prices each day from the models its turns recorded, and reports nulls for unpriceable spend', async () => {
        const res = await at(`/api/v1/usage?from=2026-08-10&to=2026-08-11`);

        expect(res.status).toBe(200);
        const parsed = UsageResponseSchema.safeParse(res.body);
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;

        // mock-provider rates: input $2/M, output $6/M.
        expect(sortedRows(parsed.data.rows)).toEqual(
          sortedRows([
            // Two priced turns sum: 1M input ($2) + 1M output ($6).
            {
              botId: botD,
              day: '2026-08-10',
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              estimatedCostUsd: 8,
            },
            {
              botId: botD,
              day: '2026-08-11',
              inputTokens: 250_000,
              outputTokens: 0,
              estimatedCostUsd: 0.5,
            },
            // Measured spend, no recorded model: unknown, not 0.
            {
              botId: botE,
              day: '2026-08-10',
              inputTokens: 1_000,
              outputTokens: 0,
              estimatedCostUsd: null,
            },
            // A recorded model with no catalog rate: unknown too.
            {
              botId: botE,
              day: '2026-08-11',
              inputTokens: 2_000,
              outputTokens: 0,
              estimatedCostUsd: null,
            },
            // A measured nothing is a real $0.
            {
              botId: botF,
              day: '2026-08-10',
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostUsd: 0,
            },
          ]),
        );
      });
    });
  },
);
