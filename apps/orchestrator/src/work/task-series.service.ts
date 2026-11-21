import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type TaskSeries } from '@prisma/client';
import {
  rankBetween,
  type CreateTaskBody,
  type CreateTaskResponse,
  type Repeat,
  type TaskSeriesDetailResponse,
  type UpdateTaskSeriesBody,
} from '@crewaid/shared';
import { StructuredLogger } from '../logging/structured-logger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  dateInZone,
  parseRoutineSchedule,
  routineEndDate,
  RoutineScheduleError,
} from '../routines/routine-schedule.js';
import { RoutineQueueUnavailableError } from '../routines/routine.queue.js';
import { taskCards } from './task-cards.js';
import { writeTaskEvent, USER_ACTOR, type WorkActor } from './task-events.js';
import { TASK_SERIES_SCHEDULER, type TaskSeriesScheduler } from './task-series.queue.js';
import { WorkEvents } from './work-events.js';
import { ownedBot, ownedSeries, resolvePlacement } from './work-refs.js';

/** How many occurrences a series' details carry, newest first. */
const RECENT_OCCURRENCES = 30;

export type FireOutcome = 'created' | 'duplicate' | 'skipped';

/**
 * Recurring tasks: a series that puts an ordinary task — an
 * occurrence — in *To do* each time its schedule comes round.
 *
 * An occurrence is a to-do that came back, never work that started: nothing
 * here posts a message or starts a turn, even for a series assigned to a bot.
 * Missed occurrences stay as they are and the next one comes regardless.
 * Editing a series changes future occurrences only; stopping or deleting it
 * keeps every occurrence already made.
 */
