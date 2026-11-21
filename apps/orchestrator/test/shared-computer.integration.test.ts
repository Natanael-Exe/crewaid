import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { BotsService } from '../src/bots/bots.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { SandboxModule } from '../src/sandbox/sandbox.module.js';
import { BotsModule } from '../src/bots/bots.module.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { SandboxIdleService } from '../src/sandbox/sandbox-idle.service.js';
import { SandboxActivityService } from '../src/sandbox/sandbox-activity.service.js';
import { SandboxHealthService } from '../src/sandbox/sandbox-health.service.js';
import { SandboxRetentionService } from '../src/sandbox/sandbox-retention.service.js';
import { SandboxReconciliationService } from '../src/sandbox/sandbox-reconciliation.service.js';
import { FakeProvider } from './sandbox-fakes.js';
import { SeatService } from '../src/sandbox/seat.service.js';
import { conversationIdOf } from './turn-fixtures.js';

// Real PostgreSQL proves the shared row leases and ownership; runtime I/O is counted.
describe.skipIf(!process.env['DATABASE_URL'])('shared computer lifecycle', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bots: BotsService;
  let sandboxes: SandboxService;
  let userId: string;
  let a: string;
  let b: string;
  let computerId: string;
  const provider = new FakeProvider();
  const input = () => ({
    name: randomUUID(),
    role: 'test',
    avatarColor: '#123456',
    systemPrompt: 'test',
  });
  const old = () => new Date(Date.now() - 120_000);
  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const module = await Test.createTestingModule({ imports: [SandboxModule, BotsModule] })
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue(provider)
      .compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    bots = app.get(BotsService);
    sandboxes = app.get(SandboxService);
  });
  beforeEach(async () => {
    provider.reset();
    userId = `shared-${randomUUID()}`;
    await prisma.user.create({
      data: { id: userId, name: 'Test User', email: `${userId}@test.invalid` },
    });
    const first = await bots.create(userId, input());
    a = first.id;
    computerId = first.sandboxId;
    b = (await bots.create(userId, input())).id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.user.delete({ where: { id: userId } });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('starts once through two bots and announces start and stop under both bot ids', async () => {
    const emit = vi.spyOn(app.get(TurnEventBus), 'emitSandboxState');
    provider.createDelayMs = 80;
    const results = await Promise.all([sandboxes.start(userId, a), sandboxes.start(userId, b)]);
    expect(results.map((r) => r.botId)).toEqual([a, b]);
    expect(results.every((r) => r.state === 'RUNNING')).toBe(true);
    expect(provider.createCalls).toBe(1);
    expect(
      emit.mock.calls
        .filter((c) => c[1] === 'RUNNING')
        .map((c) => c[0])
        .sort(),
    ).toEqual([a, b].sort());
    await sandboxes.stop(userId, b);
    expect(provider.stopCallsFor(computerId)).toBe(1);
    expect(
      emit.mock.calls
        .filter((c) => c[1] === 'STOPPED')
        .map((c) => c[0])
        .sort(),
    ).toEqual([a, b].sort());
    expect((await sandboxes.status(userId, a)).state).toBe('STOPPED');
  });

  it('preserves a sibling runtime and storage on deletion, destroying only after the last bot', async () => {
    await sandboxes.start(userId, a);
    await bots.remove(userId, a);
    expect(provider.destroyCalls).toBe(0);
    expect((await sandboxes.status(userId, b)).state).toBe('RUNNING');
    expect(provider.workspaces.has(computerId)).toBe(true);
    await bots.remove(userId, b);
    expect(provider.destroyCalls).toBe(1);
    expect(await prisma.sandbox.findUnique({ where: { id: computerId } })).toBeNull();
    expect(provider.workspaces.has(computerId)).toBe(true);
  });

  it('does not stop an older running sibling when a newer turn has completed', async () => {
    await sandboxes.start(userId, a);
    await prisma.sandbox.update({ where: { id: computerId }, data: { lastActiveAt: old() } });
    await prisma.agentTurn.create({
      data: {
        botId: a,
        conversationId: await conversationIdOf(prisma, a),
        triggerMessageId: randomUUID(),
        status: 'running',
        startedAt: new Date(0),
      },
    });
    await prisma.agentTurn.create({
      data: {
        botId: b,
        conversationId: await conversationIdOf(prisma, b),
        triggerMessageId: randomUUID(),
        status: 'completed',
        startedAt: old(),
        endedAt: old(),
      },
    });
    vi.stubEnv('SANDBOX_IDLE_STOP_MS', '1000');
    const idle = new SandboxIdleService(prisma, sandboxes, app.get(SandboxActivityService));
    vi.unstubAllEnvs();
    await idle.sweep();
    expect(provider.stopCallsFor(computerId)).toBe(0);
    await prisma.agentTurn.updateMany({
      where: { botId: a },
      data: { status: 'completed', endedAt: old() },
    });
    await idle.sweep();
    expect(provider.stopCallsFor(computerId)).toBe(1);
  });

  it('retention keys ownership on the computer after its original bot has gone', async () => {
    await bots.remove(userId, a);
    vi.spyOn(provider, 'listWorkspaces').mockResolvedValue([{ botId: computerId }]);
    const retain = vi.spyOn(provider, 'retainWorkspace');
    const service = new SandboxRetentionService(prisma, provider);
    await service.sweep();
    expect(retain).toHaveBeenLastCalledWith(
      expect.objectContaining({ botId: computerId, orphaned: false }),
    );
    await bots.remove(userId, b);
    await service.sweep();
    expect(retain).toHaveBeenLastCalledWith(
      expect.objectContaining({ botId: computerId, orphaned: true }),
    );
  });

  it('announces health failures to every attached bot', async () => {
    await sandboxes.start(userId, a);
    const emit = vi.spyOn(app.get(TurnEventBus), 'emitSandboxState');
    provider.healthBySession.set(computerId, { ok: false, reason: 'bridge down' });
    await app.get(SandboxHealthService).sweep();
    expect(
      emit.mock.calls
        .filter((c) => c[1] === 'UNHEALTHY' && [a, b].includes(c[0]))
        .map((c) => c[0])
        .sort(),
    ).toEqual([a, b].sort());
  });

  it('recognizes a runtime by computer identity when neither tenant has that id', async () => {
    await sandboxes.start(userId, a);
    provider.runtimes.push({
      botId: computerId,
      sessionId: computerId,
      containerId: `container-${computerId}`,
      running: true,
      workspace: { ok: true, volumeName: `crewaid-workspace-${computerId}` },
    });
    await app.get(SandboxReconciliationService).sweep();
    expect(provider.removedContainerIds).not.toContain(`container-${computerId}`);
    expect((await sandboxes.status(userId, b)).state).toBe('RUNNING');
  });

  it('rejects a foreign principal through either bot without touching the computer', async () => {
    await expect(sandboxes.start('foreign', a)).rejects.toThrow('Bot not found');
    await expect(sandboxes.stop('foreign', b)).rejects.toThrow('Bot not found');
    await expect(bots.remove('foreign', b)).rejects.toThrow('Bot not found');
    expect(provider.createCalls + provider.destroyCalls + provider.stopCalls).toBe(0);
  });
});

