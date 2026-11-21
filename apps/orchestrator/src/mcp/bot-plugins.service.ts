import { isCanonicalGitHub } from '../integrations/github-git/descriptors.js';
import { defaultDraft, draftPullRequests } from '../integrations/github-git/defaults.js';
import { GitHubGitService } from '../integrations/github-git/github-git.service.js';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BotPlugin, PluginAccess } from '@crewaid/shared';

import type { RegisteredTool, ToolRefusal } from '../agent/tool-registry.js';
import type {
  ActivePlugin,
  BotPluginTools,
  TurnPluginSource,
  UnavailableServer,
} from '../agent/turn-plugins.js';
import { enabledPluginWhere, toPluginAccess } from './plugin-access.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { McpServersService } from './mcp-servers.service.js';
import {
  bindMcpTools,
  toMcpInputSchema,
  type McpToolCaller,
  type McpToolServer,
} from './mcp-tool-binding.js';
import { deferredPluginTools } from './mcp-deferred-tools.js';
import { indirectPluginTools, type CatalogueEntry } from './mcp-indirect-tools.js';

/**
 * which plugins a bot has, and what they cost it.
 *
 * MCP plugins is explicit that plugins are enabled PER BOT and never globally: "A
 * bot's tool set is its built-ins plus only the servers enabled for it." This
 * service owns both halves of that — the REST routes an operator drives from
 * the plugin modal, and the per-turn answer `ChatSendService` asks for
 * through `TurnPlugins`.
 *
 * There is no longer a number here, and that is the change
 *
 * §7.4 used to read "Resolved tool definitions per bot ≤ 40, hard cap", and
 * implemented it literally: the built-ins were spent out of the same
 * forty, so this build's own tools left room for the small curated servers and
 * not a large one. A thirty-tool GitHub server was refused outright — an
 * operator's reasonable configuration rejected by a number in a design
 * document rather than by anything about the request.
 *
 * MCP plugins own reasoning for that number is about COST — "ninety tool
 * definitions in every single request … degrades tool selection accuracy and
 * burns input tokens on every step of every turn" — and a count of definitions
 * is a poor proxy for it. So the count is gone and what is bounded instead is
 * what the model is actually sent: every plugin tool now reaches a turn
 * through the two-definition bridge (`mcp-indirect-tools.ts`), whose listing
 * is bounded by `PLUGIN_LISTING_TOKEN_BUDGET` and DEGRADES in form as the
 * catalogue grows rather than refusing anything.
 *
 * Nothing in this file counts tools any more, and `PUT /bots/:id/plugins` has
 * no size refusal left to make: a bot with three hundred plugin tools is
 * configured exactly as easily as one with three, and every one of them is
 * reachable. MCP plugins "fails with a clear error naming the overage rather than
 * silently truncating" is satisfied by there being no overage to name — and,
 * as before, by nothing ever being silently dropped.
 */
/**
 * One plugin tool, bound both ways.
 *
 * The definition is what a DIRECT slot offers; the catalogue entry is what the
 * indirection advertises. Built together so the two can never describe
 * different tools — the name, the schema and the read-only verdict a search
 * answers with are the ones the direct definition would have carried.
 */
type BoundPluginTool = {
  readonly tool: RegisteredTool;
  readonly catalogue: CatalogueEntry;
};

@Injectable()
export class BotPluginsService implements TurnPluginSource {
  private readonly logger = new Logger(BotPluginsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(McpServersService) private readonly servers: McpServersService,
    @Inject(GitHubGitService) private readonly git?: GitHubGitService,
  ) {}

