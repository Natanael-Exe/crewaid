import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { TurnControlService } from './turn-control.service.js';

/**
 * `GET /bots/:id/approvals` — what a bot is waiting on now.
 *
 * `approval.requested` is emitted once, when the turn suspends. A desktop app
 * relaunched after that never saw it, and M5-FE-02's pending set is renderer
 * memory: it survives a reconnect, correctly, but not a restart. The turn then
 * sat suspended with no way to answer it but `bot.cancel`, which throws the
 * whole turn away to answer a question about one tool call.
 *
 * This is the read side that makes it recoverable — the client asks on mount
 * and gets back the same `approval.requested` payloads it would have received
 * live, so a recovered prompt and a live one are the same value taking the
 * same path into state.
 *
 * Ownership is the bot-family exemption: there is no `bot` kind for
 * `@OwnedResource`, and `listPendingApprovals` filters on `principal.userId`
 * before it returns anything — the same shape as the sandbox routes, and
 * written down in `test/ownership-route-coverage.test.ts`.
 */
@Controller('bots')
export class ApprovalsController {
  constructor(@Inject(TurnControlService) private readonly turns: TurnControlService) {}

  @Get(':id/approvals')
  list(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.turns.listPendingApprovals(principal.userId, id);
  }
}
