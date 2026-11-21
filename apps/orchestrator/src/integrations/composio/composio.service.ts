import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { JsonSchemaObjectSchema, type McpDirectoryEntry } from '@crewaid/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TurnEventBus } from '../../agent/turn-event.bus.js';
import { pluginArgumentValidator } from '../../agent/policy/validate-arguments.js';
import type { CallToolResult } from '../../mcp/mcp-connection.js';
import type { McpToolDescriptor } from '../../mcp/mcp-tools.js';
import { curationFor, composioConfiguration } from './catalog.js';
import {
  ComposioSdk,
  ComposioFailure,
  composioHttpStatus,
  safeComposioFailure,
  type CatalogToolkit,
  type ComposioPort,
} from './sdk.js';

const CONNECT_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CATALOG_TTL_MS = 10 * 60_000;

@Injectable()
export class ComposioService {
  private readonly config = composioConfiguration();
  private port: ComposioPort | undefined;
  private readonly polls = new Map<string, Promise<void>>();
  /** The vendor catalog, served stale when a listing fails. */
  private catalog: { entries: CatalogToolkit[]; fetchedAt: number } | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {}

  setPortForTests(port: ComposioPort): void {
    this.port = port;
    this.catalog = null;
  }

  async directory(): Promise<McpDirectoryEntry[]> {
    if (!this.config.apiKey) return [];
    if (this.catalog === null || Date.now() - this.catalog.fetchedAt >= CATALOG_TTL_MS) {
      try {
        const entries = await this.sdk().toolkits(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        this.catalog = { entries, fetchedAt: Date.now() };
      } catch {
        // A vendor hiccup serves the stale catalog, or an empty Composio
        // section — the directory endpoint must not fail because a third
        // party did. The next poll or reload tries again.
        if (this.catalog === null) return [];
      }
    }
    return this.catalog.entries.map((entry) => ({
      name: entry.name,
      slug: entry.slug,
      category: entry.category,
      iconUrl: entry.logo,
      authType: 'OAUTH2' as const,
      backend: 'COMPOSIO' as const,
    }));
  }

  /**
   * The install draft for a toolkit slug, provisioning its auth config here
   * rather than reading one from the environment. `undefined` means
   * "not this seam's slug" — the caller falls through to the curated entries.
   */
  async installation(slug: string) {
    if (!this.config.apiKey) return undefined;
    try {
      const known = this.catalog?.entries.find((item) => item.slug === slug);
      const entry =
        known ?? (await this.sdk().toolkit(slug, AbortSignal.timeout(REQUEST_TIMEOUT_MS)));
      if (entry === null) return undefined;
      const authConfigId = await this.sdk().ensureAuthConfig(
        entry.slug,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      return {
        name: entry.name,
        slug: entry.slug,
        category: entry.category,
        iconUrl: entry.logo,
        backend: 'COMPOSIO' as const,
        transport: null,
        url: null,
        isPrivate: false,
        authType: 'OAUTH2' as const,
        composioConnection: { create: { toolkit: entry.slug, authConfigId } },
      };
    } catch (error: unknown) {
      throw new BadGatewayException(safeComposioFailure(error).message);
    }
  }

  async connect(userId: string, serverId: string): Promise<{ authorizeUrl: string }> {
    const server = await this.owned(userId, serverId);
    const connection = server.composioConnection;
    if (connection === null || connection.removing)
      throw new ConflictException(
        'This app is unavailable. Check the server configuration or finish uninstalling it.',
      );
    // Reserve the generation before leaving the database. A late link or poll
    // cannot overwrite a newer attempt, including an uninstall in another worker.
    const revision = connection.revision + 1;
    await this.mutate(
      userId,
      serverId,
      connection.revision,
      {
        revision,
        pendingAccountId: null,
        pendingExpiresAt: new Date(Date.now() + CONNECT_TTL_MS),
        sessionId: null,
        cleanupAccounts: [
          ...connection.cleanupAccounts,
          ...(connection.pendingAccountId ? [connection.pendingAccountId] : []),
        ],
        cleanupSessions: [
          ...connection.cleanupSessions,
          ...(connection.sessionId ? [connection.sessionId] : []),
        ],
      },
      { status: 'CONNECTING', lastError: null },
    );
    let link: { id: string; redirectUrl: string };
    try {
      link = await this.sdk().link(
        userId,
        connection.authConfigId,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
    } catch (error: unknown) {
      await this.mutate(
        userId,
        serverId,
        revision,
        { pendingExpiresAt: null, revision: revision + 1 },
        { status: 'ERROR', lastError: safeComposioFailure(error).message },
      ).catch(() => undefined);
      throw new BadGatewayException(safeComposioFailure(error).message);
    }
    try {
      await this.mutate(userId, serverId, revision, { pendingAccountId: link.id }, {});
    } catch (error: unknown) {
      // The generation lost: revoke the newly minted link instead of publishing it.
      await this.sdk()
        .deleteAccount(link.id, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
        .catch(() => undefined);
      throw error;
    }
    this.events.emitMcpStatus(userId, serverId, 'CONNECTING', 0);
    return { authorizeUrl: link.redirectUrl };
  }

  /** Authenticated Plugins polling also recovers a browser trip after a restart. */
  poll(userId: string): Promise<void> {
    const pending = this.polls.get(userId);
    if (pending !== undefined) return pending;
    const request = this.pollOnce(userId).finally(() => this.polls.delete(userId));
    this.polls.set(userId, request);
    return request;
  }

  private async pollOnce(userId: string) {
    const servers = await this.prisma.mcpServer.findMany({
      where: { userId, backend: 'COMPOSIO' },
      include: { composioConnection: true },
    });
    for (const server of servers) {
      const connection = server.composioConnection;
      if (connection === null || connection.removing) continue;
      try {
        if (connection.pendingExpiresAt !== null) {
          if (connection.pendingExpiresAt.getTime() <= Date.now()) {
            await this.rejectPending(
              userId,
              server.id,
              connection.revision,
              'The connection link expired. Start Connect again.',
            );
          } else if (connection.pendingAccountId !== null) {
            const account = await this.sdk().account(
              userId,
              connection.toolkit,
              connection.authConfigId,
              connection.pendingAccountId,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            );
            if (
              account === null ||
              account.toolkit !== connection.toolkit ||
              account.authConfigId !== connection.authConfigId ||
              account.disabled
            )
              await this.rejectPending(
                userId,
                server.id,
                connection.revision,
                'The account does not match this app and owner. Start Connect again.',
              );
            else if (account.status === 'ACTIVE') {
              await this.mutate(
                userId,
                server.id,
                connection.revision,
                {
                  accountId: account.id,
                  pendingAccountId: null,
                  pendingExpiresAt: null,
                  revision: connection.revision + 1,
                  cleanupAccounts: [
                    ...connection.cleanupAccounts,
                    ...(connection.accountId && connection.accountId !== account.id
                      ? [connection.accountId]
                      : []),
                  ],
                },
                { status: 'CONNECTING', lastError: null },
              );
              await this.refresh(userId, server.id);
            } else if (['FAILED', 'EXPIRED', 'INACTIVE', 'REVOKED'].includes(account.status))
              await this.rejectPending(
                userId,
                server.id,
                connection.revision,
                'The connection was cancelled or rejected. Start Connect again.',
              );
          }
        } else if (server.status === 'CONNECTING' && connection.accountId !== null) {
          await this.refresh(userId, server.id);
        } else if (server.status === 'CONNECTED' && connection.accountId !== null) {
          await this.verifyActive(userId, server.id);
        }
        await this.cleanup(userId, server.id);
      } catch (error: unknown) {
        if (error instanceof ConflictException || error instanceof NotFoundException) continue;
        // A temporary polling outage must not consume the pending link or remove grants.
        await this.prisma.mcpServer.updateMany({
          where: { id: server.id, userId },
          data: {
            lastError:
              error instanceof BadGatewayException
                ? error.message
                : safeComposioFailure(error).message,
          },
        });
      }
    }
  }

  async refresh(userId: string, serverId: string): Promise<void> {
    let expectedRevision = (await this.owned(userId, serverId)).composioConnection?.revision;
    try {
      const server = await this.verifyActive(userId, serverId);
      const connection = server.composioConnection;
      if (connection === null || connection.accountId === null)
        throw new ConflictException('Connect this app first.');
      const curation = curationFor(connection.toolkit);
      let sessionId = connection.sessionId;
      let revision = connection.revision;
      expectedRevision = revision;
      if (sessionId === null) {
        sessionId = await this.sdk().createSession(
          userId,
          connection.toolkit,
          curation,
          connection.authConfigId,
          connection.accountId,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        );
        try {
          await this.mutate(userId, serverId, revision, { sessionId, revision: revision + 1 }, {});
          revision += 1;
          expectedRevision = revision;
        } catch (error: unknown) {
          await this.sdk()
            .deleteSession(sessionId, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
            .catch(() => undefined);
          throw error;
        }
      }
      // The port classifies each descriptor itself: an overlay's reviewed
      // reads, else the vendor's readOnlyHint tag, else external-action policy.
      const descriptors = await this.sdk().tools(
        sessionId,
        curation,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      if (
        curation !== undefined &&
        (descriptors.length !== curation.enabledTools.length ||
          new Set(descriptors.map((tool) => tool.name)).size !== curation.enabledTools.length ||
          descriptors.some((tool) => !curation.enabledTools.includes(tool.name)))
      )
        throw new ComposioFailure('SCOPE');
      await this.mutate(
        userId,
        serverId,
        revision,
        {},
        { status: 'CONNECTED', lastError: null },
        curation === undefined
          ? descriptors
          : descriptors.map((tool) => ({
              ...tool,
              readOnlyHint: curation.readTools.includes(tool.name),
            })),
      );
      this.events.emitMcpStatus(userId, serverId, 'CONNECTED', descriptors.length);
    } catch (error: unknown) {
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      const failure = safeComposioFailure(error);
      if (expectedRevision !== undefined)
        await this.prisma.mcpServer.updateMany({
          where: {
            id: serverId,
            userId,
            ...(['SCOPE', 'CONFIGURATION'].includes(failure.kind)
              ? {}
              : { status: { not: 'CONNECTING' as const } }),
            composioConnection: { revision: expectedRevision, removing: false },
          },
          data: {
            status: failure.kind === 'SCOPE' ? 'NEEDS_REAUTH' : 'ERROR',
            lastError: failure.message,
          },
        });
      throw new BadGatewayException(failure.message);
    }
  }

  async call(
    userId: string,
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    let expectedRevision: number | undefined;
    try {
      signal.throwIfAborted();
      const server = await this.verifyActive(userId, serverId, signal);
      const connection = server.composioConnection;
      if (
        server.status !== 'CONNECTED' ||
        connection === null ||
        connection.accountId === null ||
        connection.sessionId === null
      )
        throw new ConflictException('Connect or refresh this app in Plugins before using it.');
      expectedRevision = connection.revision;
      // The cached row IS the gate: a tool is callable only if this
      // connection's refresh vouched for it, under the schema cached with it.
      const cached = await this.prisma.mcpTool.findFirst({
        where: { serverId, name, server: { userId, status: 'CONNECTED' } },
      });
      if (cached === null) throw new ConflictException('Refresh this app before using its tools.');
      const validation = await pluginArgumentValidator(cached.inputSchema)(args);
      if (!validation.ok)
        throw new ConflictException('Arguments do not match the app tool schema.');
      const current = await this.owned(userId, serverId);
      if (
        current.status !== 'CONNECTED' ||
        current.composioConnection?.revision !== connection.revision
      )
        throw new ConflictException('The app connection changed. Start a new tool call.');
      signal.throwIfAborted();
      const result = await this.sdk().execute(
        connection.sessionId,
        connection.accountId,
        name,
        args,
        signal,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result.data) }],
        ...(result.failed && { isError: true }),
      };
    } catch (error: unknown) {
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      const failure = safeComposioFailure(error, signal);
      if (failure.kind === 'SCOPE' && expectedRevision !== undefined)
        await this.invalidate(userId, serverId, failure.message, expectedRevision);
      throw failure;
    }
  }

  async remove(userId: string, serverId: string): Promise<void> {
    const server = await this.owned(userId, serverId);
    const connection = server.composioConnection;
    if (connection === null) throw new ConflictException('The app connection is missing.');
    await this.mutate(
      userId,
      serverId,
      connection.revision,
      {
        removing: true,
        revision: connection.revision + 1,
        accountId: null,
        pendingAccountId: null,
        pendingExpiresAt: null,
        sessionId: null,
        cleanupAccounts: [
          ...connection.cleanupAccounts,
          ...[connection.accountId, connection.pendingAccountId].filter(
            (id): id is string => id !== null,
          ),
        ],
        cleanupSessions: [
          ...connection.cleanupSessions,
          ...(connection.sessionId ? [connection.sessionId] : []),
        ],
      },
      {
        accessMode: 'SELECTED',
        accessRevision: { increment: 1 },
        status: 'DISCONNECTED',
        lastError: null,
      },
      [],
    );
    try {
      await this.cleanup(userId, serverId);
      await this.prisma.mcpServer.deleteMany({
        where: {
          id: serverId,
          userId,
          composioConnection: {
            removing: true,
            cleanupAccounts: { isEmpty: true },
            cleanupSessions: { isEmpty: true },
          },
        },
      });
    } catch {
      const message =
        'Local app access was removed, but remote cleanup failed. Retry Uninstall to revoke the remaining connection.';
      await this.prisma.mcpServer.updateMany({
        where: { id: serverId, userId },
        data: { lastError: message },
      });
      throw new BadGatewayException(message);
    }
  }

  private async cleanup(userId: string, serverId: string) {
    const server = await this.owned(userId, serverId);
    const connection = server.composioConnection;
    if (connection === null) return;
    for (const id of new Set(connection.cleanupSessions)) {
      await this.deleteRemote(() =>
        this.sdk().deleteSession(id, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
      );
      const latest = await this.owned(userId, serverId);
      await this.mutate(
        userId,
        serverId,
        connection.revision,
        {
          cleanupSessions:
            latest.composioConnection?.cleanupSessions.filter((item) => item !== id) ?? [],
        },
        {},
      );
    }
    // Re-read lists after each mutation so a retry never resurrects completed cleanup.
    for (const id of new Set(connection.cleanupAccounts)) {
      await this.deleteRemote(() =>
        this.sdk().deleteAccount(id, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
      );
      const latest = await this.owned(userId, serverId);
      await this.mutate(
        userId,
        serverId,
        connection.revision,
        {
          cleanupAccounts:
            latest.composioConnection?.cleanupAccounts.filter((item) => item !== id) ?? [],
        },
        {},
      );
    }
  }

  private async deleteRemote(remove: () => Promise<void>) {
    try {
      await remove();
    } catch (error: unknown) {
      if (composioHttpStatus(error) === 404) return;
      throw safeComposioFailure(error);
    }
  }

  private async rejectPending(userId: string, serverId: string, revision: number, message: string) {
    const server = await this.owned(userId, serverId);
    const connection = server.composioConnection;
    if (connection === null) return;
    await this.mutate(
      userId,
      serverId,
      revision,
      {
        revision: revision + 1,
        pendingAccountId: null,
        pendingExpiresAt: null,
        cleanupAccounts: [
          ...connection.cleanupAccounts,
          ...(connection.pendingAccountId ? [connection.pendingAccountId] : []),
        ],
      },
      { status: connection.accountId ? 'NEEDS_REAUTH' : 'DISCONNECTED', lastError: message },
    );
  }

  private async verifyActive(
    userId: string,
    serverId: string,
    signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ) {
    const server = await this.owned(userId, serverId);
    const connection = server.composioConnection;
    if (
      connection === null ||
      connection.removing ||
      connection.pendingExpiresAt !== null ||
      connection.accountId === null
    )
      throw new ConflictException('Connect this app in Plugins before using it.');
    // The auth config is the row's own, provisioned at install: the
    // account must still be ACTIVE under it, not disabled, and owned.
    const account = await this.sdk().account(
      userId,
      connection.toolkit,
      connection.authConfigId,
      connection.accountId,
      signal,
    );
    if (
      account === null ||
      account.status !== 'ACTIVE' ||
      account.disabled ||
      account.toolkit !== connection.toolkit ||
      account.authConfigId !== connection.authConfigId
    ) {
      await this.invalidate(
        userId,
        serverId,
        'The app grant is missing or revoked. Reconnect it in Plugins.',
        connection.revision,
      );
      throw new ConflictException('The app grant is missing or revoked. Reconnect it in Plugins.');
    }
    return server;
  }

  private async invalidate(userId: string, serverId: string, message: string, revision: number) {
    const server = await this.owned(userId, serverId);
    const connection = server.composioConnection;
    if (connection === null || connection.revision !== revision)
      throw new ConflictException('The app connection changed. Start a new tool call.');
    await this.mutate(
      userId,
      serverId,
      revision,
      { revision: revision + 1 },
      { status: 'NEEDS_REAUTH', lastError: message },
    );
    this.events.emitMcpStatus(userId, serverId, 'NEEDS_REAUTH', 0);
  }

  private async mutate(
    userId: string,
    serverId: string,
    revision: number,
    data: Prisma.ComposioConnectionUpdateManyMutationInput,
    serverData: Prisma.McpServerUpdateManyMutationInput,
    tools?: readonly McpToolDescriptor[],
  ) {
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.composioConnection.updateMany({
        where: { serverId, revision, server: { userId } },
        data,
      });
      if (changed.count !== 1)
        throw new ConflictException('The app connection changed. Start this action again.');
      await tx.mcpServer.updateMany({ where: { id: serverId, userId }, data: serverData });
      if (data.removing === true)
        await tx.botMcpServer.deleteMany({ where: { serverId, server: { userId } } });
      if (tools !== undefined) {
        await tx.mcpTool.deleteMany({ where: { serverId, server: { userId } } });
        if (tools.length > 0)
          await tx.mcpTool.createMany({
            data: tools.map((tool) => ({
              serverId,
              name: tool.name,
              description: tool.description,
              inputSchema: JsonSchemaObjectSchema.parse(tool.inputSchema),
              readOnly: tool.readOnlyHint === true,
            })),
          });
      }
    });
  }

  private owned(userId: string, serverId: string) {
    return this.prisma.mcpServer
      .findFirst({
        where: { id: serverId, userId, backend: 'COMPOSIO' },
        include: { composioConnection: true },
      })
      .then((server) => {
        if (server === null) throw new NotFoundException('App not found.');
        return server;
      });
  }

  private sdk(): ComposioPort {
    if (this.port === undefined) {
      if (!this.config.apiKey)
        throw new ConflictException('Composio is not configured on this server.');
      this.port = new ComposioSdk(this.config.apiKey);
    }
    return this.port;
  }
}
