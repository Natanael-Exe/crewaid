import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JsonSchema } from '@crewaid/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  GitHubGitService,
  approvedReceivePack,
} from '../src/integrations/github-git/github-git.service.js';
import { defaultDraft, draftPullRequests } from '../src/integrations/github-git/defaults.js';
import {
  gitToolDescriptors,
  isCanonicalGitHub,
  GITHUB_MCP_URL,
} from '../src/integrations/github-git/descriptors.js';
import { bindMcpTool } from '../src/mcp/mcp-tool-binding.js';
import { enabledPluginWhere } from '../src/mcp/plugin-access.js';
import { assessPolicy, policyHash } from '../src/agent/policy/policy.js';
import { BotPluginsService } from '../src/mcp/bot-plugins.service.js';
import type { GitHttpForward, GitProcessSpec } from '@crewaid/sandbox-core';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

const head = 'a'.repeat(40),
  nextHead = 'c'.repeat(40),
  tree = 'b'.repeat(40);
function receive(old: string, value: string, branch: string) {
  const line = Buffer.from(`${old} ${value} refs/heads/${branch}\0report-status\n`);
  return Buffer.concat([
    Buffer.from((line.length + 4).toString(16).padStart(4, '0')),
    line,
    Buffer.from('0000PACK'),
  ]);
}
function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

describe('D-208 Git receive-pack policy boundary', () => {
  it('accepts one exact ref update and preserves binary pack bytes', async () => {
    const body = receive('0'.repeat(40), head, 'codex/fix');
    const checked = await approvedReceivePack(stream(body), {
      old: '0'.repeat(40),
      head,
      ref: 'refs/heads/codex/fix',
    });
    expect(Buffer.from(await new Response(checked).arrayBuffer())).toEqual(body);
  });
  it.each(['other', 'main', 'codex/fix/other'])(
    'refuses another ref %s before forwarding',
    async (branch) => {
      await expect(
        approvedReceivePack(stream(receive('0'.repeat(40), head, branch)), {
          old: '0'.repeat(40),
          head,
          ref: 'refs/heads/codex/fix',
        }),
      ).rejects.toThrow('APPROVAL_STALE');
    },
  );
  it('refuses a changed commit and malformed header', async () => {
    await expect(
      approvedReceivePack(stream(receive('0'.repeat(40), nextHead, 'fix')), {
        old: '0'.repeat(40),
        head,
        ref: 'refs/heads/fix',
      }),
    ).rejects.toThrow();
    await expect(
      approvedReceivePack(stream(Buffer.from('zzzzPACK')), {
        old: head,
        head,
        ref: 'refs/heads/fix',
      }),
    ).rejects.toThrow();
  });
  it('defaults draft before hashing and keeps explicit ready-for-review', () => {
    expect(defaultDraft({ title: 'Fix' })).toEqual({ title: 'Fix', draft: true });
    expect(defaultDraft({ title: 'Fix', draft: false })).toEqual({ title: 'Fix', draft: false });
    expect(policyHash(defaultDraft({ title: 'Fix' }))).toBe(
      policyHash({ title: 'Fix', draft: true }),
    );
  });
  it('does not enable local Git for Composio or an arbitrary custom server', () => {
    const canonical = {
      backend: 'DIRECT' as const,
      slug: 'github',
      url: GITHUB_MCP_URL,
      authType: 'OAUTH2' as const,
      isPrivate: false,
    };
    expect(isCanonicalGitHub(canonical)).toBe(true);
    expect(isCanonicalGitHub({ ...canonical, backend: 'COMPOSIO' })).toBe(false);
    expect(isCanonicalGitHub({ ...canonical, isPrivate: true })).toBe(false);
  });
});

