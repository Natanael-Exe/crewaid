/** PostgreSQL, rather than a process-local map, arbitrates producer ownership. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from '@tanstack/ai';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  assertRunLease,
  RunLeaseService,
  type RunLease,
} from '../src/agent/persistence/run-lease.js';
import { createPrismaMessageStore } from '../src/agent/persistence/prisma-message-store.js';
import { toTranscriptRow } from '../src/agent/persistence/transcript.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const id = () => randomUUID();

describe.skipIf(!DATABASE_URL)('MOD-AI-06 producer leases (real db)', () => {
  const prisma = new PrismaService();
  const leases = new RunLeaseService(prisma);
  let owner: SignedInUser;
  let stranger: SignedInUser;

  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'modai06' });
    stranger = await signIn(prisma, { label: 'modai06x' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await signOutAndDelete(prisma, stranger.userId);
    await prisma.$disconnect();
  });

  async function fixture() {
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: id(),
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
      },
    });
    const thread = await prisma.conversation.create({ data: { botId: bot.id } });
    const triggerMessageId = id();
    const row = toTranscriptRow(
      { id: triggerMessageId, role: 'user', content: 'hello' },
      { threadBotId: bot.id, runId: null },
    );
    if (!row.ok) throw new Error('fixture');
    await prisma.message.create({ data: { conversationId: thread.id, ...row.value } });
    return {
      userId: owner.userId,
      botId: bot.id,
      threadId: thread.id,
      runId: id(),
      triggerMessageId,
    };
  }
  async function claim(input: Awaited<ReturnType<typeof fixture>>, service = leases) {
    const result = await service.claim(input);
    expect(result.kind).toBe('claimed');
    if (result.kind !== 'claimed') throw new Error('fixture claim');
    return result.lease;
  }
  async function row(lease: RunLease) {
    return prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } });
  }
  async function expire(lease: RunLease) {
    await prisma.$executeRaw`
      UPDATE "AgentTurn" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
      WHERE id = ${lease.runId} AND "workerId" = ${lease.workerId}`;
  }
  function writer(lease: RunLease) {
    return createPrismaMessageStore(prisma, {
      userId: lease.userId,
      runId: lease.runId,
      fence: (tx) => assertRunLease(tx, lease),
    });
  }

  it('claims an admitted trigger, persists an opaque worker and joins healthy repeats', async () => {
    const input = await fixture();
    const lease = await claim(input);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(lease.epoch).toBe(1);
    expect(lease.workerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await row(lease)).toMatchObject({ activeKey: input.botId, driverEpoch: 1 });
    expect(await new RunLeaseService(prisma).claim(input)).toMatchObject({
      kind: 'joined',
      run: { id: lease.runId, workerId: lease.workerId },
    });
    await expect(leases.assertLive(lease)).resolves.toBeUndefined();
  });

  it('serializes simultaneous deliveries into exactly one producer', async () => {
    const input = await fixture();
    const claims = await Promise.all([
      leases.claim(input),
      new RunLeaseService(prisma).claim(input),
      leases.claim(input),
    ]);
    expect(claims.filter((r) => r.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((r) => r.kind === 'joined')).toHaveLength(2);
    expect(await prisma.agentTurn.count({ where: { conversationId: input.threadId } })).toBe(1);
  });

  it('refuses a different run while the bot has a producer, including expired ownership', async () => {
    const input = await fixture();
    const lease = await claim(input);
    await expect(leases.claim({ ...input, runId: id() })).rejects.toMatchObject({
      code: 'RUN_BUSY',
    });
    await expire(lease);
    await expect(leases.claim({ ...input, runId: id() })).rejects.toMatchObject({
      code: 'RUN_BUSY',
    });
  });

  it('refuses foreign principals, wrong bot/thread pairs and foreign triggers without inserting', async () => {
    const input = await fixture();
    const other = await fixture();
    for (const attempt of [
      { ...input, userId: stranger.userId },
      { ...input, threadId: other.threadId },
      { ...input, botId: other.botId },
      { ...input, triggerMessageId: other.triggerMessageId },
      { ...input, triggerMessageId: id() },
    ]) {
      await expect(leases.claim(attempt)).rejects.toMatchObject({ code: 'RUN_NOT_OWNED' });
    }
    expect(await prisma.agentTurn.count({ where: { conversationId: input.threadId } })).toBe(0);
  });

  it('refuses non-user canonical triggers', async () => {
    const input = await fixture();
    const body = toTranscriptRow(
      { id: id(), role: 'assistant', content: 'a reply' },
      { threadBotId: input.botId, runId: id() },
    );
    if (!body.ok) throw new Error('fixture');
    // This assertion is about author/parts validation; an orphan runId is not needed.
    const reply = await prisma.message.create({
      data: { conversationId: input.threadId, ...body.value, runId: null },
    });
    await expect(leases.claim({ ...input, triggerMessageId: reply.id })).rejects.toMatchObject({
      code: 'RUN_NOT_OWNED',
    });
  });

  it('does not disclose or take a globally colliding run ID', async () => {
    const first = await fixture();
    const winner = await claim(first);
    const second = await fixture();
    await expect(leases.claim({ ...second, runId: winner.runId })).rejects.toMatchObject({
      code: 'RUN_CONFLICT',
    });
    expect(await row(winner)).toMatchObject({ workerId: winner.workerId, driverEpoch: 1 });
    expect(await prisma.agentTurn.count({ where: { conversationId: second.threadId } })).toBe(0);
  });

  it('does not rebind a known run to a different trigger', async () => {
    const input = await fixture();
    const lease = await claim(input);
    await expect(leases.claim({ ...input, triggerMessageId: id() })).rejects.toMatchObject({
      code: 'RUN_CONFLICT',
    });
    expect(await row(lease)).toMatchObject({ triggerMessageId: input.triggerMessageId });
  });

  it('renews only an unexpired owned worker/epoch and refuses forged capabilities', async () => {
    const input = await fixture();
    const lease = await claim(input);
    const before = (await row(lease)).leaseExpiresAt!;
    await expect(leases.renew(lease)).resolves.toBe(true);
    expect((await row(lease)).leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    for (const changed of [
      { workerId: id() },
      { epoch: lease.epoch + 1 },
      { userId: stranger.userId },
      { botId: id() },
      { threadId: id() },
    ]) {
      await expect(leases.renew({ ...lease, ...changed })).resolves.toBe(false);
      await expect(leases.assertLive({ ...lease, ...changed })).rejects.toBeDefined();
    }
    await expire(lease);
    await expect(leases.renew(lease)).resolves.toBe(false);
    await expect(leases.assertLive(lease)).rejects.toMatchObject({ code: 'STALE_WORKER' });
  });

  it('increments epoch at takeover and fences stale finish, release and transcript writes', async () => {
    const input = await fixture();
    const stale = await claim(input);
    const store = writer(stale);
    const history = await store.loadThread(input.threadId);
    await expire(stale);
    const result = await leases.claim(input);
    expect(result).toMatchObject({ kind: 'claimed', recovered: true });
    if (result.kind !== 'claimed') throw new Error('fixture takeover');
    const winner = result.lease;
    expect(winner.epoch).toBe(stale.epoch + 1);
    expect(winner.workerId).not.toBe(stale.workerId);
    await expect(
      store.saveThread(input.threadId, [...history, { role: 'assistant', content: 'stale reply' }]),
    ).rejects.toMatchObject({ code: 'STALE_WORKER' });
    await expect(
      store.reserve(input.threadId, { role: 'tool', toolCallId: 'stale-tool' }),
    ).rejects.toMatchObject({ code: 'STALE_WORKER' });
    await expect(leases.finish(stale, 'completed')).rejects.toMatchObject({ code: 'STALE_WORKER' });
    await expect(leases.release(stale)).resolves.toBe(false);
    await expect(leases.renew(stale)).resolves.toBe(false);
    expect(await prisma.message.count({ where: { conversationId: input.threadId } })).toBe(1);
    expect(await row(winner)).toMatchObject({
      workerId: winner.workerId,
      activeKey: input.botId,
      status: 'running',
    });
    await expect(leases.assertLive(winner)).resolves.toBeUndefined();
    await writer(winner).saveThread(input.threadId, [
      ...history,
      { role: 'assistant', content: 'winner reply' },
    ]);
    expect(await prisma.message.count({ where: { conversationId: input.threadId } })).toBe(2);
  });

  it('refuses an unfenced leased writer before and after terminal release', async () => {
    const input = await fixture();
    const lease = await claim(input);
    const store = createPrismaMessageStore(prisma, { userId: input.userId, runId: input.runId });
    const history = await store.loadThread(input.threadId);
    const attempted: ModelMessage[] = [...history, { role: 'assistant', content: 'unfenced' }];
    await expect(store.saveThread(input.threadId, attempted)).rejects.toMatchObject({
      code: 'STALE_WRITER',
    });
    await leases.finish(lease, 'completed');
    await expect(store.saveThread(input.threadId, attempted)).rejects.toMatchObject({
      code: 'STALE_WRITER',
    });
    expect(await prisma.message.count({ where: { conversationId: input.threadId } })).toBe(1);
  });

  it('rolls back the whole transcript write if its transactional fence refuses', async () => {
    const input = await fixture();
    const lease = await claim(input);
    const failing = createPrismaMessageStore(prisma, {
      userId: input.userId,
      runId: input.runId,
      fence: async (tx) => {
        await assertRunLease(tx, lease);
        await tx.agentTurn.updateMany({ where: { id: input.runId }, data: { inputTokens: 99 } });
        throw new Error('fence refused');
      },
    });
    const history = await failing.loadThread(input.threadId);
    await expect(
      failing.saveThread(input.threadId, [
        ...history,
        { role: 'assistant', content: 'must roll back' },
      ]),
    ).rejects.toThrow('fence refused');
    expect(await prisma.message.count({ where: { conversationId: input.threadId } })).toBe(1);
    expect((await row(lease)).inputTokens).toBe(0);
  });

  it('parks a run without a terminal end, keeps its proposal and blocks a new unreviewed run', async () => {
    const input = await fixture();
    const lease = await claim(input);
    const proposal = await prisma.runInterrupt.create({
      data: {
        runId: input.runId,
        conversationId: input.threadId,
        userId: input.userId,
        payload: { fixture: true },
      },
    });
    await leases.finish(lease, 'interrupted');
    expect(await row(lease)).toMatchObject({
      status: 'interrupted',
      activeKey: null,
      workerId: null,
      leaseExpiresAt: null,
      endedAt: null,
    });
    expect(await leases.claim(input)).toMatchObject({
      kind: 'joined',
      run: { status: 'interrupted' },
    });
    expect(await prisma.runInterrupt.findUnique({ where: { id: proposal.id } })).toMatchObject({
      status: 'pending',
    });
    await expect(leases.claim({ ...input, runId: id() })).rejects.toMatchObject({
      code: 'RUN_BUSY',
    });
  });

  it.each(['completed', 'failed', 'aborted'] as const)(
    'atomically closes %s ownership and joins later deliveries',
    async (next) => {
      const input = await fixture();
      const lease = await claim(input);
      await leases.finish(lease, next);
      expect(await row(lease)).toMatchObject({
        status: next,
        activeKey: null,
        workerId: null,
        leaseExpiresAt: null,
      });
      expect((await row(lease)).endedAt).not.toBeNull();
      expect(await leases.claim(input)).toMatchObject({ kind: 'joined', run: { status: next } });
      await expect(leases.finish(lease, next)).rejects.toMatchObject({ code: 'STALE_WORKER' });
    },
  );

  it('cancellation revokes renewals, dispatch and writes while allowing an owned abort', async () => {
    const input = await fixture();
    const lease = await claim(input);
    await prisma.agentTurn.update({ where: { id: input.runId }, data: { cancelRequested: true } });
    await expect(leases.renew(lease)).resolves.toBe(false);
    await expect(leases.assertLive(lease)).rejects.toMatchObject({ code: 'STALE_WORKER' });
    await expect(
      writer(lease).reserve(input.threadId, { role: 'tool', toolCallId: 'cancelled-tool' }),
    ).rejects.toMatchObject({ code: 'STALE_WORKER' });
    await expect(leases.finish(lease, 'completed')).rejects.toMatchObject({ code: 'STALE_WORKER' });
    await expire(lease);
    expect(await leases.claim(input)).toMatchObject({
      kind: 'joined',
      run: { cancelRequested: true },
    });
    // An expired producer cannot acknowledge anything; a still-live one can abort.
    await expect(leases.finish(lease, 'aborted')).rejects.toMatchObject({ code: 'STALE_WORKER' });
    const liveInput = await fixture();
    const live = await claim(liveInput);
    await prisma.agentTurn.update({ where: { id: live.runId }, data: { cancelRequested: true } });
    await leases.finish(live, 'aborted');
    expect((await row(live)).status).toBe('aborted');
  });

  it('explicit release permits takeover but cannot be renewed back to health', async () => {
    const input = await fixture();
    const lease = await claim(input);
    await expect(leases.release(lease)).resolves.toBe(true);
    await expect(leases.renew(lease)).resolves.toBe(false);
    expect(await row(lease)).toMatchObject({ status: 'running', activeKey: input.botId });
    expect(await leases.claim(input)).toMatchObject({
      kind: 'claimed',
      recovered: true,
      lease: { epoch: 2 },
    });
  });

  it('heartbeat renews without overlap, waits for stop and reports ownership loss once', async () => {
    const input = await fixture();
    const service = new RunLeaseService(prisma, { leaseMs: 2000, heartbeatMs: 30 });
    const lease = await claim(input, service);
    const renew = vi.spyOn(service, 'renew');
    const lost = vi.fn();
    const heart = service.heartbeat(lease, lost);
    try {
      await vi.waitFor(() => expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2), {
        timeout: 1500,
      });
      await service.assertLive(lease);
      await service.release(lease);
      await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1), { timeout: 1500 });
    } finally {
      await heart.stop();
    }
    const calls = renew.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(renew).toHaveBeenCalledTimes(calls);
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ code: 'STALE_WORKER' }));
    renew.mockRestore();
  });

  it('refuses malformed leases and a legacy active producer with no lease', async () => {
    const input = await fixture();
    await prisma.agentTurn.create({
      data: {
        id: input.runId,
        botId: input.botId,
        conversationId: input.threadId,
        triggerMessageId: input.triggerMessageId,
        activeKey: input.botId,
      },
    });
    await expect(leases.claim(input)).rejects.toMatchObject({ code: 'RUN_BUSY' });
    await prisma.agentTurn.update({ where: { id: input.runId }, data: { workerId: id() } });
    await expect(leases.claim(input)).rejects.toMatchObject({ code: 'STALE_WORKER' });
  });

  it('discovers only expired leased work in bounded server batches without claiming it', async () => {
    const healthyInput = await fixture();
    const healthy = await claim(healthyInput);
    const expiredInput = await fixture();
    const expired = await claim(expiredInput);
    await expire(expired);
    const unleased = await fixture();
    await prisma.agentTurn.create({
      data: {
        id: unleased.runId,
        botId: unleased.botId,
        conversationId: unleased.threadId,
        triggerMessageId: unleased.triggerMessageId,
        activeKey: unleased.botId,
      },
    });
    const parkedInput = await fixture();
    const parked = await claim(parkedInput);
    await leases.finish(parked, 'interrupted');
    const before = await row(expired);
    const candidates = await leases.expiredCandidates();
    expect(candidates).toContainEqual(expiredInput);
    for (const runId of [healthy.runId, unleased.runId, parked.runId])
      expect(candidates.some((candidate) => candidate.runId === runId)).toBe(false);
    expect(await leases.expiredCandidates(1)).toHaveLength(1);
    expect(await row(expired)).toEqual(before);
    for (const limit of [0, -1, 101, 1.5])
      await expect(leases.expiredCandidates(limit)).rejects.toThrow(
        'Invalid execution recovery batch size.',
      );
  });
});
