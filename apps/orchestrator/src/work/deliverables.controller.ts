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
  Query,
} from '@nestjs/common';
import {
  CreateDeliverableBodySchema,
  ListDeliverablesQuerySchema,
  UpdateDeliverableBodySchema,
  type CreateDeliverableBody,
  type ListDeliverablesQuery,
  type Principal,
  type UpdateDeliverableBody,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { DeliverablesService } from './deliverables.service.js';

/** REST `/deliverables`. Every `:id` route carries its ownership marker. */
@Controller('deliverables')
export class DeliverablesController {
  constructor(@Inject(DeliverablesService) private readonly deliverables: DeliverablesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListDeliverablesQuerySchema)) query: ListDeliverablesQuery,
    @CurrentUser() principal: Principal,
  ) {
    return this.deliverables.list(principal.userId, query);
  }

  @Get(':id')
  @OwnedResource('deliverable')
  get(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.deliverables.get(principal.userId, id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateDeliverableBodySchema)) body: CreateDeliverableBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.deliverables.create(principal.userId, body);
  }

  @Patch(':id')
  @OwnedResource('deliverable')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateDeliverableBodySchema)) body: UpdateDeliverableBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.deliverables.update(principal.userId, id, body);
  }

  @Delete(':id')
  @OwnedResource('deliverable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.deliverables.remove(principal.userId, id);
  }
}
