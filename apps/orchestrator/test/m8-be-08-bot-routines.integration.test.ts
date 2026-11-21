import { toolReach } from '../src/agent/tool-registry.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DEFAULT_AUTO_REVIEW_RULES } from '@crewaid/shared';

import { decideAutoReview } from '../src/agent/auto-review.js';
import { ToolRegistry, type ToolContext } from '../src/agent/tool-registry.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { triggerText } from '../src/routines/routine-runner.service.js';
import { scheduledReport } from '../src/routines/routine-tools.js';
import { ROUTINE_SCHEDULER, type RoutineScheduler } from '../src/routines/routine.queue.js';
import { MAX_BOT_ROUTINES } from '../src/routines/routines.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * M8-BE-08 — a bot schedules its own follow-up, marked by provenance (D-125).
 *
 * The board's three requirements, one describe each: the routine records
 * that a bot made it; a bot's own routines have a ceiling the operator's do
 * not; and they are visible and deletable in the same place as the
 * operator's. Plus what the tools are for the approval matcher, and what a
 * bot-made routine posts when it fires.
 *
 * Driven through the real registry, the real service and a real database;
 * the scheduler is a recorder, because Redis is not what is being decided.
 */
const DATABASE_URL = process.env['DATABASE_URL'];

describe('scheduledReport — the time a model cannot otherwise know', () => {
  it('states the current time and the next three runs, in the routine’s own zone', () => {
    const report = scheduledReport(
      {
        id: 'r1',
        name: 'Invoice check',
        cron: '0 9 * * *',
        timezone: 'America/New_York',
      } as never,
      new Date('2026-09-22T20:00:00Z'), // 16:00 EDT
    );
    expect(report).toContain('It is now Tue, Sep 22, 2026, 16:00 EDT');
    expect(report).toContain('Wed, Sep 23, 2026, 09:00 EDT');
    expect(report).toContain('Fri, Sep 25, 2026, 09:00 EDT');
  });
});

