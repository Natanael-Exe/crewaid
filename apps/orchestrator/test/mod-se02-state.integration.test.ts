import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ToolPolicyStateService } from '../src/agent/policy/state.service.js';
import { pluginRevision } from '../src/agent/policy/resource-revision.js';
import { createPolicyRuntime, type PolicyCall } from '../src/agent/policy/runtime.js';
import { createPolicyProposalStore } from '../src/agent/policy/proposal-store.js';
import { SEAT_BUILTIN, OBSERVING_BUILTIN } from '../src/agent/tool-registry.js';
import { mcpToolBehavior } from '../src/mcp/mcp-tool-binding.js';
import { storeMcpCredential } from '../src/mcp/mcp-credentials.js';
import { BotPluginsService } from '../src/mcp/bot-plugins.service.js';
import type { Seat } from '../src/sandbox/seat.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

describe.skipIf(!process.env['DATABASE_URL'])(
  'current policy state from owned Prisma records',
  () => {
    const prisma = new PrismaService();
    let owner: SignedInUser;
    let stranger: SignedInUser;
    beforeAll(async () => {
      vi.stubEnv('CREDENTIAL_KEY', '44'.repeat(32));
      await prisma.$connect();
      owner = await signIn(prisma, { label: 'policyState' });
      stranger = await signIn(prisma, { label: 'policyForeign' });
    });
    afterAll(async () => {
      await prisma.skill.deleteMany({ where: { bot: { userId: owner.userId } } });
      await signOutAndDelete(prisma, owner.userId);
      await signOutAndDelete(prisma, stranger.userId);
      await prisma.$disconnect();
      vi.unstubAllEnvs();
    });
    async function fixture(mode: 'AUTO' | 'ASK' | 'FULL' = 'FULL') {
      const computer = await prisma.sandbox.create({
        data: { userId: owner.userId, sessionId: randomUUID(), state: 'RUNNING' },
      });
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          sandboxId: computer.id,
          name: randomUUID(),
          role: 'fixture',
          avatarColor: '#8B6F47',
          systemPrompt: '',
          approvalMode: mode,
        },
      });
      const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
      const run = await prisma.agentTurn.create({
        data: {
          botId: bot.id,
          conversationId: conversation.id,
          triggerMessageId: randomUUID(),
          status: 'running',
        },
      });
      let live: Seat | null = {
        seatId: randomUUID(),
        botId: bot.id,
        display: ':10',
        rfbPort: 5901,
        cdpPort: 9301,
        browserReady: true,
        browserGeneration: 1,
        profile: bot.id,
        identityRevision: 0,
        widthPx: 1280,
        heightPx: 800,
      };
      const seats = {
        ensureSeat: vi.fn(async () => live),
        ensureBrowser: vi.fn(async () => live),
        seatFor: vi.fn(async () => live),
      };
      const state = new ToolPolicyStateService(
        prisma,
        seats as never,
        {
          withComputer: async (
            _user: string,
            _bot: string,
            _reason: string,
            callback: () => Promise<unknown>,
          ) => callback(),
        } as never,
      );
      const scope = {
        userId: owner.userId,
        botId: bot.id,
        conversationId: conversation.id,
        runId: run.id,
      };
      const store = createPolicyProposalStore(prisma, scope);
      const runtime = (
        project: (name: string, args: unknown) => Omit<PolicyCall, 'args'> & { args: unknown },
      ) =>
        createPolicyRuntime({
          project,
          read: (call, prepare) => state.read(owner.userId, bot.id, call, prepare),
          store,
        });
      return {
        bot,
        computer,
        state,
        seats,
        runtime,
        scope,
        store,
        setSeat: (seat: Seat | null) => {
          live = seat;
        },
        getSeat: () => live!,
      };
    }
    const propose = (policy: ReturnType<typeof createPolicyRuntime>, name: string, input = {}) =>
      policy.decide({ toolCall: { toolName: name, toolCallId: 'model-call', input } });
    it('refuses foreign bot ownership and prepares a private browser without granting a named login', async () => {
      const f = await fixture('AUTO');
      const call = { name: 'browser_click', args: {}, behavior: SEAT_BUILTIN };
      await expect(f.state.read(stranger.userId, f.bot.id, call, true)).rejects.toThrow(
        'GRANT_REVOKED',
      );
      const read = await f.state.read(owner.userId, f.bot.id, call, true);
      expect(read.snapshot.seat).toEqual({ identity: null, browserGeneration: 1 });
      expect(f.seats.ensureBrowser).toHaveBeenCalledOnce();
      expect(
        (
          await f.state.read(
            owner.userId,
            f.bot.id,
            { name: 'fs_read', args: {}, behavior: OBSERVING_BUILTIN },
            false,
          )
        ).snapshot.seat,
      ).toBeNull();
    });
    it.each(['browser', 'seat', 'revocation'] as const)(
      'a %s change fences a named-login action even in FULL',
      async (change) => {
        const f = await fixture();
        const identity = await prisma.identity.create({
          data: { sandboxId: f.computer.id, name: 'controlled-login' },
        });
        await prisma.botIdentity.create({ data: { botId: f.bot.id, identityId: identity.id } });
        await prisma.bot.update({
          where: { id: f.bot.id },
          data: { activeIdentityId: identity.id, identityRevision: 1 },
        });
        f.setSeat({ ...f.getSeat(), profile: identity.name, identityRevision: 1 });
        const policy = f.runtime((name, args) => ({ name, args, behavior: SEAT_BUILTIN }));
        expect(await propose(policy, 'browser_click')).toBe('not-applicable');
        if (change === 'browser') f.setSeat({ ...f.getSeat(), browserGeneration: 2 });
        if (change === 'seat') f.setSeat({ ...f.getSeat(), seatId: randomUUID() });
        if (change === 'revocation')
          await prisma.botIdentity.delete({
            where: { botId_identityId: { botId: f.bot.id, identityId: identity.id } },
          });
        const action = vi.fn();
        expect(await policy.execute('browser_click', {}, 'model-call', action)).toContain(
          change === 'revocation' ? 'GRANT_REVOKED' : 'APPROVAL_STALE',
        );
        expect(action).not.toHaveBeenCalled();
      },
    );
    async function plugin(f: Awaited<ReturnType<typeof fixture>>) {
      const server = await prisma.mcpServer.create({
        data: {
          userId: owner.userId,
          name: 'controlled plugin',
          slug: randomUUID(),
          url: 'https://plugin.test.invalid',
          status: 'CONNECTED',
        },
      });
      const tool = await prisma.mcpTool.create({
        data: {
          serverId: server.id,
          name: 'send',
          description: 'controlled test',
          inputSchema: { type: 'object', additionalProperties: false },
          readOnly: false,
        },
      });
      const plugins = new BotPluginsService(prisma, {} as never);
      await plugins.replace(owner.userId, f.bot.id, [server.id]);
      return { server, tool, plugins };
    }
    it.each(['grant', 'credential', 'schema', 'classification'] as const)(
      'a changed plugin %s cannot execute an already admitted FULL call',
      async (change) => {
        const f = await fixture();
        const p = await plugin(f);
        const policy = f.runtime((name, args) => ({
          name,
          args,
          behavior: mcpToolBehavior(p.server.id, false),
          resource: { toolName: p.tool.name, revision: pluginRevision(p.server.id, p.tool) },
        }));
        expect(await propose(policy, 'plugin__send')).toBe('not-applicable');
        if (change === 'grant') await p.plugins.replace(owner.userId, f.bot.id, []);
        if (change === 'credential')
          await storeMcpCredential(prisma, {
            userId: owner.userId,
            serverId: p.server.id,
            accessToken: 'controlled-test-token',
            scopes: [],
          });
        if (change === 'schema')
          await prisma.mcpTool.update({
            where: { id: p.tool.id },
            data: { inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
          });
        if (change === 'classification')
          await prisma.mcpTool.update({ where: { id: p.tool.id }, data: { readOnly: true } });
        const action = vi.fn();
        expect(await policy.execute('plugin__send', {}, 'model-call', action)).toContain(
          change === 'grant' ? 'GRANT_REVOKED' : 'APPROVAL_STALE',
        );
        expect(action).not.toHaveBeenCalled();
      },
    );
    it('revoke/regrant and racing replacements advance revisions without relying on timestamps', async () => {
      const f = await fixture();
      const p = await plugin(f);
      const call = {
        name: 'plugin__send',
        args: {},
        behavior: mcpToolBehavior(p.server.id, false),
        resource: { toolName: p.tool.name, revision: pluginRevision(p.server.id, p.tool) },
      };
      const before = await f.state.read(owner.userId, f.bot.id, call, false);
      await p.plugins.replace(owner.userId, f.bot.id, []);
      await p.plugins.replace(owner.userId, f.bot.id, [p.server.id]);
      const restored = await f.state.read(owner.userId, f.bot.id, call, false);
      expect(restored.snapshot.grantRevision).not.toBe(before.snapshot.grantRevision);
      const revision = (await prisma.bot.findUniqueOrThrow({ where: { id: f.bot.id } }))
        .pluginGrantRevision;
      await Promise.all([
        p.plugins.replace(owner.userId, f.bot.id, []),
        p.plugins.replace(owner.userId, f.bot.id, [p.server.id]),
      ]);
      expect(
        (await prisma.bot.findUniqueOrThrow({ where: { id: f.bot.id } })).pluginGrantRevision,
      ).toBe(revision + 2);
      await Promise.all([
        storeMcpCredential(prisma, {
          userId: owner.userId,
          serverId: p.server.id,
          accessToken: 'test-one',
          scopes: [],
        }),
        storeMcpCredential(prisma, {
          userId: owner.userId,
          serverId: p.server.id,
          accessToken: 'test-two',
          scopes: [],
        }),
      ]);
      expect(
        (
          await prisma.mcpCredential.findUniqueOrThrow({
            where: { serverId: p.server.id },
            select: { revision: true },
          })
        ).revision,
      ).toBe(2);
    });
  },
);
