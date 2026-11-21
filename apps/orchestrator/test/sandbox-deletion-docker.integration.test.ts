import { privateComputerBot } from './computer-fixtures.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DockerSandboxProvider, workspaceVolumeNameFor } from '@crewaid/sandbox-docker';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SandboxRetentionService } from '../src/sandbox/sandbox-retention.service.js';
import { SINGLETON_USER_ID } from '../src/auth/singleton-user.js';

// @skip-reason: needs live PostgreSQL, ARTIFACT_DIR and the built sandbox image;
// M2 gate owner runs this with CREWAID_DOCKER_TESTS=1 (declared in turbo globalEnv).
const skip = !process.env['DATABASE_URL'] || !process.env['CREWAID_DOCKER_TESTS'];
const run = promisify(execFile);
const token = 'm2-deletion-regression-token';

describe.skipIf(skip)('bot deletion and workspace retention (HTTP + real Docker)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let botId = '';
  let containerId = '';
  const provider = new DockerSandboxProvider();
  beforeAll(async () => {
    vi.stubEnv('ORCH_API_TOKEN', token);
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.user.upsert({
      where: { id: SINGLETON_USER_ID },
      create: {
        id: SINGLETON_USER_ID,
        name: 'Test User',
        email: `${SINGLETON_USER_ID}@test.invalid`,
      },
      update: {},
    });
  });
  afterAll(async () => {
    if (containerId) await run('docker', ['rm', '-f', containerId]).catch(() => undefined);
    if (botId) {
      await prisma.bot.deleteMany({ where: { id: botId } });
      await run('docker', ['volume', 'rm', workspaceVolumeNameFor(botId)]).catch(() => undefined);
    }
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('removes the running container within ten seconds, preserves files, then reaps after seven days', async () => {
    const created = await privateComputerBot(prisma, provider, SINGLETON_USER_ID, {
      name: `delete-${randomUUID()}`,
      role: 'test',
      avatarColor: '#123456',
      systemPrompt: 'test',
    });
    botId = created.id;
    await request(app.getHttpServer())
      .post(`/api/v1/bots/${botId}/sandbox/start`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const session = await provider.attachSession({ sessionId: botId });
    expect(session).not.toBeNull();
    containerId = session!.containerId;
    await session!.writeTextFile({ path: '/home/bot/keep.txt', content: 'preserve my workspace' });
    await session!.writeTextFile({ path: '/home/bot/.crewaid-orphaned-at', content: '1000' });
    await session!.writeTextFile({
      path: '/home/bot/fcntl.py',
      content: "raise RuntimeError('workspace code must not run')",
    });
    expect(
      await provider.retainWorkspace({
        botId,
        orphaned: false,
        now: Date.now(),
        retentionMs: 7 * 86_400_000,
      }),
    ).toBe('retained');
    expect(await session!.readTextFile({ path: '/home/bot/.crewaid-orphaned-at' })).toBe('');
    await request(app.getHttpServer()).delete(`/api/v1/bots/${botId}`).expect(401);
    expect(await prisma.bot.findUnique({ where: { id: botId } })).not.toBeNull();
    const started = Date.now();
    await request(app.getHttpServer())
      .delete(`/api/v1/bots/${botId}`)
      .auth(token, { type: 'bearer' })
      .expect(204);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await provider.attachSession({ sessionId: botId })).toBeNull();
    expect(await prisma.sandbox.findFirst({ where: { bots: { some: { id: botId } } } })).toBeNull();
    expect(await provider.inspectWorkspace({ botId })).toMatchObject({ exists: true, ok: true });
    const saved = await run('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'cat',
      '-v',
      `${workspaceVolumeNameFor(botId)}:/home/bot:ro`,
      process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev',
      '/home/bot/keep.txt',
    ]);
    expect(saved.stdout).toBe('preserve my workspace');

    // Restrict inventory to this test's volume; never sweep unrelated local workspaces.
    vi.spyOn(provider, 'listWorkspaces').mockResolvedValue([{ botId }]);
    const first = Date.now();
    const reaper = new SandboxRetentionService(prisma, provider);
    await reaper.sweep(first);
    // A new service/provider has no in-memory clock to inherit.
    const restartedProvider = new DockerSandboxProvider();
    vi.spyOn(restartedProvider, 'listWorkspaces').mockResolvedValue([{ botId }]);
    const restarted = new SandboxRetentionService(prisma, restartedProvider);
    await restarted.sweep(first + 7 * 86_400_000 - 1);
    expect(await provider.inspectWorkspace({ botId })).toMatchObject({ exists: true });
    // Restoring the original database identity protects the saved workspace and
    // clears its clock. A later deletion gets a full new grace period.
    await prisma.bot.create({
      data: {
        id: botId,
        userId: SINGLETON_USER_ID,
        name: `restored-${botId}`,
        role: 'test',
        avatarColor: '#123456',
        systemPrompt: 'test',
      },
    });
    await prisma.sandbox.create({
      data: { id: botId, userId: SINGLETON_USER_ID, bots: { connect: { id: botId } } },
    });
    await restarted.sweep(first + 7 * 86_400_000);
    expect(await provider.inspectWorkspace({ botId })).toMatchObject({ exists: true });
    await prisma.bot.delete({ where: { id: botId } });
    await prisma.sandbox.delete({ where: { id: botId } });
    const second = first + 8 * 86_400_000;
    await restarted.sweep(second);
    await restarted.sweep(second + 7 * 86_400_000 - 1);
    expect(await provider.inspectWorkspace({ botId })).toMatchObject({ exists: true });
    await restarted.sweep(second + 7 * 86_400_000);
    expect(await provider.inspectWorkspace({ botId })).toEqual({ exists: false });
  }, 120_000);
});
