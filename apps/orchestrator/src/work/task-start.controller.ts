import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { IdempotencyKeySchema, type Principal } from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { TaskStartService } from './task-start.service.js';

/**
 * `POST /tasks/:id/start`. Kept apart from the task routes because it
 * is the one Work route that reaches the turn path; the rest of Work cannot
 * start anything and does not depend on anything that could.
 */
@Controller('tasks')
export class TaskStartController {
  constructor(@Inject(TaskStartService) private readonly starts: TaskStartService) {}

  @Post(':id/start')
  @OwnedResource('task')
  @HttpCode(HttpStatus.ACCEPTED)
  start(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentUser() principal: Principal,
  ) {
    const parsed = IdempotencyKeySchema.safeParse(key);
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: 'Start needs an Idempotency-Key header holding a UUID.',
      });
    }
    return this.starts.start(principal.userId, id, parsed.data);
  }
}
