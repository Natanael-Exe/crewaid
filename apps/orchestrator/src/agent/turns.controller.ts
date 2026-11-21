import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ListTurnsQuerySchema, type ListTurnsQuery, type Principal } from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { TurnHistoryService } from './turn-history.service.js';

/**
 * `GET /bots/:id/turns?limit=` — recent agent turns with step counts
 * and token usage.
 *
 * Ownership is the bot-family exemption: there is no `bot` kind for
 * `@OwnedResource`, and `TurnHistoryService.list` resolves the bot by
 * `principal.userId` before it reads a turn — written down in
 * `test/ownership-route-coverage.test.ts`.
 */
@Controller('bots')
export class TurnsController {
  constructor(@Inject(TurnHistoryService) private readonly history: TurnHistoryService) {}

  @Get(':id/turns')
  list(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ListTurnsQuerySchema)) query: ListTurnsQuery,
    @CurrentUser() principal: Principal,
  ) {
    return this.history.list(principal.userId, id, query);
  }
}
