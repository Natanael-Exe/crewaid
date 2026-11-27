/**
 * The whole approval path through production composition: a real engine parks
 * on a policy prompt, the operator's answer is admitted, and a continuation
 * built from nothing but database rows dispatches the approved call once.
 * Every runtime here is fresh, which is what a restarted process has.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import type { ExecutionResume } from '../src/agent/execution/execution-backend.port.js';
import { admitOwnedToolResumeBatch } from '../src/agent/persistence/owned-resume-admission.js';
import { RunLeaseService, type RunLease } from '../src/agent/persistence/run-lease.js';
import { ResolutionSchema } from '../src/agent/policy/proposal-store.js';
import { readAdmittedResume } from '../src/agent/persistence/owned-tanstack-persistence.js';
import { createRunEventLog, RunEventWakeups } from '../src/agent/persistence/run-event-log.js';
import {
  ownedThread,
  produceOwned,
  userMessage,
  type OwnedResume,
  type OwnedThread,
} from './mod-ai06-owned-harness.js';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';
import { EventType, type StreamChunk, type TextOptions } from '@tanstack/ai';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('MOD-AI-06 owned approval resume end to end (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'ownedresume' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await prisma.$disconnect();
  });

  const thread = () => ownedThread(prisma, owner.userId);
  const produce = (
    t: OwnedThread,
    lease: RunLease,
    action: (args: Json) => Promise<unknown>,
    resume?: OwnedResume,
    options?: {
      readonly leases?: RunLeaseService;
      readonly maxSteps?: number;
      readonly adapter?: ScriptedAdapter;
    },
  ) => produceOwned(prisma, t, lease, action, resume, options);

  async function parked() {
    const t = await thread();
    const never = vi.fn(async () => 'must not run');
    expect((await produce(t, t.first, never)).status).toBe('interrupted');
    expect(never).not.toHaveBeenCalled();
    const proposals = await prisma.runInterrupt.findMany({ where: { runId: t.first.runId } });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status: 'pending', nativeStatus: 'pending' });
    expect(
      await prisma.agentTurn.findUniqueOrThrow({ where: { id: t.first.runId } }),
    ).toMatchObject({ status: 'interrupted', workerId: null, activeKey: null });
    const proposal = proposals[0]!;
    const answer = (payload: { approved: boolean; editedArgs?: Json }): ExecutionResume[] => [
      { interruptId: proposal.nativeInterruptId!, status: 'resolved', payload },
    ];
    const scope = {
      userId: owner.userId,
      botId: t.botId,
      threadId: t.threadId,
      parentRunId: t.first.runId,
    };
    return { t, proposal, answer, scope };
  }

  it('parks, admits an edited approval and dispatches it once from a fresh runtime', async () => {
    const { t, proposal, answer, scope } = await parked();
    const batch = answer({ approved: true, editedArgs: { to: 'edited@example.test' } });
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch);
    const action = vi.fn(async (args: Json) => ({ sent: args }));

    const outcome = await produce(t, lease, action, { parentRunId: t.first.runId, batch });
    expect(outcome.status).toBe('completed');
    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith({ to: 'edited@example.test' });

    const row = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } });
    // Native consumption committed inside the continuation's closing transaction.
    expect(row).toMatchObject({ status: 'resolved', nativeStatus: 'resolved' });
    expect(ResolutionSchema.parse(row.response).dispatchedAt).toBeDefined();
    expect(await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } })).toMatchObject({
      status: 'completed',
      resumesRunId: t.first.runId,
      workerId: null,
      activeKey: null,
    });
    // Both runs' delivery logs are closed and end on their terminal event, so a
    // reader joining either replays it and finishes instead of tailing forever.
    for (const runId of [t.first.runId, lease.runId]) {
      const events = [];
      const log = createRunEventLog(
        prisma,
        { userId: owner.userId, botId: t.botId, threadId: t.threadId, runId },
        { wakeups: new RunEventWakeups() },
      );
      for await (const entry of log.read('-1')) events.push(entry.chunk.type);
      expect(events.at(-1)).toBe('RUN_FINISHED');
      expect(
        (await prisma.agentTurn.findUniqueOrThrow({ where: { id: runId } })).eventsClosedAt,
      ).not.toBeNull();
    }
    // The approval was answered once: a second admission finds nothing pending.
    await expect(admitOwnedToolResumeBatch(prisma, scope, batch)).rejects.toThrow();
  });

  it('a declined answer completes the continuation without dispatching', async () => {
    const { t, proposal, answer, scope } = await parked();
    const batch = answer({ approved: false });
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch);
    const action = vi.fn(async () => 'must not run');
    expect((await produce(t, lease, action, { parentRunId: t.first.runId, batch })).status).toBe(
      'completed',
    );
    expect(action).not.toHaveBeenCalled();
    expect(
      await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } }),
    ).toMatchObject({ status: 'resolved', nativeStatus: 'resolved' });
  });

  it('a worker that dies inside the tool is taken over without repeating it', async () => {
    const { t, answer, scope } = await parked();
    const batch = answer({ approved: true });
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch);
    // The first worker hangs inside the effect; its process is gone in all but name.
    const dying = vi.fn(() => new Promise<never>(() => undefined));
    void produce(t, lease, dying, { parentRunId: t.first.runId, batch });
    await vi.waitFor(() => expect(dying).toHaveBeenCalledOnce());

    await prisma.agentTurn.update({
      where: { id: lease.runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const takeover = await new RunLeaseService(prisma).claim({
      userId: owner.userId,
      botId: t.botId,
      threadId: t.threadId,
      runId: lease.runId,
      triggerMessageId: t.triggerMessageId,
    });
    if (takeover.kind !== 'claimed') throw new Error('expected an expired-lease takeover');
    expect(takeover.recovered).toBe(true);

    const action = vi.fn(async () => 'must not run');
    const outcome = await produce(t, takeover.lease, action, {
      parentRunId: t.first.runId,
      batch,
    });
    expect(outcome.status).toBe('completed');
    // The marker survives the dead worker: the effect may have happened, so it never repeats.
    expect(action).not.toHaveBeenCalled();
    expect(dying).toHaveBeenCalledOnce();
  });

  it('a continuation counts its parent chain against the run ceilings', async () => {
    const { t, proposal, answer, scope } = await parked();
    // The parked run's own share is on its row; pretend earlier steps used the ceiling.
    await prisma.agentTurn.update({ where: { id: t.first.runId }, data: { stepIndex: 3 } });
    const batch = answer({ approved: true });
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch);
    const action = vi.fn(async () => 'must not run');
    const outcome = await produce(
      t,
      lease,
      action,
      { parentRunId: t.first.runId, batch },
      { maxSteps: 3 },
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.stoppedBy).toBeDefined();
    expect(action).not.toHaveBeenCalled();
    // Even though the ceiling ended the continuation before chat() ran, the
    // native interrupt must be settled so later messages do not strand the thread.
    expect(
      await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } }),
    ).toMatchObject({ status: 'resolved', nativeStatus: 'resolved' });
    const nextMsg = await userMessage(prisma, t.botId, t.threadId, 'carry on');
    const nextClaim = await new RunLeaseService(prisma).claim({
      userId: owner.userId,
      botId: t.botId,
      threadId: t.threadId,
      runId: randomUUID(),
      triggerMessageId: nextMsg,
    });
    if (nextClaim.kind !== 'claimed') throw new Error('expected next claim');
    expect((await produce(t, nextClaim.lease, action)).status).toBe('completed');
  });

  it('settles native interrupts when a resumed run fails after tool execution so later turns stay usable', async () => {
    const { t, proposal, answer, scope } = await parked();
    const batch = answer({ approved: true });
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch);
    const action = vi.fn(async () => ({ ok: true }));

    class TimeoutAfterToolAdapter extends ScriptedAdapter {
      override async *chatStream(
        options: TextOptions<Record<string, never>>,
      ): AsyncIterable<StreamChunk> {
        const runId = options.runId ?? randomUUID();
        const threadId = options.threadId ?? randomUUID();
        yield {
          type: EventType.RUN_STARTED,
          runId,
          threadId,
          timestamp: Date.now(),
        } as StreamChunk;
        yield {
          type: EventType.RUN_ERROR,
          runId,
          threadId,
          timestamp: Date.now(),
          code: 'TIMEOUT',
          message: 'Upstream model timed out',
        } as StreamChunk;
      }
    }

    const failed = await produce(
      t,
      lease,
      action,
      { parentRunId: t.first.runId, batch },
      { adapter: new TimeoutAfterToolAdapter() },
    );
    expect(failed.status).toBe('failed');
    expect(action).toHaveBeenCalledOnce();
    // The answered parent closes with its continuation; left `interrupted`, it
    // kept the bot "working" for good (deletes refused, nothing to Stop).
    expect(
      await prisma.agentTurn.findUniqueOrThrow({ where: { id: t.first.runId } }),
    ).toMatchObject({ status: 'failed', endedAt: expect.any(Date) });
    expect(
      await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposal.id } }),
    ).toMatchObject({ status: 'resolved', nativeStatus: 'resolved' });

    // A follow-up turn (e.g. automatic retry or user saying "Please try again.")
    // must start cleanly rather than failing with InterruptResumeValidationError.
    const nextMsg = await userMessage(prisma, t.botId, t.threadId, 'Please try again.');
    const nextClaim = await new RunLeaseService(prisma).claim({
      userId: owner.userId,
      botId: t.botId,
      threadId: t.threadId,
      runId: randomUUID(),
      triggerMessageId: nextMsg,
    });
    if (nextClaim.kind !== 'claimed') throw new Error('expected next claim');
    const retryAction = vi.fn(async () => 'must not repeat');
    const nextOutcome = await produce(t, nextClaim.lease, retryAction);
    expect(nextOutcome.status).toBe('completed');
    expect(retryAction).not.toHaveBeenCalled();
  });

  it("records each run's own steps and time, including the paused one", async () => {
    const { t, answer, scope } = await parked();
    const parent = await prisma.agentTurn.findUniqueOrThrow({ where: { id: t.first.runId } });
    // The pause recorded its time; the paused step completes in the continuation.
    expect(parent.stepIndex).toBe(0);
    expect(parent.workingMs).toBeGreaterThanOrEqual(0);
    const batch = answer({ approved: true });
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch);
    await produce(t, lease, async () => 'sent', { parentRunId: t.first.runId, batch });
    const continuation = await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } });
    expect(continuation.stepIndex).toBeGreaterThanOrEqual(1);
  });

  it("the heartbeat keeps a producer's lease through work longer than the lease", async () => {
    const { t, answer, scope } = await parked();
    const batch = answer({ approved: true });
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch, { leaseMs: 1_000 });
    const leases = new RunLeaseService(prisma, { leaseMs: 1_000, heartbeatMs: 200 });
    const slow = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve('sent'), 2_500)));
    const outcome = await produce(
      t,
      lease,
      slow,
      { parentRunId: t.first.runId, batch },
      { leases },
    );
    expect(outcome.status).toBe('completed');
    expect(slow).toHaveBeenCalledOnce();
  });

  it('a producer whose lease is taken over stops without touching the new owner', async () => {
    const { t, answer, scope } = await parked();
    const batch = answer({ approved: true });
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch, { leaseMs: 1_000 });
    const leases = new RunLeaseService(prisma, { leaseMs: 1_000, heartbeatMs: 200 });
    let release: () => void = () => undefined;
    const stuck = vi.fn(() => new Promise((resolve) => (release = () => resolve('sent'))));
    const first = produce(t, lease, stuck, { parentRunId: t.first.runId, batch }, { leases });
    await vi.waitFor(() => expect(stuck).toHaveBeenCalledOnce());
    // Another worker finds the lease expired and claims the run.
    await prisma.agentTurn.update({
      where: { id: lease.runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const takeover = await new RunLeaseService(prisma).claim({
      userId: owner.userId,
      botId: t.botId,
      threadId: t.threadId,
      runId: lease.runId,
      triggerMessageId: t.triggerMessageId,
    });
    if (takeover.kind !== 'claimed') throw new Error('expected a takeover');
    // The old producer's next renewal fails; let its tool return into an aborted run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    // Its next event is refused by the delivery log's epoch fence, so it fails loudly.
    await expect(first).rejects.toMatchObject({ code: 'STALE_WRITER' });
    expect(await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } })).toMatchObject({
      status: 'running',
      workerId: takeover.lease.workerId,
      driverEpoch: takeover.lease.epoch,
    });
  });

  it('new input or a forged continuation cannot resurrect a consumed decision', async () => {
    const { t, answer, scope } = await parked();
    const batch = answer({ approved: true });
    const { lease } = await admitOwnedToolResumeBatch(prisma, scope, batch);
    const sent = vi.fn(async () => 'sent');
    await produce(t, lease, sent, { parentRunId: t.first.runId, batch });
    expect(sent).toHaveBeenCalledOnce();

    // A new message asking for the same thing is a new decision, not the old one.
    const again = vi.fn(async () => 'must not run');
    const next = await userMessage(prisma, t.botId, t.threadId, 'gated again');
    const claim = await new RunLeaseService(prisma).claim({
      userId: owner.userId,
      botId: t.botId,
      threadId: t.threadId,
      runId: randomUUID(),
      triggerMessageId: next,
    });
    if (claim.kind !== 'claimed') throw new Error('fixture');
    expect((await produce(t, claim.lease, again, undefined)).status).toBe('interrupted');
    expect(again).not.toHaveBeenCalled();
    expect(
      await prisma.runInterrupt.count({ where: { runId: claim.lease.runId, status: 'pending' } }),
    ).toBe(1);
    // Close that pause so the bot is free for the forgery below.
    await prisma.runInterrupt.updateMany({
      where: { runId: claim.lease.runId },
      data: {
        status: 'cancelled',
        resolvedAt: new Date(),
        nativeStatus: 'cancelled',
        nativeResolvedAt: new Date(),
      },
    });

    // A run inserted as if it continued the consumed parent, replaying the batch.
    const forged = await prisma.agentTurn.create({
      data: {
        id: randomUUID(),
        botId: t.botId,
        conversationId: t.threadId,
        triggerMessageId: t.triggerMessageId,
        status: 'running',
        resumesRunId: t.first.runId,
      },
    });
    const forgedClaim = await new RunLeaseService(prisma).claim({
      userId: owner.userId,
      botId: t.botId,
      threadId: t.threadId,
      runId: forged.id,
      triggerMessageId: t.triggerMessageId,
    });
    if (forgedClaim.kind !== 'claimed') throw new Error('fixture');
    // Its rows hold nothing left to resume, and a replayed batch dispatches nothing.
    expect(await readAdmittedResume(prisma, forgedClaim.lease)).toEqual({
      parentRunId: t.first.runId,
      batch: [],
    });
    const replay = vi.fn(async () => 'must not run');
    await produce(t, forgedClaim.lease, replay, { parentRunId: t.first.runId, batch });
    expect(replay).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledOnce();
  });
});