describe.skipIf(!process.env['DATABASE_URL'])(
  'D-208 owned checkout and publication lifecycle',
  () => {
    const prisma = new PrismaService();
    let owner: SignedInUser, other: SignedInUser;
    let serverId: string, botId: string;
    let service: GitHubGitService;
    let localHead: string;
    let targetWritable: boolean;
    let failAfterSend: boolean;
    let grantVersion: number;
    let ancestor: boolean;
    let forkExists: boolean;
    let loseWriteResponse: boolean;
    let remoteWriteCount: number;
    const pulls: unknown[] = [];
    const refs = new Map<string, string>();
    const sent: GitProcessSpec[] = [];
    const requests: string[] = [];
    const access = async (userId: string, bot: string, id: string) => {
      const server = await prisma.mcpServer.findFirst({
        where: { id, userId, ...enabledPluginWhere(bot), status: 'CONNECTED' },
      });
      const ownedBot = await prisma.bot.findFirst({ where: { id: bot, userId } });
      if (!server || !ownedBot || !isCanonicalGitHub(server)) throw new Error('GRANT_REVOKED');
      return {
        ...server,
        gitGrantRevision: policyHash({ version: grantVersion, access: server.accessRevision }),
      };
    };
    const gateway = {
      githubAccess: access,
      githubRead: async (
        userId: string,
        bot: string,
        id: string,
        repository?: string,
        branch?: string,
      ) => {
        await access(userId, bot, id);
        if (!repository) return { id: 1, login: 'account', name: 'Account' };
        if (branch) {
          const value = refs.get(`${repository}/${branch}`);
          return value ? { commit: { sha: value } } : null;
        }
        if (!['owner/repo', 'account/repo', 'other/unrelated'].includes(repository)) return null;
        return {
          id: repository === 'owner/repo' ? 11 : repository === 'account/repo' ? 22 : 33,
          full_name: repository,
          default_branch: 'main',
          owner: { id: 1 },
          fork: repository === 'account/repo',
          ...(repository === 'account/repo' ? { source: { id: 11 } } : {}),
          permissions: { push: repository === 'owner/repo' ? targetWritable : true },
        };
      },
      githubArtifact: async (
        _user: string,
        _bot: string,
        _id: string,
        repository: string,
        pull?: unknown,
      ) =>
        pull
          ? pulls
          : forkExists
            ? { id: 22, full_name: repository, fork: true, owner: { id: 1 }, source: { id: 11 } }
            : null,
      callTool: async (_user: string, _id: string, name: string, args: Record<string, unknown>) => {
        remoteWriteCount++;
        if (name === 'fork_repository') forkExists = true;
        else
          pulls.push({
            number: 1,
            title: args.title,
            body: args.body ?? null,
            draft: args.draft,
            user: { id: 1 },
            head: {
              label: String(args.head).includes(':') ? args.head : `owner:${String(args.head)}`,
            },
            base: { ref: args.base },
          });
        if (loseWriteResponse) throw new Error('Response lost after creation');
        return { content: [{ type: 'text', text: 'Created' }] };
      },
      githubGit: async (
        userId: string,
        bot: string,
        id: string,
        _repository: string,
        request: { method: string; path: string; body?: ReadableStream<Uint8Array> },
      ) => {
        await access(userId, bot, id);
        requests.push(request.path);
        if (request.body) await new Response(request.body).arrayBuffer();
        return { status: 200, contentType: 'application/x-git-receive-pack-result', body: null };
      },
    };
    const runner = async (spec: GitProcessSpec, forward: GitHttpForward, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      sent.push(spec);
      if (spec.mode === 'push') {
        await forward(
          {
            method: 'GET',
            path: `/${spec.repository}.git/info/refs?service=git-receive-pack`,
            headers: {},
          },
          signal ?? AbortSignal.timeout(1000),
        );
        await forward(
          {
            method: 'POST',
            path: `/${spec.repository}.git/git-receive-pack`,
            headers: {},
            body: stream(
              receive(spec.previousHead ?? '0'.repeat(40), spec.head ?? '', spec.branch ?? ''),
            ),
          },
          signal ?? AbortSignal.timeout(1000),
        );
        if (failAfterSend) throw new Error('Transport closed after sending');
        refs.set(`${spec.repository}/${spec.branch}`, spec.head ?? '');
      }
      return {
        exitCode: 0,
        data: {
          exitCode: 0,
          head: localHead,
          tree,
          branch: 'main',
          files: ['fix.ts'],
          summary: '1 file changed',
          ancestor,
        },
        output: '',
      };
    };
    beforeAll(async () => {
      await prisma.$connect();
      owner = await signIn(prisma, { label: 'git-owner' });
      other = await signIn(prisma, { label: 'git-other' });
    });
    afterAll(async () => {
      await signOutAndDelete(prisma, owner.userId);
      await signOutAndDelete(prisma, other.userId);
      await prisma.$disconnect();
    });
    beforeEach(async () => {
      await prisma.mcpServer.deleteMany({ where: { userId: owner.userId } });
      const server = await prisma.mcpServer.create({
        data: {
          userId: owner.userId,
          slug: 'github',
          name: 'GitHub',
          url: GITHUB_MCP_URL,
          backend: 'DIRECT',
          transport: 'HTTP',
          authType: 'OAUTH2',
          status: 'CONNECTED',
          accessMode: 'ALL',
        },
      });
      serverId = server.id;
      const bot = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: 'Git bot',
          role: 'test',
          avatarColor: '#123456',
          systemPrompt: '',
        },
      });
      botId = bot.id;
      localHead = head;
      targetWritable = true;
      failAfterSend = false;
      grantVersion = 1;
      ancestor = true;
      forkExists = false;
      loseWriteResponse = false;
      remoteWriteCount = 0;
      pulls.length = 0;
      refs.clear();
      sent.length = 0;
      requests.length = 0;
      service = new GitHubGitService(
        prisma,
        gateway as never,
        { restrictedFor: async () => ({ git: runner }) } as never,
        {
          withComputer: async (
            _user: string,
            _bot: string,
            _owner: string,
            work: () => Promise<unknown>,
          ) => work(),
        } as never,
      );
      for (const descriptor of gitToolDescriptors())
        await prisma.mcpTool.create({
          data: {
            serverId,
            name: descriptor.name,
            description: descriptor.description,
            inputSchema: descriptor.inputSchema,
            source: 'CREWAID_GIT',
          },
        });
    });
    async function invoke(name: string, args: unknown, proposal = true) {
      const descriptor = gitToolDescriptors().find((entry) => entry.name === name);
      if (!descriptor) throw new Error('Missing tool');
      const bound = bindMcpTool(
        { id: serverId, slug: 'github', name: 'GitHub' },
        { ...descriptor, source: 'CREWAID_GIT', readOnly: false },
        async () => {
          throw new Error('Native Git cannot use MCP dispatch');
        },
      );
      if (!bound.ok) throw new Error('Binding failed');
      const registered = service.bind(bound.tool, owner.userId, botId, serverId, name);
      if (proposal) await registered.commitAdapter?.proposal(JsonSchema.parse(args));
      const definition = registered.build({} as never);
      if (!definition.execute) throw new Error('Missing execution');
      return definition.execute(args, { toolCallId: 'call-' + name });
    }
    async function clone() {
      await invoke('crewaid_git_clone', { repository: 'owner/repo' });
      return prisma.gitCheckout.findFirstOrThrow({ where: { userId: owner.userId, botId } });
    }
    it('uses the owned computer and records a confirmed feature branch without credentials', async () => {
      const checkout = await clone();
      localHead = nextHead;
      await invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'codex/fix' });
      expect(
        (
          await prisma.gitPublication.findFirstOrThrow({
            where: { userId: owner.userId, botId, checkoutId: checkout.id },
          })
        ).confirmedHead,
      ).toBe(nextHead);
      expect(sent[0]?.path).toContain(`/agents/${botId}/`);
      expect(JSON.stringify(sent)).not.toMatch(/accessToken|Authorization|apiKey/);
    });
    it('refuses missing publication authorization and an unrelated destination', async () => {
      const checkout = await clone();
      await expect(
        invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'fix' }, false),
      ).rejects.toThrow('APPROVAL_STALE');
      await expect(
        invoke('crewaid_git_push', {
          checkoutId: checkout.id,
          branch: 'fix',
          targetRepository: 'other/unrelated',
        }),
      ).rejects.toThrow('verified fork');
      expect(requests).toEqual([]);
    });
    it('publishes to a verified fork when source write access is unavailable', async () => {
      const checkout = await clone();
      targetWritable = false;
      await expect(
        invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'fix' }),
      ).rejects.toThrow('fork tool');
      await invoke('crewaid_git_push', {
        checkoutId: checkout.id,
        branch: 'fix',
        targetRepository: 'account/repo',
      });
      expect(refs.get('account/repo/fix')).toBe(head);
    });
    it('refuses default branches, existing foreign branches and advanced remote heads', async () => {
      const checkout = await clone();
      await expect(
        invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'main' }),
      ).rejects.toThrow('default branch');
      refs.set('owner/repo/foreign', head);
      await expect(
        invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'foreign' }),
      ).rejects.toThrow('not owned');
      await invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'fix' });
      refs.set('owner/repo/fix', nextHead);
      await expect(
        invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'fix' }),
      ).rejects.toThrow('advanced');
    });
    it('records uncertainty and reconciles a committed ref after restart without replay', async () => {
      const checkout = await clone();
      failAfterSend = true;
      const output = await invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'fix' });
      expect(JSON.stringify(output)).toContain('uncertain');
      const publication = await prisma.gitPublication.findFirstOrThrow({
        where: { userId: owner.userId, botId },
      });
      expect(publication.status).toBe('UNCERTAIN');
      refs.set('owner/repo/fix', head);
      requests.length = 0;
      await invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'fix' });
      expect(requests).toEqual([]);
      expect(
        (
          await prisma.gitPublication.findFirstOrThrow({
            where: { id: publication.id, userId: owner.userId },
          })
        ).status,
      ).toBe('CONFIRMED');
    });
    it('enforces exclusions, future-bot inheritance, foreign users and revoked access', async () => {
      const checkout = await clone();
      const future = await prisma.bot.create({
        data: {
          userId: owner.userId,
          name: 'Future',
          role: 'test',
          avatarColor: '#123456',
          systemPrompt: '',
        },
      });
      await expect(access(owner.userId, future.id, serverId)).resolves.toBeDefined();
      await expect(
        service.call(owner.userId, future.id, serverId, 'crewaid_git_fetch', {
          checkoutId: checkout.id,
        }),
      ).rejects.toThrow('unavailable');
      await prisma.botMcpServer.create({ data: { botId, serverId, enabled: false } });
      await expect(
        service.call(owner.userId, botId, serverId, 'crewaid_git_fetch', {
          checkoutId: checkout.id,
        }),
      ).rejects.toThrow('GRANT_REVOKED');
      await expect(
        service.call(other.userId, botId, serverId, 'crewaid_git_fetch', {
          checkoutId: checkout.id,
        }),
      ).rejects.toThrow('GRANT_REVOKED');
    });
    it.each(['HEAD', 'connection'])(
      'rejects stale %s binding before sending authenticated publish requests',
      async (change) => {
        const checkout = await clone(),
          args = { checkoutId: checkout.id, branch: 'fix' };
        const descriptor = gitToolDescriptors().find((entry) => entry.name === 'crewaid_git_push');
        if (!descriptor) throw new Error('Missing push');
        const binding = bindMcpTool(
          { id: serverId, slug: 'github', name: 'GitHub' },
          { ...descriptor, readOnly: false },
          async () => ({ content: [] }),
        );
        if (!binding.ok) throw new Error('Missing binding');
        const registered = service.bind(
          binding.tool,
          owner.userId,
          botId,
          serverId,
          'crewaid_git_push',
        );
        await registered.commitAdapter?.proposal(args);
        if (change === 'HEAD') localHead = nextHead;
        else grantVersion++;
        await expect(
          registered.build({} as never).execute?.(args, { toolCallId: 'stale' }),
        ).rejects.toThrow('APPROVAL_STALE');
        expect(requests).toEqual([]);
      },
    );
    it('refuses non-fast-forward history and recovers the owned checkout across a new service instance', async () => {
      const checkout = await clone();
      await invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'fix' });
      ancestor = false;
      localHead = nextHead;
      await expect(
        invoke('crewaid_git_push', { checkoutId: checkout.id, branch: 'fix' }),
      ).rejects.toThrow('Non-fast-forward');
      service = new GitHubGitService(
        prisma,
        gateway as never,
        { restrictedFor: async () => ({ git: runner }) } as never,
        {
          withComputer: async (_u: string, _b: string, _o: string, work: () => Promise<unknown>) =>
            work(),
        } as never,
      );
      await expect(invoke('crewaid_git_fetch', { checkoutId: checkout.id })).resolves.toBeDefined();
    });
    it.each(['ASK', 'AUTO', 'FULL'] as const)(
      'uses the existing %s rules for the trusted publish adapter',
      async (mode) => {
        const checkout = await clone();
        const plugins = await new BotPluginsService(prisma, gateway as never, service).toolsForBot(
          owner.userId,
          botId,
        );
        const registered = plugins.deferred.find((t) => t.name === 'github__crewaid_git_push');
        if (!registered) throw new Error('Missing deferred tool');
        const args = { checkoutId: checkout.id, branch: 'fix' },
          commit = await registered.commitAdapter?.proposal(args);
        const snapshot = {
          mode,
          rules: [],
          grantRevision: 'a'.repeat(64),
          grantValid: true,
          seat: null,
          resourceRevision: null,
        };
        expect(
          assessPolicy({
            name: registered.name,
            args,
            behavior: registered.behavior,
            snapshot,
            memory: [],
            commit,
          }).decision,
        ).toBe(mode === 'FULL' ? 'allow' : 'ask');
        expect(
          assessPolicy({
            name: registered.name,
            args,
            behavior: registered.behavior,
            snapshot: { ...snapshot, rules: [{ toolPattern: '*', decision: 'deny' }] },
            memory: [],
            commit,
          }).decision,
        ).toBe('deny');
        const bridge = plugins.tools
          .find((t) => t.name === 'use_plugin_tool')
          ?.unwrap?.({ tool: registered.name, arguments: args });
        expect(bridge?.commitAdapter).toBeDefined();
      },
    );
    async function remoteTool(name: string) {
      const binding = bindMcpTool(
        { id: serverId, slug: 'github', name: 'GitHub' },
        { name, description: 'GitHub method', readOnly: false, inputSchema: { type: 'object' } },
        async () => {
          throw new Error('Must use the existing gateway');
        },
      );
      if (!binding.ok) throw new Error('Missing binding');
      const registered = service.bind(binding.tool, owner.userId, botId, serverId, name);
      return name === 'create_pull_request' ? draftPullRequests(registered) : registered;
    }
    it.each(['fork_repository', 'create_pull_request'])(
      'reconciles a lost %s response after restart and never replays it',
      async (name) => {
        let registered = await remoteTool(name);
        const args =
          name === 'fork_repository'
            ? { owner: 'owner', repo: 'repo' }
            : { owner: 'owner', repo: 'repo', head: 'account:fix', base: 'main', title: 'Fix' };
        const projected = registered.unwrap?.(args)?.args ?? args;
        await registered.commitAdapter?.proposal(JsonSchema.parse(projected));
        loseWriteResponse = true;
        const output = await registered.build({} as never).execute?.(args, { toolCallId: 'first' });
        expect(JSON.stringify(output)).toContain('uncertain');
        expect(remoteWriteCount).toBe(1);
        registered = await remoteTool(name);
        await registered.commitAdapter?.proposal(JsonSchema.parse(projected));
        const recovered = await registered
          .build({} as never)
          .execute?.(args, { toolCallId: 'second' });
        expect(JSON.stringify(recovered)).toContain('committed');
        expect(remoteWriteCount).toBe(1);
        expect(
          (await prisma.gitRemoteWrite.findFirstOrThrow({ where: { userId: owner.userId, botId } }))
            .status,
        ).toBe('CONFIRMED');
        if (name === 'create_pull_request') expect(JSON.stringify(pulls)).toContain('"draft":true');
      },
    );
    it('keeps work metadata owner scoped and removes it when the installation is removed', async () => {
      await clone();
      await prisma.mcpServer.delete({ where: { id: serverId, userId: owner.userId } });
      expect(await prisma.gitCheckout.count({ where: { userId: owner.userId, botId } })).toBe(0);
      await expect(
        service.call(owner.userId, botId, serverId, 'crewaid_git_fetch', { checkoutId: 'deleted' }),
      ).rejects.toThrow('GRANT_REVOKED');
    });
    it('offers draft clone/fetch and a commit adapter through the discovery bridge', async () => {
      const plugins = new BotPluginsService(prisma, gateway as never, service);
      const set = await plugins.toolsForBot(owner.userId, botId);
      expect(set.deferred.length).toBeGreaterThan(0);
      const descriptor = gitToolDescriptors()[0];
      if (!descriptor) throw new Error('Missing clone descriptor');
      const binding = bindMcpTool(
        { id: serverId, slug: 'github', name: 'GitHub' },
        { ...descriptor, readOnly: false },
        async () => ({ content: [] }),
      );
      if (!binding.ok) throw new Error('Binding failed');
      const adapter = service.bind(
        binding.tool,
        owner.userId,
        botId,
        serverId,
        'crewaid_git_clone',
      );
      expect(adapter.behavior.effect).toBe('draft');
    });
  },
);
