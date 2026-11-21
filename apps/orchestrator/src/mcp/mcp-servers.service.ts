import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { McpServer } from '@prisma/client';
import type { GitHttpRequest, GitHttpResponse } from '@crewaid/sandbox-core';
import type {
  ConnectMcpServerResponse,
  InstallMcpServerBody,
  McpDirectoryEntry,
  McpServerSummary as WireServer,
} from '@crewaid/shared';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import { KeyringConfigError } from '../credentials/keyring.js';
import { ComposioService } from '../integrations/composio/composio.service.js';
import {
  GIT_TOOL_NAMES,
  gitToolDescriptors,
  isCanonicalGitHub,
} from '../integrations/github-git/descriptors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AddressResolver } from '../providers/endpoint-guard.js';
import { openMcpConnection, type CallToolResult, type McpConnection } from './mcp-connection.js';
import {
  McpCredentialUnreadableError,
  readMcpCredential,
  storeMcpCredential,
  type McpCredentialRecord,
} from './mcp-credentials.js';
import {
  fromDirectory,
  fromPrivate,
  listDirectory as listCatalogDirectory,
  refuseBuiltinCollision,
} from './mcp-directory.js';
import {
  githubAccess as resolveGitHubAccess,
  githubArtifact as fetchGitHubArtifact,
  githubGit as proxyGitHubGit,
  githubRead as fetchGitHubRead,
  type GitHubProxyDeps,
} from './mcp-github-proxy.js';
import {
  assertCallableTool,
  attemptWithBearer,
  bounded,
  buildConnectionDeps,
  closeQuietly,
  combineCallSignal,
  describeFailure,
  expiresWithin,
  invokeMcpTool,
  isUniqueViolation,
  McpTimeoutError,
  REFRESH_SKEW_MS,
  SERVER_SUMMARY_INCLUDE,
  toSummary,
  withCallCancellation,
  withTimeout,
  type OwnedMcpServer,
} from './mcp-helpers.js';
import {
  beginOAuthConnect,
  completeOAuthCallback as redeemOAuthCallback,
  McpRefreshRefusedError,
  renewOAuthCredential,
} from './mcp-oauth-flow.js';
import type { McpOAuthCallbackOutcome } from './mcp-oauth.js';
import { isReadOnlyTool } from './mcp-readonly.js';
import { MCP_STRIKE_LIMIT as STRIKE_LIMIT } from './mcp-tool-binding.js';
import type { McpToolDescriptor } from './mcp-tools.js';

export { McpTimeoutError } from './mcp-helpers.js';

/** End-to-end bound on handshake, paginated tool listing, and close. */
const LIST_TOOLS_TIMEOUT_MS = 10_000;

/**
 * Owns MCP server lifecycle, authorized connections, token renewal, tool-cache
 * refresh, and circuit-breaker strikes. Sole caller of `mcp-credentials.ts`.
 */
