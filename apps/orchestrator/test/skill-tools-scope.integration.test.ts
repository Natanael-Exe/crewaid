import { SeatControlService } from '../src/screen/seat-control.service.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';
import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SkillRunService } from '../src/skills/skill-run.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';

/**
 * M5-BE-06 — which skills `run_skill` can reach.
 *
 * §6/M5: "only APPROVED skills belonging to that bot or global". Both halves
 * are security properties, not conveniences: the first keeps an unreviewed
 * script from running, and the second keeps one bot's private skill out of
 * another bot's hands. The unit suite fakes the lookup, so this is the one
 * that proves the QUERY is right.
 */
/**
 * The three cases that RESOLVE a skill and then run it take a longer timeout,
 * the way `cdp-degrade.integration.test.ts` does. Resolution is the assertion,
 * but `runForBot` awaits the execution, and that goes through ensure-ready →
 * capacity admission → the fake bridge. On a shared test database that scan
 * is the slow part, and 5s is not a statement about this code.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M5-BE-06 run_skill reachability (real db)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let runs: SkillRunService;
    let mine: string;
    let other: string;

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const moduleRef = await Test.createTestingModule({
        imports: [(await import('../src/skills/skills.module.js')).SkillsModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(new FakeProvider())
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      runs = app.get(SkillRunService);
      const bots = app.get(BotsService);
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });

      const suffix = randomUUID().slice(0, 8);
      mine = (
        await bots.create(USER_ID, {
          name: `m5be06-mine-${suffix}`,
          role: 'R',
          avatarColor: '#123456',
          systemPrompt: 'x',
        })
      ).id;
      app.get(SeatControlService).seats.observed(mine);
      other = (
        await bots.create(USER_ID, {
          name: `m5be06-other-${suffix}`,
          role: 'R',
          avatarColor: '#123456',
          systemPrompt: 'x',
        })
      ).id;
    });

    afterAll(async () => {
      await prisma?.bot
        .deleteMany({ where: { userId: USER_ID, name: { startsWith: 'm5be06-' } } })
        .catch(() => undefined);
      await app?.close();
    });

    async function seedSkill(input: {
      botId: string | null;
      name: string;
      status: 'DRAFT' | 'APPROVED';
      version?: number;
    }): Promise<void> {
      await prisma.skill.create({
        data: {
          botId: input.botId,
          name: input.name,
          description: 'x',
          paramsSchema: {},
          script: 'export default async () => ({ ok: true });',
          status: input.status,
          version: input.version ?? 1,
        },
      });
    }

    it('cannot reach another bot’s skill, even by its exact name', async () => {
      // The leak this design exists to prevent. `run_skill` takes a NAME, so
      // if reachability were not scoped, naming another bot's skill would run
      // it — a private script executing on the wrong bot's computer.
      const name = `private_${randomUUID().slice(0, 6)}`;
      await seedSkill({ botId: other, name, status: 'APPROVED' });

      await expect(runs.runForBot(USER_ID, mine, name, {})).rejects.toThrow(/no APPROVED skill/);
    });

    it('cannot run a DRAFT skill of its own', async () => {
      const name = `draft_${randomUUID().slice(0, 6)}`;
      await seedSkill({ botId: mine, name, status: 'DRAFT' });

      await expect(runs.runForBot(USER_ID, mine, name, {})).rejects.toThrow(/no APPROVED skill/);
    });

    it('reaches a global skill, which the HTTP run route refuses', async () => {
      // `start` refuses botId === null because §4.1's route names no bot to
      // borrow a computer from. A turn always has one, so the refusal does
      // not apply — and §6/M5 says global skills are reachable.
      const name = `global_${randomUUID().slice(0, 6)}`;
      await seedSkill({ botId: null, name, status: 'APPROVED' });

      // Resolution is what is under test; the run itself fails on the fake
      // provider's bridge, which is a settled outcome rather than a throw.
      const outcome = await runs.runForBot(USER_ID, mine, name, {});
      expect(outcome.status).toBe('FAILED');
      expect(outcome.error).not.toBeNull();
    }, 30_000);

    it('prefers the bot’s own skill over a global one of the same name', async () => {
      // The specific beats the general — the order an operator writing a
      // bot-local override would expect.
      const name = `shared_${randomUUID().slice(0, 6)}`;
      await seedSkill({ botId: null, name, status: 'APPROVED' });
      await seedSkill({ botId: mine, name, status: 'APPROVED' });

      await runs.runForBot(USER_ID, mine, name, {});

      const run = await prisma.skillRun.findFirst({
        where: { skill: { name } },
        orderBy: { id: 'desc' },
        include: { skill: { select: { botId: true } } },
      });
      expect(run?.skill.botId).toBe(mine);
    }, 30_000);

    it('runs the newest APPROVED version of a name', async () => {
      const name = `versioned_${randomUUID().slice(0, 6)}`;
      await seedSkill({ botId: mine, name, status: 'APPROVED', version: 1 });
      await seedSkill({ botId: mine, name, status: 'APPROVED', version: 2 });

      await runs.runForBot(USER_ID, mine, name, {});

      const run = await prisma.skillRun.findFirst({
        where: { skill: { name } },
        orderBy: { id: 'desc' },
        include: { skill: { select: { version: true } } },
      });
      expect(run?.skill.version).toBe(2);
    }, 30_000);

    it('registers the skill tools into the registry the app builds', async () => {
      // The last mile: SkillToolsRegistrar runs onModuleInit, so a registry
      // missing these means no bot has them however correct the tools are.
      //
      // `send_message` is no longer among them. M7-BE-01 gave it a body and
      // moved it to the module that owns its delivery queue, so it registers
      // from `SendMessageRegistrar` and this module no longer knows about it.
      const { ToolRegistry } = await import('../src/agent/tool-registry.js');
      const registry = app.get(ToolRegistry);

      expect(registry.names()).toEqual(expect.arrayContaining(['run_skill', 'attach_file']));
      expect(registry.names()).not.toContain('send_message');
      expect(registry.behaviorOf('run_skill').origin.kind).toBe('builtin');
    });
  },
);