  /**
   * `GET /bots/:id/plugins`.
   *
   * Every server this user has INSTALLED, each saying whether this bot has it
   * enabled — not only the enabled ones. `BotPluginSchema` carries an
   * `enabled` field, and a listing of enabled servers only would make that
   * field constant, which is a field nobody needs. The modal's question is
   * "which of my plugins does this bot use", and both halves of the answer
   * have to be in one list for it to be answerable without a second request.
   */
  async list(userId: string, botId: string): Promise<BotPlugin[]> {
    await this.findOwnedBot(userId, botId);
    const rows = await this.prisma.mcpServer.findMany({
      where: { userId },
      // Install order, the order the operator built the list in — the same
      // ordering `GET /mcp/servers` uses, so the two lists line up.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        accessMode: true,
        slug: true,
        name: true,
        _count: { select: { tools: true } },
        bots: { where: { botId }, select: { enabled: true } },
      },
    });
    return rows.map((row) => ({
      serverId: row.id,
      slug: row.slug,
      name: row.name,
      enabled:
        row.accessMode === 'ALL' ? row.bots[0]?.enabled !== false : row.bots[0]?.enabled === true,
      toolCount: row._count.tools,
    }));
  }

  /**
   * `PUT /bots/:id/plugins` — replaces the set.
   *
   * Replace rather than patch, because that is what REST body says
   * (`{serverIds}`) and because it is the shape a modal with checkboxes
   * produces: the operator submits the state they want, not a diff nobody
   * computed.
   *
   * Everything is checked before anything is written. A foreign or absent
   * server id 404s ( non-leaking shape — the same answer for both), so a
   * rejected submission leaves the bot exactly as it was rather than
   * half-applied.
   *
   * AND NOTHING IS CHECKED ABOUT SIZE, which is rather than an
   * omission. This route used to refuse a set whose tools exceeded forty
   * resolved definitions, and then a set that left no room for the
   * doors that carry the overflow. Both numbers are gone: a bot's
   * plugin tools reach the model through the bridge, whose listing degrades
   * instead of refusing, so there is no configuration an operator can submit
   * that this build has to reject for being big.
   */
  async replace(userId: string, botId: string, serverIds: readonly string[]): Promise<BotPlugin[]> {
    await this.findOwnedBot(userId, botId);
    // Duplicates in the body are the same request said twice, not a second
    // plugin — and left in, they would fail `createMany` on the composite key.
    const wanted = [...new Set(serverIds)];

    const rows =
      wanted.length === 0
        ? []
        : await this.prisma.mcpServer.findMany({
            where: { userId, id: { in: wanted } },
            select: { id: true },
          });
    if (rows.length !== wanted.length) {
      const found = new Set(rows.map((row) => row.id));
      const missing = wanted.filter((id) => !found.has(id));
      throw new NotFoundException(
        `no installed plugin with ${missing.length === 1 ? 'id' : 'ids'} ${missing
          .map((id) => `"${id}"`)
          .join(', ')}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.bot.update({
        where: { id: botId, userId },
        data: { pluginGrantRevision: { increment: 1 } },
      });
      const installations = await tx.mcpServer.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      for (const installation of installations) {
        // The server lock serializes this per-bot edit with the access editor.
        const current = await tx.mcpServer.update({
          where: { id: installation.id, userId },
          data: { accessRevision: { increment: 1 } },
          select: { accessMode: true, composioConnection: { select: { removing: true } } },
        });
        const enabled = wanted.includes(installation.id);
        if (enabled && current.composioConnection?.removing)
          throw new NotFoundException('Plugin access was removed.');
        await tx.botMcpServer.deleteMany({
          where: { serverId: installation.id, botId, bot: { userId } },
        });
        if (
          (current.accessMode === 'ALL' && !enabled) ||
          (current.accessMode === 'SELECTED' && enabled)
        ) {
          await tx.botMcpServer.createMany({
            data: [{ botId, serverId: installation.id, enabled }],
          });
        }
      }
    });

    return this.list(userId, botId);
  }

  /** Replace the installation's mode and overrides atomically. */
  async setAccess(userId: string, serverId: string, access: PluginAccess): Promise<PluginAccess> {
    const ids = [...new Set(access.mode === 'ALL' ? access.excludedBotIds : access.selectedBotIds)];
    return this.prisma.$transaction(async (tx) => {
      const server = await tx.mcpServer.findFirst({
        where: { id: serverId, userId },
        select: { id: true, composioConnection: { select: { removing: true } } },
      });
      if (server === null || server.composioConnection?.removing)
        throw new NotFoundException('No installed plugin with that id.');
      const bots = await tx.bot.findMany({
        where: { userId, id: { in: ids } },
        select: { id: true },
      });
      if (bots.length !== ids.length)
        throw new NotFoundException('One or more bots are unavailable.');
      // The owner-scoped update locks this installation before replacing grants.
      const changed = await tx.mcpServer.updateMany({
        where: { id: serverId, userId, composioConnection: { isNot: { removing: true } } },
        data: { accessMode: access.mode, accessRevision: { increment: 1 } },
      });
      if (changed.count !== 1) throw new NotFoundException('Plugin access was removed.');
      await tx.botMcpServer.deleteMany({ where: { serverId, server: { userId } } });
      await tx.botMcpServer.createMany({
        data: ids.map((botId) => ({ botId, serverId, enabled: access.mode === 'SELECTED' })),
      });
      return toPluginAccess({
        accessMode: access.mode,
        bots: ids.map((botId) => ({ botId, enabled: access.mode === 'SELECTED' })),
      });
    });
  }

  /**
   * `TurnPluginSource` — what this bot's plugins contribute to one turn.
   *
   * Reads the CACHE, never the network: a turn must not wait on eight servers
   * answering `tools/list` before the model sees its first token, and §6/M6's
   * `McpTool` cache exists so it does not have to. `POST /mcp/servers/:id/refresh-tools`
   * is what fills the cache, and connecting a server runs it.
   */
  async toolsForBot(userId: string, botId: string): Promise<BotPluginTools> {
    const owned = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: { id: true },
    });
    if (owned === null)
      return { tools: [], deferred: [], refusals: [], unavailable: [], servers: [] };
    // Every ENABLED server, connected or not. The status filter is applied in
    // memory rather than in the query because both halves of the answer are
    // needed: §6/M6 asks for the tools of the ones that work AND a note naming
    // the ones that do not, and a query that excluded the second kind would
    // make the note impossible to write without a second round trip.
    const rows = await this.prisma.mcpServer.findMany({
      where: { userId, ...enabledPluginWhere(botId) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        backend: true,
        url: true,
        authType: true,
        isPrivate: true,
        tools: {
          orderBy: [{ name: 'asc' }],
          select: {
            name: true,
            description: true,
            inputSchema: true,
            readOnly: true,
            source: true,
          },
        },
      },
    });

    const bound: BoundPluginTool[] = [];
    const refusals: ToolRefusal[] = [];
    const unavailable: UnavailableServer[] = [];
    // What the bot is TOLD it has, which the two doors cannot say on
    // their own: `find_plugin_tools` is named for what it does, not for what
    // is behind it. Counted from the cached rows, so the number a bot reads
    // is the number this turn can actually reach.
    const active: ActivePlugin[] = [];
    const call: McpToolCaller = (request) =>
      this.servers.callTool(
        userId,
        request.serverId,
        request.toolName,
        request.args,
        // The ceiling, as the tool's own descriptor published it
        //. Passed rather than re-read, so the number the registry
        // advertises is the number the socket is held to.
        request.timeoutMs,
        request.abortSignal,
      );

    for (const row of rows) {
      if (row.status !== 'CONNECTED') {
        // A server that is not connected "stays out of tool sets until
        // reconnected". Offering its cached tools would put names in the
        // model's list that can only fail, and spend budget doing it.
        unavailable.push({
          serverId: row.id,
          name: row.name,
          reason: BotPluginsService.reasonForStatus(row.status),
        });
        continue;
      }
      active.push({ name: row.name, toolCount: row.tools.length });
      const server: McpToolServer = { id: row.id, name: row.name, slug: row.slug };
      const cached = row.tools.map((entry) => ({
        name: entry.name,
        source: entry.source,
        description: entry.description,
        inputSchema: toMcpInputSchema(entry.inputSchema),
        // The verdict, carried from the row the listing wrote. It is
        // what decides whether this tool asks before it runs.
        readOnly: entry.readOnly,
      }));
      const bindings = bindMcpTools(server, cached, call);
      for (const [index, binding] of bindings.entries()) {
        if (!binding.ok) {
          refusals.push({
            name: `${row.slug}__${binding.toolName}`,
            reason: `"${row.name}" offers a tool this build cannot name: ${binding.reason}`,
          });
          continue;
        }
        const source = cached[index];
        if (source === undefined) continue;
        const normalize =
          isCanonicalGitHub(row) && source.name === 'create_pull_request'
            ? defaultDraft
            : undefined;
        const extended =
          source.source === 'CREWAID_GIT' ||
          (isCanonicalGitHub(row) &&
            ['fork_repository', 'create_pull_request'].includes(source.name))
            ? this.git
              ? this.git.bind(binding.tool, userId, botId, row.id, source.name)
              : (() => {
                  throw new Error('Git workspace service is unavailable.');
                })()
            : binding.tool;
        const resolved = normalize ? draftPullRequests(extended) : extended;
        bound.push({
          tool: resolved,
          catalogue: {
            name: binding.tool.name,
            serverName: row.name,
            serverId: row.id,
            toolName: source.name,
            description: source.description,
            inputSchema: source.inputSchema,
            readOnly: source.readOnly,
            // The descriptor comes from the binding rather than a second
            // derivation here, so the reach a door decides on is the
            // reach a direct definition would have carried — one ladder,
            // consulted in one place.
            behavior: resolved.behavior,
            ...(resolved.commitAdapter ? { commitAdapter: resolved.commitAdapter } : {}),
            dispatch: resolved.build,
            source: source.source,
            ...(normalize ? { normalize } : {}),
          },
        });
      }
    }

    // The whole catalogue goes behind two definitions
    //
    // The order is the one the loop above built — install order, then tool
    // name — and it matters more than it used to: the listing is generated
    // from it, and a listing that changes between two turns of one
    // conversation is a bot whose tools look different for no reason. It is
    // also what the degradation rungs cut along, so the tools a truncated
    // listing keeps are the same ones on every turn.
    //
    // The bound `tool` is deliberately not offered on its own any more. It is
    // still what NAMES and CLASSIFIES a plugin tool — the catalogue above is
    // built from it, and `mcp-namespace.test.ts` still pins its dispatch — but
    // a turn reaches every plugin tool through the door, which is the property
    // that makes the surface cost two definitions instead of one per tool.
    const tools: RegisteredTool[] =
      bound.length === 0
        ? []
        : indirectPluginTools(
            bound.map((entry) => entry.catalogue),
            call,
          );

    const deferred = deferredPluginTools(
      bound.map((entry) => entry.catalogue),
      bound.map((entry) => entry.tool),
    );

    if (refusals.length > 0) {
      this.logger.warn(
        `bot ${botId}: ${String(refusals.length)} plugin tool(s) not offered this turn`,
      );
    }
    return { tools, deferred, refusals, unavailable, servers: active };
  }

  /**
   * Why a server took no part, in one clause a person can act on.
   *
   * Written from the STATUS rather than from `lastError`, which holds the
   * server's own words: a note in a transcript is read by somebody who was not
   * debugging anything, and "ECONNREFUSED 10.0.0.4:443" tells them nothing
   * they can do. The reason it needs to carry is which of three situations
   * this is, because each has a different next action.
   */
  private static reasonForStatus(status: string): string {
    switch (status) {
      case 'ERROR':
        return 'stopped responding';
      case 'NEEDS_REAUTH':
        return 'needs to be reconnected';
      case 'CONNECTING':
        return 'is still being connected';
      default:
        return 'has not been connected yet';
    }
  }

  /**
   * The same 404 for a bot that is absent and one that is somebody else's.
   * Scoped by `userId`, which is what makes this route safe without
   * an `@OwnedResource` marker — there is no `bot` kind for the guard.
   */
  private async findOwnedBot(userId: string, botId: string): Promise<void> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: { id: true },
    });
    if (bot === null) throw new NotFoundException('Bot not found');
  }
}
