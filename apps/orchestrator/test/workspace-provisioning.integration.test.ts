import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { BotsModule } from '../src/bots/bots.module.js';
import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxWorkspaceService } from '../src/sandbox/sandbox-workspace.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { FakeProvider } from './sandbox-fakes.js';

// Requires Postgres; CI supplies DATABASE_URL. Docker semantics are tested separately.
describe.skipIf(!process.env['DATABASE_URL'])(
  'shared computer provisioning (real database)',
  () => {
    let userId: string;
    let app: INestApplication;
    let prisma: PrismaService;
    let bots: BotsService;
    let workspaces: SandboxWorkspaceService;
    const provider = new FakeProvider();
    const input = () => ({
      name: `provision-${randomUUID()}`,
      role: 'test',
      avatarColor: '#123456',
      systemPrompt: 'test',
    });
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const module = await Test.createTestingModule({ imports: [BotsModule] })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .compile();
      app = module.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      bots = app.get(BotsService);
      workspaces = app.get(SandboxWorkspaceService);
    });
    beforeEach(async () => {
      provider.reset();
      userId = `provision-user-${randomUUID()}`;
      await prisma.user.create({
        data: { id: userId, name: 'Test User', email: `${userId}@test.invalid` },
      });
    });
    afterEach(async () => {
      await prisma.user.delete({ where: { id: userId } });
    });
    afterAll(async () => {
      await app?.close();
    });

    it('concurrently creates twelve bots on one computer with one volume and no runtime', async () => {
      const created = await Promise.all(
        Array.from({ length: 12 }, () => bots.create(userId, input())),
      );
      const id = created[0]!.sandboxId;
      expect(new Set(created.map((bot) => bot.sandboxId))).toEqual(new Set([id]));
      expect(created.every((bot) => bot.id !== id)).toBe(true);
      expect(provider.workspaces.get(id)).toMatchObject({ exists: true, ok: true });
      expect(await prisma.sandbox.findUnique({ where: { id } })).toMatchObject({
        userId,
        state: 'STOPPED',
        sessionId: null,
        containerId: null,
      });
      for (const bot of created)
        expect(await prisma.conversation.count({ where: { botId: bot.id } })).toBe(1);
      expect(provider.provisionCalls).toBe(1);
      expect(provider.createCalls).toBe(0);
    });

    it('attaches to an occupied computer without entering capacity admission', async () => {
      const first = await bots.create(userId, input());
      await prisma.sandbox.update({ where: { id: first.sandboxId }, data: { state: 'RUNNING' } });
      const second = await bots.create(userId, input());
      expect(second.sandboxId).toBe(first.sandboxId);
      expect(provider.provisionCalls).toBe(1);
      expect(provider.createCalls).toBe(0);
    });

    it('duplicates onto the source computer even when another computer sorts first', async () => {
      const source = await bots.create(userId, input());
      await prisma.sandbox.create({ data: { id: `aaa-${randomUUID()}`, userId } });
      await prisma.skill.create({
        data: {
          botId: source.id,
          name: 'copied_skill',
          description: 'test',
          paramsSchema: {},
          script: 'test',
          version: 1,
          status: 'DRAFT',
        },
      });
      provider.failProvisionWith = new Error('must not provision');
      const clone = await bots.duplicate(userId, source.id);
      expect(clone.sandboxId).toBe(source.sandboxId);
      expect(await prisma.skill.count({ where: { botId: clone.id } })).toBe(1);
      expect(await prisma.conversation.count({ where: { botId: clone.id } })).toBe(1);
      expect(provider.provisionCalls).toBe(1);
    });

    it('rolls back failed first provisioning and leaves storage to retention', async () => {
      const failed = input();
      provider.failProvisionWith = new Error('disk unavailable');
      const before = new Set(provider.workspaces.keys());
      await expect(bots.create(userId, failed)).rejects.toThrow('disk unavailable');
      expect(await prisma.bot.count({ where: { userId } })).toBe(0);
      expect(await prisma.sandbox.count({ where: { userId } })).toBe(0);
      const orphan = [...provider.workspaces.keys()].find((id) => !before.has(id))!;
      expect(provider.workspaces.has(orphan)).toBe(true);
      provider.failProvisionWith = null;
      expect((await bots.create(userId, failed)).sandboxId).not.toBe(orphan);
    });

    it('retries legacy provisioning and attaches all detached siblings on the next sweep', async () => {
      const a = await prisma.bot.create({ data: { userId, ...input() } });
      const b = await prisma.bot.create({ data: { userId, ...input() } });
      const inventory = vi.spyOn(prisma.bot, 'findMany').mockResolvedValue([a, b]);
      const provision = vi
        .spyOn(provider, 'provisionWorkspace')
        .mockRejectedValueOnce(new Error('daemon unavailable'));
      try {
        await workspaces.sweep();
        expect((await prisma.bot.findUniqueOrThrow({ where: { id: a.id } })).sandboxId).toBeNull();
        const machine = (await prisma.bot.findUniqueOrThrow({ where: { id: b.id } })).sandboxId;
        expect(machine).not.toBeNull();
        await workspaces.sweep();
        expect((await prisma.bot.findUniqueOrThrow({ where: { id: a.id } })).sandboxId).toBe(
          machine,
        );
        expect(provider.createCalls).toBe(0);
      } finally {
        inventory.mockRestore();
        provision.mockRestore();
      }
    });

    it('backfills concurrent detached bots once and checks ownership before provisioning', async () => {
      const a = await prisma.bot.create({ data: { userId, ...input() } });
      const b = await prisma.bot.create({ data: { userId, ...input() } });
      await expect(workspaces.ensure('foreign-user', a.id)).rejects.toThrow('Bot not found');
      expect(provider.provisionCalls).toBe(0);
      await Promise.all([a, b, a, b, a].map((bot) => workspaces.ensure(userId, bot.id)));
      expect(provider.provisionCalls).toBe(1);
      expect(await prisma.sandbox.count({ where: { userId } })).toBe(1);
    });

    it('never recreates missing storage or adopts unknown runtime history', async () => {
      const bot = await bots.create(userId, input());
      provider.history.set(bot.sandboxId, { referenced: false, runtimeCreatedAt: Date.now() });
      await expect(workspaces.ensure(userId, bot.id)).rejects.toThrow('runtime history');
      provider.workspaces.delete(bot.sandboxId);
      await expect(workspaces.ensure(userId, bot.id)).rejects.toThrow('Workspace missing');
      expect(provider.provisionCalls).toBe(1);
      expect(provider.createCalls).toBe(0);
    });

    it('serializes provisioning and deletion without resurrecting the bot', async () => {
      const bot = await prisma.bot.create({ data: { userId, ...input() } });
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      provider.onProvision = async () => {
        entered();
        await gate;
      };
      const provisioning = workspaces.ensure(userId, bot.id);
      await started;
      const deletion = bots.remove(userId, bot.id);
      release();
      await Promise.all([provisioning, deletion]);
      expect(await prisma.bot.findUnique({ where: { id: bot.id } })).toBeNull();
      expect(await prisma.sandbox.count({ where: { userId } })).toBe(0);
      await expect(workspaces.ensure(userId, bot.id)).rejects.toThrow('Bot not found');
    });
  },
);
