import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, Task, TaskStatus } from '@prisma/client';
import {
  TaskEventSchema,
  rankBetween,
  type CreateTaskBody,
  type CreateTaskResponse,
  type ListTasksQuery,
  type TaskCard,
  type TaskDetailResponse,
  type TaskEvent,
  type UpdateTaskBody,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { deliverableViews } from './deliverable-views.js';
import { taskCards } from './task-cards.js';
import { writeTaskEvent, type WorkActor } from './task-events.js';
import { TaskSeriesService } from './task-series.service.js';
import { WorkEvents } from './work-events.js';
import { workUsage } from './work-usage.js';
import { ownedBot, ownedTask, resolvePlacement } from './work-refs.js';

/** How much activity a task's details carry. */
const DETAIL_EVENTS = 100;

/** Everything but CANCELLED, which the board hides and a status filter can ask for. */
const DEFAULT_STATUSES: readonly TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'IN_REVIEW',
  'DONE',
];

/** The fields an EDITED event names. Rank is left out: a drag is not an edit. */
const EDIT_FIELDS = ['title', 'brief', 'dueOn', 'projectId', 'goalId'] as const;

/**
 * Tasks: the user's list, which the user and any of their bots
 * read and write.
 *
 * Every rule here is about the data staying true, none about workflow: one
 * level of subtasks, a subtask shares its parent's project and goal, a task on
 * a goal that has a project is in that project, and every referenced row is
 * the caller's. Nothing here starts a turn, messages a bot or changes a task
 * nobody asked to change — Start is its own route.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkEvents) private readonly events: WorkEvents,
    @Inject(TaskSeriesService) private readonly series: TaskSeriesService,
  ) {}

  /**
   * `GET /tasks`. Top-level tasks unless `parentId` asks for a parent's
   * subtasks. Without a project filter, tasks in archived projects are left
   * out: archiving hides a project and its tasks.
   */
  async list(userId: string, query: ListTasksQuery): Promise<TaskCard[]> {
    const where: Prisma.TaskWhereInput = {
      userId,
      parentId: query.parentId ?? null,
      status: { in: [...(query.status ?? DEFAULT_STATUSES)] },
      ...(query.goalId !== undefined && { goalId: query.goalId }),
      ...(query.assigneeBotId !== undefined && { assigneeBotId: query.assigneeBotId }),
      ...(query.seriesId !== undefined && { seriesId: query.seriesId }),
      ...((query.occursFrom !== undefined || query.occursThrough !== undefined) && {
        occursOn: {
          ...(query.occursFrom !== undefined && { gte: query.occursFrom }),
          ...(query.occursThrough !== undefined && { lte: query.occursThrough }),
        },
      }),
    };
    const and: Prisma.TaskWhereInput[] = [];
    if (query.projectId !== undefined) where.projectId = query.projectId;
    else if (query.inbox === true) where.projectId = null;
    else and.push({ OR: [{ projectId: null }, { project: { status: 'ACTIVE' } }] });
    if (query.doneSince !== undefined) {
      and.push({ NOT: { status: 'DONE', completedAt: { lt: query.doneSince } } });
    }
    const tasks = await this.prisma.task.findMany({
      where: { ...where, userId, ...(and.length > 0 && { AND: and }) },
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    });
    return taskCards(this.prisma, userId, tasks);
  }

  /** `GET /tasks/:id` — everything the details rail shows, in one read. */
  async get(userId: string, taskId: string): Promise<TaskDetailResponse> {
    const task = await this.findOwned(userId, taskId);
    const [cards, subtasks, events, deliverables, seriesRow, linked, usage] = await Promise.all([
      taskCards(this.prisma, userId, [task]),
      this.prisma.task.findMany({
        where: { userId, parentId: taskId },
        orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.taskEvent.findMany({
        where: { userId, taskId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: DETAIL_EVENTS,
      }),
      deliverableViews(this.prisma, userId, { taskId }, DETAIL_EVENTS),
      task.seriesId === null
        ? null
        : this.prisma.taskSeries.findFirst({ where: { id: task.seriesId, userId } }),
      task.assigneeBotId === null
        ? null
        : this.prisma.message.findFirst({
            where: {
              taskId,
              conversation: { botId: task.assigneeBotId, bot: { userId } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true },
          }),
      workUsage(this.prisma, userId, { task: { OR: [{ id: taskId }, { parentId: taskId }] } }),
    ]);
    const [card] = cards;
    if (card === undefined) throw new NotFoundException('Task not found');
    return {
      ...card,
      subtaskRows: await taskCards(this.prisma, userId, subtasks),
      events: this.wireEvents(events),
      deliverables,
      seriesRow,
      lastLinkedMessageId: linked?.id ?? null,
      usage,
    };
  }

  /**
   * `POST /tasks`, and a bot's `task_create`. Lands in *To do* and starts
   * nothing; with `repeat` it is a recurring task instead. A new top-level task goes to the top of the column unless
   * a rank is given; a subtask goes below its siblings.
   */
  async create(
    userId: string,
    actor: WorkActor,
    input: CreateTaskBody,
  ): Promise<CreateTaskResponse> {
    if (input.repeat !== undefined) {
      return this.series.create(userId, actor, { ...input, repeat: input.repeat });
    }
    const task = await this.prisma.$transaction(async (tx) => {
      const placement = await resolvePlacement(tx, userId, {
        parentId: input.parentId ?? null,
        projectId: input.projectId ?? null,
        goalId: input.goalId ?? null,
      });
      if (input.assigneeBotId) await ownedBot(tx, userId, input.assigneeBotId);
      const rank = input.rank ?? (await this.newRank(tx, userId, placement.parentId));
      const created = await tx.task.create({
        data: {
          userId,
          title: input.title,
          brief: input.brief ?? null,
          dueOn: input.dueOn ?? null,
          assigneeBotId: input.assigneeBotId ?? null,
          ...placement,
          rank,
          origin: actor.kind === 'BOT' ? 'BOT' : 'OPERATOR',
          createdByBotId: actor.kind === 'BOT' ? actor.botId : null,
        },
      });
      await writeTaskEvent(tx, userId, created.id, actor, 'CREATED', {});
      if (created.assigneeBotId !== null) {
        await this.assignedEvent(tx, userId, created.id, actor, created.assigneeBotId);
      }
      return created;
    });
    this.announce(task, null);
    const [card] = await taskCards(this.prisma, userId, [task]);
    return { task: card ?? null, series: null };
  }

  /**
   * `PATCH /tasks/:id`, and a bot's `task_update`. Any field, any status, by
   * the user or any of their bots; each change is logged with who
   * made it. Dragging a card sends a status and a rank and nothing else, so it
   * changes nothing else — in particular it starts nothing.
   */
  async update(
    userId: string,
    actor: WorkActor,
    taskId: string,
    input: UpdateTaskBody,
  ): Promise<TaskCard> {
    let before: Task | null = null;
    const task = await this.prisma.$transaction(async (tx) => {
      const current = await ownedTask(tx, userId, taskId);
      before = current;
      const data: Prisma.TaskUncheckedUpdateInput = {};

      const movesPlacement =
        (input.projectId !== undefined && input.projectId !== current.projectId) ||
        (input.goalId !== undefined && input.goalId !== current.goalId);
      if (movesPlacement) {
        if (current.parentId !== null) {
          throw new BadRequestException('A subtask shares its parent’s project and goal.');
        }
        const placement = await resolvePlacement(tx, userId, {
          parentId: null,
          projectId: input.projectId !== undefined ? input.projectId : current.projectId,
          goalId: input.goalId !== undefined ? input.goalId : current.goalId,
          explicitProject: input.projectId !== undefined,
        });
        data.projectId = placement.projectId;
        data.goalId = placement.goalId;
      }

      if (input.assigneeBotId !== undefined && input.assigneeBotId !== current.assigneeBotId) {
        if (input.assigneeBotId !== null) await ownedBot(tx, userId, input.assigneeBotId);
        data.assigneeBotId = input.assigneeBotId;
      }
      if (input.title !== undefined) data.title = input.title;
      if (input.brief !== undefined) data.brief = input.brief;
      if (input.dueOn !== undefined) data.dueOn = input.dueOn;
      if (input.rank !== undefined) data.rank = input.rank;

      const status =
        input.status !== undefined && input.status !== current.status ? input.status : null;
      if (status !== null) {
        data.status = status;
        if (status === 'IN_PROGRESS' && current.startedAt === null) data.startedAt = new Date();
        data.completedAt = status === 'DONE' ? new Date() : null;
      }
      const nextStatus = status ?? current.status;
      if (nextStatus !== 'BLOCKED') data.blockedReason = null;
      else if (input.blockedReason !== undefined) data.blockedReason = input.blockedReason;

      const updated = await tx.task.update({ where: { id: taskId, userId }, data });

      // A subtask follows its parent; a filed deliverable follows its task.
      if (movesPlacement) {
        await tx.task.updateMany({
          where: { userId, parentId: taskId },
          data: { projectId: updated.projectId, goalId: updated.goalId },
        });
        await tx.deliverable.updateMany({
          where: { userId, taskId },
          data: { projectId: updated.projectId, goalId: updated.goalId },
        });
      }

      await this.logUpdate(tx, userId, actor, current, updated);
      return updated;
    });
    this.announce(task, before);
    const [card] = await taskCards(this.prisma, userId, [task]);
    if (card === undefined) throw new NotFoundException('Task not found');
    return card;
  }

  /**
   * `DELETE /tasks/:id`. Its subtasks and activity go with it; its
   * deliverables are unfiled by the foreign key and never deleted — they are
   * the bots' work, not the task's.
   */
  async remove(userId: string, taskId: string): Promise<void> {
    const task = await this.findOwned(userId, taskId);
    const filed = await this.prisma.deliverable.findMany({
      where: { userId, OR: [{ taskId }, { task: { parentId: taskId } }] },
      select: { id: true },
    });
    await this.prisma.task.delete({ where: { id: taskId, userId } });
    this.events.task(userId, taskId, true);
    if (task.parentId !== null) this.events.task(userId, task.parentId);
    for (const row of filed) this.events.deliverable(userId, row.id);
  }

  /** `POST /tasks/:id/notes`, and a bot's `task_update({note})`. */
  async addNote(userId: string, actor: WorkActor, taskId: string, text: string) {
    const event = await this.prisma.$transaction(async (tx) => {
      await ownedTask(tx, userId, taskId);
      return writeTaskEvent(tx, userId, taskId, actor, 'NOTE', { text });
    });
    this.events.task(userId, taskId);
    return event;
  }

  /** The top of *To do* for a new task; below its siblings for a subtask. */
  private async newRank(
    tx: Prisma.TransactionClient,
    userId: string,
    parentId: string | null,
  ): Promise<string> {
    if (parentId !== null) {
      const last = await tx.task.findFirst({
        where: { userId, parentId },
        orderBy: { rank: 'desc' },
        select: { rank: true },
      });
      return rankBetween(last?.rank ?? null, null);
    }
    const first = await tx.task.findFirst({
      where: { userId, parentId: null, status: 'TODO' },
      orderBy: { rank: 'asc' },
      select: { rank: true },
    });
    return rankBetween(null, first?.rank ?? null);
  }

  private async assignedEvent(
    tx: Prisma.TransactionClient,
    userId: string,
    taskId: string,
    actor: WorkActor,
    botId: string,
  ): Promise<void> {
    const bot = await ownedBot(tx, userId, botId);
    await writeTaskEvent(tx, userId, taskId, actor, 'ASSIGNED', { botId, botName: bot.name });
  }

  /** One row per kind of change, so the log reads as what happened. */
  private async logUpdate(
    tx: Prisma.TransactionClient,
    userId: string,
    actor: WorkActor,
    before: Task,
    after: Task,
  ): Promise<void> {
    if (before.status !== after.status) {
      await writeTaskEvent(tx, userId, after.id, actor, 'STATUS_CHANGED', {
        from: before.status,
        to: after.status,
        ...(after.status === 'BLOCKED' &&
          after.blockedReason !== null && {
            blockedReason: after.blockedReason,
          }),
      });
    }
    if (before.assigneeBotId !== after.assigneeBotId) {
      if (before.assigneeBotId !== null) {
        const previous = await tx.bot.findFirst({
          where: { id: before.assigneeBotId, userId },
          select: { name: true },
        });
        await writeTaskEvent(tx, userId, after.id, actor, 'UNASSIGNED', {
          botId: before.assigneeBotId,
          botName: previous?.name ?? 'a deleted bot',
        });
      }
      if (after.assigneeBotId !== null) {
        await this.assignedEvent(tx, userId, after.id, actor, after.assigneeBotId);
      }
    }
    const fields = EDIT_FIELDS.filter((field) => before[field] !== after[field]);
    if (fields.length > 0) {
      await writeTaskEvent(tx, userId, after.id, actor, 'EDITED', { fields: [...fields] });
    }
  }

  /** After commit: the task, its parent, and any project or goal whose counts moved. */
  private announce(after: Task, before: Task | null): void {
    const { userId } = after;
    this.events.task(userId, after.id);
    if (after.parentId !== null) this.events.task(userId, after.parentId);
    const projects = new Set([before?.projectId, after.projectId]);
    const goals = new Set([before?.goalId, after.goalId]);
    for (const projectId of projects) if (projectId) this.events.project(userId, projectId);
    for (const goalId of goals) if (goalId) this.events.goal(userId, goalId);
  }

  /**
   * Activity rows onto the wire. Each payload was parsed by its type's schema
   * when it was written, so a row failing here is a defect, not user input —
   * it is logged and left out rather than failing the whole details read.
   */
  private wireEvents(rows: readonly unknown[]): TaskEvent[] {
    const events: TaskEvent[] = [];
    for (const row of rows) {
      const parsed = TaskEventSchema.safeParse(row);
      if (parsed.success) events.push(parsed.data);
      else this.logger.error(`task event dropped from the log: ${parsed.error.message}`);
    }
    return events;
  }

  private async findOwned(userId: string, taskId: string): Promise<Task> {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, userId } });
    if (task === null) throw new NotFoundException('Task not found');
    return task;
  }
}
