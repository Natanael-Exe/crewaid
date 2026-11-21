import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CreateBotBodySchema,
  MarkBotReadBodySchema,
  UpdateBotBodySchema,
  type CreateBotBody,
  type MarkBotReadBody,
  type UpdateBotBody,
  type Principal,
} from '@crewaid/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { BotsService } from './bots.service.js';

/**
 * Bot CRUD endpoints.
 *
 * AuthGuard resolves the Principal; this controller reads it via
 * `@CurrentUser` and passes `principal.userId` into the service. The service
 * so the scoping discipline is testable without HTTP.
 *
 * Inbound bodies parse against the shared Zod schemas (ZodValidationPipe) —
 * `@crewaid/shared` stays the single contract source. Outbound rows are returned
 * as Prisma emits them; the integration suite parses every response through
 * the same shared schemas, which is where contract conformance is proven.
 */
@Controller('bots')
export class BotsController {
  constructor(@Inject(BotsService) private readonly bots: BotsService) {}

  @Get()
  list(@CurrentUser() principal: Principal) {
    return this.bots.list(principal.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateBotBodySchema)) body: CreateBotBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.bots.create(principal.userId, body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateBotBodySchema)) body: UpdateBotBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.bots.update(principal.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.bots.remove(principal.userId, id);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  duplicate(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.bots.duplicate(principal.userId, id);
  }

  /** 200 with the count after the change, never 204: the client shows it. */
  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(MarkBotReadBodySchema)) body: MarkBotReadBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.bots.markRead(principal.userId, id, body.unread === true);
  }
}