describe('triggerText — who the transcript says asked', () => {
  it('posts an operator routine’s prompt verbatim', () => {
    expect(triggerText({ name: 'Digest', prompt: 'Summarise.', origin: 'OPERATOR' })).toBe(
      'Summarise.',
    );
  });

  it('labels a bot’s own routine as its note to itself, never as the operator asking', () => {
    const text = triggerText({ name: 'Invoice check', prompt: 'Was it paid?', origin: 'BOT' });
    expect(text).toMatch(/^Scheduled follow-up you set for yourself \("Invoice check"\)/);
    expect(text).toContain('Was it paid?');
  });
});

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M8-BE-08 — bot-scheduled routines (real db)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let registry: ToolRegistry;
    let ACTOR: SignedInUser;
    const calls: string[] = [];
    const scheduler: RoutineScheduler = {
      schedule: (r) => {
        calls.push(`schedule:${r.id}`);
        return Promise.resolve();
      },
      unschedule: (id) => {
        calls.push(`unschedule:${id}`);
        return Promise.resolve();
      },
      scheduled: () => Promise.resolve([]),
      runNow: () => Promise.resolve(),
    };

    const api = (path: string): string => `/api/v1${path}`;
    const http = (): request.Agent => request(app.getHttpServer()) as unknown as request.Agent;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module.js');
      const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ROUTINE_SCHEDULER)
        .useValue(scheduler)
        .compile();
      app = moduleRef.createNestApplication();
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();
      prisma = app.get(PrismaService);
      registry = app.get(ToolRegistry);
      ACTOR = await signIn(prisma, { label: 'bot-routines' });
    }, 60_000);

    afterAll(async () => {
      if (prisma !== undefined) await signOutAndDelete(prisma, ACTOR.userId);
      await app?.close();
    });

    beforeEach(() => {
      calls.length = 0;
    });

    async function makeBot(): Promise<string> {
      const bot = await prisma.bot.create({
        data: {
          userId: ACTOR.userId,
          name: `Scheduler ${randomUUID().slice(0, 8)}`,
          role: 'R',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      return bot.id;
    }

    /** Call a registered tool the way a turn would, as `botId`. */
    async function call(name: string, botId: string, input: Record<string, unknown>) {
      const context = { userId: ACTOR.userId, botId } as unknown as ToolContext;
      const built = registry.toolSetFor(context)[name] as unknown as {
        execute: (input: unknown, options: unknown) => Promise<string>;
      };
      return built.execute(input, { toolCallId: randomUUID(), messages: [] });
    }

    const schedule = (botId: string, name: string, extra: Record<string, unknown> = {}) =>
      call('schedule_routine', botId, {
        name,
        cron: '0 9 * * *',
        timezone: 'America/New_York',
        prompt: 'Check whether the invoice was paid.',
        ...extra,
      });

    describe('provenance', () => {
      it('a routine the bot schedules is stored as BOT, on that bot, and scheduled', async () => {
        const botId = await makeBot();
        const result = await schedule(botId, 'Invoice check');

        const rows = await prisma.routine.findMany({ where: { botId } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          origin: 'BOT',
          name: 'Invoice check',
          prompt: 'Check whether the invoice was paid.',
          enabled: true,
        });
        expect(calls).toEqual([`schedule:${rows[0]!.id}`]);
        expect(result).toMatch(/^Scheduled "Invoice check" \(.+\) .*It is now .*next run/);
      });

      it("reads a cron with no zone in the person's own zone, not §3's default (D-234)", async () => {
        const botId = await makeBot();
        await prisma.userSettings.upsert({
          where: { userId: ACTOR.userId },
          create: { userId: ACTOR.userId, systemTimezone: 'Asia/Tokyo' },
          update: { systemTimezone: 'Asia/Tokyo' },
        });
        try {
          await schedule(botId, 'Morning nudge', { timezone: undefined });
          const row = await prisma.routine.findFirstOrThrow({ where: { botId } });
          expect(row.timezone).toBe('Asia/Tokyo');
        } finally {
          await prisma.userSettings.deleteMany({ where: { userId: ACTOR.userId } });
        }
      });

      it('the REST route always creates OPERATOR, even when the body says otherwise', async () => {
        const botId = await makeBot();
        const res = await http()
          .post(api('/routines'))
          .set(ACTOR.headers)
          .send({ botId, name: 'Mine', cron: '0 8 * * *', prompt: 'Digest.', origin: 'BOT' })
          .expect(201);
        expect((res.body as { origin: string }).origin).toBe('OPERATOR');
      });

      it('lists both kinds together, each saying which it is', async () => {
        const botId = await makeBot();
        await schedule(botId, 'Bot follow-up');
        await http()
          .post(api('/routines'))
          .set(ACTOR.headers)
          .send({ botId, name: 'Operator digest', cron: '0 8 * * *', prompt: 'Digest.' })
          .expect(201);

        const res = await http().get(api('/routines')).set(ACTOR.headers).expect(200);
        const forBot = (res.body as Array<{ botId: string; name: string; origin: string }>)
          .filter((r) => r.botId === botId)
          .map((r) => [r.name, r.origin]);
        expect(forBot).toEqual([
          ['Bot follow-up', 'BOT'],
          ['Operator digest', 'OPERATOR'],
        ]);
      });

      it('the operator can delete what a bot scheduled, like any routine', async () => {
        const botId = await makeBot();
        await schedule(botId, 'Nag');
        const row = await prisma.routine.findFirstOrThrow({ where: { botId } });

        await http()
          .delete(api(`/routines/${row.id}`))
          .set(ACTOR.headers)
          .expect(204);

        expect(await prisma.routine.findUnique({ where: { id: row.id } })).toBeNull();
      });
    });

    describe('the ceiling', () => {
      it(`holds a bot to ${MAX_BOT_ROUTINES} of its own, with a sentence it can act on`, async () => {
        const botId = await makeBot();
        for (let i = 0; i < MAX_BOT_ROUTINES; i += 1) {
          expect(await schedule(botId, `Follow-up ${i}`)).toMatch(/^Scheduled/);
        }

        const refused = await schedule(botId, 'One too many');

        expect(refused).toMatch(/^Could not schedule "One too many": .*limit of 5.*cancel one/);
        expect(await prisma.routine.count({ where: { botId, origin: 'BOT' } })).toBe(
          MAX_BOT_ROUTINES,
        );
      });

      it('does not count the operator’s routines, and does not limit the operator', async () => {
        const botId = await makeBot();
        for (let i = 0; i < MAX_BOT_ROUTINES + 1; i += 1) {
          await http()
            .post(api('/routines'))
            .set(ACTOR.headers)
            .send({ botId, name: `Op ${i}`, cron: '0 8 * * *', prompt: 'Digest.' })
            .expect(201);
        }
        expect(await schedule(botId, 'Still allowed')).toMatch(/^Scheduled/);
      });

      it('is per bot: another bot’s routines leave this one’s room alone', async () => {
        const full = await makeBot();
        const other = await makeBot();
        for (let i = 0; i < MAX_BOT_ROUTINES; i += 1) await schedule(full, `F ${i}`);
        expect(await schedule(other, 'Mine')).toMatch(/^Scheduled/);
      });
    });

    describe('what a bad request gets back', () => {
      it('a six-field cron is refused with the reason, and nothing is stored', async () => {
        const botId = await makeBot();
        const result = await schedule(botId, 'Too fast', { cron: '* * * * * *' });
        expect(result).toMatch(/Could not schedule "Too fast": .*exactly 5 fields/);
        expect(await prisma.routine.count({ where: { botId } })).toBe(0);
      });
    });

    describe('cancel_routine', () => {
      it('cancels one of its own by name, unscheduling it', async () => {
        const botId = await makeBot();
        await schedule(botId, 'Invoice check');
        const row = await prisma.routine.findFirstOrThrow({ where: { botId } });
        calls.length = 0;

        const result = await call('cancel_routine', botId, { routine: 'Invoice check' });

        expect(result).toBe('Cancelled "Invoice check"; it will not run again.');
        expect(calls).toEqual([`unschedule:${row.id}`]);
        expect(await prisma.routine.findUnique({ where: { id: row.id } })).toBeNull();
      });

      it('cannot touch the operator’s routine, even by its exact id', async () => {
        const botId = await makeBot();
        const res = await http()
          .post(api('/routines'))
          .set(ACTOR.headers)
          .send({ botId, name: 'Operator digest', cron: '0 8 * * *', prompt: 'Digest.' })
          .expect(201);
        const operatorId = (res.body as { id: string }).id;

        const byId = await call('cancel_routine', botId, { routine: operatorId });
        const byName = await call('cancel_routine', botId, { routine: 'Operator digest' });

        expect(byId).toBe('You have no routines of your own to cancel.');
        expect(byName).toBe('You have no routines of your own to cancel.');
        expect(await prisma.routine.findUnique({ where: { id: operatorId } })).not.toBeNull();
      });

      it('cannot touch another bot’s routine', async () => {
        const mine = await makeBot();
        const theirs = await makeBot();
        await schedule(theirs, 'Theirs');
        await schedule(mine, 'Mine');

        const result = await call('cancel_routine', mine, { routine: 'Theirs' });

        expect(result).toMatch(/^None of your routines is "Theirs"\. Yours are: "Mine"/);
        expect(await prisma.routine.count({ where: { botId: theirs } })).toBe(1);
      });
    });

    describe('what the approval matcher makes of the two tools', () => {
      const shipped = (toolName: string) =>
        decideAutoReview({
          rules: DEFAULT_AUTO_REVIEW_RULES,
          toolName,
          args: {},
          behavior: registry.behaviorOf(toolName),
        }).decision;

      it('asks before a bot commits the operator to unattended runs', () => {
        expect(toolReach(registry.behaviorOf('schedule_routine'))).toBe('sensitive');
        expect(shipped('schedule_routine')).toBe('ask');
      });

      it('lets a bot clear up its own schedule without asking', () => {
        expect(toolReach(registry.behaviorOf('cancel_routine'))).toBe('contained');
        expect(shipped('cancel_routine')).toBe('allow');
      });
    });
  },
);
