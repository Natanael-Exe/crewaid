import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MockLanguageModelV4,
  scriptModel,
  simulateReadableStream,
} from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import { ServiceUnavailableException, type INestApplication } from '@nestjs/common';

import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ROUTINE_SCHEDULER, type RoutineScheduler } from '../src/routines/routine.queue.js';
import { RoutineRunnerService } from '../src/routines/routine-runner.service.js';
import { RoutineScheduleReconciler } from '../src/routines/routine-schedule.reconciler.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { FakeProvider } from './sandbox-fakes.js';
import { privateComputerBot } from './computer-fixtures.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';

/**
 * M8-BE-01 — what a firing does, against a real database.
 *
 * The scheduler is a recorder: Redis is `routine-queue.integration.test.ts`'s
 * business, and this suite is about the row a firing reads and the rows it
 * writes. The model is a mock; the messages, the turn and the routine's
 * `lastRunAt`/`lastStatus` are real.
 */

function replyingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'routine-model',
    doStream: () => {
      const chunks: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'report ready' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        },
      ];
      return Promise.resolve({
        stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
      });
    },
  });
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M8 routine runner (real db)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let bots: BotsService;
    let runner: RoutineRunnerService;
    let reconciler: RoutineScheduleReconciler;
    const created: string[] = [];
    const calls: string[] = [];
    const inRedis: Array<{ routineId: string; pattern: string | null; tz: string | null }> = [];
    const scheduler: RoutineScheduler = {
      schedule: (r) => {
        calls.push(`schedule:${r.id}`);
        return Promise.resolve();
      },
      unschedule: (id) => {
        calls.push(`unschedule:${id}`);
        return Promise.resolve();
      },
      scheduled: () => Promise.resolve([...inRedis]),
      runNow: (id) => {
        calls.push(`runNow:${id}`);
        return Promise.resolve();
      },
    };
    const createdFrames: Array<{ botId: string; content: string }> = [];
    /** What happened, in order: computer wakes and messages posted. */
    const order: string[] = [];
    const provider = new FakeProvider();
    let sandboxes: SandboxService;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        imports: [
          (await import('../src/routines/routines.module.js')).RoutinesModule,
          // The producer a prompt routine's run is handed to (D-199).
          (await import('../src/chat/chat-delivery.module.js')).ChatDeliveryModule,
        ],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .overrideProvider(ROUTINE_SCHEDULER)
        .useValue(scheduler)
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      bots = app.get(BotsService);
      runner = app.get(RoutineRunnerService);
      reconciler = app.get(RoutineScheduleReconciler);
      sandboxes = app.get(SandboxService);
      const events = app.get(TurnEventBus);
      const emitCreated = events.emitCreated.bind(events);
      events.emitCreated = (botId, message) => {
        createdFrames.push({ botId, content: message.content });
        order.push(`message:${botId}`);
        emitCreated(botId, message);
      };
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
    });

    afterAll(async () => {
      // Leave nothing RUNNING for another suite's idle sweep to count.
      await prisma.sandbox
        .updateMany({
          where: { bots: { some: { id: { in: created } } } },
          data: { state: 'STOPPED', keepRunningUntil: null },
        })
        .catch(() => undefined);
      for (const id of created) await prisma.bot.delete({ where: { id } }).catch(() => undefined);
      await app?.close();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    beforeEach(() => {
      // Per case: `afterEach` restores every spy, this one included.
      scriptModel(app, () => replyingModel());
      order.length = 0;
      calls.length = 0;
      inRedis.length = 0;
      createdFrames.length = 0;
    });

    /**
     * A bot with its own provisioned computer: a firing now wakes it
     * (M8-BE-03), and ensure-ready refuses a workspace it cannot vouch for.
     */
    async function makeBot() {
      const bot = await privateComputerBot(prisma, provider, USER_ID, {
        name: `m8be01-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'you are a test bot',
      });
      created.push(bot.id);
      return bot;
    }

    const computerOf = (botId: string) =>
      prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } });

    async function makeRoutine(
      botId: string,
      fields: {
        prompt?: string;
        skillId?: string;
        enabled?: boolean;
        cron?: string;
        endsOn?: string;
      } = {},
    ) {
      return prisma.routine.create({
        data: {
          botId,
          name: 'morning report',
          cron: fields.cron ?? '0 9 * * *',
          timezone: 'America/New_York',
          endsOn: fields.endsOn ?? null,
          prompt:
            fields.skillId === undefined ? (fields.prompt ?? 'write the morning report') : null,
          skillId: fields.skillId ?? null,
          enabled: fields.enabled ?? true,
        },
      });
    }

    it('posts a prompt routine as a USER message, runs the turn, and records the outcome', async () => {
      const bot = await makeBot();
      const routine = await makeRoutine(bot.id, { prompt: 'summarise overnight email' });
      const before = new Date();

      const outcome = await runner.run(routine.id);

      expect(outcome).toEqual({ kind: 'ran', status: 'SUCCEEDED' });
      const rows = await prisma.message.findMany({
        where: { conversation: { botId: bot.id } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { author: true, content: true },
      });
      expect(rows).toEqual([
        { author: 'USER', content: 'summarise overnight email' },
        { author: 'BOT', content: 'report ready' },
      ]);
      const after = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
      expect(after.lastStatus).toBe('SUCCEEDED');
      expect(after.lastRunAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    describe('M8-BE-03 — the computer first, then the work', () => {
      /** Record each wake, then let the real start run (or refuse, for capacity). */
      function watchStarts(refuse = false) {
        const real = sandboxes.start.bind(sandboxes);
        return vi.spyOn(sandboxes, 'start').mockImplementation(async (userId, botId) => {
          order.push(`start:${botId}`);
          if (refuse) {
            throw new ServiceUnavailableException({
              code: 'SANDBOX_CAPACITY',
              message: 'the host is at capacity',
            });
          }
          return real(userId, botId);
        });
      }

      it('starts a stopped computer before the prompt is posted', async () => {
        const bot = await makeBot();
        const routine = await makeRoutine(bot.id, { prompt: 'check the dashboard' });
        const starts = watchStarts();
        const before = await computerOf(bot.id);
        expect(before?.state ?? 'STOPPED').not.toBe('RUNNING');

        const outcome = await runner.run(routine.id);

        expect(outcome).toEqual({ kind: 'ran', status: 'SUCCEEDED' });
        expect(starts).toHaveBeenCalledWith(USER_ID, bot.id);
        // Ordering is the claim: the wake is not a side effect of a tool. The
        // first thing posted for this bot is the prompt, and it comes after
        // the start (the reply's own frame follows it).
        const forBot = order.filter((e) => e.endsWith(bot.id));
        expect(forBot[0]).toBe(`start:${bot.id}`);
        expect(forBot.indexOf(`message:${bot.id}`)).toBeGreaterThan(0);
        const after = await computerOf(bot.id);
        expect(after?.state).toBe('RUNNING');
      });

      it('releases the keep-running lease when the work ends', async () => {
        const bot = await makeBot();
        const routine = await makeRoutine(bot.id);
        watchStarts();
        const before = new Date();

        await runner.run(routine.id);
        const ended = new Date();

        // Release stops renewing and records final activity, so §8's idle
        // period runs from the end of the work. (The deadline already bought
        // stands until it expires — release never clears it, because another
        // owner may be relying on it; see SandboxLeaseService.)
        const row = await computerOf(bot.id);
        expect(row?.lastActiveAt).not.toBeNull();
        expect(row!.lastActiveAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(row!.lastActiveAt!.getTime()).toBeLessThanOrEqual(ended.getTime());
      });

      it('on a full host: FAILED, nothing posted, so the next slot cannot answer it twice', async () => {
        const bot = await makeBot();
        const routine = await makeRoutine(bot.id, { prompt: 'this must not be posted' });
        watchStarts(true);

        await expect(runner.run(routine.id)).rejects.toThrow(ServiceUnavailableException);

        expect(await prisma.message.count({ where: { conversation: { botId: bot.id } } })).toBe(0);
        expect(order).toEqual([`start:${bot.id}`]);
        const after = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
        expect(after.lastStatus).toBe('FAILED');
      });
    });

    it('tells an open client about the message, since no request carried it', async () => {
      const bot = await makeBot();
      const routine = await makeRoutine(bot.id, { prompt: 'check the queue' });

      await runner.run(routine.id);

      expect(createdFrames).toContainEqual({ botId: bot.id, content: 'check the queue' });
    });

    it('drops a firing whose routine is gone, and removes its schedule', async () => {
      const outcome = await runner.run('cl_routine_that_never_existed');

      expect(outcome).toEqual({ kind: 'gone' });
      expect(calls).toEqual(['unschedule:cl_routine_that_never_existed']);
    });

    it('drops a firing whose routine is disabled, without posting anything', async () => {
      const bot = await makeBot();
      const routine = await makeRoutine(bot.id, { enabled: false });

      const outcome = await runner.run(routine.id);

      expect(outcome).toEqual({ kind: 'disabled' });
      expect(calls).toEqual([`unschedule:${routine.id}`]);
      expect(await prisma.message.count({ where: { conversation: { botId: bot.id } } })).toBe(0);
      const after = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
      expect(after.lastRunAt).toBeNull();
    });

    it('drops a delayed firing after its end date without posting a message', async () => {
      const bot = await makeBot();
      const routine = await makeRoutine(bot.id, { endsOn: '2020-01-01' });

      expect(await runner.run(routine.id)).toEqual({ kind: 'expired' });
      expect(calls).toEqual([`unschedule:${routine.id}`]);
      expect(await prisma.message.count({ where: { conversation: { botId: bot.id } } })).toBe(0);
      const after = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
      expect(after.lastRunAt).toBeNull();
    });

    it('records FAILED when a skill routine cannot run, and still rejects the job', async () => {
      const bot = await makeBot();
      const skill = await prisma.skill.create({
        data: {
          botId: bot.id,
          name: `draft_${randomUUID().slice(0, 8).replace(/-/g, '')}`,
          description: 'not approved yet',
          paramsSchema: { type: 'object', properties: {} },
          script: 'export default async () => {}',
          status: 'DRAFT',
        },
      });
      const routine = await makeRoutine(bot.id, { skillId: skill.id });

      await expect(runner.run(routine.id)).rejects.toThrow(/only an APPROVED skill can be run/);

      const after = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
      expect(after.lastStatus).toBe('FAILED');
      expect(after.lastRunAt).not.toBeNull();
    });

    it('records FAILED for a row with neither a prompt nor a skill, posting nothing', async () => {
      const bot = await makeBot();
      const routine = await makeRoutine(bot.id);
      await prisma.routine.update({ where: { id: routine.id }, data: { prompt: null } });

      await expect(runner.run(routine.id)).rejects.toThrow(/neither a prompt nor a skill/);

      expect(await prisma.message.count({ where: { conversation: { botId: bot.id } } })).toBe(0);
      const after = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
      expect(after.lastStatus).toBe('FAILED');
    });

    it('reconciles: schedules an enabled row Redis lacks, drops an orphan, keeps a match', async () => {
      const bot = await makeBot();
      const missing = await makeRoutine(bot.id);
      const matching = await makeRoutine(bot.id, { cron: '*/5 * * * *' });
      const disabled = await makeRoutine(bot.id, { enabled: false });
      inRedis.push(
        { routineId: matching.id, pattern: '*/5 * * * *', tz: 'America/New_York' },
        { routineId: disabled.id, pattern: '0 9 * * *', tz: 'America/New_York' },
        { routineId: 'cl_orphan_scheduler', pattern: '0 9 * * *', tz: 'America/New_York' },
      );

      const report = await reconciler.reconcile();

      // The shared database holds other suites' routines too, so this asserts
      // about the rows this case made rather than about the whole report.
      expect(report.scheduled).toContain(missing.id);
      expect(report.scheduled).not.toContain(matching.id);
      expect(report.unscheduled).toEqual(
        expect.arrayContaining([disabled.id, 'cl_orphan_scheduler']),
      );
      expect(calls).not.toContain(`schedule:${matching.id}`);
      expect(calls).not.toContain(`schedule:${disabled.id}`);
    });
  },
);
