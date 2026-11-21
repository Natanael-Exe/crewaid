/** A resumed run's plans come from durable rows only; each new runtime here is a restarted process. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JsonSchema, type Json } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import {
  createPolicyProposalStore,
  PolicyProposalSchema,
  ResolutionSchema,
  type ProposalStoreScope,
} from '../src/agent/policy/proposal-store.js';
import { createPolicyRuntime, type PolicyState } from '../src/agent/policy/runtime.js';
import { policyHash } from '../src/agent/policy/policy.js';
import { SENSITIVE_BUILTIN } from '../src/agent/tool-registry.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const BRIDGE = 'use_plugin_tool';

describe.skipIf(!DATABASE_URL)('MOD-AI-06 restored policy plans (real db)', () => {
  const prisma = new PrismaService();
  let owner: SignedInUser;
  beforeAll(async () => {
    await prisma.$connect();
    owner = await signIn(prisma, { label: 'restoredplans' });
  });
  afterAll(async () => {
    await signOutAndDelete(prisma, owner.userId);
    await prisma.$disconnect();
  });

  // The bridge's envelope is the definition input; policy sees the inner call.
  const project = (name: string, args: unknown) => {
    const envelope = z(args);
    return name === BRIDGE
      ? {
          name: String(envelope['tool']),
          args: envelope['arguments'],
          behavior: SENSITIVE_BUILTIN,
          repackArgs: (edited: Json) =>
            JsonSchema.parse({ tool: envelope['tool'], arguments: edited }),
        }
      : { name, args, behavior: SENSITIVE_BUILTIN };
  };
  function z(value: unknown): Record<string, Json> {
    const parsed = JsonSchema.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('fixture');
    return parsed;
  }

  async function parked(definitionName: string, rawArgs: Json) {
    const bot = await prisma.bot.create({
      data: {
        userId: owner.userId,
        name: `restore-${randomUUID()}`,
        role: 'fixture',
        avatarColor: '#8B6F47',
        systemPrompt: '',
      },
    });
    const thread = await prisma.conversation.create({
      data: { botId: bot.id },
    });
    const parent = await prisma.agentTurn.create({
      data: {
        botId: bot.id,
        conversationId: thread.id,
        triggerMessageId: randomUUID(),
        status: 'running',
      },
    });
    const state: { current: PolicyState } = {
      current: {
        snapshot: {
          mode: 'ASK',
          rules: [],
          grantRevision: policyHash(['grant']),
          grantValid: true,
          seat: null,
          resourceRevision: null,
        },
      },
    };
    const runtime = (runId: string, projector = project) => {
      const scope: ProposalStoreScope = {
        userId: owner.userId,
        botId: bot.id,
        conversationId: thread.id,
        runId,
      };
      return createPolicyRuntime({
        project: projector,
        read: async () => state.current,
        store: createPolicyProposalStore(prisma, scope),
      });
    };
    // The parent producer decides the call and parks on its approval.
    const toolCallId = randomUUID();
    const first = runtime(parent.id);
    expect(
      await first.decide({ toolCall: { toolCallId, toolName: definitionName, input: rawArgs } }),
    ).toBe('user-approval');
    const row = await prisma.runInterrupt.findFirstOrThrow({ where: { runId: parent.id } });
    const proposal = PolicyProposalSchema.parse(row.payload);
    await prisma.agentTurn.update({ where: { id: parent.id }, data: { status: 'interrupted' } });
    // What admission stages, then the continuation it creates.
    async function answer(approved: boolean, editedArgs?: Json) {
      const args = approved && editedArgs !== undefined ? editedArgs : proposal.args;
      await prisma.runInterrupt.update({
        where: { id: row.id },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          response: ResolutionSchema.parse({
            approved,
            source: 'operator',
            ...(approved ? {} : { reason: 'No' }),
            args,
            binding: proposal.binding,
          }),
        },
      });
      return prisma.agentTurn.create({
        data: {
          botId: bot.id,
          conversationId: thread.id,
          triggerMessageId: parent.triggerMessageId,
          status: 'running',
          resumesRunId: parent.id,
        },
      });
    }
    const response = async () =>
      ResolutionSchema.parse(
        (await prisma.runInterrupt.findUniqueOrThrow({ where: { id: row.id } })).response,
      );
    return { toolCallId, proposal, row, state, runtime, answer, response };
  }

  it('stores the definition input beside the reviewed projection', async () => {
    const f = await parked(BRIDGE, { tool: 'notes__write', arguments: { text: 'hi' } });
    expect(f.proposal).toMatchObject({
      definitionName: BRIDGE,
      toolName: 'notes__write',
      args: { text: 'hi' },
      rawArgs: { tool: 'notes__write', arguments: { text: 'hi' } },
    });
  });

  it('dispatches an approved edit once from a fresh runtime and never after a restart', async () => {
    const raw = { tool: 'notes__write', arguments: { text: 'hi' } };
    const f = await parked(BRIDGE, raw);
    const continuation = await f.answer(true, { text: 'edited' });
    const action = vi.fn(async (args: Json) => ({ wrote: args }));

    const resumed = f.runtime(continuation.id);
    await resumed.restore();
    // The edit is repacked into the definition's shape, never handed over projected.
    expect(await resumed.execute(BRIDGE, raw, f.toolCallId, action)).toMatchObject({
      actualArguments: { text: 'edited' },
    });
    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith({ tool: 'notes__write', arguments: { text: 'edited' } });
    expect((await f.response()).dispatchedAt).toBeDefined();

    // A process that restarts mid-run finds the marker and refuses to repeat the call.
    const restarted = f.runtime(continuation.id);
    await restarted.restore();
    expect(await restarted.execute(BRIDGE, raw, f.toolCallId, action)).toMatch(
      /^APPROVAL_STALE: this approved call was already dispatched/,
    );
    expect(action).toHaveBeenCalledOnce();
  });

  it('a dispatch interrupted before its outcome stays uncertain across a restart', async () => {
    const f = await parked('shell', { command: 'ls' });
    const continuation = await f.answer(true);
    const resumed = f.runtime(continuation.id);
    await resumed.restore();
    // The process dies inside the action: the marker is all that survives.
    const dying = vi.fn(() => new Promise<never>(() => undefined));
    void resumed.execute('shell', { command: 'ls' }, f.toolCallId, dying);
    await vi.waitFor(() => expect(dying).toHaveBeenCalledOnce());
    expect((await f.response()).dispatchedAt).toBeDefined();
    expect((await f.response()).outcome).toBeUndefined();

    const action = vi.fn(async () => 'ran');
    const restarted = f.runtime(continuation.id);
    await restarted.restore();
    expect(await restarted.execute('shell', { command: 'ls' }, f.toolCallId, action)).toMatch(
      /^APPROVAL_STALE/,
    );
    expect(action).not.toHaveBeenCalled();
  });

  it('dispatches nothing for a declined answer, changed input or changed projection', async () => {
    const action = vi.fn(async () => 'ran');

    const declined = await parked('shell', { command: 'ls' });
    const c1 = await declined.answer(false);
    const r1 = declined.runtime(c1.id);
    await r1.restore();
    expect(await r1.execute('shell', { command: 'ls' }, declined.toolCallId, action)).toMatch(
      /^APPROVAL_STALE/,
    );

    const changed = await parked('shell', { command: 'ls' });
    const c2 = await changed.answer(true);
    const r2 = changed.runtime(c2.id);
    await r2.restore();
    expect(await r2.execute('shell', { command: 'rm -rf /' }, changed.toolCallId, action)).toMatch(
      /^APPROVAL_STALE/,
    );

    // The same stored input no longer projects to what the operator reviewed.
    const drifted = await parked(BRIDGE, { tool: 'notes__write', arguments: { text: 'hi' } });
    const c3 = await drifted.answer(true);
    const r3 = drifted.runtime(c3.id, (name, args) => ({
      ...project(name, args),
      name: 'notes__delete',
    }));
    await r3.restore();
    expect(
      await r3.execute(
        BRIDGE,
        { tool: 'notes__write', arguments: { text: 'hi' } },
        drifted.toolCallId,
        action,
      ),
    ).toMatch(/^APPROVAL_STALE/);

    expect(action).not.toHaveBeenCalled();
    for (const f of [declined, changed, drifted])
      expect((await f.response()).dispatchedAt).toBeUndefined();
  });

  it('a grant revoked while parked fails the final fence and leaves no dispatch marker', async () => {
    const f = await parked('shell', { command: 'ls' });
    const continuation = await f.answer(true);
    const resumed = f.runtime(continuation.id);
    await resumed.restore();
    f.state.current = {
      snapshot: { ...f.state.current.snapshot, grantRevision: policyHash(['revoked']) },
    };
    const action = vi.fn(async () => 'ran');
    expect(await resumed.execute('shell', { command: 'ls' }, f.toolCallId, action)).toMatch(
      /^GRANT_CHANGED|^APPROVAL_STALE|propose a fresh call/,
    );
    expect(action).not.toHaveBeenCalled();
    expect((await f.response()).dispatchedAt).toBeUndefined();
  });

  it('a run that resumes nothing, or another bot, restores no plan', async () => {
    const f = await parked('shell', { command: 'ls' });
    await f.answer(true);
    const action = vi.fn(async () => 'ran');
    // The parent itself is not a continuation: it has nothing staged to restore.
    const parentAgain = f.runtime(f.row.runId);
    await parentAgain.restore();
    expect(await parentAgain.execute('shell', { command: 'ls' }, f.toolCallId, action)).toMatch(
      /^APPROVAL_STALE/,
    );
    const other = await parked('shell', { command: 'ls' });
    const foreign = await prisma.agentTurn.create({
      data: {
        botId: (await prisma.agentTurn.findUniqueOrThrow({ where: { id: other.row.runId } })).botId,
        conversationId: other.row.conversationId,
        triggerMessageId: randomUUID(),
        status: 'running',
        resumesRunId: other.row.runId,
      },
    });
    // A store scoped to another bot cannot read this continuation at all.
    await expect(f.runtime(foreign.id).restore()).rejects.toThrow('not owned');
    expect(action).not.toHaveBeenCalled();
  });
});
