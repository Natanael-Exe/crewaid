import { computerId, privateComputerBot } from './computer-fixtures.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxReconciliationService } from '../src/sandbox/sandbox-reconciliation.service.js';
import {
  SANDBOX_PROVIDER,
  type SandboxRuntimeObservation,
} from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const USER_ID = 'usr_crewaid_singleton_v1';

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'M2-BE-12 sandbox reconciliation (real db)',
  () => {
    let app: INestApplication;
    let bots: BotsService;
    let prisma: PrismaService;
    let reconciliation: SandboxReconciliationService;
    let provider: FakeProvider;
    let botId: string;
    const createdBotIds: string[] = [];

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      provider = new FakeProvider();
      const moduleRef = await Test.createTestingModule({
        imports: [
          (await import('../src/sandbox/sandbox.module.js')).SandboxModule,
          // SandboxModule no longer pulls in the whole of bots (M5-BE-14 moved
          // TurnEventBus out to break the cycle), so a suite that reaches for
          // BotsService imports it itself.
          (await import('../src/bots/bots.module.js')).BotsModule,
        ],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .compile();

      app = moduleRef.createNestApplication();
      await app.init();
      bots = app.get(BotsService);
      prisma = app.get(PrismaService);
      reconciliation = app.get(SandboxReconciliationService);
      // This provider observes only this suite's runtimes. Read their real
      // database rows through the same client, rather than diagnosing every
      // unrelated computer against an intentionally empty fake inventory.
      const findComputers = prisma.sandbox.findMany.bind(prisma.sandbox);
      vi.spyOn(prisma.sandbox, 'findMany').mockImplementation((args) =>
        findComputers({ ...args, where: { ...args?.where, id: { in: createdBotIds } } }),
      );
      await prisma.user.upsert({
        where: { id: USER_ID },
        create: { id: USER_ID, name: 'Test User', email: `${USER_ID}@test.invalid` },
        update: {},
      });
    });

    afterAll(async () => {
      await prisma?.bot.deleteMany({ where: { id: { in: createdBotIds } } }).catch(() => undefined);
      await prisma?.sandbox
        .deleteMany({ where: { id: { in: createdBotIds } } })
        .catch(() => undefined);
      vi.restoreAllMocks();
      await app?.close();
    });

    beforeEach(async () => {
      provider.reset();
      const bot = await privateComputerBot(prisma, provider, USER_ID, {
        name: `m2be12-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      botId = bot.id;
      // These cases simulate runtime creation before database persistence.
      await prisma.sandbox.delete({ where: { id: await computerId(prisma, botId) } });
      createdBotIds.push(botId);
    });

    it('preserves a never-started workspace but diagnoses a lost stopped runtime', async () => {
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
        },
      });
      await reconciliation.sweep();
      expect(
        await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } }),
      ).toMatchObject({
        state: 'STOPPED',
        lastStartedAt: null,
      });
      await prisma.sandbox.update({
        where: { id: await computerId(prisma, botId) },
        data: { sessionId: botId, lastStartedAt: new Date() },
      });
      provider.history.set(botId, { referenced: false, runtimeCreatedAt: Date.now() });
      await reconciliation.sweep();
      expect(
        await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } }),
      ).toMatchObject({
        state: 'UNHEALTHY',
      });
      expect(provider.createCalls).toBe(0);
      expect(provider.workspaces.has(botId)).toBe(true);
    });

    it('adopts a provisioned-but-unrecorded container on a known computer', async () => {
      await prisma.sandbox.create({
        data: {
          id: botId,
          state: 'STARTING',
          lastStartedAt: new Date(0),
          userId: USER_ID,
          bots: { connect: { id: botId } },
        },
      });
      provider.runtimes.push(runtimeFor(botId));
      provider.existing = true;

      await reconciliation.sweep();

      expect(provider.resumeCalls).toBe(1);
      expect(provider.createCalls).toBe(0);
      await expect(
        prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } }),
      ).resolves.toMatchObject({
        state: 'RUNNING',
        sessionId: botId,
        containerId: `container-${botId}`,
        vncPort: 32768,
        cdpPort: 32769,
        bridgePort: 32770,
      });
    });

    it('adopts a stopped unrecorded container without bypassing start admission', async () => {
      await prisma.sandbox.create({
        data: { id: botId, userId: USER_ID, bots: { connect: { id: botId } } },
      });
      provider.runtimes.push({ ...runtimeFor(botId), running: false });
      provider.existing = true;

      await reconciliation.sweep();

      expect(provider.resumeCalls).toBe(0);
      expect(provider.createCalls).toBe(0);
      expect(provider.stopCalls).toBe(0);
      await expect(
        prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } }),
      ).resolves.toMatchObject({
        state: 'STOPPED',
        sessionId: botId,
        containerId: `container-${botId}`,
      });
    });

    it('keeps a stopped runtime stopped after workspace backfill marked its history unknown', async () => {
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
          state: 'UNHEALTHY',
          lastError: 'unknown history',
        },
      });
      provider.runtimes.push({ ...runtimeFor(botId), running: false });
      provider.existing = true;
      await reconciliation.sweep();
      expect(provider.resumeCalls).toBe(0);
      expect(
        await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } }),
      ).toMatchObject({
        state: 'STOPPED',
        containerId: `container-${botId}`,
      });
    });

    it('recovers a stale STARTING lease by adopting its existing runtime', async () => {
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
          state: 'STARTING',
          lastStartedAt: new Date(Date.now() - 10 * 60_000),
        },
      });
      provider.runtimes.push(runtimeFor(botId));
      provider.existing = true;

      await reconciliation.sweep();

      expect(provider.resumeCalls).toBe(1);
      await expect(
        prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } }),
      ).resolves.toMatchObject({
        state: 'RUNNING',
        sessionId: botId,
        containerId: `container-${botId}`,
      });
    });

    it('surfaces a missing runtime without creating a replacement or touching its workspace', async () => {
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
          state: 'RUNNING',
          sessionId: botId,
          containerId: `gone-${botId}`,
        },
      });
      provider.workspaces.set(botId, {
        exists: true,
        ok: true,
        volumeName: `crewaid-workspace-${botId}`,
      });

      await reconciliation.sweep();

      expect(provider.createCalls).toBe(0);
      expect(provider.removedContainerIds).toEqual([]);
      expect(provider.workspaces.get(botId)).toEqual({
        exists: true,
        ok: true,
        volumeName: `crewaid-workspace-${botId}`,
      });
      const row = await prisma.sandbox.findFirstOrThrow({
        where: { bots: { some: { id: botId } } },
      });
      expect(row.state).toBe('UNHEALTHY');
      expect(row.containerId).toBeNull();
      expect(row.lastError).toMatch(/runtime .* is missing.*workspace .* was preserved/i);
    });

    it('removes a runtime orphan after bot deletion and leaves its workspace observation intact', async () => {
      const deletedBotId = `deleted-${randomUUID()}`;
      provider.runtimes.push(runtimeFor(deletedBotId));
      provider.workspaces.set(deletedBotId, {
        exists: true,
        ok: true,
        volumeName: `crewaid-workspace-${deletedBotId}`,
      });

      await reconciliation.sweep();

      expect(provider.removedContainerIds).toEqual([`container-${deletedBotId}`]);
      expect(provider.workspaces.has(deletedBotId)).toBe(true);
    });

    it('finishes partial teardown by stopping, not removing, the recorded container', async () => {
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
          state: 'STOPPED',
          sessionId: botId,
          containerId: `container-${botId}`,
        },
      });
      provider.runtimes.push(runtimeFor(botId));
      provider.existing = true;

      await reconciliation.sweep();

      expect(provider.stopCallsFor(botId)).toBe(1);
      expect(provider.removedContainerIds).toEqual([]);
      await expect(
        prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } }),
      ).resolves.toMatchObject({
        state: 'STOPPED',
        sessionId: botId,
        containerId: `container-${botId}`,
      });
    });

    it('removes duplicate writers before adopting the recorded container', async () => {
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
          state: 'RUNNING',
          sessionId: botId,
          containerId: `container-${botId}`,
        },
      });
      provider.runtimes.push(runtimeFor(botId), runtimeFor(botId, `container-duplicate-${botId}`));
      provider.existing = true;

      await reconciliation.sweep();

      expect(provider.removedContainerIds).toEqual([`container-duplicate-${botId}`]);
      expect(provider.resumeCalls).toBe(1);
      await expect(
        prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } }),
      ).resolves.toMatchObject({
        state: 'RUNNING',
        containerId: `container-${botId}`,
      });
    });

    it('removes an inconsistent runtime and records a recoverable error', async () => {
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
          state: 'RUNNING',
          sessionId: botId,
          containerId: `container-${botId}`,
        },
      });
      provider.runtimes.push({
        ...runtimeFor(botId),
        workspace: { ok: false, reason: 'workspace volume is absent' },
      });

      await reconciliation.sweep();

      expect(provider.removedContainerIds).toEqual([`container-${botId}`]);
      expect(provider.createCalls).toBe(0);
      const row = await prisma.sandbox.findFirstOrThrow({
        where: { bots: { some: { id: botId } } },
      });
      expect(row.state).toBe('UNHEALTHY');
      expect(row.containerId).toBeNull();
      expect(row.lastError).toMatch(/inconsistent.*workspace volume is absent/i);
    });

    it('does not steal a fresh STARTING lease from another orchestrator', async () => {
      const startedAt = new Date();
      await prisma.sandbox.create({
        data: {
          id: botId,
          userId: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).userId,
          bots: { connect: { id: botId } },
          state: 'STARTING',
          lastStartedAt: startedAt,
        },
      });
      provider.runtimes.push(runtimeFor(botId));
      provider.existing = true;

      await reconciliation.sweep();

      expect(provider.resumeCalls).toBe(0);
      await expect(
        prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } }),
      ).resolves.toMatchObject({
        state: 'STARTING',
        lastStartedAt: startedAt,
      });
    });
  },
);

function runtimeFor(botId: string, containerId = `container-${botId}`): SandboxRuntimeObservation {
  return {
    botId,
    sessionId: botId,
    containerId,
    running: true,
    workspace: { ok: true, volumeName: `crewaid-workspace-${botId}` },
  };
}
