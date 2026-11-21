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
  CreateBotGroupBodySchema,
  UpdateBotGroupBodySchema,
  type CreateBotGroupBody,
  type Principal,
  type UpdateBotGroupBody,
} from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { GroupsService } from './groups.service.js';

/** REST `/groups`. Every `:id` route carries its ownership marker. */
@Controller('groups')
export class GroupsController {
  constructor(@Inject(GroupsService) private readonly groups: GroupsService) {}

  @Get()
  list(@CurrentUser() principal: Principal) {
    return this.groups.list(principal.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateBotGroupBodySchema)) body: CreateBotGroupBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.groups.create(principal.userId, body);
  }

  @Patch(':id')
  @OwnedResource('botGroup')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateBotGroupBodySchema)) body: UpdateBotGroupBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.groups.update(principal.userId, id, body);
  }

  @Delete(':id')
  @OwnedResource('botGroup')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.groups.remove(principal.userId, id);
  }
}
