import { ConflictException } from '@nestjs/common';
import type { GitHttpRequest, GitHttpResponse } from '@crewaid/sandbox-core';
import { GitBranchSchema, GitHubRepositorySchema } from '@crewaid/shared';
import { policyHash } from '../agent/policy/policy.js';
import { isCanonicalGitHub } from '../integrations/github-git/descriptors.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { createGuardedFetch, type AddressResolver } from '../providers/endpoint-guard.js';
import { expiresWithin, REFRESH_SKEW_MS, type OwnedMcpServer } from './mcp-helpers.js';
import { enabledPluginWhere } from './plugin-access.js';

export type GitHubProxyPrisma = Pick<PrismaService, 'mcpServer' | 'bot'>;

export type GitHubProxyCredential = {
  readonly accessToken: string;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[];
};

export type GitHubProxyDeps = {
  readonly readCredential: (
    server: OwnedMcpServer,
    options?: { readonly refreshWithinMs?: number },
  ) => Promise<GitHubProxyCredential>;
  readonly resolver?: AddressResolver | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
};

/** Resolves an enabled, connected GitHub MCP server for the given bot. */
export async function githubAccess(
  prisma: GitHubProxyPrisma,
  userId: string,
  botId: string,
  serverId: string,
) {
  const server = await prisma.mcpServer.findFirst({
    where: { id: serverId, userId, ...enabledPluginWhere(botId), status: 'CONNECTED' },
    include: {
      _count: { select: { tools: true } },
      credential: { select: { revision: true } },
      bots: { where: { bot: { userId } }, select: { botId: true, enabled: true } },
    },
  });
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId },
    select: { id: true, pluginGrantRevision: true, approvalMode: true, autoReviewRules: true },
  });
  if (server === null || bot === null || !isCanonicalGitHub(server))
    throw new ConflictException(
      'GRANT_REVOKED: this bot has no connected GitHub repository access.',
    );
  return {
    ...server,
    gitGrantRevision: policyHash({
      credential: server.credential?.revision,
      access: server.accessRevision,
      bots: bot.pluginGrantRevision,
      mode: bot.approvalMode,
      rules: bot.autoReviewRules,
    }),
  };
}

export async function githubRead(
  prisma: GitHubProxyPrisma,
  deps: GitHubProxyDeps,
  userId: string,
  botId: string,
  serverId: string,
  repository?: string,
  branch?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const path =
    repository === undefined
      ? '/user'
      : '/repos/' +
        GitHubRepositorySchema.parse(repository) +
        (branch === undefined
          ? ''
          : '/branches/' + encodeURIComponent(GitBranchSchema.parse(branch)));
  const server = await githubAccess(prisma, userId, botId, serverId);
  const credential = await deps.readCredential(server, { refreshWithinMs: REFRESH_SKEW_MS });
  if (!credential.scopes.includes('repo'))
    throw new ConflictException(
      'GitHub repository scope is missing. Reconnect GitHub and authorize repo access.',
    );
  const response = await createGuardedFetch(deps.resolver, deps.fetchImpl)(
    'https://api.github.com' + path,
    {
      headers: {
        Authorization: 'Bearer ' + credential.accessToken,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Crewaid',
      },
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    },
  ).catch(() => {
    throw new ConflictException(
      'GitHub could not complete the read. Check access or try again later.',
    );
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConflictException(
      response.status === 401
        ? 'GitHub authorization expired. Reconnect GitHub in Plugins.'
        : response.status === 403
          ? 'GitHub denied access. Check repository permissions, OAuth scopes and organization authorization.'
          : 'GitHub could not complete the read. Try again later.',
    );
  }
  return response.json();
}

/** Read-only recovery endpoints; callers supply identifiers, never a URL. */
export async function githubArtifact(
  prisma: GitHubProxyPrisma,
  deps: GitHubProxyDeps,
  userId: string,
  botId: string,
  serverId: string,
  repository: string,
  pull?: { head: string; base: string },
  signal?: AbortSignal,
): Promise<unknown> {
  if (!pull)
    return githubRead(prisma, deps, userId, botId, serverId, repository, undefined, signal);
  const server = await githubAccess(prisma, userId, botId, serverId);
  const credential = await deps.readCredential(server, { refreshWithinMs: REFRESH_SKEW_MS });
  const query = new URLSearchParams({
    state: 'all',
    head: pull.head,
    base: pull.base,
    per_page: '100',
  });
  const response = await createGuardedFetch(deps.resolver, deps.fetchImpl)(
    'https://api.github.com/repos/' +
      GitHubRepositorySchema.parse(repository) +
      '/pulls?' +
      query.toString(),
    {
      headers: {
        Authorization: 'Bearer ' + credential.accessToken,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Crewaid',
      },
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    },
  ).catch(() => {
    throw new ConflictException(
      'GitHub could not reconcile the artifact. Check its remote state before publishing again.',
    );
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConflictException(
      'GitHub could not reconcile the pull request. Check access before publishing again.',
    );
  }
  return response.json();
}

export async function githubGit(
  prisma: GitHubProxyPrisma,
  deps: GitHubProxyDeps,
  userId: string,
  botId: string,
  serverId: string,
  repository: string,
  request: GitHttpRequest,
  signal: AbortSignal,
): Promise<GitHttpResponse> {
  const server = await githubAccess(prisma, userId, botId, serverId);
  const credential = await deps.readCredential(server);
  if (!credential.scopes.includes('repo'))
    throw new ConflictException(
      'GitHub repository scope is missing. Reconnect GitHub and authorize repo access.',
    );
  // Refresh during read preparation, never repeat an uncertain receive-pack request.
  if (expiresWithin(credential.expiresAt, 0))
    throw new ConflictException(
      'GitHub authorization expired. Reconnect or prepare the operation again.',
    );
  const prefix = '/' + GitHubRepositorySchema.parse(repository) + '.git/';
  if (!request.path.startsWith(prefix))
    throw new ConflictException('Git transport requested another repository.');
  const suffix = request.path.slice(prefix.length);
  if (
    ![
      'info/refs?service=git-upload-pack',
      'info/refs?service=git-receive-pack',
      'git-upload-pack',
      'git-receive-pack',
    ].includes(suffix)
  )
    throw new ConflictException('Unsupported Git transport endpoint.');
  if ((suffix.startsWith('info/refs') ? 'GET' : 'POST') !== request.method)
    throw new ConflictException('Unsupported Git transport method.');
  const current = await githubAccess(prisma, userId, botId, serverId);
  if (current.gitGrantRevision !== server.gitGrantRevision)
    throw new ConflictException(
      'GRANT_REVOKED: GitHub access changed before the authenticated request.',
    );
  const response = await createGuardedFetch(deps.resolver, deps.fetchImpl)(
    'https://github.com' + request.path,
    {
      method: request.method,
      headers: {
        ...request.headers,
        Authorization:
          'Basic ' + Buffer.from('x-access-token:' + credential.accessToken).toString('base64'),
        'User-Agent': 'Crewaid',
      },
      redirect: 'error',
      signal,
      ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    },
  ).catch(() => {
    throw new ConflictException(
      'GitHub transport failed. Check the branch before retrying a publish.',
    );
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConflictException(
      response.status === 401
        ? 'GitHub rejected authorization. Reconnect GitHub.'
        : response.status === 403 || response.status === 404
          ? 'GitHub denied repository access. Check permissions, scopes or organization restrictions.'
          : 'GitHub transport failed. Check the branch before retrying a publish.',
    );
  }
  return {
    status: response.status,
    contentType: response.headers.get('Content-Type') ?? 'application/octet-stream',
    body: response.body,
  };
}
