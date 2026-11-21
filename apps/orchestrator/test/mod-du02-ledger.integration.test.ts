/** D-197: the dispatch ledger on a real run — settlement, and the fence on a stale worker. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import { RunLeaseService } from '../src/agent/persistence/run-lease.js';
import { createDispatchLedger } from '../src/agent/policy/dispatch-ledger.js';
import { ownedThread, produceOwned } from './mod-ai06-owned-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('MOD-DU-02 dispatch ledger (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'du02ledger' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await prisma.$disconnect();
  });

  async function settledAfter(action: () => Promise<unknown>) {
    const t = await ownedThread(prisma, owner.userId);
    await produceOwned(prisma, t, t.first, action, undefined, { mode: 'FULL', ledger: true });
    return prisma.toolDispatch.findMany({ where: { conversationId: t.threadId } });
  }

  it('settles a write that returned as COMMITTED', async () => {
    expect(await settledAfter(async () => 'sent')).toEqual([
      expect.objectContaining({ toolName: 'send_email', effect: 'unknown', status: 'COMMITTED' }),
    ]);
  });

  it('settles a tool that says nothing was sent as REFUSED, and any other throw as UNCERTAIN', async () => {
    expect(
      await settledAfter(async () => {
        throw new Error('SEAT_BUSY: no action was dispatched.');
      }),
    ).toEqual([expect.objectContaining({ status: 'REFUSED' })]);
    expect(
      await settledAfter(async () => {
        throw new Error('socket hang up');
      }),
    ).toEqual([expect.objectContaining({ status: 'UNCERTAIN' })]);
  });

  it('refuses a worker that lost its run, and a second reservation of one call', async () => {
    const t = await ownedThread(prisma, owner.userId);
    const scope = { userId: owner.userId, conversationId: t.threadId, runId: t.first.runId };
    const call = { toolCallId: 'call-1', toolName: 'send_email', effect: 'unknown', args: {} };
    const current = createDispatchLedger(prisma, scope, t.first);
    const first = await current.reserve(call);
    expect(first.kind).toBe('reserved');
    expect(await current.reserve(call)).toEqual({ kind: 'existing', status: 'DISPATCHED' });

    // Taken over: the old epoch can start nothing in this run.
    await prisma.agentTurn.update({
      where: { id: t.first.runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const takeover = await new RunLeaseService(prisma).claim({
      userId: owner.userId,
      botId: t.botId,
      threadId: t.threadId,
      triggerMessageId: t.triggerMessageId,
      runId: t.first.runId,
    });
    if (takeover.kind !== 'claimed') throw new Error('fixture');
    await expect(current.reserve({ ...call, toolCallId: 'call-2' })).rejects.toThrow(
      'STALE_WORKER',
    );
    expect(await prisma.toolDispatch.count({ where: { conversationId: t.threadId } })).toBe(1);
    const fresh = createDispatchLedger(prisma, scope, takeover.lease);
    expect((await fresh.reserve({ ...call, toolCallId: 'call-2' })).kind).toBe('reserved');
  });
});
