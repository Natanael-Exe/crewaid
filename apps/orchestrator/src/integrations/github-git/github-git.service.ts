import { bindGitHubWrite } from './remote-writes.js';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  GitCloneInputSchema,
  GitFetchInputSchema,
  GitPushInputSchema,
  GitHubRepositorySchema,
  GitPushResultSchema,
  type Json,
} from '@crewaid/shared';
import {
  GIT_TIMEOUT_MS,
  type GitHttpRequest,
  type GitHttpForward,
  type GitProcessSpec,
  type GitProcessResult,
} from '@crewaid/sandbox-core';
import type { GitCheckout } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { McpServersService } from '../../mcp/mcp-servers.service.js';
import { AgentSessionService } from '../../agent/agent-session.service.js';
import { SandboxReadinessService } from '../../sandbox/sandbox-readiness.service.js';
import { policyHash, type CommitAdapter } from '../../agent/policy/policy.js';
import type { RegisteredTool } from '../../agent/tool-registry.js';
import { mcpResultText } from '../../mcp/mcp-tool-binding.js';

const Id = z.union([z.number().int().nonnegative(), z.string().min(1)]).transform(String);
const Account = z.object({
  id: Id,
  login: z.string().min(1),
  name: z.string().nullable().optional(),
});
const Repository = z.object({
  id: Id,
  full_name: GitHubRepositorySchema,
  default_branch: z.string(),
  fork: z.boolean(),
  owner: z.object({ id: Id }).optional(),
  source: z.object({ id: Id }).optional(),
  parent: z.object({ id: Id }).optional(),
  permissions: z.object({ push: z.boolean().optional() }).optional(),
});
const Branch = z.object({ commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) });
const Snapshot = z.object({
  head: z.string().regex(/^[a-f0-9]{40}$/),
  tree: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string(),
  files: z.array(z.string()).max(200),
  summary: z.string().max(16000),
  ancestor: z.boolean(),
});

/** One ref update only. The pack bytes following the validated header stay streamed. */
export async function approvedReceivePack(
  body: ReadableStream<Uint8Array>,
  expected: { old: string; head: string; ref: string },
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  let prefix = Buffer.alloc(0),
    offset = 0;
  let found = false;
  try {
    while (true) {
      if (prefix.length > 131072) throw new Error('Invalid Git receive-pack header.');
      if (prefix.length - offset < 4) {
        const next = await reader.read();
        if (next.done) throw new Error('Incomplete Git receive-pack header.');
        prefix = Buffer.concat([prefix, next.value]);
        continue;
      }
      const code = prefix.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-f]{4}$/.test(code)) throw new Error('Invalid Git receive-pack packet.');
      const length = Number.parseInt(code, 16);
      if (length === 0) {
        if (!found) throw new Error('Missing Git ref update.');
        break;
      }
      if (length < 4 || length > 65520) throw new Error('Invalid Git receive-pack packet.');
      if (prefix.length - offset < length) {
        const next = await reader.read();
        if (next.done) throw new Error('Incomplete Git ref update.');
        prefix = Buffer.concat([prefix, next.value]);
        continue;
      }
      const line = prefix
        .subarray(offset + 4, offset + length)
        .toString('utf8')
        .split('\0')[0]
        ?.trim();
      if (found || line !== `${expected.old} ${expected.head} ${expected.ref}`)
        throw new Error('APPROVAL_STALE: Git ref update differs from the approved publish.');
      found = true;
      offset += length;
    }
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(prefix);
    },
    async pull(c) {
      try {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          c.close();
        } else c.enqueue(next.value);
      } catch (error: unknown) {
        c.error(error);
      }
    },
    async cancel() {
      await reader.cancel();
      reader.releaseLock();
    },
  });
}

