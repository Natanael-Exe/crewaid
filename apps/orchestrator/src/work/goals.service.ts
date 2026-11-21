import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Goal } from '@prisma/client';
import type {
  CreateGoalBody,
  GoalDetailResponse,
  GoalWithProgress,
  ListGoalsQuery,
  UpdateGoalBody,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { deliverableViews } from './deliverable-views.js';
import { goalSummaries } from './goal-summaries.js';
import { taskCards } from './task-cards.js';
import { ownedProject } from './work-refs.js';
import { WorkEvents } from './work-events.js';
import { workUsage } from './work-usage.js';

/** How many deliverables a goal's details carry; the Deliverables view pages the rest. */
const GOAL_DELIVERABLES = 50;

/**
 * Goals: an outcome with a target date, with or without a
 * project. Progress and done rates are derived on every read and never
 * stored, and a goal never closes itself — at 100% the view says *Ready to
 * close* and the user decides.
 */
@Injectable()
export class GoalsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkEvents) private readonly events: WorkEvents,
  ) {}

  async list(userId: string, query: ListGoalsQuery): Promise<GoalWithProgress[]> {
    const goals = await this.prisma.goal.findMany({
      where: {
        userId,
        ...(query.status !== undefined && { status: query.status }),
        ...(query.projectId !== undefined && { projectId: query.projectId }),
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    return goalSummaries(this.prisma, userId, goals);
  }

  async create(userId: string, input: CreateGoalBody): Promise<GoalWithProgress> {
    const goal = await this.prisma.$transaction(async (tx) => {
      if (input.projectId) await ownedProject(tx, userId, input.projectId);
      return tx.goal.create({
        data: {
          userId,
          title: input.title,
          outcome: input.outcome ?? null,
          targetOn: input.targetOn ?? null,
          projectId: input.projectId ?? null,
        },
      });
    });
    this.events.goal(userId, goal.id);
    if (goal.projectId !== null) this.events.project(userId, goal.projectId);
    return this.summary(userId, goal);
  }

  /** `GET /goals/:id`: the goal, its one-off tasks, its routines and its newest deliverables. */
  async get(userId: string, goalId: string): Promise<GoalDetailResponse> {
    const goal = await this.findOwned(userId, goalId);
    const [summary, tasks, routines, deliverables, usage] = await Promise.all([
      this.summary(userId, goal),
      this.prisma.task.findMany({
        where: { userId, goalId, parentId: null, seriesId: null },
        orderBy: [{ createdAt: 'asc' }],
      }),
      this.prisma.routine.findMany({
        where: { goalId, bot: { userId } },
        select: {
          id: true,
          botId: true,
          name: true,
          cron: true,
          timezone: true,
          enabled: true,
          lastRunAt: true,
          lastStatus: true,
        },
        orderBy: { name: 'asc' },
      }),
      deliverableViews(
        this.prisma,
        userId,
        { OR: [{ goalId }, { task: { goalId } }] },
        GOAL_DELIVERABLES,
      ),
      workUsage(this.prisma, userId, {
        OR: [{ task: { goalId } }, { routine: { goalId } }],
      }),
    ]);
    return {
      ...summary,
      tasks: await taskCards(this.prisma, userId, tasks),
      routines,
      deliverables,
      usage,
    };
  }

  /**
   * `PATCH /goals/:id`. Closing records `closedAt`; reopening clears it.
   *
   * Moving a goal to another project moves everything filed under it in the
   * same transaction — its tasks, its recurring tasks and its deliverables —
   * because a task on a goal is in that goal's project, and a filter
   * that could find the goal in one project and its work in another would be
   * answering from a state that never existed.
   */
  async update(userId: string, goalId: string, input: UpdateGoalBody): Promise<GoalWithProgress> {
    const before = await this.findOwned(userId, goalId);
    const moving = input.projectId !== undefined && input.projectId !== before.projectId;
    const goal = await this.prisma.$transaction(async (tx) => {
      if (moving && input.projectId) await ownedProject(tx, userId, input.projectId);
      const status =
        input.status !== undefined && input.status !== before.status ? input.status : null;
      const updated = await tx.goal.update({
        where: { id: goalId, userId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.outcome !== undefined && { outcome: input.outcome }),
          ...(input.targetOn !== undefined && { targetOn: input.targetOn }),
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          ...(status !== null && {
            status,
            closedAt: status === 'ACTIVE' ? null : new Date(),
          }),
        },
      });
      if (moving) {
        const projectId = input.projectId ?? null;
        await tx.task.updateMany({ where: { userId, goalId }, data: { projectId } });
        await tx.taskSeries.updateMany({ where: { userId, goalId }, data: { projectId } });
        await tx.deliverable.updateMany({
          where: { userId, OR: [{ goalId }, { task: { goalId } }] },
          data: { projectId },
        });
      }
      return updated;
    });
    this.events.goal(userId, goal.id);
    if (moving) {
      if (before.projectId !== null) this.events.project(userId, before.projectId);
      if (goal.projectId !== null) this.events.project(userId, goal.projectId);
    }
    return this.summary(userId, goal);
  }

  /**
   * `DELETE /goals/:id` — unlinks its tasks, recurring tasks, routines and
   * deliverables through the foreign keys, and deletes nothing else.
   */
  async remove(userId: string, goalId: string): Promise<void> {
    const goal = await this.findOwned(userId, goalId);
    await this.prisma.goal.delete({ where: { id: goalId, userId } });
    this.events.goal(userId, goalId, true);
    if (goal.projectId !== null) this.events.project(userId, goal.projectId);
  }

  private async summary(userId: string, goal: Goal): Promise<GoalWithProgress> {
    const [summary] = await goalSummaries(this.prisma, userId, [goal]);
    if (summary === undefined) throw new NotFoundException('Goal not found');
    return summary;
  }

  private async findOwned(userId: string, goalId: string): Promise<Goal> {
    const goal = await this.prisma.goal.findFirst({ where: { id: goalId, userId } });
    if (goal === null) throw new NotFoundException('Goal not found');
    return goal;
  }
}
