import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import {
  MemoryQuerySchema,
  UpdateMemoryBodySchema,
  type MemoryQuery,
  type UpdateMemoryBody,
  type MemoryResponse,
  type Principal,
} from '@crewaid/shared';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { MemoryService } from './memory.service.js';

/**
 * `GET /memory?botId=&includeInactive=` — what this user's bots know.
 *
 * Read-only, and it exists because D-073 took something away. An operator
 * used to be able to open `/home/bot/shared/MEMORY.md` in the seat and read
 * it; moving the memory into Postgres removed that, and a memory nobody can
 * inspect is a black box exactly when a bot is confidently wrong and you need
 * to look at what it thinks it knows.
 *
 * The door, on the `usage/` shape: shape validation in the shared Zod schema,
 * scoping and projection in MemoryService, the principal from AuthGuard via
 * `@CurrentUser()`. No `@OwnedResource` marker because there is no id in the
 * path — this is a LIST route and its ownership is the `where` clause, which
 * is what the R7 allowlist audits.
 *
 * D-229 adds the write half: `PATCH /memory/:id` records a person's
 * correction as TOLD and supersedes the old row, `DELETE /memory/:id` forgets
 * one. Both tombstone the old claim so extraction cannot learn it back, and
 * both resolve the row by id AND `principal.userId` inside their transaction,
 * which is the ownership check (the exemption in the route-coverage test).
 */
@Controller('memory')
export class MemoryController {
  constructor(@Inject(MemoryService) private readonly memories: MemoryService) {}

  @Patch(':id')
  @HttpCode(204)
  async correct(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateMemoryBodySchema)) body: UpdateMemoryBody,
  ): Promise<void> {
    await this.memories.editOwned(principal.userId, id, body.text);
  }

  @Delete(':id')
  @HttpCode(204)
  async forget(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    await this.memories.forgetOwned(principal.userId, id);
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(MemoryQuerySchema)) query: MemoryQuery,
    @CurrentUser() principal: Principal,
  ): Promise<MemoryResponse> {
    return { rows: await this.memories.listFor(principal.userId, query) };
  }
}
