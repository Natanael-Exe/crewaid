import { GitHubGitService } from '../integrations/github-git/github-git.service.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { ComposioService } from '../integrations/composio/composio.service.js';
import { Module } from '@nestjs/common';
import { BotsModule } from '../bots/bots.module.js';
import { TurnEventsModule } from '../agent/turn-events.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BotPluginsController } from './bot-plugins.controller.js';
import { BotPluginsService } from './bot-plugins.service.js';
import { McpController } from './mcp.controller.js';
import { McpServersService } from './mcp-servers.service.js';
import { McpTurnPluginsRegistrar } from './mcp-turn-plugins.registrar.js';

/**
 * the MCP install surface, and the module M6's later tasks hang
 * their own pieces off.
 *
 * The service is exported because resolves a bot's tool budget from
 * the servers it has enabled, and needs a server's status to decide
 * whether it takes part in a turn. Both read the cache through here rather
 * than querying `McpServer`/`McpTool` themselves: one place that knows how a
 * row becomes a wire type is also the one place to audit for §7.3.
 *
 * The client itself (`mcp-connection.ts`, `mcp-tools.ts`, `mcp-transport.ts`)
 * is not a provider: it is functions over a target, with no state and nothing
 * to inject, and `mcp-connection.test.ts` calls it directly.
 *
 * imports `TurnEventsModule` for one frame: a refresh that cannot mint
 * a token writes NEEDS_REAUTH and emits `mcp.status`, so the modal finds out
 * without polling. The bus is the WebSocket fan-out and is deliberately its own
 * module — importing it is not importing chat.
 *
 * imports `BotsModule` for `ToolRegistry`, and the arrow runs that
 * way round on purpose. It is the same rule set for `SkillsModule`
 * and for `InterbotModule`: a module that needs something of the
 * turn's reaches into `BotsModule`, never the reverse, because `BotsModule`
 * importing back is the cycle `TurnEventsModule` was extracted to break.
 * What is read is the built-in tool NAMES, so an install can refuse a slug
 * that would shadow one. MCP tools do not travel the other way: they
 * are not registered into that registry at all — says why, and
 * `mcp-tool-binding.ts` is the per-turn projection that replaces it.
 *
 * adds the per-bot half: `BotPluginsController` serves REST
 * `/bots/:id/plugins` from here, because the answer is a join of three tables
 * this module owns — Nest mounts a controller by its own path, not by the
 * module it is declared in. `McpTurnPluginsRegistrar` puts the same service
 * into `TurnPlugins`, the holder `BotsModule` exports, so a turn can ask for a
 * bot's plugin tools without `BotsModule` importing this module back.
 */
@Module({
  imports: [PrismaModule, TurnEventsModule, BotsModule, SandboxModule],
  controllers: [McpController, BotPluginsController],
  providers: [
    GitHubGitService,
    ComposioService,
    McpServersService,
    BotPluginsService,
    McpTurnPluginsRegistrar,
  ],
  exports: [McpServersService, BotPluginsService],
})
export class McpModule {}
