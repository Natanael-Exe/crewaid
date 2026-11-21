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
  AddTaskNoteBodySchema,
  CreateTaskBodySchema,
  ListTasksQuerySchema,
  UpdateTaskBodySchema,
  type AddTaskNoteBody,
  type CreateTaskBody,
  type ListTasksQuery,
  type Principal,
  type UpdateTaskBody,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { USER_ACTOR } from './task-events.js';
import { TasksService } from './tasks.service.js';

/**
 * REST `/tasks`. Every `:id` route carries its ownership marker.
 * The board is the user acting, so every write here is attributed to
 * the user and carries no message link.
 */
@Controller('tasks')
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListTasksQuerySchema)) query: ListTasksQuery,
    @CurrentUser() principal: Principal,
  ) {
    return this.tasks.list(principal.userId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateTaskBodySchema)) body: CreateTaskBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.tasks.create(principal.userId, USER_ACTOR, body);
  }

  @Get(':id')
  @OwnedResource('task')
  get(@Param('id') id: string, @CurrentUser() principal: Principal) {
    return this.tasks.get(principal.userId, id);
  }

  @Patch(':id')
  @OwnedResource('task')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateTaskBodySchema)) body: UpdateTaskBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.tasks.update(principal.userId, USER_ACTOR, id, body);
  }

  @Delete(':id')
  @OwnedResource('task')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.tasks.remove(principal.userId, id);
  }

  @Post(':id/notes')
  @OwnedResource('task')
  @HttpCode(HttpStatus.CREATED)
  addNote(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddTaskNoteBodySchema)) body: AddTaskNoteBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.tasks.addNote(principal.userId, USER_ACTOR, id, body.text);
  }
}
