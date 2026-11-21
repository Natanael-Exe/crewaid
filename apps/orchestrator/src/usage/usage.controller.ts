import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  UsageQuerySchema,
  type Principal,
  type UsageQuery,
  type UsageResponse,
} from '@crewaid/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { UsageService } from './usage.service.js';

/**
 * GET /usage?from=&to= — daily token-spend rollup per bot.
 *
 * The controller is the door: shape validation happens in the shared Zod
 * schema (ZodValidationPipe), range semantics and the aggregation live in
 * UsageService, and the principal comes from AuthGuard via `@CurrentUser()`
 * like every other route. The response is built to UsageResponseSchema and
 * parsed back through it by the integration suite — wire conformance is
 * proven there, not asserted here.
 */
@Controller('usage')
export class UsageController {
  constructor(@Inject(UsageService) private readonly usage: UsageService) {}

  @Get()
  daily(
    @Query(new ZodValidationPipe(UsageQuerySchema)) query: UsageQuery,
    @CurrentUser() principal: Principal,
  ): Promise<UsageResponse> {
    return this.usage.daily(principal.userId, query);
  }
}
