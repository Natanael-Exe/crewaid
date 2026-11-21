import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Project } from '@prisma/client';
import type {
  CreateProjectBody,
  ListProjectsQuery,
  ProjectWithCounts,
  UpdateProjectBody,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { OPEN_STATUSES } from './task-cards.js';
import { WorkEvents } from './work-events.js';

/**
 * Projects: a grouping of goals and tasks, and nothing else. Not a
 * folder on the computer, not a memory scope, and optional at every level.
 *
 * Every query is scoped by `userId`; an absent project and somebody
 * else's are the same 404.
 */
@Injectable()
export class ProjectsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkEvents) private readonly events: WorkEvents,
  ) {}

  /** `GET /projects` — sidebar order, each with what it holds. */
  async list(userId: string, query: ListProjectsQuery): Promise<ProjectWithCounts[]> {
    const projects = await this.prisma.project.findMany({
      where: { userId, ...(query.status !== undefined && { status: query.status }) },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return this.withCounts(userId, projects);
  }

  /** New projects go below the existing ones. */
  async create(userId: string, input: CreateProjectBody): Promise<ProjectWithCounts> {
    const last = await this.prisma.project.aggregate({
      where: { userId },
      _max: { sortOrder: true },
    });
    const project = await this.prisma.project.create({
      data: {
        userId,
        name: input.name,
        description: input.description ?? null,
        color: input.color,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    this.events.project(userId, project.id);
    return { ...project, openTaskCount: 0, goalCount: 0 };
  }

  /** `PATCH /projects/:id`. `{status: 'ARCHIVED'}` archives; nothing else moves. */
  async update(
    userId: string,
    projectId: string,
    input: UpdateProjectBody,
  ): Promise<ProjectWithCounts> {
    await this.findOwned(userId, projectId);
    const project = await this.prisma.project.update({
      where: { id: projectId, userId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.color !== undefined && { color: input.color }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
    });
    this.events.project(userId, project.id);
    const [withCounts] = await this.withCounts(userId, [project]);
    if (withCounts === undefined) throw new NotFoundException('Project not found');
    return withCounts;
  }

  /**
   * `DELETE /projects/:id` — refused while it holds a goal, a task or a
   * recurring task. Deleting a grouping must never be how work is
   * lost; the user moves or deletes what is in it first. Deliverables filed
   * under it are only unfiled, by the foreign key.
   */
  async remove(userId: string, projectId: string): Promise<void> {
    await this.findOwned(userId, projectId);
    const [goals, tasks, series] = await Promise.all([
      this.prisma.goal.count({ where: { userId, projectId } }),
      this.prisma.task.count({ where: { userId, projectId } }),
      this.prisma.taskSeries.count({ where: { userId, projectId } }),
    ]);
    if (goals + tasks + series > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PROJECT_NOT_EMPTY',
        message: 'This project still holds goals or tasks. Move or delete them first.',
      });
    }
    await this.prisma.project.delete({ where: { id: projectId, userId } });
    this.events.project(userId, projectId, true);
  }

  private async withCounts(
    userId: string,
    projects: readonly Project[],
  ): Promise<ProjectWithCounts[]> {
    if (projects.length === 0) return [];
    const ids = projects.map((project) => project.id);
    const [open, goals] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['projectId'],
        where: {
          userId,
          projectId: { in: ids },
          parentId: null,
          status: { in: [...OPEN_STATUSES] },
        },
        _count: { _all: true },
      }),
      this.prisma.goal.groupBy({
        by: ['projectId'],
        where: { userId, projectId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    return projects.map((project) => ({
      ...project,
      openTaskCount: open.find((row) => row.projectId === project.id)?._count._all ?? 0,
      goalCount: goals.find((row) => row.projectId === project.id)?._count._all ?? 0,
    }));
  }

  private async findOwned(userId: string, projectId: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId } });
    if (project === null) throw new NotFoundException('Project not found');
    return project;
  }
}
