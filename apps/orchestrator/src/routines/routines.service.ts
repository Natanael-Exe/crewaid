import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type Routine, type RoutineOrigin } from '@prisma/client';
import type { CreateRoutineBody, UpdateRoutineBody } from '@crewaid/shared';

import { PrismaService } from '../prisma/prisma.service.js';
import { USER_PREFERENCES_SELECT, userPreferences } from '../providers/user-preferences.js';
import { parseRoutineSchedule, routineEndDate, RoutineScheduleError } from './routine-schedule.js';
import {
  ROUTINE_SCHEDULER,
  RoutineQueueUnavailableError,
  type RoutineScheduler,
} from './routine.queue.js';

/**
 * The default zone, used when a create names none and the person's settings
 * name none either.
 */
export const DEFAULT_TIMEZONE = 'America/Port-au-Prince';

/**
 * How many routines a bot may hold that it scheduled itself.
 *
 * A bot that parks work for later is useful; an unattended team that does it
 * on every turn accumulates schedules nobody reads, each a model call per
 * firing. Five is room for a handful of genuine follow-ups and small enough
 * that the ceiling is met by a runaway rather than by ordinary use. The
 * operator's own routines do not count toward it and have no ceiling.
 */
export const MAX_BOT_ROUTINES = 5;

/**
 * REST `/routines` CRUD and run-now.
 *
 * The row and the schedule change together, or neither does
 *
 * A routine is two things in two stores: a row in Postgres and a job
 * scheduler in Redis. No transaction spans both, so every write here
 * is ordered to make the failure that CAN happen harmless:
 *
 * - create writes the row, then schedules it, and deletes the row if the
 * schedule is refused — so "saved" always means "will fire";
 * - update writes the row, then syncs the schedule, and restores the row's
 * previous values if the sync is refused — so the panel never shows a
 * schedule Redis does not hold;
 * - delete unschedules FIRST, then deletes — so there is no window in which
 * a firing finds a row that the operator has already removed.
 *
 * What is left — a process dying between the two steps — is the drift the
 * boot reconciliation exists for.
 *
 * The schedule is checked here, not in the shared schema
 *
 * `CreateRoutineBodySchema` takes `cron` and `timezone` as plain strings, and
 * that stays: whether a zone exists is a question for this runtime's `Intl`
 * data, and what a cron means is a question for the parser the scheduler
 * uses. Both answers live in `parseRoutineSchedule`, and a refusal from it is
 * a 400 carrying its sentence.
 */