@Injectable()
export class GitHubGitService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(McpServersService) private readonly servers: McpServersService,
    @Inject(AgentSessionService) private readonly sessions: AgentSessionService,
    @Inject(SandboxReadinessService) private readonly computers: SandboxReadinessService,
  ) {}

  bind(
    tool: RegisteredTool,
    userId: string,
    botId: string,
    serverId: string,
    name: string,
  ): RegisteredTool {
    if (name === 'fork_repository' || name === 'create_pull_request')
      return bindGitHubWrite(tool, this.prisma, this.servers, userId, botId, serverId, name);
    const proposals = new Map<string, string>();
    const base = {
      ...tool,
      build: (context: Parameters<RegisteredTool['build']>[0]) => ({
        ...tool.build(context),
        execute: async (args: unknown, options: { abortSignal?: AbortSignal }) => {
          const key = policyHash(args);
          const expected = proposals.get(key);
          proposals.delete(key);
          return this.call(userId, botId, serverId, name, args, options.abortSignal, expected);
        },
      }),
      behavior: {
        ...tool.behavior,
        effect: name === 'crewaid_git_push' ? ('unknown' as const) : ('draft' as const),
        failure: { kind: 'isolate' as const },
      },
    };
    if (name !== 'crewaid_git_push') return base;
    const adapter: CommitAdapter = {
      proposal: async (args: Json) => {
        const prepared = await this.prepare(
          userId,
          botId,
          serverId,
          GitPushInputSchema.parse(args),
        );
        proposals.set(policyHash(args), policyHash(prepared.binding));
        return {
          account: prepared.account.login,
          destinations: [
            `https://github.com/${prepared.target.full_name}/tree/${encodeURIComponent(prepared.args.branch)}`,
          ],
          contentRevision: policyHash(prepared.binding),
          review: {
            repository: prepared.target.full_name,
            branch: prepared.args.branch,
            commit: prepared.snapshot.head,
            files: prepared.snapshot.files,
            summary: prepared.snapshot.summary,
          },
        };
      },
      outcome: (output: unknown) => {
        try {
          const result = GitPushResultSchema.parse(JSON.parse(mcpResultText(output)));
          if (result.status === 'committed' && result.reference)
            return Promise.resolve({ status: 'committed', reference: result.reference });
          return Promise.resolve(
            result.status === 'uncertain'
              ? { status: 'uncertain' }
              : { status: 'refused', code: 'GIT_PUBLISH_REFUSED' },
          );
        } catch {
          return Promise.resolve({ status: 'uncertain' });
        }
      },
    };
    return { ...base, commitAdapter: adapter };
  }

  async call(
    userId: string,
    botId: string,
    serverId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal,
    expectedBinding?: string,
  ) {
    const operationSignal = AbortSignal.any([
      AbortSignal.timeout(GIT_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    await this.servers.githubAccess(userId, botId, serverId);
    let value: unknown;
    if (name === 'crewaid_git_clone')
      value = await this.clone(userId, botId, serverId, input, operationSignal);
    else if (name === 'crewaid_git_fetch')
      value = await this.fetch(
        userId,
        botId,
        serverId,
        GitFetchInputSchema.parse(input).checkoutId,
        operationSignal,
      );
    else if (name === 'crewaid_git_push')
      value = await this.push(userId, botId, serverId, input, operationSignal, expectedBinding);
    else throw new Error('Unknown Crewaid Git tool.');
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  }

  private async checkout(
    userId: string,
    botId: string,
    serverId: string,
    id: string,
  ): Promise<GitCheckout> {
    const row = await this.prisma.gitCheckout.findFirst({
      where: { id, userId, botId, serverId, status: 'READY' },
    });
    if (row === null) throw new Error('GRANT_REVOKED: the checkout is unavailable to this bot.');
    return row;
  }
  private root(botId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(botId)) throw new Error('Invalid bot workspace identity.');
    return `/home/bot/agents/${botId}`;
  }
  private async identity(userId: string, botId: string, serverId: string, signal?: AbortSignal) {
    return Account.parse(
      await this.servers.githubRead(userId, botId, serverId, undefined, undefined, signal),
    );
  }
  private async repository(
    userId: string,
    botId: string,
    serverId: string,
    name: string,
    signal?: AbortSignal,
  ) {
    const data = await this.servers.githubRead(userId, botId, serverId, name, undefined, signal);
    if (data === null) throw new Error('GitHub repository is unavailable to this account.');
    return Repository.parse(data);
  }
  private spec(checkout: GitCheckout, mode: GitProcessSpec['mode']): GitProcessSpec {
    const root = this.root(checkout.botId);
    if (!checkout.path.startsWith(root + '/'))
      throw new Error('Checkout path is outside the bot workspace.');
    return {
      mode,
      root,
      path: checkout.path,
      repository: checkout.repository,
      defaultBranch: checkout.defaultBranch,
    };
  }
  private async run(
    userId: string,
    botId: string,
    spec: GitProcessSpec,
    forward: GitHttpForward,
    signal?: AbortSignal,
  ): Promise<GitProcessResult> {
    return this.computers.withComputer(userId, botId, 'agent-tool', async () => {
      const session = await this.sessions.restrictedFor(botId);
      if (!session.git)
        throw new Error('Git streaming is unavailable. Rebuild the computer image.');
      return session.git(spec, forward, signal);
    });
  }
  private async locked<T>(row: GitCheckout, work: () => Promise<T>): Promise<T> {
    const operation = randomUUID();
    const claim = await this.prisma.gitCheckout.updateMany({
      where: {
        id: row.id,
        userId: row.userId,
        botId: row.botId,
        OR: [{ activeUntil: null }, { activeUntil: { lt: new Date() } }],
      },
      data: {
        activeOperationId: operation,
        activeUntil: new Date(Date.now() + GIT_TIMEOUT_MS + 30_000),
      },
    });
    if (claim.count !== 1) throw new Error('Another Git operation is using this checkout.');
    try {
      return await work();
    } finally {
      await this.prisma.gitCheckout.updateMany({
        where: { id: row.id, userId: row.userId, activeOperationId: operation },
        data: { activeOperationId: null, activeUntil: null },
      });
    }
  }
  private async readForward(
    userId: string,
    botId: string,
    serverId: string,
    repository: string,
  ): Promise<GitHttpForward> {
    const initial = await this.servers.githubAccess(userId, botId, serverId);
    return async (request, signal) => {
      if (
        request.path !== `/${repository}.git/info/refs?service=git-upload-pack` &&
        request.path !== `/${repository}.git/git-upload-pack`
      )
        throw new Error('Read-only Git operation cannot publish.');
      const current = await this.servers.githubAccess(userId, botId, serverId);
      if (current.gitGrantRevision !== initial.gitGrantRevision)
        throw new Error('GRANT_REVOKED: GitHub connection or bot access changed.');
      return this.servers.githubGit(userId, botId, serverId, repository, request, signal);
    };
  }
  private async clone(
    userId: string,
    botId: string,
    serverId: string,
    input: unknown,
    signal: AbortSignal,
  ) {
    const args = GitCloneInputSchema.parse(input);
    const account = await this.identity(userId, botId, serverId, signal);
    const repo = await this.repository(userId, botId, serverId, args.repository, signal);
    const root = this.root(botId);
    const directory = args.directory ?? `repos/${repo.full_name}`;
    const destination = path.posix.resolve(root, directory);
    if (!destination.startsWith(root + '/')) throw new Error('Invalid clone destination.');
    const row = await this.prisma.gitCheckout.create({
      data: {
        userId,
        botId,
        serverId,
        repository: repo.full_name,
        repositoryId: repo.id,
        defaultBranch: repo.default_branch,
        path: destination,
      },
    });
    try {
      const forward = await this.readForward(userId, botId, serverId, repo.full_name);
      const result = await this.locked(row, () =>
        this.run(
          userId,
          botId,
          {
            ...this.spec(row, 'clone'),
            ...(args.branch ? { branch: args.branch } : {}),
            identity: {
              name: account.name ?? account.login,
              email: `${account.id}+${account.login}@users.noreply.github.com`,
            },
          },
          forward,
          signal,
        ),
      );
      if (result.exitCode !== 0)
        throw new Error(
          'Git clone failed. Check access and the destination; partial files are preserved.',
        );
      const snapshot = Snapshot.parse(result.data);
      await this.prisma.gitCheckout.updateMany({
        where: { id: row.id, userId, botId, serverId },
        data: { status: 'READY' },
      });
      return {
        checkoutId: row.id,
        path: destination,
        repository: repo.full_name,
        branch: snapshot.branch,
        head: snapshot.head,
      };
    } catch (error: unknown) {
      await this.prisma.gitCheckout.updateMany({
        where: { id: row.id, userId, botId, serverId },
        data: { status: 'FAILED' },
      });
      throw error;
    }
  }
  private async fetch(
    userId: string,
    botId: string,
    serverId: string,
    checkoutId: string,
    signal: AbortSignal,
  ) {
    const row = await this.checkout(userId, botId, serverId, checkoutId);
    await this.identity(userId, botId, serverId, signal);
    const repo = await this.repository(userId, botId, serverId, row.repository, signal);
    if (repo.id !== row.repositoryId)
      throw new Error(
        'The checkout repository identity changed. Clone it again in a new directory.',
      );
    return this.locked(row, async () => {
      const result = await this.run(
        userId,
        botId,
        this.spec(row, 'fetch'),
        await this.readForward(userId, botId, serverId, row.repository),
        signal,
      );
      if (result.exitCode !== 0) throw new Error('Git fetch failed. Local work was preserved.');
      const snapshot = Snapshot.parse(result.data);
      return {
        checkoutId: row.id,
        path: row.path,
        repository: row.repository,
        branch: snapshot.branch,
        head: snapshot.head,
      };
    });
  }
  private async prepare(
    userId: string,
    botId: string,
    serverId: string,
    args: z.infer<typeof GitPushInputSchema>,
    signal?: AbortSignal,
  ) {
    signal = AbortSignal.any([AbortSignal.timeout(GIT_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    await this.servers.githubAccess(userId, botId, serverId);
    const row = await this.checkout(userId, botId, serverId, args.checkoutId);
    const account = await this.identity(userId, botId, serverId, signal);
    const source = await this.repository(userId, botId, serverId, row.repository, signal);
    if (source.id !== row.repositoryId)
      throw new Error('APPROVAL_STALE: the source repository identity changed.');
    const target = await this.repository(
      userId,
      botId,
      serverId,
      args.targetRepository ?? row.repository,
      signal,
    );
    if (
      target.id !== source.id &&
      (!target.fork ||
        (target.source?.id ?? target.parent?.id) !== (source.source?.id ?? source.id))
    )
      throw new Error(
        'The publish destination must be the source repository or its verified fork.',
      );
    if (target.id !== source.id && target.owner?.id !== account.id)
      throw new Error('Publish to the connected account’s fork.');
    if (target.permissions?.push !== true)
      throw new Error(
        'This account cannot push to the repository. Use the GitHub fork tool, then publish to that fork.',
      );
    if (args.branch === target.default_branch || args.branch === source.default_branch)
      throw new Error('Publish to a feature branch, not a default branch.');
    const publication = await this.prisma.gitPublication.findFirst({
      where: {
        userId,
        botId,
        checkoutId: row.id,
        targetRepositoryId: target.id,
        branch: args.branch,
      },
    });
    const remoteData = await this.servers.githubRead(
      userId,
      botId,
      serverId,
      target.full_name,
      args.branch,
      signal,
    );
    const remote = remoteData === null ? null : Branch.parse(remoteData).commit.sha;
    if (publication && (publication.status === 'SENDING' || publication.status === 'UNCERTAIN')) {
      if (remote === publication.intendedHead)
        await this.prisma.gitPublication.updateMany({
          where: { id: publication.id, userId, botId },
          data: { status: 'CONFIRMED', confirmedHead: remote },
        });
      else if (remote !== publication.previousHead)
        throw new Error(
          'Previous publication is uncertain. Check the remote branch before another push.',
        );
    }
    const confirmed =
      publication && remote === publication.intendedHead
        ? publication.intendedHead
        : publication?.confirmedHead;
    if (remote !== null && (publication === null || confirmed !== remote))
      throw new Error(
        'The remote branch is not owned by this checkout or advanced since its last publication.',
      );
    const inspection = await this.run(
      userId,
      botId,
      { ...this.spec(row, 'inspect'), ...(remote ? { previousHead: remote } : {}) },
      () => {
        throw new Error('Inspection cannot access the network.');
      },
      signal,
    );
    if (inspection.exitCode !== 0) throw new Error('The checkout is unavailable.');
    const snapshot = Snapshot.parse(inspection.data);
    if (!snapshot.ancestor)
      throw new Error('Non-fast-forward publishing is refused. Fetch and integrate changes first.');
    const scope = await this.servers.githubAccess(userId, botId, serverId);
    const binding = {
      grant: scope.gitGrantRevision,
      account: account.id,
      checkout: row.id,
      repository: target.id,
      branch: args.branch,
      head: snapshot.head,
      tree: snapshot.tree,
      remote,
    };
    return { row, account, target, args, publication, remote, snapshot, binding };
  }
  private async push(
    userId: string,
    botId: string,
    serverId: string,
    input: unknown,
    signal: AbortSignal,
    expectedBinding?: string,
  ) {
    const args = GitPushInputSchema.parse(input);
    const row = await this.checkout(userId, botId, serverId, args.checkoutId);
    return this.locked(row, async () => {
      const prepared = await this.prepare(userId, botId, serverId, args, signal);
      if (!expectedBinding || policyHash(prepared.binding) !== expectedBinding)
        throw new Error('APPROVAL_STALE: publish binding is missing or changed.');
      const { target, snapshot, remote } = prepared;
      const reference = `https://github.com/${target.full_name}/tree/${encodeURIComponent(args.branch)}`;
      if (remote === snapshot.head)
        return {
          status: 'committed',
          repository: target.full_name,
          branch: args.branch,
          head: snapshot.head,
          reference,
        };
      const publication = await this.prisma.gitPublication.upsert({
        where: {
          userId,
          botId,
          checkoutId_targetRepositoryId_branch: {
            checkoutId: row.id,
            targetRepositoryId: target.id,
            branch: args.branch,
          },
        },
        create: {
          userId,
          botId,
          checkoutId: row.id,
          targetRepository: target.full_name,
          targetRepositoryId: target.id,
          branch: args.branch,
          intendedHead: snapshot.head,
          tree: snapshot.tree,
          previousHead: remote,
          status: 'PREPARED',
        },
        update: {
          intendedHead: snapshot.head,
          tree: snapshot.tree,
          previousHead: remote,
          status: 'PREPARED',
        },
      });
      let sent = false;
      const forward: GitHttpForward = async (request: GitHttpRequest, relaySignal) => {
        const scope = await this.servers.githubAccess(userId, botId, serverId);
        if (scope.gitGrantRevision !== prepared.binding.grant)
          throw new Error('GRANT_REVOKED: GitHub access changed.');
        const prefix = `/${target.full_name}.git/`;
        if (
          request.path !== prefix + 'info/refs?service=git-receive-pack' &&
          request.path !== prefix + 'git-receive-pack'
        )
          throw new Error('Unexpected publishing endpoint.');
        if (request.method === 'POST') {
          if (sent || !request.body) throw new Error('A publish may send exactly one ref update.');
          const current = await this.prepare(userId, botId, serverId, args, relaySignal);
          if (policyHash(current.binding) !== policyHash(prepared.binding))
            throw new Error('APPROVAL_STALE: publish content or destination changed.');
          const body = await approvedReceivePack(request.body, {
            old: remote ?? '0'.repeat(40),
            head: snapshot.head,
            ref: 'refs/heads/' + args.branch,
          });
          await this.prisma.gitPublication.updateMany({
            where: { id: publication.id, userId, botId },
            data: { status: 'SENDING' },
          });
          sent = true;
          return this.servers.githubGit(
            userId,
            botId,
            serverId,
            target.full_name,
            { ...request, body },
            relaySignal,
          );
        }
        return this.servers.githubGit(
          userId,
          botId,
          serverId,
          target.full_name,
          request,
          relaySignal,
        );
      };
      try {
        const result = await this.run(
          userId,
          botId,
          {
            ...this.spec(row, 'push'),
            repository: target.full_name,
            branch: args.branch,
            head: snapshot.head,
            tree: snapshot.tree,
            ...(remote ? { previousHead: remote } : {}),
          },
          forward,
          signal,
        );
        if (result.exitCode !== 0)
          throw new Error('GitHub refused or did not confirm the publish.');
        const remoteData = await this.servers.githubRead(
          userId,
          botId,
          serverId,
          target.full_name,
          args.branch,
          signal,
        );
        if (remoteData === null || Branch.parse(remoteData).commit.sha !== snapshot.head)
          throw new Error('The remote did not confirm the expected commit.');
        await this.prisma.gitPublication.updateMany({
          where: { id: publication.id, userId, botId },
          data: { status: 'CONFIRMED', confirmedHead: snapshot.head },
        });
        return {
          status: 'committed',
          repository: target.full_name,
          branch: args.branch,
          head: snapshot.head,
          reference,
        };
      } catch {
        await this.prisma.gitPublication.updateMany({
          where: { id: publication.id, userId, botId },
          data: { status: sent ? 'UNCERTAIN' : 'PREPARED' },
        });
        return {
          status: sent ? 'uncertain' : 'refused',
          repository: target.full_name,
          branch: args.branch,
          head: snapshot.head,
          message: sent
            ? 'Check the remote branch before retrying. This publish will not be replayed automatically.'
            : 'Publishing was refused or cancelled before sending changes. Prepare it again.',
        };
      }
    });
  }
}
