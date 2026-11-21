/** Library conformance uses explicit fixture authority; producer fencing has its own PostgreSQL suite. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineAIPersistence } from '@tanstack/ai-persistence';
import { runPersistenceConformance } from '@tanstack/ai-persistence/testkit';
import { ModelErrorCodeSchema } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  createPrismaRunStore,
  assertLeasedRunWrite,
  projectRunError,
  type RunAdmission,
  type RunStoreAuthority,
} from '../src/agent/persistence/prisma-run-store.js';
import { toTranscriptRow } from '../src/agent/persistence/transcript.js';
import { RunLeaseService } from '../src/agent/persistence/run-lease.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const id = () => randomUUID();

describe.skipIf(!DATABASE_URL)('MOD-AI-06 scoped Prisma RunStore (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  let stranger: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'runstore' });
    stranger = await signIn(prisma, { label: 'runstorex' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await signOutAndDelete(prisma, stranger.userId);
    await prisma.$disconnect();
  });

  function fixture(actor: SignedInUser, projector = projectRunError) {
    const threads = new Map<string, RunAdmission>();
    const authority: RunStoreAuthority = {
      transaction: (operation) => prisma.$transaction(operation),
      projectError: projector,
      assertWrite: async (_tx, row) => {
        // Fixture maintenance can patch only its unclaimed rows. No producer capability is granted.
        if (row.workerId !== null || row.activeKey !== null)
          throw new Error('fixture cannot write a producer');
      },
      admitNew: async (tx, input) => {
        let admission = threads.get(input.threadId);
        if (admission === undefined) {
          const bot = await tx.bot.create({
            data: {
              userId: actor.userId,
              name: id(),
              role: 'fixture',
              avatarColor: '#8B6F47',
              systemPrompt: '',
            },
          });
          await tx.conversation.create({
            data: { id: input.threadId, botId: bot.id },
          });
          const triggerMessageId = id();
          const body = toTranscriptRow(
            { id: triggerMessageId, role: 'user', content: 'fixture' },
            { threadBotId: bot.id, runId: null },
          );
          if (!body.ok) throw new Error('fixture');
          await tx.message.create({ data: { conversationId: input.threadId, ...body.value } });
          admission = { botId: bot.id, threadId: input.threadId, triggerMessageId };
          threads.set(input.threadId, admission);
        }
        return admission;
      },
    };
    return {
      authority,
      store: createPrismaRunStore(prisma, { userId: actor.userId }, authority),
      threads,
    };
  }

  // The exact upstream suite is unmodified. This slice provides runs only;
  // transcript reconciliation is tested in MOD-AI-04, interrupts remain in progress,
  // metadata/generation stores are outside this backend, and subagents are explicitly omitted (D-178).
  runPersistenceConformance(
    'Prisma runs with explicit fixture admission',
    () => {
      const { store } = fixture(owner, (error) => error); // Known synthetic conformance error values only.
      return defineAIPersistence({ stores: { runs: store } });
    },
    {
      skip: ['messages', 'interrupts', 'metadata', 'generationRuns', 'artifacts', 'blobs'],
      skipMethods: ['runs.listByParentRun'],
      checks: ['runs.listByThread.state'],
    },
  );

  it('serializes concurrent insert-if-absent without overwriting the first timestamp', async () => {
    const f = fixture(owner);
    const threadId = id();
    await f.store.createOrResume({ runId: id(), threadId, startedAt: 1 });
    const runId = id();
    const records = await Promise.all(
      [10, 20, 30].map((startedAt) => f.store.createOrResume({ runId, threadId, startedAt })),
    );
    expect(new Set(records.map((r) => r.startedAt)).size).toBe(1);
    expect(await prisma.agentTurn.count({ where: { id: runId } })).toBe(1);
    expect(await prisma.agentTurn.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      workerId: null,
      leaseExpiresAt: null,
      driverEpoch: null,
      activeKey: null,
    });
  });

  it('does not return or mutate foreign runs and keeps colliding IDs opaque', async () => {
    const f = fixture(owner);
    const foreign = fixture(stranger);
    const saved = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 10 });
    expect(await foreign.store.get(saved.runId)).toBeNull();
    expect(await foreign.store.findActiveRun(saved.threadId)).toBeNull();
    expect(await foreign.store.listByThread(saved.threadId)).toEqual([]);
    await foreign.store.update(saved.runId, { status: 'failed' });
    await expect(
      foreign.store.createOrResume({ runId: saved.runId, threadId: id(), startedAt: 100 }),
    ).rejects.toMatchObject({ code: 'RUN_CONFLICT' });
    expect(await f.store.get(saved.runId)).toEqual(saved);
  });

  it('refuses a creation callback that returns a foreign bot or a noncanonical trigger', async () => {
    const f = fixture(owner);
    const foreign = fixture(stranger);
    const saved = await foreign.store.createOrResume({ runId: id(), threadId: id(), startedAt: 1 });
    const bad = createPrismaRunStore(
      prisma,
      { userId: owner.userId },
      { ...f.authority, admitNew: async () => foreign.threads.get(saved.threadId)! },
    );
    await expect(
      bad.createOrResume({ runId: id(), threadId: saved.threadId, startedAt: 2 }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_ADMITTED' });
    const known = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 1 });
    const a = f.threads.get(known.threadId)!;
    await prisma.message.update({ where: { id: a.triggerMessageId }, data: { parts: {} } });
    await expect(
      f.store.createOrResume({ runId: id(), threadId: known.threadId, startedAt: 2 }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_ADMITTED' });
  });

  it('rolls back all writes made by a refusing transactional authority', async () => {
    const f = fixture(owner);
    const saved = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 1 });
    const refused = createPrismaRunStore(
      prisma,
      { userId: owner.userId },
      {
        ...f.authority,
        assertWrite: async (tx, row) => {
          await tx.agentTurn.update({ where: { id: row.id }, data: { inputTokens: 123 } });
          throw new Error('refused authority');
        },
      },
    );
    await expect(
      refused.update(saved.runId, {
        status: 'completed',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      }),
    ).rejects.toThrow('refused authority');
    expect(await f.store.get(saved.runId)).toEqual(saved);
  });

  it('uses the captured real producer lease and refuses stale record updates after takeover', async () => {
    const f = fixture(owner);
    const run = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 1 });
    const admission = f.threads.get(run.threadId)!;
    const leases = new RunLeaseService(prisma);
    const input = { userId: owner.userId, runId: run.runId, ...admission };
    const first = await leases.claim(input);
    if (first.kind !== 'claimed') throw new Error('fixture lease');
    const producer = createPrismaRunStore(
      prisma,
      { userId: owner.userId },
      {
        ...f.authority,
        assertWrite: (tx, row, patch) => assertLeasedRunWrite(tx, row, patch, first.lease),
      },
    );
    await producer.update(run.runId, {
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    const unrelated = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 2 });
    await expect(producer.update(unrelated.runId, { status: 'completed' })).rejects.toMatchObject({
      code: 'STALE_WORKER',
    });
    expect(await f.store.get(unrelated.runId)).toEqual(unrelated);
    await expect(
      producer.update(run.runId, { driverEpoch: first.lease.epoch + 1 }),
    ).rejects.toMatchObject({ code: 'STALE_WORKER' });
    await expect(producer.update(run.runId, { cancelRequested: false })).rejects.toMatchObject({
      code: 'STALE_WORKER',
    });
    await leases.release(first.lease);
    const second = await leases.claim(input);
    if (second.kind !== 'claimed') throw new Error('fixture takeover');
    const before = await prisma.agentTurn.findUniqueOrThrow({ where: { id: run.runId } });
    await expect(producer.update(run.runId, { status: 'completed' })).rejects.toMatchObject({
      code: 'STALE_WORKER',
    });
    expect(await prisma.agentTurn.findUniqueOrThrow({ where: { id: run.runId } })).toEqual(before);
  });

  it('stores complete reported usage and mirrors counters atomically, preserving an absent report', async () => {
    const f = fixture(owner);
    const r = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 1 });
    expect(r).not.toHaveProperty('usage');
    const usage = {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 20,
      promptTokensDetails: { cachedTokens: 3, cacheWriteTokens: 2 },
      completionTokensDetails: { reasoningTokens: 4 },
      cost: 0.002,
      costDetails: { upstreamCost: 0.001 },
      providerUsageDetails: { request: 'fixture' },
    };
    await f.store.update(r.runId, { usage });
    expect((await f.store.get(r.runId))?.usage).toEqual(usage);
    await f.store.update(r.runId, { usage: { ...usage, totalTokens: 3_000_000_000 } });
    expect((await f.store.get(r.runId))?.usage?.totalTokens).toBe(3_000_000_000);
    await f.store.update(r.runId, { usage });
    expect(await prisma.agentTurn.findUniqueOrThrow({ where: { id: r.runId } })).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 3,
      cacheCreationTokens: 2,
      usage,
    });
    await expect(
      f.store.update(r.runId, { usage: { ...usage, promptTokens: -1 } }),
    ).rejects.toBeDefined();
    expect((await f.store.get(r.runId))?.usage).toEqual(usage);
    await f.store.update(r.runId, { usage: undefined } as never);
    expect(await f.store.get(r.runId)).not.toHaveProperty('usage');
    await f.store.update(r.runId, {
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    expect((await f.store.get(r.runId))?.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it('normalizes vendor prose and codes before either the database or record can expose them', async () => {
    const f = fixture(owner);
    const r = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 1 });
    const secret = 'provider-secret-marker-APIKEY';
    await f.store.update(r.runId, {
      status: 'failed',
      error: { message: `401 unauthorized ${secret}`, code: secret },
    });
    const row = await prisma.agentTurn.findUniqueOrThrow({ where: { id: r.runId } });
    expect(row.errorCode).toBe('AUTH_FAILED');
    expect(JSON.stringify(row)).not.toContain(secret);
    expect((await f.store.get(r.runId))?.error).toEqual(
      projectRunError({ message: '401', code: '401' }),
    );
    for (const code of ModelErrorCodeSchema.options) {
      const safe = projectRunError({ code, message: secret });
      expect(safe.code).toBe(code);
      expect(safe.message).not.toContain(secret);
    }
  });

  it('clears explicit undefined optional values while omitted patches retain them', async () => {
    const f = fixture(owner);
    const r = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 1 });
    await f.store.update(r.runId, {
      sandboxKey: 'fixture-seat',
      detachedSince: 0,
      cancelRequested: false,
      driverEpoch: 0,
    });
    await f.store.update(r.runId, {});
    expect(await f.store.get(r.runId)).toMatchObject({
      sandboxKey: 'fixture-seat',
      detachedSince: 0,
      cancelRequested: false,
      driverEpoch: 0,
    });
    await f.store.update(r.runId, {
      sandboxKey: undefined,
      detachedSince: undefined,
      cancelRequested: undefined,
      driverEpoch: undefined,
    } as never);
    const cleared = await f.store.get(r.runId);
    for (const key of ['sandboxKey', 'detachedSince', 'cancelRequested', 'driverEpoch'])
      expect(cleared).not.toHaveProperty(key);
  });

  it('rejects unsupported new subagent inputs while idempotent resumes ignore replacement links', async () => {
    const f = fixture(owner);
    const r = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 1 });
    expect(
      await f.store.createOrResume({
        runId: r.runId,
        threadId: id(),
        startedAt: 2,
        parentRunId: 'ignored',
      }),
    ).toEqual(r);
    await expect(
      f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 3, parentRunId: r.runId }),
    ).rejects.toMatchObject({ code: 'SUBAGENTS_UNSUPPORTED' });
  });

  it('does not give an interrupted pause a terminal timestamp', async () => {
    const f = fixture(owner);
    const r = await f.store.createOrResume({ runId: id(), threadId: id(), startedAt: 1 });
    await expect(
      f.store.update(r.runId, { status: 'interrupted', finishedAt: 2 }),
    ).rejects.toMatchObject({ code: 'INVALID_RUN' });
    await f.store.update(r.runId, { status: 'interrupted' });
    expect(await f.store.get(r.runId)).not.toHaveProperty('finishedAt');
  });
});