/**
 * M5-BE-24 — a seat leaves with its tenant.
 *
 * A seat is a window on a machine that outlives the bot it belonged to. Before
 * this, deleting a bot from a shared machine left its window open and its RFB
 * port held for as long as the machine ran — a leak nothing reaped, and one
 * that shows up as a machine that can no longer seat a new bot.
 */
describe.skipIf(!process.env['DATABASE_URL'])('a departing tenant takes its seat', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bots: BotsService;
  let userId: string;
  const provider = new FakeProvider();
  const released: Array<{ sessionId: string; botId: string }> = [];
  const seats = {
    releaseSeat: async (sessionId: string, botId: string) => {
      released.push({ sessionId, botId });
      return true;
    },
    seatFor: async () => null,
  };
  const input = () => ({
    name: randomUUID(),
    role: 'test',
    avatarColor: '#123456',
    systemPrompt: 'test',
  });

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const module = await Test.createTestingModule({ imports: [SandboxModule, BotsModule] })
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue(provider)
      .overrideProvider(SeatService)
      .useValue(seats)
      .compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    bots = app.get(BotsService);
    userId = `seat-tenant-${randomUUID()}`;
    await prisma.user.create({
      data: { id: userId, name: 'Test User', email: `${userId}@test.invalid` },
    });
  });

  afterAll(async () => {
    await prisma?.bot.deleteMany({ where: { userId } });
    await prisma?.sandbox.deleteMany({ where: { userId } });
    await prisma?.user.deleteMany({ where: { id: userId } });
    await app?.close();
  });

  beforeEach(() => {
    released.length = 0;
    provider.retiredProfiles.length = 0;
  });

  it('closes the seat when the machine outlives the bot', async () => {
    const stays = await bots.create(userId, input());
    const goes = await bots.create(userId, input());
    expect(goes.sandboxId).toBe(stays.sandboxId);

    await bots.remove(userId, goes.id);

    expect(released).toEqual([{ sessionId: stays.sandboxId, botId: goes.id }]);
    expect(provider.retiredProfiles).toEqual([{ computerId: stays.sandboxId, botId: goes.id }]);
    await bots.remove(userId, stays.id);
  });

  it('does not ask a machine that is being destroyed', async () => {
    // The last tenant takes the container with it, and the seat's window goes
    // with the container. Asking would be a call into something on its way
    // out, and its only possible answer is a timeout.
    const only = await bots.create(userId, input());

    await bots.remove(userId, only.id);

    expect(released).toEqual([]);
  });

  it('reports a deletion that committed, even when the seat will not close', async () => {
    // The bot is gone and the row is committed. A window left open is a leak
    // for reconciliation, not a reason to tell the operator their delete
    // failed and leave them retrying a bot that no longer exists.
    const stays = await bots.create(userId, input());
    const goes = await bots.create(userId, input());
    const boom = vi
      .spyOn(seats, 'releaseSeat')
      .mockRejectedValueOnce(new Error('the machine stopped answering'));

    await expect(bots.remove(userId, goes.id)).resolves.toBeUndefined();
    expect(await prisma.bot.findUnique({ where: { id: goes.id } })).toBeNull();

    boom.mockRestore();
    await bots.remove(userId, stays.id);
  });
});
