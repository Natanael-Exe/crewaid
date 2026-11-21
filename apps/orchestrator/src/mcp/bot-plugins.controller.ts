import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import {
  SetBotPluginsBodySchema,
  type BotPlugin,
  type Principal,
  type SetBotPluginsBody,
} from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { BotPluginsService } from './bot-plugins.service.js';

/**
 * REST per-bot plugin surface.
 *
 * It lives in `McpModule` rather than beside the other `bots/:id/*` routes,
 * and the path is what makes that look odd rather than anything about the
 * code: the answer is a join of `McpServer`, `McpTool` and `BotMcpServer`, all
 * three of which this module owns, and `McpModule` already imports
 * `BotsModule` for `ToolRegistry`. Putting the controller the other
 * way round would mean `BotsModule` importing this one back, which is the
 * cycle `TurnEventsModule` was extracted to break. Nest mounts a controller by
 * its own `@Controller` path, not by the module it is declared in, so the
 * route is `/bots/:id/plugins` either way.
 *
 * ⚠️ No `@OwnedResource` marker, and that is an entry in
 * `ownership-route-coverage.test.ts`'s exemption list rather than an omission:
 * there is no `bot` kind for the guard to resolve (see the other nine
 * `bots/:id/*` routes), and `BotPluginsService` scopes every query by
 * `principal.userId` before it reads or writes anything.
 *
 * Nothing here returns a credential: `BotPluginSchema` has an id, a slug, a
 * name, a flag and a count, and no field token material could travel in.
 */
@Controller('bots')
export class BotPluginsController {
  constructor(@Inject(BotPluginsService) private readonly plugins: BotPluginsService) {}

  @Get(':id/plugins')
  list(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<BotPlugin[]> {
    return this.plugins.list(principal.userId, id);
  }

  /**
   * Replaces the set, and answers with what the bot now has.
   *
   * The whole list rather than 204: the caller just changed the thing it was
   * displaying, and the counts it needs to redraw (§7.4's budget) are this
   * server's arithmetic, not the modal's.
   */
  @Put(':id/plugins')
  replace(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetBotPluginsBodySchema)) body: SetBotPluginsBody,
    @CurrentUser() principal: Principal,
  ): Promise<BotPlugin[]> {
    return this.plugins.replace(principal.userId, id, body.serverIds);
  }
}
