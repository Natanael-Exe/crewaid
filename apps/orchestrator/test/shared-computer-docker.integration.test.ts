import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DockerSandboxProvider, workspaceVolumeNameFor } from '@crewaid/sandbox-docker';
import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxModule } from '../src/sandbox/sandbox.module.js';
import { BotsModule } from '../src/bots/bots.module.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';

// @skip-reason: live Docker and the built sandbox image; run with CREWAID_DOCKER_TESTS=1.
describe.skipIf(!process.env['DATABASE_URL'] || !process.env['CREWAID_DOCKER_TESTS'])(
  'shared computer (real Docker)',
  () => {
    const run = promisify(execFile);
    const userId = `docker-shared-${randomUUID()}`;
    const provider = new DockerSandboxProvider();
    let app: INestApplication;
    let prisma: PrismaService;
    let computerId = '';
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const module = await Test.createTestingModule({
        imports: [SandboxModule, BotsModule],
      }).compile();
      app = module.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      await prisma.user.create({
        data: { id: userId, name: 'Test User', email: `${userId}@test.invalid` },
      });
    });
    afterAll(async () => {
      if (computerId) {
        for (const runtime of await provider.listManagedSessions()) {
          if (runtime.botId === computerId)
            await provider.removeManagedSession({ containerId: runtime.containerId });
        }
        await run('docker', ['volume', 'rm', workspaceVolumeNameFor(computerId)]);
      }
      await prisma?.user.deleteMany({ where: { id: userId } });
      await app?.close();
    }, 120_000);
    it('shares one runtime and git workspace, survives restart and sibling deletion', async () => {
      const bots = app.get(BotsService);
      const lifecycle = app.get(SandboxService);
      const input = (name: string) => ({
        name,
        role: 'test',
        avatarColor: '#123456',
        systemPrompt: 'test',
      });
      const a = await bots.create(userId, input('A'));
      computerId = a.sandboxId;
      const b = await bots.create(userId, input('B'));
      expect(b.sandboxId).toBe(computerId);
      expect(computerId).not.toBe(a.id);
      await Promise.all([lifecycle.start(userId, a.id), lifecycle.start(userId, b.id)]);
      const runtimes = (await provider.listManagedSessions()).filter((r) => r.botId === computerId);
      expect(runtimes).toHaveLength(1);
      const session = await provider.attachSession({ sessionId: computerId });
      await session!.writeTextFile({
        path: '/home/bot/shared-proof.txt',
        content: 'shared and durable',
      });
      const tools = await run('docker', [
        'exec',
        runtimes[0]!.containerId,
        'bash',
        '-ec',
        [
          'git init /home/bot/project',
          'cd /home/bot/project',
          'git -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -m initial',
          'git worktree add -b sibling /home/bot/sibling',
          'npm --version',
          'node --version',
          'test -f /home/bot/sibling/.git',
        ].join('\n'),
      ]);
      expect(tools.stdout).toContain('v22.');
      await lifecycle.stop(userId, a.id);
      await lifecycle.start(userId, b.id);
      const resumed = await provider.attachSession({ sessionId: computerId });
      expect(await resumed!.readTextFile({ path: '/home/bot/shared-proof.txt' })).toBe(
        'shared and durable',
      );
      await bots.remove(userId, a.id);
      expect((await lifecycle.status(userId, b.id)).state).toBe('RUNNING');
      expect(await provider.attachSession({ sessionId: computerId })).not.toBeNull();
      await bots.remove(userId, b.id);
      expect(await provider.attachSession({ sessionId: computerId })).toBeNull();
      expect(await provider.inspectWorkspace({ botId: computerId })).toMatchObject({
        exists: true,
        ok: true,
      });
    }, 180_000);
  },
);
