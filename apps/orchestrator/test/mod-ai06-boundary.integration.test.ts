/** Real library ordering and PostgreSQL transactions; native approval mapping is a separate gate. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chat, defineInterrupt, EventType, type ChatMiddleware } from '@tanstack/ai';
import { composePersistence, memoryPersistence, withPersistence } from '@tanstack/ai-persistence';
import { z } from 'zod';
import { JsonSchema, type Json } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { OwnedRunBoundary } from '../src/agent/persistence/owned-run-boundary.js';
import { RunLeaseService } from '../src/agent/persistence/run-lease.js';
import { createPrismaMessageStore } from '../src/agent/persistence/prisma-message-store.js';
import {
  createPrismaRunStore,
  projectRunError,
} from '../src/agent/persistence/prisma-run-store.js';
import { toTranscriptRow } from '../src/agent/persistence/transcript.js';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';
import { TanStackExecutionBackend } from '../src/agent/execution/tanstack-execution-backend.js';
import type {
  ExecutionPorts,
  ExecutionRequest,
} from '../src/agent/execution/execution-backend.port.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const question = defineInterrupt({
  id: 'fixture.boundary-question',
  payloadSchema: z.object({ question: z.string() }),
  responseSchema: z.object({ yes: z.boolean() }),
});

describe.skipIf(!DATABASE_URL)('MOD-AI-06 owned closing boundary (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'boundary' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await prisma.$disconnect();
  });

  async function fixture(timing?: { leaseMs: number; heartbeatMs: number }) {
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: randomUUID(),
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
      },
    });
    const thread = await prisma.conversation.create({
      data: { botId: bot.id },
    });
    const triggerMessageId = randomUUID();
    const body = toTranscriptRow(
      { id: triggerMessageId, role: 'user', content: 'hello' },
      { threadBotId: bot.id, runId: null },
    );
    if (!body.ok) throw new Error('fixture');
    await prisma.message.create({ data: { conversationId: thread.id, ...body.value } });
    const input = {
      userId: owner.userId,
      botId: bot.id,
      threadId: thread.id,
      runId: randomUUID(),
      triggerMessageId,
    };
    const leases = new RunLeaseService(prisma, timing);
    const claim = await leases.claim(input);
    if (claim.kind !== 'claimed') throw new Error('fixture');
    const boundary = new OwnedRunBoundary(prisma, claim.lease);
    const messages = createPrismaMessageStore(prisma, {
      userId: owner.userId,
      runId: input.runId,
      fence: boundary.fence,
      transaction: boundary.transaction,
    });
    const runs = createPrismaRunStore(
      prisma,
      { userId: owner.userId },
      {
        transaction: boundary.transaction,
        assertWrite: boundary.assertWrite,
        projectError: projectRunError,
        admitNew: async () => {
          throw new Error('Fixture run was already admitted.');
        },
      },
    );
    const history = await messages.loadThread(thread.id);
    const row = () => prisma.agentTurn.findUniqueOrThrow({ where: { id: input.runId } });
    const flush = () =>
      messages.saveThread(thread.id, [
        ...history,
        { id: `a_${input.runId}`, role: 'assistant', content: 'done' },
      ]);
    return {
      bot,
      thread,
      input,
      lease: claim.lease,
      leases,
      boundary,
      messages,
      runs,
      history,
      row,
      flush,
    };
  }

  it.each(['interrupted', 'completed', 'failed', 'aborted'] as const)(
    'allows the selected %s status before final transcript flush and releases authority atomically',
    async (next) => {
      const f = await fixture();
      await f.boundary.close(next, async () => {
        await f.runs.update(f.input.runId, { status: next });
        await f.flush();
      });
      const row = await f.row();
      expect(row).toMatchObject({
        status: next,
        activeKey: null,
        workerId: null,
        leaseExpiresAt: null,
        driverEpoch: f.lease.epoch,
      });
      expect(row.endedAt === null).toBe(next === 'interrupted');
      expect(await f.messages.loadThread(f.thread.id)).toHaveLength(2);
      await expect(f.flush()).rejects.toMatchObject({ code: 'STALE_WORKER' });
      await expect(f.boundary.assertLive()).rejects.toMatchObject({ code: 'STALE_WORKER' });
    },
  );

  it.each(['after transcript', 'after status', 'wrong final status'] as const)(
    'rolls back all participating writes on failure %s',
    async (stage) => {
      const f = await fixture();
      const before = await f.row();
      await expect(
        f.boundary.close('completed', async () => {
          await f.flush();
          if (stage === 'after transcript') throw new Error('injected failure');
          if (stage !== 'wrong final status')
            await f.runs.update(f.input.runId, { status: 'completed' });
          if (stage === 'after status') throw new Error('injected failure');
        }),
      ).rejects.toThrow();
      expect(await f.row()).toEqual(before);
      expect(await f.messages.loadThread(f.thread.id)).toEqual(f.history);
    },
  );

  it('rolls back a store failure even if the library hook catches it', async () => {
    const f = await fixture();
    const before = await f.row();
    await expect(
      f.boundary.close('completed', async () => {
        await f.flush();
        try {
          await f.runs.update(f.input.runId, { driverEpoch: f.lease.epoch + 1 });
        } catch {
          /* Emulates an isolated/best-effort middleware hook. */
        }
        await f.runs.update(f.input.runId, { status: 'completed' });
      }),
    ).rejects.toMatchObject({ code: 'STALE_WORKER' });
    expect(await f.row()).toEqual(before);
    expect(await f.messages.loadThread(f.thread.id)).toEqual(f.history);
  });

  it('refuses independent closing, mixed outcomes, nested boundaries and cancellation erasure', async () => {
    const f = await fixture();
    await expect(f.runs.update(f.input.runId, { status: 'completed' })).rejects.toMatchObject({
      code: 'STALE_WORKER',
    });
    for (const operation of [
      () => f.runs.update(f.input.runId, { status: 'failed' }),
      () => f.runs.update(f.input.runId, { cancelRequested: false }),
      () => f.boundary.close('completed', async () => undefined),
    ])
      await expect(f.boundary.close('completed', operation)).rejects.toMatchObject({
        code: 'STALE_WORKER',
      });
    expect((await f.row()).status).toBe('running');
  });

  it('allows cancellation acknowledgement only in an abort boundary and never restores dispatch', async () => {
    const f = await fixture();
    await prisma.agentTurn.update({
      where: { id: f.input.runId },
      data: { cancelRequested: true },
    });
    await expect(f.boundary.assertLive()).rejects.toMatchObject({ code: 'STALE_WORKER' });
    await expect(f.boundary.close('completed', f.flush)).rejects.toMatchObject({
      code: 'STALE_WORKER',
    });
    await f.boundary.close('aborted', async () => {
      await f.runs.update(f.input.runId, { status: 'aborted' });
      await f.flush();
    });
    expect(await f.row()).toMatchObject({
      status: 'aborted',
      cancelRequested: true,
      workerId: null,
    });
  });

  it('refuses a stale producer after expiry and takeover', async () => {
    const f = await fixture();
    await f.leases.release(f.lease);
    await expect(f.boundary.close('completed', f.flush)).rejects.toMatchObject({
      code: 'STALE_WORKER',
    });
    const replacement = await f.leases.claim(f.input);
    expect(replacement.kind).toBe('claimed');
    const before = await f.row();
    await expect(f.boundary.close('failed', f.flush)).rejects.toMatchObject({
      code: 'STALE_WORKER',
    });
    expect(await f.row()).toEqual(before);
  });
  it('rolls back a finalizer when expiry occurs after the last store flush', async () => {
    const f = await fixture();
    const before = await f.row();
    await expect(
      f.boundary.close('completed', async () => {
        await f.runs.update(f.input.runId, { status: 'completed' });
        await f.flush();
        await f.boundary.transaction((tx) =>
          tx.agentTurn.update({
            where: { id: f.input.runId },
            data: { leaseExpiresAt: new Date(0) },
          }),
        );
      }),
    ).rejects.toMatchObject({ code: 'STALE_WORKER' });
    expect(await f.row()).toEqual(before);
    expect(await f.messages.loadThread(f.thread.id)).toEqual(f.history);
  });

  it('refuses another owned run and another transaction client inside the captured boundary', async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      f.boundary.close('completed', () =>
        f.runs.update(other.input.runId, { status: 'completed' }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_WORKER' });
    await expect(
      f.boundary.close('completed', () => prisma.$transaction(f.boundary.fence)),
    ).rejects.toMatchObject({ code: 'STALE_WORKER' });
    expect((await other.row()).status).toBe('running');
  });

  it.each([false, true])(
    'revokes inherited async callbacks after callback completion (rollback: %s)',
    async (rollback) => {
      const f = await fixture();
      let wake!: () => void;
      const ready = new Promise<void>((resolve) => {
        wake = resolve;
      });
      let late!: Promise<unknown>;
      const closing = f.boundary.close('completed', async () => {
        late = ready.then(() => f.boundary.transaction(async () => 'should not run'));
        await f.runs.update(f.input.runId, { status: 'completed' });
        if (rollback) throw new Error('injected rollback');
      });
      if (rollback) await expect(closing).rejects.toThrow('injected rollback');
      else await closing;
      wake();
      await expect(late).rejects.toMatchObject({ code: 'STALE_WORKER' });
    },
  );
  it('allows only one concurrent closure of the same captured producer', async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        f.boundary.close('completed', async () => {
          await f.flush();
          await f.runs.update(f.input.runId, { status: 'completed' });
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await f.row()).toMatchObject({ status: 'completed', workerId: null });
    expect(await f.messages.loadThread(f.thread.id)).toHaveLength(2);
  });

  it.each(['complete', 'checkpoint failure', 'cancel'] as const)(
    'the backend uses real owned boundaries for %s',
    async (outcome) => {
      const f = await fixture();
      const adapter = new ScriptedAdapter();
      const controller = new AbortController();
      if (outcome === 'cancel') {
        adapter.chatStream = async function* (options) {
          await prisma.agentTurn.update({
            where: { id: f.input.runId },
            data: { cancelRequested: true },
          });
          controller.abort();
          yield { type: EventType.RUN_STARTED, runId: options.runId!, threadId: options.threadId! };
        };
      }
      const events: Json[] = [];
      const persistence = composePersistence(memoryPersistence(), {
        overrides: { messages: f.messages, runs: f.runs },
      }); // Interrupts are an unused explicit fixture here; no approval-resume claim.
      const backend = new TanStackExecutionBackend({
        logger: { warn: () => undefined },
        loadAttachments: async () => new Map(),
        resolveModel: async () => ({
          adapter,
          modelId: 'fixture',
          kind: 'custom',
          connectionId: 'fixture',
          connectionName: 'Fixture',
          upstreamModelId: 'fixture',
          label: 'Fixture',
          contextWindow: 10000,
          capabilities: { tools: true, vision: false, reasoning: false },
        }),
        openPersistence: async () => ({
          persistence,
          reserve: f.messages.reserve,
          withdraw: f.messages.withdraw,
          assertLive: f.boundary.assertLive,
          boundary: f.boundary.close,
          progress: async () => undefined,
          authorizeResume: async () => {
            throw new Error('No resume is admitted in this fixture.');
          },
          budget: {
            steps: 0,
            workingMs: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              reportedCalls: 0,
              unreportedCalls: 0,
            },
          },
        }),
      });
      const request: ExecutionRequest = {
        runId: f.input.runId,
        threadId: f.thread.id,
        botId: f.bot.id,
        triggerMessageId: f.input.triggerMessageId,
        model: { userId: owner.userId, modelRef: 'fixture' },
        instructions: { identity: { name: 'Fixture', role: 'Test' } },
        tools: {},
        policy: {
          decide: async () => {
            throw new Error('No tools in this fixture.');
          },
          prompt: () => {
            throw new Error('No tools in this fixture.');
          },
        },
      };
      const ports: ExecutionPorts = {
        signal: controller.signal,
        appendEvent: async (event) => {
          events.push(event);
        },
        checkpoint: async () => {
          if (outcome === 'checkpoint failure') throw new Error('checkpoint unavailable');
        },
        releaseForApproval: async () => undefined,
        persistUsage: async () => undefined,
        status: () => undefined,
      };
      const result = await backend.execute(request, ports);
      const status =
        outcome === 'complete' ? 'completed' : outcome === 'cancel' ? 'aborted' : 'failed';
      expect(result.status).toBe(status);
      expect(await f.row()).toMatchObject({
        status,
        activeKey: null,
        workerId: null,
        leaseExpiresAt: null,
      });
      expect(events.at(-1)).toMatchObject({
        type: outcome === 'complete' ? EventType.RUN_FINISHED : EventType.RUN_ERROR,
      });
      if (outcome === 'checkpoint failure')
        expect(
          events.some(
            (event) => z.object({ type: z.string() }).parse(event).type === EventType.RUN_FINISHED,
          ),
        ).toBe(false);
    },
  );

  it.each([false, true])(
    'the installed middleware pause ordering is atomic (inject flush failure: %s)',
    async (fail) => {
      const f = await fixture();
      // This fixture writes synthetic native rows directly. It tests transaction participation,
      // not the production native-id/private-proposal mapping or answer admission.
      const memory = memoryPersistence();
      const interrupts = memory.stores.interrupts;
      interrupts.create = (record) =>
        f.boundary.transaction(async (tx) => {
          await f.boundary.fence(tx);
          await tx.runInterrupt.create({
            data: {
              id: record.interruptId,
              runId: f.input.runId,
              conversationId: f.thread.id,
              userId: owner.userId,
              payload: JsonSchema.parse(record.payload),
              requestedAt: new Date(record.requestedAt),
            },
          });
        });
      const messages = {
        ...f.messages,
        saveThread: async (
          threadId: string,
          history: Parameters<typeof f.messages.saveThread>[1],
        ) => {
          await f.boundary.transaction(async (tx) => {
            const row = await tx.agentTurn.findUniqueOrThrow({ where: { id: f.input.runId } });
            if (row.status === 'interrupted') {
              if (fail) throw new Error('injected pause flush failure');
              expect(await tx.runInterrupt.count({ where: { runId: f.input.runId } })).toBe(1);
            }
            await f.messages.saveThread(threadId, history);
          });
        },
      };
      const persistence = composePersistence(memory, {
        overrides: { messages, runs: f.runs, interrupts },
      });
      const pm = withPersistence(persistence);
      const failures: unknown[] = [];
      const wrapped: ChatMiddleware = {
        ...pm,
        async onChunk(ctx, chunk) {
          if (chunk.type === EventType.RUN_FINISHED && chunk.outcome?.type === 'interrupt') {
            try {
              await f.boundary.close('interrupted', async () => pm.onChunk?.(ctx, chunk));
            } catch (error) {
              failures.push(error);
              throw error;
            }
          } else await pm.onChunk?.(ctx, chunk);
        },
        async onError() {
          /* Failure close is intentionally omitted to inspect the rollback state. */
        },
      };
      const interrupting: ChatMiddleware = {
        onInterruptBoundary(ctx) {
          if (ctx.phase === 'beforeModel')
            return {
              interrupts: [
                question.interrupt({
                  key: 'q',
                  reason: 'policy',
                  message: 'Continue?',
                  payload: { question: 'Continue?' },
                }),
              ],
            };
          return undefined;
        },
      };
      const events = [];
      for await (const event of chat({
        debug: false,
        adapter: new ScriptedAdapter(),
        threadId: f.thread.id,
        runId: f.input.runId,
        messages: [],
        interrupts: [question],
        middleware: [wrapped, interrupting],
      }))
        events.push(event);
      expect(failures).toHaveLength(fail ? 1 : 0);
      expect((await f.row()).status).toBe(fail ? 'running' : 'interrupted');
      expect(await prisma.runInterrupt.count({ where: { runId: f.input.runId } })).toBe(
        fail ? 0 : 1,
      );
      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(fail);
      if (!fail) expect((await f.row()).workerId).toBeNull();
    },
  );
});
