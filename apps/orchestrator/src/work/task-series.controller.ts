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
} from '@nestjs/common';
import {
  UpdateTaskSeriesBodySchema,
  type Principal,
  type UpdateTaskSeriesBody,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { TaskSeriesService } from './task-series.service.js';

/** REST `/task-series/:id`. A series is created through `POST /tasks`. */
@Controller('task-series')
export class TaskSeriesController {
  constructor(@Inject(TaskSeriesService) private readonly series: TaskSeriesService) {}

  @Get(':id')
  @OwnedResource('taskSeries')
  get(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.series.get(principal.userId, id);
  }

  @Patch(':id')
  @OwnedResource('taskSeries')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateTaskSeriesBodySchema)) body: UpdateTaskSeriesBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.series.update(principal.userId, id, body);
  }

  @Delete(':id')
  @OwnedResource('taskSeries')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.series.remove(principal.userId, id);
  }
}
