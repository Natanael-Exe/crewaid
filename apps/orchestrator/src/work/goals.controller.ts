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
  CreateGoalBodySchema,
  ListGoalsQuerySchema,
  UpdateGoalBodySchema,
  type CreateGoalBody,
  type ListGoalsQuery,
  type Principal,
  type UpdateGoalBody,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { GoalsService } from './goals.service.js';

/** REST `/goals`. Every `:id` route carries its ownership marker. */
@Controller('goals')
export class GoalsController {
  constructor(@Inject(GoalsService) private readonly goals: GoalsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListGoalsQuerySchema)) query: ListGoalsQuery,
    @CurrentUser() principal: Principal,
  ) {
    return this.goals.list(principal.userId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateGoalBodySchema)) body: CreateGoalBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.goals.create(principal.userId, body);
  }

  @Get(':id')
  @OwnedResource('goal')
  get(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.goals.get(principal.userId, id);
  }

  @Patch(':id')
  @OwnedResource('goal')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateGoalBodySchema)) body: UpdateGoalBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.goals.update(principal.userId, id, body);
  }

  @Delete(':id')
  @OwnedResource('goal')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.goals.remove(principal.userId, id);
  }
}
