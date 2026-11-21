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
  CreateRoutineBodySchema,
  UpdateRoutineBodySchema,
  type CreateRoutineBody,
  type Principal,
  type UpdateRoutineBody,
} from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { RoutinesService } from './routines.service.js';

/**
 * REST `/routines` — CRUD and run-now.
 *
 * Every `:id` route carries its ownership marker. Create has no id in
 * the path; the bot it names is in the BODY, which the guard does not read,
 * so the service scopes that lookup itself.
 */
@Controller('routines')
export class RoutinesController {
  constructor(@Inject(RoutinesService) private readonly routines: RoutinesService) {}

  @Get()
  list(@CurrentUser() principal: Principal) {
    return this.routines.list(principal.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateRoutineBodySchema)) body: CreateRoutineBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.routines.create(principal.userId, body);
  }

  @Patch(':id')
  @OwnedResource('routine')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateRoutineBodySchema)) body: UpdateRoutineBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.routines.update(principal.userId, id, body);
  }

  @Delete(':id')
  @OwnedResource('routine')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.routines.remove(principal.userId, id);
  }

  /**
   * 202, not 200: the firing is queued, not done. The body is the routine as
   * it stands; its outcome lands in `lastStatus` like any scheduled firing's.
   */
  @Post(':id/run-now')
  @OwnedResource('routine')
  @HttpCode(HttpStatus.ACCEPTED)
  runNow(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.routines.runNow(principal.userId, id);
  }
}