@Injectable()
export class TaskSeriesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TASK_SERIES_SCHEDULER) private readonly scheduler: TaskSeriesScheduler,
    @Inject(WorkEvents) private readonly events: WorkEvents,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  /**
   * `POST /tasks` with `repeat`. Creates the series and schedules it; its
   * first occurrence appears when the schedule first comes round, so the
   * response carries no task yet.
   */
  async create(
    userId: string,
    actor: WorkActor,
    input: CreateTaskBody & { readonly repeat: Repeat },
  ): Promise<CreateTaskResponse> {
    if (input.parentId) throw new BadRequestException('A subtask cannot repeat.');
    const repeat = this.checkedRepeat(input.repeat);
    const series = await this.prisma.$transaction(async (tx) => {
      const placement = await resolvePlacement(tx, userId, {
        parentId: null,
        projectId: input.projectId ?? null,
        goalId: input.goalId ?? null,
      });
      if (input.assigneeBotId) await ownedBot(tx, userId, input.assigneeBotId);
      return tx.taskSeries.create({
        data: {
          userId,
          title: input.title,
          brief: input.brief ?? null,
          assigneeBotId: input.assigneeBotId ?? null,
          projectId: placement.projectId,
          goalId: placement.goalId,
          ...repeat,
          origin: actor.kind === 'BOT' ? 'BOT' : 'OPERATOR',
        },
      });
    });
    try {
      await this.scheduler.schedule(series);
    } catch (error) {
      // A series that cannot fire must not sit there looking like it will.
      await this.prisma.taskSeries.delete({ where: { id: series.id, userId } });
      throw scheduleError(error);
    }
    if (series.goalId !== null) this.events.goal(userId, series.goalId);
    return { task: null, series };
  }

  /** `GET /task-series/:id` — the series and its recent occurrences, newest first. */
  async get(userId: string, seriesId: string): Promise<TaskSeriesDetailResponse> {
    const series = await this.findOwned(userId, seriesId);
    const occurrences = await this.prisma.task.findMany({
      where: { userId, seriesId },
      orderBy: [{ occursAt: 'desc' }],
      take: RECENT_OCCURRENCES,
    });
    return { ...series, occurrences: await taskCards(this.prisma, userId, occurrences) };
  }

  /**
   * `PATCH /task-series/:id` — edits what future occurrences will be, and
   * when. `enabled: false` stops it. Occurrences already on the board keep
   * the title, assignee and schedule they were made with.
   */
  async update(userId: string, seriesId: string, input: UpdateTaskSeriesBody): Promise<TaskSeries> {
    const before = await this.findOwned(userId, seriesId);
    const schedule = {
      cron: input.cron ?? before.cron,
      timezone: input.timezone ?? before.timezone,
      endsOn: input.endsOn !== undefined ? input.endsOn : before.endsOn,
    };
    const rescheduling =
      schedule.cron !== before.cron ||
      schedule.timezone !== before.timezone ||
      schedule.endsOn !== before.endsOn;
    if (rescheduling) this.checkedRepeat(schedule, input.endsOn !== undefined);

    const series = await this.prisma.$transaction(async (tx) => {
      const moving =
        (input.projectId !== undefined && input.projectId !== before.projectId) ||
        (input.goalId !== undefined && input.goalId !== before.goalId);
      const placement = moving
        ? await resolvePlacement(tx, userId, {
            parentId: null,
            projectId: input.projectId !== undefined ? input.projectId : before.projectId,
            goalId: input.goalId !== undefined ? input.goalId : before.goalId,
            explicitProject: input.projectId !== undefined,
          })
        : null;
      if (input.assigneeBotId) await ownedBot(tx, userId, input.assigneeBotId);
      return tx.taskSeries.update({
        where: { id: seriesId, userId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.brief !== undefined && { brief: input.brief }),
          ...(input.assigneeBotId !== undefined && { assigneeBotId: input.assigneeBotId }),
          ...(placement !== null && { projectId: placement.projectId, goalId: placement.goalId }),
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(rescheduling && schedule),
        },
      });
    });
    try {
      if (series.enabled) await this.scheduler.schedule(series);
      else await this.scheduler.unschedule(series.id);
    } catch (error) {
      throw scheduleError(error);
    }
    for (const goalId of new Set([before.goalId, series.goalId])) {
      if (goalId !== null) this.events.goal(userId, goalId);
    }
    await this.announceNewest(userId, series.id);
    return series;
  }

  /** `DELETE /task-series/:id` — stops it; every occurrence already made stays. */
  async remove(userId: string, seriesId: string): Promise<void> {
    const series = await this.findOwned(userId, seriesId);
    await this.scheduler.unschedule(seriesId);
    const newest = await this.newestOccurrence(userId, seriesId);
    await this.prisma.taskSeries.delete({ where: { id: seriesId, userId } });
    if (series.goalId !== null) this.events.goal(userId, series.goalId);
    if (newest !== null) this.events.task(userId, newest);
  }

  /**
   * One scheduled firing → at most one occurrence. Called by the queue worker,
   * which has no principal: the series row is found by id and everything it
   * writes is scoped by that row's own `userId`.
   *
   * The instant is the identity. A retried job carries the same one and
   * `@@unique([seriesId, occursAt])` refuses the second insert, so a retry
   * makes nothing; two firings on one local date are two instants and make
   * two tasks.
   */
  async fire(seriesId: string, occursAt: Date): Promise<FireOutcome> {
    const series = await this.prisma.taskSeries.findUnique({ where: { id: seriesId } });
    if (series === null || !series.enabled) {
      await this.scheduler.unschedule(seriesId);
      return 'skipped';
    }
    if (series.endsOn && occursAt > routineEndDate(series.endsOn, series.timezone)) {
      await this.scheduler.unschedule(seriesId);
      return 'skipped';
    }
    const { userId } = series;
    let taskId: string;
    try {
      taskId = await this.prisma.$transaction(async (tx) => {
        const first = await tx.task.findFirst({
          where: { userId, parentId: null, status: 'TODO' },
          orderBy: { rank: 'asc' },
          select: { rank: true },
        });
        const task = await tx.task.create({
          data: {
            userId,
            title: series.title,
            brief: series.brief,
            assigneeBotId: series.assigneeBotId,
            projectId: series.projectId,
            goalId: series.goalId,
            seriesId: series.id,
            occursAt,
            occursOn: dateInZone(occursAt, series.timezone),
            rank: rankBetween(null, first?.rank ?? null),
            origin: series.origin,
          },
        });
        // The user scheduled it, so the user is the actor of every occurrence.
        await writeTaskEvent(tx, userId, task.id, USER_ACTOR, 'CREATED', {});
        await tx.taskSeries.update({
          where: { id: series.id, userId },
          data: { lastFiredAt: occursAt },
        });
        return task.id;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return 'duplicate';
      }
      throw error;
    }
    this.logger.info('task.series.fired', { seriesId, taskId });
    this.events.task(userId, taskId);
    if (series.goalId !== null) this.events.goal(userId, series.goalId);
    if (series.projectId !== null) this.events.project(userId, series.projectId);
    return 'created';
  }

  /**
   * The schedule, validated exactly as a routine's is. An end date
   * already past is refused when it is being set — D-129's rule — because the
   * scheduler would drop it at once and the series would read as live.
   */
  private checkedRepeat(
    repeat: { cron: string; timezone: string; endsOn?: string | null | undefined },
    settingEnd = true,
  ): { cron: string; timezone: string; endsOn: string | null } {
    try {
      const { pattern, tz } = parseRoutineSchedule(repeat.cron, repeat.timezone);
      const endsOn = repeat.endsOn ?? null;
      if (endsOn !== null && settingEnd && routineEndDate(endsOn, tz).getTime() < Date.now()) {
        throw new BadRequestException('Choose an end date that has not passed.');
      }
      return { cron: pattern, timezone: tz, endsOn };
    } catch (error) {
      if (error instanceof RoutineScheduleError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private async newestOccurrence(userId: string, seriesId: string): Promise<string | null> {
    const newest = await this.prisma.task.findFirst({
      where: { userId, seriesId },
      orderBy: { occursAt: 'desc' },
      select: { id: true },
    });
    return newest?.id ?? null;
  }

  /** The board shows a series as its newest occurrence, so that card is what changed. */
  private async announceNewest(userId: string, seriesId: string): Promise<void> {
    const newest = await this.newestOccurrence(userId, seriesId);
    if (newest !== null) this.events.task(userId, newest);
  }

  private async findOwned(userId: string, seriesId: string): Promise<TaskSeries> {
    return ownedSeries(this.prisma, userId, seriesId);
  }
}

function scheduleError(error: unknown): Error {
  if (error instanceof RoutineScheduleError) return new BadRequestException(error.message);
  if (error instanceof RoutineQueueUnavailableError) {
    return new ServiceUnavailableException(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}
