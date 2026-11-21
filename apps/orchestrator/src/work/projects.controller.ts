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
  CreateProjectBodySchema,
  ListProjectsQuerySchema,
  UpdateProjectBodySchema,
  type CreateProjectBody,
  type ListProjectsQuery,
  type Principal,
  type UpdateProjectBody,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { ProjectsService } from './projects.service.js';

/** REST `/projects`. Every `:id` route carries its ownership marker. */
@Controller('projects')
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListProjectsQuerySchema)) query: ListProjectsQuery,
    @CurrentUser() principal: Principal,
  ) {
    return this.projects.list(principal.userId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateProjectBodySchema)) body: CreateProjectBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.projects.create(principal.userId, body);
  }

  @Patch(':id')
  @OwnedResource('project')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateProjectBodySchema)) body: UpdateProjectBody,
    @CurrentUser() principal: Principal,
  ) {
    return this.projects.update(principal.userId, id, body);
  }

  @Delete(':id')
  @OwnedResource('project')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.projects.remove(principal.userId, id);
  }
}
