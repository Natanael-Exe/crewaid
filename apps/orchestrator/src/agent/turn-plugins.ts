import { Injectable } from '@nestjs/common';

import type { RegisteredTool, ToolRefusal } from './tool-registry.js';

/**
 * Where a turn asks which plugin tools this bot has.
 *
 * Why a holder and not a direct dependency
 *
 * The answer lives in `McpModule`: it owns `McpServer`, `McpTool` and
 * `BotMcpServer`, and it reads `ToolRegistry` to refuse a slug that would
 * shadow a built-in, so the arrow already runs mcp → bots.
 * `ChatSendService` is on the other end of that arrow, so it cannot import
 * back without the cycle `TurnEventsModule` was extracted to break.
 *
 * This is the same shape `ToolRegistry` already has and for the same reason: a
 * neutral holder that `BotsModule` owns and exports, which the module with the
 * dependencies registers ITSELF into at init (`SkillToolsRegistrar`,
 * `SendMessageRegistrar`, and now `McpTurnPluginsRegistrar`). What differs is
 * only what is held — the registry holds definitions that are the same for
 * every user, and this holds a function, because a bot's plugin tools are a
 * question that can only be answered per bot and per turn.
 */

/** What one bot's enabled plugins contribute to one turn. */
export type BotPluginTools = {
  /**
   * The tools to offer, already namespaced and bound to their servers.
   * Passed to `ToolRegistry.resolveFor` as extras, never registered.
   */
  readonly tools: readonly RegisteredTool[];
  /**
   * The same catalogue for a TanStack run — `find_plugin_tools` that
   * loads, then every plugin tool as itself, sent only once loaded. Names and
   * bindings are the ones `tools` reaches through the bridge.
   */
  readonly deferred: readonly RegisteredTool[];
  /**
   * Tools a bot has but is not being offered this turn, each with the reason.
   *
   * Carried rather than dropped because a capability a bot silently does not
   * have is precisely what MCP plugins failure isolation exists to make visible.
   * These go to the LOG: they are per-tool and usually a configuration
   * detail (a name this build cannot use, a budget already spent).
   */
  readonly refusals: readonly ToolRefusal[];
  /**
   * Whole servers the bot has enabled that took no part in this turn.
   *
   * Separate from `refusals` because MCP plugins asks for something different about
   * them: "A server failing its health check is dropped from the bot's tool
   * set for that turn, and a single system note names it." A note is for a
   * PERSON, and the thing a person can act on is the server — they reconnect
   * Linear, they do not reconnect `linear__create_issue`.
   */
  readonly unavailable: readonly UnavailableServer[];
  /**
   * The plugins that DID contribute, for the bot's own instructions.
   *
   * Separate from `tools` because the two doors are named for what they do,
   * not for what is behind them: a turn holding `find_plugin_tools` cannot
   * say "you have Notion" from the tool list alone. Reported here so
   * `agent-instructions.ts` can, and so the sentence a bot reads about its
   * plugins is built from the same resolution that decided which ones work.
   */
  readonly servers: readonly ActivePlugin[];
};

/** A connected plugin whose tools this turn can reach. */
export type ActivePlugin = {
  /** What the operator called it — what the bot should call it too. */
  readonly name: string;
  readonly toolCount: number;
};

/** One enabled server that contributed nothing, said for the operator. */
export type UnavailableServer = {
  readonly serverId: string;
  /** What the operator called it — what the note has to say. */
  readonly name: string;
  /** One clause, no jargon: why it took no part. */
  readonly reason: string;
};

/** Nothing offered, nothing refused. What a turn gets before M6 is wired. */
export const NO_PLUGIN_TOOLS: BotPluginTools = {
  tools: [],
  deferred: [],
  refusals: [],
  unavailable: [],
  servers: [],
};

/** Whatever can answer the question. One implementation: `BotPluginsService`. */
export interface TurnPluginSource {
  toolsForBot(userId: string, botId: string): Promise<BotPluginTools>;
}

@Injectable()
export class TurnPlugins {
  private source: TurnPluginSource | undefined;

  /**
   * Bind the one source. Throws on a second call rather than replacing:
   * two sources would be two answers to one question, and which one a turn
   * got would depend on module initialisation order.
   */
  use(source: TurnPluginSource): void {
    if (this.source !== undefined) {
      throw new Error('A turn plugin source is already bound; there can be only one.');
    }
    this.source = source;
  }

  /**
   * What this bot's plugins contribute, or nothing when no source is bound.
   *
   * Nothing rather than a throw, because "no source" is a legitimate build —
   * a test app that boots `BotsModule` alone has no MCP module in it, and a
   * turn there should run with its built-ins rather than fail on a
   * dependency it was never given.
   */
  toolsForBot(userId: string, botId: string): Promise<BotPluginTools> {
    return this.source?.toolsForBot(userId, botId) ?? Promise.resolve(NO_PLUGIN_TOOLS);
  }
}
