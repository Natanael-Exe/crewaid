/** Generic conformance grants fixture maintenance only; actual attachment is separately lease-fenced. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chat, EventType, type ChatMiddleware } from '@tanstack/ai';
import { createInterruptBinding } from '@tanstack/ai/adapter-internals';
import { defineAIPersistence, withPersistence } from '@tanstack/ai-persistence';
import { runPersistenceConformance } from '@tanstack/ai-persistence/testkit';
import {
  JsonSchema,
  ToolApprovalRequestSchema,
  type Json,
  type ToolApprovalRequest,
} from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  createPrismaInterruptStore,
  type InterruptStoreAuthority,
  type CreateInterrupt,
} from '../src/agent/persistence/prisma-interrupt-store.js';
import {
  assertOwnedToolInterruptAttachment,
  nativeToolProposalId,
} from '../src/agent/persistence/native-tool-interrupt.js';
import { PolicyProposalSchema } from '../src/agent/policy/proposal-store.js';
import { toolApproval } from '../src/agent/execution/tool-approval-interrupt.js';
import { OwnedRunBoundary } from '../src/agent/persistence/owned-run-boundary.js';
import { RunLeaseService, RunOwnershipError } from '../src/agent/persistence/run-lease.js';
import {
  createPrismaRunStore,
  projectRunError,
} from '../src/agent/persistence/prisma-run-store.js';
import { createPrismaMessageStore } from '../src/agent/persistence/prisma-message-store.js';
import { toInterruptRecord, toTranscriptRow } from '../src/agent/persistence/transcript.js';
import {
  readOwnedToolResumeBatch,
  validateOwnedToolResumeBatch,
} from '../src/agent/persistence/owned-resume-batch.js';
import { admitOwnedToolResumeBatch } from '../src/agent/persistence/owned-resume-admission.js';
import {
  assertOwnedToolInterruptCommit,
  createOwnedToolDispatchAuthorizer,
} from '../src/agent/persistence/owned-native-consumption.js';
import { ScriptedAdapter } from './mod-02-tanstack-harness.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const id = () => randomUUID();

describe.skipIf(!DATABASE_URL)('MOD-AI-06 Prisma native interrupt facets (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  let stranger: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'interrupt' });
    stranger = await signIn(prisma, { label: 'interruptx' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await signOutAndDelete(prisma, stranger.userId);
    await prisma.$disconnect();
  });

  function fixture(actor = owner) {
    const proposals = new Map<string, string>();
    const authority: InterruptStoreAuthority = {
      transaction: (operation) => prisma.$transaction(operation),
      // Explicit conformance admission creates private fixture rows, not production capabilities.
      locateProposal: async (tx, input) => {
        const existing = proposals.get(input.interruptId);
        if (existing !== undefined) return existing;
        let thread = await tx.conversation.findFirst({
          where: { id: input.threadId, bot: { userId: actor.userId } },
        });
        if (thread === null) {
          const bot = await tx.bot.create({
            data: {
              userId: actor.userId,
              name: id(),
              role: 'fixture',
              avatarColor: '#8B6F47',
              systemPrompt: '',
            },
          });
          thread = await tx.conversation.create({
            data: { id: input.threadId, botId: bot.id },
          });
        }
        let run = await tx.agentTurn.findFirst({
          where: { id: input.runId, bot: { userId: actor.userId } },
        });
        if (run === null) {
          const body = toTranscriptRow(
            { id: id(), role: 'user', content: 'fixture' },
            { threadBotId: thread.botId, runId: null },
          );
          if (!body.ok) throw new Error('fixture');
          const message = await tx.message.create({
            data: { conversationId: thread.id, ...body.value },
          });
          run = await tx.agentTurn.create({
            data: {
              id: input.runId,
              botId: thread.botId,
              conversationId: thread.id,
              triggerMessageId: message.id,
              status: 'running',
            },
          });
        }
        const row = await tx.runInterrupt.create({
          data: {
            userId: actor.userId,
            conversationId: thread.id,
            runId: run.id,
            payload: { fixture: true },
          },
        });
        proposals.set(input.interruptId, row.id);
        return row.id;
      },
      assertAttach: async (tx, row) => {
        const run = await tx.agentTurn.findUniqueOrThrow({ where: { id: row.runId } });
        if (run.workerId !== null || run.activeKey !== null)
          throw new Error('fixture cannot attach to a producer');
      },
      assertCommit: async (tx, row) => {
        const run = await tx.agentTurn.findUniqueOrThrow({ where: { id: row.runId } });
        if (run.workerId !== null || run.activeKey !== null)
          throw new Error('fixture cannot consume a producer interrupt');
      },
    };
    return {
      authority,
      proposals,
      store: createPrismaInterruptStore(prisma, { userId: actor.userId }, authority),
    };
  }
  const input = (): CreateInterrupt => ({
    interruptId: id(),
    runId: id(),
    threadId: id(),
    requestedAt: 10,
    payload: { question: 'fixture' },
  });

  runPersistenceConformance(
    'Prisma interrupts on admitted fixture proposals',
    () => defineAIPersistence({ stores: { interrupts: fixture().store } }),
    {
      // This suite provides only interrupts; run/transcript ownership and other stores have separate suites/owners.
      skip: ['messages', 'runs', 'metadata', 'generationRuns', 'artifacts', 'blobs'],
    },
  );

  it('attaches one row and preserves private policy acceptance separately from native consumption', async () => {
    const f = fixture();
    const record = input();
    await f.store.create(record);
    expect(await prisma.runInterrupt.count({ where: { runId: record.runId } })).toBe(1);
    const proposalId = f.proposals.get(record.interruptId)!;
    await prisma.runInterrupt.update({
      where: { id: proposalId },
      data: {
        status: 'resolved',
        response: { approved: true, args: { edited: true } },
        resolvedAt: new Date(),
      },
    });
    expect(await f.store.listPending(record.threadId)).toHaveLength(1);
    await f.store.resolve(record.interruptId, { approved: true });
    expect(
      await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposalId } }),
    ).toMatchObject({
      status: 'resolved',
      response: { approved: true, args: { edited: true } },
      nativeStatus: 'resolved',
      nativeResponse: { value: { approved: true } },
    });
  });

  it('excludes foreign and unattached policy rows', async () => {
    const f = fixture();
    const record = input();
    await f.store.create(record);
    const foreign = fixture(stranger).store;
    expect(await foreign.get(record.interruptId)).toBeNull();
    expect(await foreign.list(record.threadId)).toEqual([]);
    expect(await foreign.listByRun(record.runId)).toEqual([]);
    await foreign.resolve(record.interruptId, { approved: true });
    await foreign.cancel(record.interruptId);
    expect((await f.store.get(record.interruptId))?.status).toBe('pending');
    await prisma.runInterrupt.create({
      data: {
        userId: owner.userId,
        runId: record.runId,
        conversationId: record.threadId,
        payload: { type: 'crewaid.identity-window' },
        status: 'resolved',
      },
    });
    expect(await f.store.list(record.threadId)).toHaveLength(1);
  });

  it('keeps a foreign native-id collision opaque and rolls back fixture admission', async () => {
    const record = input();
    await fixture(stranger).store.create(record);
    const f = fixture();
    const other = { ...input(), interruptId: record.interruptId };
    await expect(f.store.create(other)).rejects.toMatchObject({ code: 'INTERRUPT_CONFLICT' });
    expect(await prisma.agentTurn.count({ where: { id: other.runId } })).toBe(0);
  });

  it('preserves missing versus null response and never replaces a terminal answer', async () => {
    const f = fixture();
    const a = input();
    const b = input();
    await f.store.create(a);
    await f.store.create(b);
    await f.store.resolve(a.interruptId, null);
    await f.store.cancel(b.interruptId);
    expect(await f.store.get(a.interruptId)).toMatchObject({ response: null, status: 'resolved' });
    expect(await f.store.get(b.interruptId)).not.toHaveProperty('response');
    await f.store.resolve(a.interruptId, { replaced: true });
    await f.store.cancel(a.interruptId);
    expect(await f.store.get(a.interruptId)).toMatchObject({ response: null, status: 'resolved' });
    await f.store.create({
      ...a,
      runId: 'replacement',
      threadId: 'replacement',
      requestedAt: -1,
      payload: {},
    });
    expect(await f.store.get(a.interruptId)).toMatchObject({
      runId: a.runId,
      requestedAt: 10,
      payload: a.payload,
      response: null,
    });
  });

  it('missing IDs are no-ops even with malformed replacement response, without invoking authority', async () => {
    const f = fixture();
    let commits = 0;
    const store = createPrismaInterruptStore(
      prisma,
      { userId: owner.userId },
      {
        ...f.authority,
        assertCommit: async () => {
          commits++;
          throw new Error('unexpected authority');
        },
      },
    );
    await store.resolve(id(), () => {});
    await store.cancel(id());
    await store.commitBatch([]);
    expect(commits).toBe(0);
  });

  it('rejects incomplete database facets and unreadable native response envelopes', async () => {
    const f = fixture();
    const record = input();
    await f.store.create(record);
    const proposalId = f.proposals.get(record.interruptId)!;
    await expect(
      prisma.runInterrupt.update({ where: { id: proposalId }, data: { nativeStatus: null } }),
    ).rejects.toThrow();
    await prisma.runInterrupt.update({
      where: { id: proposalId },
      data: { nativeResponse: { forged: true } },
    });
    await expect(f.store.get(record.interruptId)).rejects.toMatchObject({
      code: 'INVALID_INTERRUPT',
    });
    await expect(
      f.store.commitBatch([{ interruptId: record.interruptId, status: 'cancelled' }]),
    ).rejects.toMatchObject({ code: 'INVALID_INTERRUPT' });
    expect(
      (await prisma.runInterrupt.findUniqueOrThrow({ where: { id: proposalId } })).nativeStatus,
    ).toBe('pending');
  });

  it.each(['duplicate', 'missing', 'terminal', 'foreign', 'authority', 'invalid response'])(
    'rejects a whole batch without partial writes: %s',
    async (failure) => {
      const f = fixture();
      const a = input();
      const b = { ...input(), runId: a.runId, threadId: a.threadId };
      await f.store.create(a);
      await f.store.create(b);
      if (failure === 'terminal') await f.store.cancel(b.interruptId);
      if (failure === 'foreign')
        await prisma.runInterrupt.update({
          where: { id: f.proposals.get(b.interruptId)! },
          data: { userId: stranger.userId },
        });
      const store =
        failure === 'authority'
          ? createPrismaInterruptStore(
              prisma,
              { userId: owner.userId },
              {
                ...f.authority,
                assertCommit: async (tx, row) => {
                  await tx.runInterrupt.update({
                    where: { id: row.id },
                    data: { response: { touched: true } },
                  });
                  if (row.nativeInterruptId === b.interruptId) throw new Error('refused');
                },
              },
            )
          : f.store;
      const before = await prisma.runInterrupt.findMany({
        where: { runId: a.runId },
        orderBy: { sequence: 'asc' },
      });
      await expect(
        store.commitBatch([
          { interruptId: a.interruptId, status: 'resolved', response: { ok: true } },
          {
            interruptId:
              failure === 'duplicate'
                ? a.interruptId
                : failure === 'missing'
                  ? id()
                  : b.interruptId,
            status: 'resolved',
            response: failure === 'invalid response' ? () => {} : { ok: true },
          },
        ]),
      ).rejects.toThrow();
      expect(
        await prisma.runInterrupt.findMany({
          where: { runId: a.runId },
          orderBy: { sequence: 'asc' },
        }),
      ).toEqual(before);
    },
  );

  it('commits once under concurrent batches and preserves requested timestamp ordering', async () => {
    const f = fixture();
    const a = input();
    const b = { ...input(), threadId: a.threadId, runId: a.runId, requestedAt: 1 };
    const c = { ...input(), threadId: a.threadId, runId: a.runId };
    await f.store.create(a);
    await f.store.create(b);
    await f.store.create(c);
    expect((await f.store.list(a.threadId)).map((row) => row.interruptId)).toEqual([
      b.interruptId,
      a.interruptId,
      c.interruptId,
    ]);
    const entries = [a, b, c].map((row) => ({
      interruptId: row.interruptId,
      status: 'resolved' as const,
      response: null,
    }));
    const outcomes = await Promise.allSettled([
      f.store.commitBatch(entries),
      f.store.commitBatch(entries),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await f.store.listPendingByRun(a.runId)).toEqual([]);
  });

  async function leasedFixture() {
    const f = fixture();
    const record = input();
    // Prepare the private fixture proposal without attaching protocol state.
    const proposalId = await prisma.$transaction((tx) => f.authority.locateProposal(tx, record));
    const run = await prisma.agentTurn.findUniqueOrThrow({ where: { id: record.runId } });
    const leases = new RunLeaseService(prisma);
    const admission = {
      userId: owner.userId,
      botId: run.botId,
      threadId: run.conversationId,
      runId: run.id,
      triggerMessageId: run.triggerMessageId,
    };
    const claim = await leases.claim(admission);
    if (claim.kind !== 'claimed') throw new Error('fixture claim');
    const boundary = new OwnedRunBoundary(prisma, claim.lease);
    const proposal = PolicyProposalSchema.parse({
      type: 'crewaid.tool-approval',
      toolCallId: id(),
      definitionName: 'send_message',
      toolName: 'send_message',
      args: { recipient: 'fixture' },
      rawArgs: { recipient: 'fixture' },
      mode: 'ASK',
      authority: false,
      binding: {
        toolName: 'send_message',
        effect: 'draft',
        scope: 'call',
        argsHash: 'a'.repeat(64),
        grantRevision: 'b'.repeat(64),
        resourceRevision: null,
        seat: null,
        commit: null,
      },
    });
    await prisma.runInterrupt.update({ where: { id: proposalId }, data: { payload: proposal } });
    const request: ToolApprovalRequest = {
      proposalId,
      botId: run.botId,
      runId: run.id,
      toolCallId: proposal.toolCallId,
      definitionName: proposal.definitionName,
      toolName: proposal.toolName,
      args: proposal.args,
      binding: proposal.binding,
    };
    const native = createInterruptBinding(
      toolApproval.interrupt({
        key: proposalId,
        reason: 'policy',
        message: 'Allow send_message?',
        payload: request,
      }),
      { interruptedRunId: run.id, generation: 0, batchIndex: 0 },
    );
    const {
      responseSchemaCanonicalJson,
      payloadSchemaCanonicalJson: _payloadSchema,
      ...nativeBinding
    } = native.descriptor;
    const payload = JsonSchema.parse({
      id: record.interruptId,
      reason: 'policy',
      message: 'Allow send_message?',
      responseSchema: JSON.parse(responseSchemaCanonicalJson!),
      metadata: {
        'tanstack:interruptBinding': { ...nativeBinding, interruptId: record.interruptId },
        'tanstack:interruptPayload': request,
      },
    });
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('fixture descriptor');
    const nativeRecord: CreateInterrupt = { ...record, payload };
    const authority: InterruptStoreAuthority = {
      transaction: boundary.transaction,
      locateProposal: async (_tx, value) => nativeToolProposalId(value),
      assertAttach: (tx, row, value) =>
        assertOwnedToolInterruptAttachment(tx, row, value, claim.lease, boundary.fence),
      assertCommit: async () => {
        throw new Error('No production resume acceptance proof in this slice.');
      },
    };
    const store = createPrismaInterruptStore(prisma, { userId: owner.userId }, authority);
    const runs = createPrismaRunStore(
      prisma,
      { userId: owner.userId },
      {
        transaction: boundary.transaction,
        assertWrite: boundary.assertWrite,
        projectError: projectRunError,
        admitNew: async () => {
          throw new Error('already admitted');
        },
      },
    );
    const messages = createPrismaMessageStore(prisma, {
      userId: owner.userId,
      runId: run.id,
      transaction: boundary.transaction,
      fence: boundary.fence,
    });
    return {
      ...f,
      store,
      authority,
      nativeRecord,
      request,
      proposalId,
      leases,
      claim,
      admission,
      boundary,
      runs,
      messages,
    };
  }

  it('validates a native tool descriptor against the one private proposal and current definition', async () => {
    const f = await leasedFixture();
    await f.store.create(f.nativeRecord);
    expect(await prisma.runInterrupt.count({ where: { runId: f.admission.runId } })).toBe(1);
    expect(await f.store.get(f.nativeRecord.interruptId)).toMatchObject({
      payload: f.nativeRecord.payload,
      status: 'pending',
    });
    await expect(f.store.resolve(f.nativeRecord.interruptId, { approved: true })).rejects.toThrow(
      'acceptance proof',
    );
    expect((await f.store.get(f.nativeRecord.interruptId))?.status).toBe('pending');
  });

  it('concurrent attachment is immutable and never adds another proposal', async () => {
    const f = await leasedFixture();
    await Promise.all([f.store.create(f.nativeRecord), f.store.create(f.nativeRecord)]);
    expect(await prisma.runInterrupt.count({ where: { runId: f.admission.runId } })).toBe(1);
    const replacement = { ...f.nativeRecord, interruptId: id() };
    await expect(f.store.create(replacement)).rejects.toMatchObject({ code: 'INTERRUPT_CONFLICT' });
    expect((await f.store.get(f.nativeRecord.interruptId))?.payload).toEqual(
      f.nativeRecord.payload,
    );
  });

  it.each([false, true])(
    'native terminal writes join the owned closing transaction (failure: %s)',
    async (fail) => {
      const f = await leasedFixture();
      await f.store.create(f.nativeRecord);
      // Synthetic acceptance for the storage boundary only. Production requires the later whole-batch admission proof.
      const store = createPrismaInterruptStore(
        prisma,
        { userId: owner.userId },
        {
          ...f.authority,
          assertCommit: async (tx, row) => {
            expect(row.runId).toBe(f.admission.runId);
            await f.boundary.fence(tx);
          },
        },
      );
      const before = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: f.proposalId } });
      const close = f.boundary.close('completed', async () => {
        await store.commitBatch([
          {
            interruptId: f.nativeRecord.interruptId,
            status: 'resolved',
            response: { approved: false },
          },
        ]);
        await f.runs.update(f.admission.runId, { status: 'completed' });
        if (fail) throw new Error('late checkpoint failed');
      });
      if (fail) {
        await expect(close).rejects.toThrow('late checkpoint');
        expect(
          await prisma.runInterrupt.findUniqueOrThrow({ where: { id: f.proposalId } }),
        ).toEqual(before);
      } else {
        await close;
        expect((await store.get(f.nativeRecord.interruptId))?.status).toBe('resolved');
      }
      const row = await prisma.agentTurn.findUniqueOrThrow({ where: { id: f.admission.runId } });
      expect(row.status).toBe(fail ? 'running' : 'completed');
      expect(row.workerId === null).toBe(!fail);
    },
  );

  it.each([
    'native id',
    'run',
    'generation',
    'version',
    'batch index',
    'key',
    'schema hash',
    'response schema',
    'private args',
    'private binding',
    'proposal',
    'private terminal',
    'expired',
    'cancel',
    'takeover',
  ])('refuses unsafe native attachment: %s', async (change) => {
    const f = await leasedFixture();
    const record = structuredClone(f.nativeRecord);
    const metadata = record.payload.metadata as Record<string, any>;
    const binding = metadata['tanstack:interruptBinding'];
    const request = metadata['tanstack:interruptPayload'];
    if (change === 'native id') record.payload.id = id();
    if (change === 'run') binding.interruptedRunId = id();
    if (change === 'generation') binding.generation = 1;
    if (change === 'version') delete binding.v;
    if (change === 'batch index') binding.batchIndex = -1;
    if (change === 'key') binding.key = id();
    if (change === 'schema hash') binding.responseSchemaHash = 'forged';
    if (change === 'response schema') record.payload.responseSchema = {};
    if (change === 'private args') request.args = { changed: true };
    if (change === 'private binding') request.binding.argsHash = 'c'.repeat(64);
    if (change === 'proposal') request.proposalId = id();
    if (change === 'private terminal')
      await prisma.runInterrupt.update({
        where: { id: f.proposalId },
        data: { status: 'cancelled', resolvedAt: new Date() },
      });
    if (change === 'expired') await f.leases.release(f.claim.lease);
    if (change === 'cancel')
      await prisma.agentTurn.update({
        where: { id: f.admission.runId },
        data: { cancelRequested: true },
      });
    if (change === 'takeover') {
      await f.leases.release(f.claim.lease);
      expect((await f.leases.claim(f.admission)).kind).toBe('claimed');
    }
    await expect(f.store.create(record)).rejects.toThrow();
    expect(
      (await prisma.runInterrupt.findUniqueOrThrow({ where: { id: f.proposalId } }))
        .nativeInterruptId,
    ).toBeNull();
  });

  it.each([false, true])(
    'actual native tool pause attaches and flushes atomically (failure: %s)',
    async (fail) => {
      const f = await leasedFixture();
      let saved = false;
      const messages = {
        ...f.messages,
        saveThread: async (threadId: string, body: Parameters<typeof f.messages.saveThread>[1]) => {
          await f.messages.saveThread(threadId, body);
          saved = true;
          if (fail) throw new Error('flush failed');
        },
      };
      const persistence = withPersistence(
        defineAIPersistence({ stores: { messages, runs: f.runs, interrupts: f.store } }),
      );
      const middleware: ChatMiddleware<unknown, typeof toolApproval> = {
        ...persistence,
        name: 'owned native pause fixture',
        onChunk: async (ctx, chunk) => {
          if (chunk.type === EventType.RUN_FINISHED && chunk.outcome?.type === 'interrupt')
            await f.boundary.close('interrupted', async () => {
              await persistence.onChunk?.(ctx, chunk);
            });
          else await persistence.onChunk?.(ctx, chunk);
        },
      };
      const outcome = async () => {
        for await (const _event of chat({
          adapter: new ScriptedAdapter([]),
          messages: [],
          threadId: f.admission.threadId,
          runId: f.admission.runId,
          interrupts: [toolApproval],
          middleware: [
            middleware,
            {
              name: 'private approval fixture',
              onInterruptBoundary: (ctx) =>
                ctx.phase === 'beforeModel'
                  ? {
                      interrupts: [
                        toolApproval.interrupt({
                          key: f.proposalId,
                          reason: 'policy',
                          message: 'Allow send_message?',
                          payload: f.request,
                        }),
                      ],
                    }
                  : undefined,
            },
          ],
        })) {
          /* Drain the actual engine. */
        }
      };
      // Engine isolation is deliberate; durable state, not hook propagation, proves rollback.
      await outcome();
      expect(saved).toBe(true);
      const row = await prisma.agentTurn.findUniqueOrThrow({ where: { id: f.admission.runId } });
      const proposal = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: f.proposalId } });
      expect(row.status).toBe(fail ? 'running' : 'interrupted');
      expect(proposal.nativeInterruptId === null).toBe(fail);
      expect(await prisma.runInterrupt.count({ where: { runId: row.id } })).toBe(1);
      expect(row.workerId === null).toBe(!fail);
    },
  );

  async function parkedFixture() {
    const f = await leasedFixture();
    const original = await prisma.runInterrupt.findUniqueOrThrow({ where: { id: f.proposalId } });
    const proposal = PolicyProposalSchema.parse(original.payload);
    const second = await prisma.runInterrupt.create({
      data: {
        userId: owner.userId,
        runId: original.runId,
        conversationId: original.conversationId,
        payload: { ...proposal, toolCallId: id() },
      },
    });
    const secondRecord = structuredClone(f.nativeRecord);
    secondRecord.interruptId = id();
    secondRecord.payload.id = secondRecord.interruptId;
    const metadata = secondRecord.payload.metadata as Record<string, any>;
    metadata['tanstack:interruptBinding'].interruptId = secondRecord.interruptId;
    metadata['tanstack:interruptBinding'].key = second.id;
    metadata['tanstack:interruptBinding'].batchIndex = 1;
    metadata['tanstack:interruptPayload'].proposalId = second.id;
    metadata['tanstack:interruptPayload'].toolCallId = PolicyProposalSchema.parse(
      second.payload,
    ).toolCallId;
    await f.boundary.close('interrupted', async () => {
      await f.store.create(f.nativeRecord);
      await f.store.create(secondRecord);
      await f.runs.update(f.admission.runId, { status: 'interrupted' });
    });
    const scope = {
      userId: owner.userId,
      botId: f.admission.botId,
      threadId: f.admission.threadId,
      parentRunId: f.admission.runId,
    };
    const resume = [f.nativeRecord, secondRecord].map((record) => ({
      interruptId: record.interruptId,
      status: 'resolved' as const,
      payload: { approved: true },
    }));
    const snapshot = async () => ({
      run: await prisma.agentTurn.findUniqueOrThrow({ where: { id: scope.parentRunId } }),
      proposals: await prisma.runInterrupt.findMany({
        where: { runId: scope.parentRunId },
        orderBy: { sequence: 'asc' },
      }),
    });
    return { ...f, second, secondRecord, scope, resume, snapshot };
  }

  it('validates the complete owned batch without writes and canonicalizes submission order', async () => {
    const f = await parkedFixture();
    const before = await f.snapshot();
    const a = await readOwnedToolResumeBatch(prisma, f.scope, f.resume);
    const b = await readOwnedToolResumeBatch(prisma, f.scope, [...f.resume].reverse());
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.canonicalResolutions).toBe(b.canonicalResolutions);
    expect(a.pending.map((entry) => entry.request.proposalId)).toEqual([f.proposalId, f.second.id]);
    expect(await f.snapshot()).toEqual(before);
    // The same validator joins the later admission transaction, retaining its locks.
    await prisma.$transaction(async (tx) => {
      expect((await validateOwnedToolResumeBatch(tx, f.scope, f.resume)).fingerprint).toBe(
        a.fingerprint,
      );
    });
  });

  it.each([
    'empty',
    'partial',
    'duplicate',
    'unknown',
    'foreign owner',
    'foreign bot',
    'foreign thread',
    'foreign run',
    'invalid response',
    'forged response properties',
    'cancel payload',
    'active parent',
    'cancelled parent',
    'private resolved',
    'private cancelled',
    'native resolved',
    'mixed runs',
    'forged native binding',
  ])('refuses a resume batch without changing any row: %s', async (change) => {
    const f = await parkedFixture();
    let scope = f.scope;
    let resume: any[] = structuredClone(f.resume);
    if (change === 'empty') resume = [];
    if (change === 'partial') resume.pop();
    if (change === 'duplicate') resume.push(resume[0]);
    if (change === 'unknown') resume[1].interruptId = id();
    if (change === 'foreign owner') scope = { ...scope, userId: stranger.userId };
    if (change === 'foreign bot') scope = { ...scope, botId: id() };
    if (change === 'foreign thread') scope = { ...scope, threadId: id() };
    if (change === 'foreign run') scope = { ...scope, parentRunId: id() };
    if (change === 'invalid response') resume[1].payload = { approved: 'yes' };
    if (change === 'forged response properties') resume[1].payload.authority = true;
    if (change === 'cancel payload') resume[1].status = 'cancelled';
    if (change === 'active parent')
      await prisma.agentTurn.update({
        where: { id: f.scope.parentRunId },
        data: { status: 'running', activeKey: f.scope.botId },
      });
    if (change === 'cancelled parent')
      await prisma.agentTurn.update({
        where: { id: f.scope.parentRunId },
        data: { cancelRequested: true },
      });
    if (change === 'private resolved' || change === 'private cancelled')
      await prisma.runInterrupt.update({
        where: { id: f.second.id },
        data: {
          status: change === 'private resolved' ? 'resolved' : 'cancelled',
          resolvedAt: new Date(),
        },
      });
    if (change === 'native resolved')
      await prisma.runInterrupt.update({
        where: { id: f.second.id },
        data: { nativeStatus: 'resolved', nativeResolvedAt: new Date() },
      });
    if (change === 'mixed runs') {
      const parent = await prisma.agentTurn.findUniqueOrThrow({
        where: { id: f.scope.parentRunId },
      });
      const other = await prisma.agentTurn.create({
        data: {
          id: id(),
          botId: parent.botId,
          conversationId: parent.conversationId,
          triggerMessageId: parent.triggerMessageId,
          status: 'interrupted',
        },
      });
      await prisma.runInterrupt.update({ where: { id: f.second.id }, data: { runId: other.id } });
    }
    if (change === 'forged native binding') {
      const payload = structuredClone(f.secondRecord.payload);
      (payload.metadata as Record<string, any>)['tanstack:interruptBinding'].responseSchemaHash =
        'forged';
      await prisma.runInterrupt.update({
        where: { id: f.second.id },
        data: { nativePayload: JsonSchema.parse(payload) },
      });
    }
    const before = await f.snapshot();
    await expect(readOwnedToolResumeBatch(prisma, scope, resume)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
  });

  it('accepts a complete denial/cancellation batch without creating grants or consuming it', async () => {
    const f = await parkedFixture();
    const before = await f.snapshot();
    const batch = await readOwnedToolResumeBatch(prisma, f.scope, [
      {
        interruptId: f.nativeRecord.interruptId,
        status: 'resolved',
        payload: { approved: false, reason: 'No', editedArgs: { recipient: 'changed' } },
      },
      { interruptId: f.secondRecord.interruptId, status: 'cancelled' },
    ]);
    expect(batch.resume).toHaveLength(2);
    expect(await f.snapshot()).toEqual(before);
  });

  it('admits an approved batch once: policy consumed, native untouched, continuation created', async () => {
    const f = await parkedFixture();
    const before = await f.snapshot();
    const admission = await admitOwnedToolResumeBatch(prisma, f.scope, f.resume);
    const lease = admission.lease;
    expect(lease.userId).toBe(owner.userId);
    expect(lease.botId).toBe(f.scope.botId);
    expect(lease.threadId).toBe(f.scope.threadId);
    expect(lease.runId).not.toBe(f.scope.parentRunId);
    expect(lease.epoch).toBe(1);
    expect(admission.batch.fingerprint).toBeTruthy();
    // The parked run row is the unchanged audit anchor; only the proposals move.
    const after = await f.snapshot();
    expect(after.run).toEqual(before.run);
    const continuation = await prisma.agentTurn.findFirstOrThrow({
      where: { resumesRunId: f.scope.parentRunId },
    });
    expect(continuation.id).toBe(lease.runId);
    expect(continuation.status).toBe('running');
    expect(continuation.activeKey).toBe(f.scope.botId);
    expect(continuation.workerId).toBe(lease.workerId);
    expect(continuation.driverEpoch).toBe(1);
    expect(continuation.triggerMessageId).toBe(before.run.triggerMessageId);
    // Lease liveness is a database-clock question; a host clock may disagree.
    const [live] = await prisma.$queryRaw<Array<{ live: boolean }>>`
      SELECT "leaseExpiresAt" > clock_timestamp() AS live FROM "AgentTurn" WHERE id = ${lease.runId}`;
    expect(live?.live).toBe(true);
    const rows = new Map(before.proposals.map((row) => [row.id, row]));
    for (const row of after.proposals) {
      const beforeRow = rows.get(row.id);
      expect(beforeRow).toBeDefined();
      // The native facet stays pending for the resumed producer's closing boundary.
      expect(row.nativeStatus).toBe('pending');
      expect(row.nativeResolvedAt).toBeNull();
      expect(row.nativeInterruptId).toBe(beforeRow?.nativeInterruptId);
      expect(row.status).toBe('resolved');
      expect(row.resolvedAt).not.toBeNull();
      const proposal = PolicyProposalSchema.parse(row.payload);
      expect(row.response).toEqual({
        approved: true,
        source: 'operator',
        args: proposal.args,
        binding: proposal.binding,
      });
      // The resumed producer can still consume the native facet after admission.
      expect(toInterruptRecord(row).ok).toBe(true);
    }
    // Answered once: a second admission neither re-consumes nor forks another continuation.
    await expect(admitOwnedToolResumeBatch(prisma, f.scope, f.resume)).rejects.toThrow();
    expect(await prisma.agentTurn.count({ where: { resumesRunId: f.scope.parentRunId } })).toBe(1);
    const settled = await prisma.agentTurn.findUniqueOrThrow({ where: { id: lease.runId } });
    expect(settled.workerId).toBe(lease.workerId);
    expect(settled.driverEpoch).toBe(1);
  });

  it('admits a mixed denial/cancellation batch without letting an edit take effect', async () => {
    const f = await parkedFixture();
    await admitOwnedToolResumeBatch(prisma, f.scope, [
      {
        interruptId: f.nativeRecord.interruptId,
        status: 'resolved',
        payload: { approved: false, reason: 'No', editedArgs: { recipient: 'changed' } },
      },
      { interruptId: f.secondRecord.interruptId, status: 'cancelled' },
    ]);
    const [first, second] = await prisma.runInterrupt.findMany({
      where: { runId: f.scope.parentRunId },
      orderBy: { sequence: 'asc' },
    });
    expect(first.status).toBe('resolved');
    const firstProposal = PolicyProposalSchema.parse(first.payload);
    // A denial records the reviewed args unchanged; the edited args never took effect.
    expect(first.response).toEqual({
      approved: false,
      source: 'operator',
      reason: 'No',
      args: firstProposal.args,
      binding: firstProposal.binding,
    });
    expect(first.nativeStatus).toBe('pending');
    expect(second.status).toBe('cancelled');
    expect(second.resolvedAt).not.toBeNull();
    expect(second.response).toBeNull();
    expect(second.nativeStatus).toBe('pending');
    const continuation = await prisma.agentTurn.findFirstOrThrow({
      where: { resumesRunId: f.scope.parentRunId },
    });
    expect(continuation.status).toBe('running');
  });

  it('refuses admission when another run of the same bot holds the active key', async () => {
    const f = await parkedFixture();
    const parent = await prisma.agentTurn.findUniqueOrThrow({
      where: { id: f.scope.parentRunId },
    });
    const active = await prisma.agentTurn.create({
      data: {
        id: id(),
        botId: parent.botId,
        conversationId: parent.conversationId,
        triggerMessageId: parent.triggerMessageId,
        status: 'running',
        activeKey: f.scope.botId,
        workerId: id(),
        driverEpoch: 1,
        leaseExpiresAt: new Date(Date.now() + 30_000),
      },
    });
    try {
      const before = await f.snapshot();
      await expect(admitOwnedToolResumeBatch(prisma, f.scope, f.resume)).rejects.toThrow(
        RunOwnershipError,
      );
      expect(await f.snapshot()).toEqual(before);
      expect(await prisma.agentTurn.count({ where: { resumesRunId: f.scope.parentRunId } })).toBe(
        0,
      );
    } finally {
      await prisma.agentTurn.delete({ where: { id: active.id } });
    }
  });

  it('refuses a foreign-scope admission without staging any decision', async () => {
    const f = await parkedFixture();
    const before = await f.snapshot();
    await expect(
      admitOwnedToolResumeBatch(prisma, { ...f.scope, userId: stranger.userId }, f.resume),
    ).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    expect(await prisma.agentTurn.count({ where: { resumesRunId: f.scope.parentRunId } })).toBe(0);
  });

  describe('D-182 owned native consumption authority', () => {
    type Claim =
      | {
          status: 'resolved';
          response: { approved: boolean; reason?: string; editedArgs?: Json };
        }
      | { status: 'cancelled' };

    // The claim the resumed producer hands its authorizer. Its request is the
    // server descriptor rehydrated at attachment; its response is the runtime's
    // claim, which D-182 never trusts.
    function claimOf(
      scope: { readonly botId: string },
      row: { id: string; runId: string; payload: unknown },
      answer: Claim,
    ) {
      const proposal = PolicyProposalSchema.parse(row.payload);
      return {
        request: toolApproval.interrupt({
          key: row.id,
          reason: 'policy',
          message: `Allow ${proposal.toolName}?`,
          payload: {
            proposalId: row.id,
            botId: scope.botId,
            runId: row.runId,
            toolCallId: proposal.toolCallId,
            definitionName: proposal.definitionName,
            toolName: proposal.toolName,
            args: proposal.args,
            binding: proposal.binding,
          },
        }),
        ...answer,
      };
    }

    it('authorizes admitted dispatch with the reviewed definition input, never the claimed edit', async () => {
      const f = await parkedFixture();
      await admitOwnedToolResumeBatch(prisma, f.scope, [
        {
          interruptId: f.nativeRecord.interruptId,
          status: 'resolved',
          payload: { approved: true },
        },
        {
          interruptId: f.secondRecord.interruptId,
          status: 'resolved',
          payload: { approved: true, editedArgs: { recipient: 'edited' } },
        },
      ]);
      const continuation = await prisma.agentTurn.findFirstOrThrow({
        where: { resumesRunId: f.scope.parentRunId },
      });
      const [first, second] = await prisma.runInterrupt.findMany({
        where: { runId: f.scope.parentRunId },
        orderBy: { sequence: 'asc' },
      });
      const authorize = createOwnedToolDispatchAuthorizer(prisma, {
        userId: owner.userId,
        botId: f.scope.botId,
      });
      const authorized = await authorize({
        runId: continuation.id,
        parentRunId: f.scope.parentRunId,
        threadId: f.scope.threadId,
        resolutions: [
          // The runtime re-frames both answers' edits. The tool receives the
          // stored definition input; the restored plan applies the staged edit.
          claimOf(f.scope, first, {
            status: 'resolved',
            response: { approved: true, editedArgs: { recipient: 'claimed-forgery' } },
          }),
          claimOf(f.scope, second, {
            status: 'resolved',
            response: { approved: true, editedArgs: { recipient: 'claimed-forgery' } },
          }),
        ],
      });
      expect(authorized).toEqual([
        {
          toolCallId: PolicyProposalSchema.parse(first.payload).toolCallId,
          approved: true,
          dispatchArgs: { recipient: 'fixture' },
        },
        {
          toolCallId: PolicyProposalSchema.parse(second.payload).toolCallId,
          approved: true,
          dispatchArgs: { recipient: 'fixture' },
        },
      ]);
    });

    it('skips declined and cancelled staged decisions with their staged reason', async () => {
      const f = await parkedFixture();
      await admitOwnedToolResumeBatch(prisma, f.scope, [
        {
          interruptId: f.nativeRecord.interruptId,
          status: 'resolved',
          payload: { approved: false, reason: 'No', editedArgs: { recipient: 'changed' } },
        },
        { interruptId: f.secondRecord.interruptId, status: 'cancelled' },
      ]);
      const continuation = await prisma.agentTurn.findFirstOrThrow({
        where: { resumesRunId: f.scope.parentRunId },
      });
      const [first, second] = await prisma.runInterrupt.findMany({
        where: { runId: f.scope.parentRunId },
        orderBy: { sequence: 'asc' },
      });
      const authorize = createOwnedToolDispatchAuthorizer(prisma, {
        userId: owner.userId,
        botId: f.scope.botId,
      });
      const authorized = await authorize({
        runId: continuation.id,
        parentRunId: f.scope.parentRunId,
        threadId: f.scope.threadId,
        resolutions: [
          claimOf(f.scope, first, {
            status: 'resolved',
            response: { approved: false, reason: 'Claimed reason' },
          }),
          claimOf(f.scope, second, { status: 'cancelled' }),
        ],
      });
      expect(authorized).toEqual([
        {
          toolCallId: PolicyProposalSchema.parse(first.payload).toolCallId,
          approved: false,
          reason: 'No',
        },
        {
          toolCallId: PolicyProposalSchema.parse(second.payload).toolCallId,
          approved: false,
          reason: 'Cancelled',
        },
      ]);
    });

    it('refuses a pending claim without changing any row', async () => {
      const f = await parkedFixture();
      // A continuation exists, but the batch never reached admission: no staged
      // decision may authorize anything it claims.
      const continuation = await prisma.agentTurn.create({
        data: {
          id: id(),
          botId: f.scope.botId,
          conversationId: f.scope.threadId,
          triggerMessageId: f.admission.triggerMessageId,
          status: 'running',
          activeKey: f.scope.botId,
          workerId: id(),
          driverEpoch: 1,
          leaseExpiresAt: new Date(Date.now() + 30_000),
          resumesRunId: f.scope.parentRunId,
        },
      });
      const [first] = await prisma.runInterrupt.findMany({
        where: { runId: f.scope.parentRunId },
        orderBy: { sequence: 'asc' },
      });
      const authorize = createOwnedToolDispatchAuthorizer(prisma, {
        userId: owner.userId,
        botId: f.scope.botId,
      });
      const before = await f.snapshot();
      await expect(
        authorize({
          runId: continuation.id,
          parentRunId: f.scope.parentRunId,
          threadId: f.scope.threadId,
          resolutions: [
            claimOf(f.scope, first, { status: 'resolved', response: { approved: true } }),
          ],
        }),
      ).rejects.toThrow();
      expect(await f.snapshot()).toEqual(before);
    });

    it('refuses foreign-run and mismatched claims without changing any row', async () => {
      const f = await parkedFixture();
      await admitOwnedToolResumeBatch(prisma, f.scope, f.resume);
      const continuation = await prisma.agentTurn.findFirstOrThrow({
        where: { resumesRunId: f.scope.parentRunId },
      });
      const [first, second] = await prisma.runInterrupt.findMany({
        where: { runId: f.scope.parentRunId },
        orderBy: { sequence: 'asc' },
      });
      const authorize = createOwnedToolDispatchAuthorizer(prisma, {
        userId: owner.userId,
        botId: f.scope.botId,
      });
      const input = {
        runId: continuation.id,
        parentRunId: f.scope.parentRunId,
        threadId: f.scope.threadId,
      };
      const before = await f.snapshot();
      // The executing run must chain to the interrupted parent.
      await expect(
        authorize({
          ...input,
          runId: id(),
          resolutions: [
            claimOf(f.scope, first, { status: 'resolved', response: { approved: true } }),
          ],
        }),
      ).rejects.toThrow(RunOwnershipError);
      // A staged approval cannot be claimed as a denial or a cancellation.
      await expect(
        authorize({
          ...input,
          resolutions: [
            claimOf(f.scope, first, {
              status: 'resolved',
              response: { approved: false, reason: 'Claimed denial' },
            }),
          ],
        }),
      ).rejects.toThrow();
      await expect(
        authorize({
          ...input,
          resolutions: [claimOf(f.scope, second, { status: 'cancelled' })],
        }),
      ).rejects.toThrow();
      // A claim whose request misidentifies the proposal is refused too.
      const forged = claimOf(f.scope, first, { status: 'resolved', response: { approved: true } });
      await expect(
        authorize({
          ...input,
          resolutions: [
            {
              ...forged,
              request: toolApproval.interrupt({
                key: first.id,
                reason: 'policy',
                message: `Allow send_message?`,
                payload: {
                  ...ToolApprovalRequestSchema.parse(forged.request.payload),
                  runId: id(),
                },
              }),
            },
          ],
        }),
      ).rejects.toThrow();
      expect(await f.snapshot()).toEqual(before);
    });

    it('commits matching native terminal writes and refuses pending or mismatched ones', async () => {
      const f = await parkedFixture();
      const store = createPrismaInterruptStore(
        prisma,
        { userId: owner.userId },
        { ...f.authority, assertCommit: assertOwnedToolInterruptCommit },
      );
      // A batch that failed admission can never be consumed.
      const before = await f.snapshot();
      await expect(
        store.commitBatch([
          {
            interruptId: f.nativeRecord.interruptId,
            status: 'resolved',
            response: { approved: true },
          },
        ]),
      ).rejects.toThrow();
      expect(await f.snapshot()).toEqual(before);

      await admitOwnedToolResumeBatch(prisma, f.scope, [
        {
          interruptId: f.nativeRecord.interruptId,
          status: 'resolved',
          payload: { approved: true },
        },
        { interruptId: f.secondRecord.interruptId, status: 'cancelled' },
      ]);
      const [first, second] = await prisma.runInterrupt.findMany({
        where: { runId: f.scope.parentRunId },
        orderBy: { sequence: 'asc' },
      });
      // Mismatched entries are refused before any native column changes.
      await expect(
        store.commitBatch([
          {
            interruptId: f.nativeRecord.interruptId,
            status: 'resolved',
            response: { approved: false, reason: 'Forged denial' },
          },
        ]),
      ).rejects.toThrow();
      await expect(
        store.commitBatch([{ interruptId: f.nativeRecord.interruptId, status: 'cancelled' }]),
      ).rejects.toThrow();
      await expect(
        store.commitBatch([
          {
            interruptId: f.secondRecord.interruptId,
            status: 'resolved',
            response: { approved: true },
          },
        ]),
      ).rejects.toThrow();
      expect(
        (await prisma.runInterrupt.findUniqueOrThrow({ where: { id: first.id } })).nativeStatus,
      ).toBe('pending');
      expect(
        (await prisma.runInterrupt.findUniqueOrThrow({ where: { id: second.id } })).nativeStatus,
      ).toBe('pending');

      // Matching entries commit into the native facet, once.
      await store.commitBatch([
        {
          interruptId: f.nativeRecord.interruptId,
          status: 'resolved',
          response: { approved: true },
        },
        { interruptId: f.secondRecord.interruptId, status: 'cancelled' },
      ]);
      expect(
        await prisma.runInterrupt.findUniqueOrThrow({ where: { id: first.id } }),
      ).toMatchObject({
        nativeStatus: 'resolved',
        nativeResponse: { value: { approved: true } },
      });
      expect(
        await prisma.runInterrupt.findUniqueOrThrow({ where: { id: second.id } }),
      ).toMatchObject({
        nativeStatus: 'cancelled',
        nativeResponse: null,
      });
    });
  });
});
