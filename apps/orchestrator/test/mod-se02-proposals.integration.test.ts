import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';
import {
  createPolicyProposalStore,
  type PolicyProposal,
  type ProposalStoreScope,
} from '../src/agent/policy/proposal-store.js';
import { policyHash } from '../src/agent/policy/policy.js';

// Real database acceptance; the repository gate supplies DATABASE_URL.
describe.skipIf(!process.env['DATABASE_URL'])(
  'durable policy proposal ownership and continuations',
  () => {
    const prisma = new PrismaService();
    let owner: SignedInUser;
    let stranger: SignedInUser;
    beforeAll(async () => {
      await prisma.$connect();
      owner = await signIn(prisma, { label: 'modse02' });
      stranger = await signIn(prisma, { label: 'modse02x' });
    });
    afterAll(async () => {
      await signOutAndDelete(prisma, owner.userId);
      await signOutAndDelete(prisma, stranger.userId);
      await prisma.$disconnect();
    });

    async function scope(): Promise<ProposalStoreScope> {
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: `policy-${randomUUID()}`,
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
        },
      });
      const conversation = await prisma.conversation.create({
        data: { botId: bot.id },
      });
      const run = await prisma.agentTurn.create({
        data: {
          botId: bot.id,
          conversationId: conversation.id,
          triggerMessageId: randomUUID(),
          status: 'running',
        },
      });
      return {
        userId: owner.userId,
        botId: bot.id,
        conversationId: conversation.id,
        runId: run.id,
      };
    }
    const proposal = (overrides: Partial<PolicyProposal> = {}): PolicyProposal => ({
      type: 'crewaid.tool-approval',
      toolCallId: randomUUID(),
      definitionName: 'shell',
      toolName: 'shell',
      args: { command: 'ls' },
      rawArgs: { command: 'ls' },
      mode: 'AUTO',
      authority: false,
      binding: {
        toolName: 'shell',
        effect: 'unknown',
        scope: 'call',
        argsHash: policyHash({ command: 'ls' }),
        grantRevision: policyHash(['grant']),
        resourceRevision: null,
        seat: null,
        commit: null,
      },
      ...overrides,
    });

    it('persists the exact proposal and admits one of two racing responses', async () => {
      const s = await scope();
      const store = createPolicyProposalStore(prisma, s);
      const p = proposal();
      const id = await store.create(p);
      expect(await store.read(id)).toEqual(p);
      const answers = await Promise.all(
        [true, false].map((approved) =>
          store.resolve(id, { approved, args: p.args, binding: p.binding }),
        ),
      );
      expect(answers.filter(Boolean)).toHaveLength(1);
      expect(await store.read(id)).toBeNull();
      expect((await prisma.runInterrupt.findUniqueOrThrow({ where: { id } })).status).toBe(
        'resolved',
      );
    });

    it('does not expose or consume another principal/bot/run proposal', async () => {
      const s = await scope();
      const store = createPolicyProposalStore(prisma, s);
      const p = proposal();
      const id = await store.create(p);
      const other = await scope();
      for (const badScope of [
        { ...s, userId: stranger.userId },
        { ...s, botId: other.botId },
        { ...s, runId: other.runId },
      ]) {
        const foreign = createPolicyProposalStore(prisma, badScope);
        expect(await foreign.read(id)).toBeNull();
        expect(
          await foreign.resolve(id, { approved: true, args: p.args, binding: p.binding }),
        ).toBe(false);
        await expect(foreign.create(p)).rejects.toThrow();
      }
      expect(await store.read(id)).toEqual(p);
    });

    it('a cancelled or terminal run cannot acquire approval', async () => {
      const s = await scope();
      const store = createPolicyProposalStore(prisma, s);
      const p = proposal();
      const id = await store.create(p);
      await store.cancel(id);
      expect(await store.resolve(id, { approved: true, args: p.args, binding: p.binding })).toBe(
        false,
      );
      await prisma.agentTurn.update({ where: { id: s.runId }, data: { status: 'aborted' } });
      await expect(store.create(p)).rejects.toThrow();
    });

    it('loads resolved approval across a restarted store and a genuine continuation only', async () => {
      const s = await scope();
      const store = createPolicyProposalStore(prisma, s);
      const p = proposal();
      const id = await store.create(p);
      expect(await store.resolve(id, { approved: true, args: p.args, binding: p.binding })).toBe(
        true,
      );
      const next = await prisma.agentTurn.create({
        data: {
          botId: s.botId,
          conversationId: s.conversationId,
          triggerMessageId: randomUUID(),
          resumesRunId: s.runId,
          status: 'running',
        },
      });
      expect(await createPolicyProposalStore(prisma, { ...s, runId: next.id }).memory()).toEqual([
        // Not yet dispatched: the only state in which an `alwaysAsk` approval may cover its call.
        { binding: p.binding, mode: 'AUTO', authority: false, dispatched: false },
      ]);
      expect(await createPolicyProposalStore(prisma, await scope()).memory()).toEqual([]);
      const other = await scope();
      await prisma.agentTurn.update({
        where: { id: next.id },
        data: { resumesRunId: other.runId },
      });
      await expect(
        createPolicyProposalStore(prisma, { ...s, runId: next.id }).memory(),
      ).rejects.toThrow('not owned by this bot');
    });

    it('stores edited server binding and arguments rather than trusting the original proposal', async () => {
      const s = await scope();
      const store = createPolicyProposalStore(prisma, s);
      const p = proposal();
      const id = await store.create(p);
      const args = { command: 'pwd' };
      const binding = { ...p.binding, argsHash: policyHash(args) };
      await store.resolve(id, { approved: true, args, binding });
      expect(await store.memory()).toEqual([
        { binding, mode: 'AUTO', authority: false, dispatched: false },
      ]);
    });

    it('persists commit receipts and does not turn a FULL policy resolution into operator memory', async () => {
      const s = await scope();
      const store = createPolicyProposalStore(prisma, s);
      const p = proposal({ mode: 'FULL' });
      const id = await store.create(p);
      await store.resolve(id, {
        approved: true,
        source: 'policy',
        args: p.args,
        binding: p.binding,
      });
      await store.recordOutcome(id, { status: 'committed', reference: 'controlled-message' });
      expect(
        (await prisma.runInterrupt.findUniqueOrThrow({ where: { id } })).response,
      ).toMatchObject({ outcome: { status: 'committed', reference: 'controlled-message' } });
      expect(await store.memory()).toEqual([]);
      await expect(
        createPolicyProposalStore(prisma, { ...s, userId: stranger.userId }).recordOutcome(id, {
          status: 'uncertain',
        }),
      ).rejects.toThrow();
      const denied = await store.create(proposal());
      await store.resolve(denied, { approved: false, args: p.args, binding: p.binding });
      await expect(store.recordOutcome(denied, { status: 'uncertain' })).rejects.toThrow(
        'declined',
      );
      expect(await store.assertLive()).toBe(true);
      await prisma.agentTurn.update({ where: { id: s.runId }, data: { status: 'completed' } });
      expect(await store.assertLive()).toBe(false);
    });

    it('an identity window requires the approved selection of that exact login', async () => {
      const s = await scope();
      const store = createPolicyProposalStore(prisma, s);
      const args = { identity: 'company-google' };
      const p = proposal({
        definitionName: 'use_identity',
        toolName: 'use_identity',
        args,
        authority: true,
        binding: {
          ...proposal().binding,
          toolName: 'use_identity',
          effect: 'draft',
          argsHash: policyHash(args),
        },
      });
      const id = await store.create(p);
      const window = {
        ...p.binding,
        effect: 'unknown' as const,
        scope: 'identity-turn' as const,
        seat: { identity: 'company-google', browserGeneration: 2 },
        grantRevision: policyHash(['new selection']),
      };
      await expect(store.openIdentityWindow(id, window)).rejects.toThrow();
      await store.resolve(id, { approved: true, args, binding: p.binding });
      await expect(
        store.openIdentityWindow(id, {
          ...window,
          seat: { identity: 'other', browserGeneration: 2 },
        }),
      ).rejects.toThrow();
      await store.openIdentityWindow(id, window);
      expect(await store.memory()).toContainEqual({
        binding: window,
        mode: 'AUTO',
        authority: false,
      });
    });
  },
);