@Injectable()
export class RoutinesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ROUTINE_SCHEDULER) private readonly scheduler: RoutineScheduler,
  ) {}

  list(userId: string): Promise<Routine[]> {
    return this.prisma.routine.findMany({
      where: { bot: { userId } },
      orderBy: [{ botId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * `origin` is not in the REST body and cannot be: the REST route is the
   * operator's, so everything it creates is `OPERATOR`. Only the bot's own
   * `schedule_routine` tool passes `BOT`.
   */
  async create(
    userId: string,
    input: CreateRoutineBody,
    origin: RoutineOrigin = 'OPERATOR',
  ): Promise<Routine> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: input.botId, userId },
      select: { id: true, user: { select: { settings: { select: USER_PREFERENCES_SELECT } } } },
    });
    if (bot === null) throw new NotFoundException('Bot not found');
    if (origin === 'BOT') {
      const held = await this.prisma.routine.count({
        where: { botId: bot.id, origin: 'BOT', bot: { userId } },
      });
      if (held >= MAX_BOT_ROUTINES) {
        throw new ConflictException(
          `this bot already has ${held} routines it scheduled itself, which is the limit ` +
            `of ${MAX_BOT_ROUTINES}; cancel one before scheduling another`,
        );
      }
    }

    // A bot's `schedule_routine` usually names no zone, and "at nine" means
    // the person's nine — so their settings decide before the default does.
    const timezone =
      input.timezone ?? userPreferences(bot.user.settings).timezone ?? DEFAULT_TIMEZONE;
    const cron = checkedSchedule(input.cron, timezone).pattern;
    if (input.endsOn) checkedEndDate(input.endsOn, timezone, { notPast: true });
    const skillId = input.skillId ?? null;
    if (skillId !== null) await this.assertSkillReachable(userId, bot.id, skillId);
    if (input.goalId) await this.assertGoalOwned(userId, input.goalId);

    const routine = await this.prisma.routine.create({
      data: {
        botId: bot.id,
        name: input.name,
        cron,
        timezone,
        endsOn: input.endsOn ?? null,
        prompt: skillId === null ? (input.prompt ?? null) : null,
        skillId,
        skillParams: jsonOrNull(input.skillParams),
        enabled: input.enabled ?? true,
        origin,
        goalId: input.goalId ?? null,
      },
    });

    if (!routine.enabled) return routine;
    try {
      await this.scheduler.schedule(routine);
    } catch (error) {
      await this.prisma.routine.deleteMany({ where: { id: routine.id, bot: { userId } } });
      throw httpError(error);
    }
    return routine;
  }

  async update(userId: string, id: string, input: UpdateRoutineBody): Promise<Routine> {
    const current = await this.findOwned(userId, id);

    const merged = {
      name: input.name ?? current.name,
      cron: input.cron ?? current.cron,
      timezone: input.timezone ?? current.timezone,
      endsOn: input.endsOn === undefined ? current.endsOn : input.endsOn,
      prompt: input.prompt === undefined ? current.prompt : input.prompt,
      skillId: input.skillId === undefined ? current.skillId : input.skillId,
      enabled: input.enabled ?? current.enabled,
    };
    // The invariant is about the ROW, so it is checked on the row this
    // update would produce: switching a prompt routine to a skill has to
    // clear the prompt in the same request.
    if ((merged.prompt === null || merged.prompt === '') === (merged.skillId === null)) {
      throw new BadRequestException('exactly one of prompt or skillId must be set');
    }
    const cron = checkedSchedule(merged.cron, merged.timezone).pattern;
    // Only a date being set now has to lie ahead: an ended routine must stay
    // editable (renamed, re-enabled with a new date) without first being
    // refused for the end date it already had.
    if (merged.endsOn) {
      checkedEndDate(merged.endsOn, merged.timezone, { notPast: typeof input.endsOn === 'string' });
    }
    if (merged.skillId !== null && merged.skillId !== current.skillId) {
      await this.assertSkillReachable(userId, current.botId, merged.skillId);
    }
    if (input.goalId) await this.assertGoalOwned(userId, input.goalId);

    const updated = await this.write(userId, id, {
      name: merged.name,
      cron,
      timezone: merged.timezone,
      endsOn: merged.endsOn,
      prompt: merged.prompt,
      skillId: merged.skillId,
      ...(input.skillParams !== undefined && { skillParams: jsonOrNull(input.skillParams) }),
      ...(input.goalId !== undefined && { goalId: input.goalId }),
      enabled: merged.enabled,
    });

    try {
      if (updated.enabled) await this.scheduler.schedule(updated);
      else await this.scheduler.unschedule(updated.id);
    } catch (error) {
      await this.write(userId, id, {
        name: current.name,
        cron: current.cron,
        timezone: current.timezone,
        endsOn: current.endsOn,
        prompt: current.prompt,
        skillId: current.skillId,
        skillParams: jsonOrNull(current.skillParams),
        enabled: current.enabled,
      });
      throw httpError(error);
    }
    return updated;
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.findOwned(userId, id);
    await this.scheduler.unschedule(id);
    await this.prisma.routine.deleteMany({ where: { id, bot: { userId } } });
  }

  /**
   * Fire the routine once, now. Answers with the row as it stands; the
   * firing's outcome arrives in `lastStatus` as it would for a scheduled one.
   *
   * A disabled routine is refused rather than run. Disabling is the
   * operator's "this should not happen", and the runner honours it for every
   * firing; a run-now that bypassed it would need the runner to tell the two
   * apart, and "enable it, or edit it" is the more honest answer.
   */
  async runNow(userId: string, id: string): Promise<Routine> {
    const routine = await this.findOwned(userId, id);
    if (!routine.enabled) {
      throw new ConflictException(`routine "${routine.name}" is disabled — enable it to run it`);
    }
    if (routine.endsOn && routineEndDate(routine.endsOn, routine.timezone).getTime() < Date.now()) {
      throw new ConflictException(`routine "${routine.name}" has ended`);
    }
    try {
      await this.scheduler.runNow(routine.id);
    } catch (error) {
      throw httpError(error);
    }
    return routine;
  }

  /**
   * The routines this bot scheduled for itself — what its own
   * `cancel_routine` may touch. The operator's routines are never in it: a
   * bot may clear up after itself, not rearrange the operator's schedule.
   */
  listBotScheduled(userId: string, botId: string): Promise<Routine[]> {
    return this.prisma.routine.findMany({
      where: { botId, origin: 'BOT', bot: { userId } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  private async findOwned(userId: string, id: string): Promise<Routine> {
    const routine = await this.prisma.routine.findFirst({ where: { id, bot: { userId } } });
    if (routine === null) throw new NotFoundException('Routine not found');
    return routine;
  }

  /**
   * A routine may work toward one of the user's goals. Another user's
   * goal is not found, as every foreign id is.
   */
  private async assertGoalOwned(userId: string, goalId: string): Promise<void> {
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
      select: { id: true },
    });
    if (goal === null) throw new NotFoundException('Goal not found');
  }

  private async write(
    userId: string,
    id: string,
    data: Prisma.RoutineUncheckedUpdateManyInput,
  ): Promise<Routine> {
    await this.prisma.routine.updateMany({ where: { id, bot: { userId } }, data });
    return this.findOwned(userId, id);
  }

  /**
   * A routine may run this bot's own skills or a global one — the same reach
   * `run_skill` has. Another bot's skill is not found rather than
   * refused, so the endpoint does not answer whether a foreign id exists.
   * Approval is not checked here: a routine may be scheduled before its
   * skill is approved, and the run refuses a DRAFT with a readable FAILED.
   */
  private async assertSkillReachable(userId: string, botId: string, skillId: string) {
    const skill = await this.prisma.skill.findFirst({
      where: { id: skillId, OR: [{ botId, bot: { userId } }, { botId: null }] },
      select: { id: true },
    });
    if (skill === null) throw new NotFoundException('Skill not found for this bot');
  }
}

function checkedSchedule(cron: string, timezone: string) {
  try {
    return parseRoutineSchedule(cron, timezone);
  } catch (error) {
    if (error instanceof RoutineScheduleError) throw new BadRequestException(error.message);
    throw error;
  }
}

/**
 * A past end date is refused rather than stored: the scheduler would drop the
 * routine on the spot, so the row would read enabled and never run.
 */
function checkedEndDate(endsOn: string, timezone: string, { notPast }: { notPast: boolean }) {
  let end: Date;
  try {
    end = routineEndDate(endsOn, timezone);
  } catch (error) {
    if (error instanceof RoutineScheduleError) throw new BadRequestException(error.message);
    throw error;
  }
  if (notPast && end.getTime() < Date.now()) {
    throw new BadRequestException(
      `endsOn ${endsOn} has already passed in ${timezone}; choose today or a later date`,
    );
  }
}

/** A scheduler refusal, as the HTTP answer it deserves. */
function httpError(error: unknown): unknown {
  if (error instanceof RoutineQueueUnavailableError) {
    return new ServiceUnavailableException(error.message);
  }
  if (error instanceof RoutineScheduleError) return new BadRequestException(error.message);
  return error;
}

/** Prisma's nullable-JSON write: `null` must be spelled `Prisma.JsonNull`. */
function jsonOrNull(
  value: Prisma.InputJsonValue | Prisma.JsonValue | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined ? Prisma.JsonNull : value;
}