@Injectable()
export class McpServersService {
  private readonly logger = new Logger(McpServersService.name);
  private readonly refreshes = new Map<string, Promise<WireServer>>();
  /** In-memory consecutive tool-call failures; persisted status flips to ERROR at STRIKE_LIMIT. */
  private readonly strikes = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(ToolRegistry) private readonly tools: ToolRegistry,
    @Inject(ComposioService) private readonly composio: ComposioService,
  ) {}

  private resolver: AddressResolver | undefined;
  private mcpFetch: typeof fetch | undefined;

  setAddressResolverForTests(resolve: AddressResolver | undefined): void {
    this.resolver = resolve;
  }

  setMcpFetchForTests(impl: typeof fetch | undefined): void {
    this.mcpFetch = impl;
  }

  // Directory & installation

  async listDirectory(): Promise<McpDirectoryEntry[]> {
    return listCatalogDirectory(this.composio);
  }

  async list(userId: string): Promise<WireServer[]> {
    await this.composio.poll(userId);
    const rows = await this.prisma.mcpServer.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: SERVER_SUMMARY_INCLUDE,
    });
    return rows.map(toSummary);
  }

  async install(userId: string, body: InstallMcpServerBody): Promise<WireServer> {
    const draft =
      'slug' in body
        ? await fromDirectory(body.slug, this.composio)
        : await fromPrivate(body, this.resolver);
    refuseBuiltinCollision(draft.slug, this.tools.names());

    const existing = await this.prisma.mcpServer.findFirst({
      where: { userId, slug: draft.slug },
      select: { name: true },
    });
    if (existing !== null) {
      throw new ConflictException(
        `"${existing.name}" already uses the slug "${draft.slug}" — every tool from this ` +
          'server would be named it. Uninstall that one, or install this server under a ' +
          'different name.',
      );
    }

    const bearerToken = 'slug' in body ? undefined : body.bearerToken;

    try {
      const created = await this.prisma.mcpServer.create({ data: { userId, ...draft } });
      // Roll back the row if credential storage fails so HEADER servers never stay credential-less.
      if (bearerToken !== undefined) {
        try {
          await storeMcpCredential(this.prisma, {
            userId,
            serverId: created.id,
            accessToken: bearerToken,
            scopes: [],
          });
        } catch (error: unknown) {
          await this.prisma.mcpServer.delete({ where: { id: created.id } }).catch(() => undefined);
          throw error;
        }
      }
      return toSummary({ ...created, _count: { tools: 0 }, bots: [], oauthFlows: [] });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`a server with the slug "${draft.slug}" was installed twice`);
      }
      throw error;
    }
  }

  async setCredential(userId: string, serverId: string, bearerToken: string): Promise<WireServer> {
    const server = await this.findOwned(userId, serverId);

    if (server.authType !== 'HEADER') {
      throw new ConflictException(
        `"${server.name}" does not authenticate with a bearer token — it is ` +
          `${server.authType === 'NONE' ? 'installed without a credential' : 'connected through OAuth'}, ` +
          'so there is nothing here to replace.',
      );
    }

    await storeMcpCredential(this.prisma, {
      userId,
      serverId,
      accessToken: bearerToken,
      scopes: [],
    });

    const updated = await this.prisma.mcpServer.update({
      where: { id: serverId },
      data: { status: 'DISCONNECTED', lastError: null },
      include: SERVER_SUMMARY_INCLUDE,
    });
    this.events.emitMcpStatus(updated.userId, serverId, 'DISCONNECTED', updated._count.tools);
    return toSummary(updated);
  }

  async connect(userId: string, serverId: string): Promise<ConnectMcpServerResponse> {
    const server = await this.findOwned(userId, serverId);
    if (server.backend === 'COMPOSIO') return this.composio.connect(userId, serverId);

    if (server.authType === 'NONE') {
      await this.refreshTools(userId, serverId);
      return { connected: true };
    }

    if (server.authType === 'HEADER') {
      const stored = await readMcpCredential(this.prisma, {
        userId: server.userId,
        serverId: server.id,
      });
      if (stored === null) {
        throw new ConflictException(
          `"${server.name}" authenticates with a bearer token and has none stored — add its ` +
            'token, then connect it.',
        );
      }
      await this.refreshTools(userId, serverId);
      return { connected: true };
    }

    return {
      authorizeUrl: await beginOAuthConnect(this.prisma, server, {
        connectionDeps: buildConnectionDeps(this.mcpFetch, this.resolver),
        recordConnectFailure: (target, message) => this.recordConnectFailure(target, message),
      }),
    };
  }

  async completeOAuthCallback(
    query: Record<string, unknown>,
    browserUserId: string | null = null,
  ): Promise<McpOAuthCallbackOutcome> {
    return redeemOAuthCallback(this.prisma, query, browserUserId, {
      connectionDeps: buildConnectionDeps(this.mcpFetch, this.resolver),
      recordConnectFailure: (target, message) => this.recordConnectFailure(target, message),
      storeCredential: (input) => storeMcpCredential(this.prisma, input),
      refreshTools: (userId, serverId) => this.refreshTools(userId, serverId),
    });
  }

  async remove(userId: string, serverId: string): Promise<void> {
    const server = await this.findOwned(userId, serverId);
    if (server.backend === 'COMPOSIO') return this.composio.remove(userId, serverId);
    await this.prisma.mcpServer.deleteMany({ where: { id: serverId, userId } });
  }

  // Tool refresh & execution

  refreshTools(userId: string, serverId: string): Promise<WireServer> {
    // Coalesce concurrent refreshes per (userId, serverId) so rotating grants are not spent twice.
    const key = `${userId}:${serverId}`;
    const pending = this.refreshes.get(key);
    if (pending !== undefined) return pending;
    const request = this.refreshToolsOnce(userId, serverId).finally(() => {
      this.refreshes.delete(key);
    });
    this.refreshes.set(key, request);
    return request;
  }

  private async refreshToolsOnce(userId: string, serverId: string): Promise<WireServer> {
    const server = await this.findOwned(userId, serverId);
    if (server.backend === 'COMPOSIO') {
      await this.composio.refresh(userId, serverId);
      return toSummary({ ...(await this.findOwned(userId, serverId)), oauthFlows: [] });
    }

    let tools: McpToolDescriptor[];
    try {
      tools = await withTimeout(
        this.withAuthorizedConnection(server, (connection) => connection.listTools()),
        LIST_TOOLS_TIMEOUT_MS,
        `it did not finish listing its tools within ${String(LIST_TOOLS_TIMEOUT_MS / 1000)}s`,
      );
    } catch (error: unknown) {
      // Local refusals and missing keyring config are not remote server failures.
      if (error instanceof HttpException) throw error;
      if (error instanceof KeyringConfigError) throw error;
      const message = describeFailure(error);
      await this.prisma.mcpServer.update({
        where: { id: server.id },
        data: { status: 'ERROR', lastError: message },
      });
      throw new BadGatewayException(
        `"${server.name}" did not answer: ${message}. It is marked ERROR and will stay out ` +
          'of every bot’s tool set until it is refreshed successfully.',
      );
    }

    return this.cacheTools(server, tools);
  }

  async callTool(
    userId: string,
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    beforeRequest?: () => Promise<void>,
  ): Promise<CallToolResult> {
    signal?.throwIfAborted();
    const server = await this.findOwned(userId, serverId);
    assertCallableTool(server, toolName, args);
    const callSignal = combineCallSignal(timeoutMs, signal);
    if (server.backend === 'COMPOSIO')
      return this.composio.call(userId, serverId, toolName, args, callSignal);
    const replayAllowed = !(
      isCanonicalGitHub(server) && ['fork_repository', 'create_pull_request'].includes(toolName)
    );
    const timeoutMsg = `"${server.name}" did not answer within ${String(Math.round(timeoutMs / 1000))}s`;
    try {
      const result = await withTimeout(
        withCallCancellation(
          callSignal,
          this.withAuthorizedConnection(
            server,
            (connection) => invokeMcpTool(connection, server.name, toolName, args, callSignal),
            replayAllowed,
            beforeRequest,
          ),
        ),
        timeoutMs,
        timeoutMsg,
      );
      this.strikes.delete(server.id);
      return result;
    } catch (error: unknown) {
      const failure =
        callSignal.aborted && !signal?.aborted ? new McpTimeoutError(timeoutMsg) : error;
      if (!signal?.aborted) await this.recordCallFailure(server, failure);
      throw failure;
    }
  }

  private async recordCallFailure(server: OwnedMcpServer, error: unknown): Promise<void> {
    if (error instanceof HttpException || error instanceof KeyringConfigError) return;

    const count = (this.strikes.get(server.id) ?? 0) + 1;
    this.strikes.set(server.id, count);
    if (count < STRIKE_LIMIT) return;
    this.strikes.delete(server.id);

    const message = bounded(
      `"${server.name}" failed ${String(count)} calls in a row — ${describeFailure(error)}. ` +
        'It is out of every bot’s tool set until it is refreshed successfully.',
    );
    try {
      const changed = server.status !== 'ERROR';
      await this.prisma.mcpServer.update({
        where: { id: server.id },
        data: { status: 'ERROR', lastError: message },
      });
      if (changed) {
        this.events.emitMcpStatus(server.userId, server.id, 'ERROR', server._count.tools, message);
      }
    } catch (writeError: unknown) {
      this.logger.warn(
        `could not mark MCP server ${server.id} as ERROR: ${describeFailure(writeError)}`,
      );
    }
  }

  // GitHub proxy facade

  githubAccess(userId: string, botId: string, serverId: string) {
    return resolveGitHubAccess(this.prisma, userId, botId, serverId);
  }

  githubRead(
    userId: string,
    botId: string,
    serverId: string,
    repository?: string,
    branch?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return fetchGitHubRead(
      this.prisma,
      this.githubProxyDeps(),
      userId,
      botId,
      serverId,
      repository,
      branch,
      signal,
    );
  }

  githubArtifact(
    userId: string,
    botId: string,
    serverId: string,
    repository: string,
    pull?: { head: string; base: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return fetchGitHubArtifact(
      this.prisma,
      this.githubProxyDeps(),
      userId,
      botId,
      serverId,
      repository,
      pull,
      signal,
    );
  }

  githubGit(
    userId: string,
    botId: string,
    serverId: string,
    repository: string,
    request: GitHttpRequest,
    signal: AbortSignal,
  ): Promise<GitHttpResponse> {
    return proxyGitHubGit(
      this.prisma,
      this.githubProxyDeps(),
      userId,
      botId,
      serverId,
      repository,
      request,
      signal,
    );
  }

  // Authorized connection & credential renewal

  private async credentialFor(
    server: McpServer,
    prisma: Pick<PrismaService, 'mcpCredential'> = this.prisma,
  ): Promise<McpCredentialRecord> {
    let credential: McpCredentialRecord | null;
    try {
      credential = await readMcpCredential(prisma, {
        userId: server.userId,
        serverId: server.id,
      });
    } catch (error: unknown) {
      if (error instanceof McpCredentialUnreadableError) {
        throw new ConflictException(
          `"${server.name}" has a stored credential that cannot be read — reconnect it. ` +
            `(${error.message})`,
        );
      }
      throw error;
    }
    if (credential === null) {
      throw new ConflictException(
        `"${server.name}" has no credential yet — connect it first, then refresh its tools.`,
      );
    }
    return credential;
  }

  /**
   * Opens a fresh connection per call (so revocation via DELETE takes immediate
   * effect), renews expiring OAuth bearers, and retries a 401 at most once.
   */
  private async withAuthorizedConnection<T>(
    server: OwnedMcpServer,
    run: (connection: McpConnection) => Promise<T>,
    replayAllowed = true,
    beforeRequest?: () => Promise<void>,
  ): Promise<T> {
    if (server.backend !== 'DIRECT' || server.url === null || server.transport === null)
      throw new ConflictException('This app does not use an MCP connection.');
    const endpoint = { url: server.url, transport: server.transport };

    if (server.authType === 'NONE') {
      const connection = await openMcpConnection(
        endpoint,
        buildConnectionDeps(this.mcpFetch, this.resolver),
      );
      try {
        return await run(connection);
      } finally {
        await closeQuietly(connection, server.name, this.logger);
      }
    }

    const bearerDeps = {
      mcpFetch: this.mcpFetch,
      resolver: this.resolver,
      logger: this.logger,
      beforeRequest,
    };

    if (server.authType === 'HEADER') {
      const credential = await this.credentialFor(server);
      const attempt = await attemptWithBearer(
        server.name,
        endpoint,
        credential.accessToken,
        run,
        bearerDeps,
      );
      if (attempt.ok) return attempt.value;
      return this.refuseReauth(
        server,
        'the server rejected its bearer token, and a header credential has no refresh to spend',
      );
    }

    let credential = await this.credentialFor(server);
    let renewed = false;
    if (expiresWithin(credential.expiresAt, REFRESH_SKEW_MS)) {
      credential = await this.refreshCredential(server, credential);
      renewed = true;
    }

    for (;;) {
      const attempt = await attemptWithBearer(
        server.name,
        endpoint,
        credential.accessToken,
        run,
        bearerDeps,
      );
      if (attempt.ok) return attempt.value;
      if (attempt.dispatched && !replayAllowed)
        return this.refuseReauth(
          server,
          'authorization was rejected after a write started; check GitHub with read-only tools before creating it again',
        );
      if (renewed) {
        return this.refuseReauth(
          server,
          'the token this server just issued was rejected as well, so there is nothing left to retry',
        );
      }
      credential = await this.refreshCredential(server, credential);
      renewed = true;
    }
  }

  private async refreshCredential(
    server: OwnedMcpServer,
    credential: McpCredentialRecord,
  ): Promise<McpCredentialRecord> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Row-lock across processes and re-read so rotating grants are not spent twice.
          await tx.$queryRaw`
            SELECT c."serverId" FROM "McpCredential" c
            JOIN "McpServer" s ON s.id = c."serverId"
            WHERE c."serverId" = ${server.id} AND s."userId" = ${server.userId}
            FOR UPDATE OF c
          `;
          const current = await this.credentialFor(server, tx);
          if (
            current.accessToken !== credential.accessToken ||
            current.refreshToken !== credential.refreshToken ||
            current.expiresAt?.getTime() !== credential.expiresAt?.getTime()
          ) {
            return current;
          }
          return this.refreshLockedCredential(server, current, tx);
        },
        { timeout: 30_000 },
      );
    } catch (error: unknown) {
      if (error instanceof HttpException || error instanceof KeyringConfigError) throw error;
      if (error instanceof McpRefreshRefusedError) return this.refuseReauth(server, error.message);
      // Never echo raw Prisma transaction errors that may quote credential arguments.
      return this.refuseReauth(server, 'the renewed credential could not be saved');
    }
  }

  private async refreshLockedCredential(
    server: OwnedMcpServer,
    credential: McpCredentialRecord,
    prisma: Pick<PrismaService, 'mcpCredential'>,
  ): Promise<McpCredentialRecord> {
    const renewed = await renewOAuthCredential(
      server,
      credential,
      buildConnectionDeps(this.mcpFetch, this.resolver),
    );
    try {
      await storeMcpCredential(prisma, {
        userId: server.userId,
        serverId: server.id,
        accessToken: renewed.accessToken,
        refreshToken: renewed.refreshToken ?? undefined,
        expiresAt: renewed.expiresAt ?? undefined,
        scopes: renewed.scopes,
        authMetadata: renewed.authMetadata,
      });
    } catch {
      throw new McpRefreshRefusedError('the renewed credential could not be saved');
    }
    return renewed;
  }

  private async refuseReauth(server: OwnedMcpServer, reason: string): Promise<never> {
    const message = bounded(
      `"${server.name}" needs to be reconnected — ${reason}. Reconnecting it authorizes it again.`,
    );
    const changed = server.status !== 'NEEDS_REAUTH';
    await this.prisma.mcpServer.update({
      where: { id: server.id },
      data: { status: 'NEEDS_REAUTH', lastError: message },
    });
    if (changed) {
      this.events.emitMcpStatus(
        server.userId,
        server.id,
        'NEEDS_REAUTH',
        server._count.tools,
        message,
      );
    }
    throw new ConflictException(message);
  }

  // Tool cache & internal helpers

  private async cacheTools(
    server: McpServer,
    tools: readonly McpToolDescriptor[],
  ): Promise<WireServer> {
    if (tools.some((tool) => GIT_TOOL_NAMES.some((name) => name === tool.name)))
      throw new BadGatewayException('The server offered a reserved Crewaid Git tool name.');
    const local = isCanonicalGitHub(server) ? gitToolDescriptors() : [];
    const listing = [...tools, ...local];
    const names = listing.map((tool) => tool.name);
    const updated = await this.prisma.$transaction(
      async (tx) => {
        // Lock the server row first so concurrent prunes cannot interleave and merge stale listings.
        await tx.mcpServer.update({
          where: { id: server.id },
          data: { status: 'CONNECTED', lastError: null },
        });
        for (const tool of listing) {
          const fields = {
            source: local.includes(tool) ? ('CREWAID_GIT' as const) : ('REMOTE' as const),
            description: tool.description,
            inputSchema: tool.inputSchema as object,
            readOnly: isReadOnlyTool(tool),
            refreshedAt: new Date(),
          };
          await tx.mcpTool.upsert({
            where: { serverId_name: { serverId: server.id, name: tool.name } },
            create: { serverId: server.id, name: tool.name, ...fields },
            update: fields,
          });
        }

        if (names.length === 0) {
          await tx.mcpTool.deleteMany({ where: { serverId: server.id } });
        } else {
          await tx.mcpTool.deleteMany({
            where: { serverId: server.id, name: { notIn: names } },
          });
        }

        return tx.mcpServer.findUniqueOrThrow({
          where: { id: server.id },
          include: SERVER_SUMMARY_INCLUDE,
        });
      },
      { timeout: 20_000 },
    );

    return toSummary(updated);
  }

  private async findOwned(userId: string, serverId: string): Promise<OwnedMcpServer> {
    const row = await this.prisma.mcpServer.findFirst({
      where: { id: serverId, userId },
      include: {
        _count: { select: { tools: true } },
        bots: { select: { botId: true, enabled: true } },
      },
    });
    if (row === null) throw new NotFoundException('MCP server not found');
    return row;
  }

  private async recordConnectFailure(server: McpServer, message: string): Promise<void> {
    await this.prisma.mcpServer.updateMany({
      where: { id: server.id, userId: server.userId },
      data: { lastError: bounded(message) },
    });
  }

  private githubProxyDeps(): GitHubProxyDeps {
    return {
      readCredential: async (server, options) => {
        let credential = await this.credentialFor(server);
        if (
          options?.refreshWithinMs !== undefined &&
          expiresWithin(credential.expiresAt, options.refreshWithinMs)
        ) {
          credential = await this.refreshCredential(server, credential);
        }
        return credential;
      },
      resolver: this.resolver,
      fetchImpl: this.mcpFetch,
    };
  }
}
