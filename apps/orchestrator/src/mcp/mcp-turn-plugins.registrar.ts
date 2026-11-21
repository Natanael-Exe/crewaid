import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { TurnPlugins } from '../agent/turn-plugins.js';
import { BotPluginsService } from './bot-plugins.service.js';

/**
 * the plugin source puts itself where a turn can reach it.
 *
 * The same shape as `SkillToolsRegistrar` and `SendMessageRegistrar`, and for
 * the same reason: what a turn needs lives in the module that owns the rows,
 * and that module already depends on `BotsModule` — so it registers itself
 * into the holder `BotsModule` exports rather than dragging `McpServer`,
 * `McpTool` and `BotMcpServer` into `BotsModule`'s factory.
 *
 * `onModuleInit` rather than the constructor, because Nest initialises a
 * module's imports before the module itself: the holder exists by the time
 * this runs, and a second source still throws at boot with this class named in
 * the stack.
 */
@Injectable()
export class McpTurnPluginsRegistrar implements OnModuleInit {
  constructor(
    @Inject(TurnPlugins) private readonly plugins: TurnPlugins,
    @Inject(BotPluginsService) private readonly source: BotPluginsService,
  ) {}

  onModuleInit(): void {
    this.plugins.use(this.source);
  }
}
