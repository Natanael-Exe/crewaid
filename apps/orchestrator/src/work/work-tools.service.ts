import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { Prisma, Task, TaskStatus } from '@prisma/client';
import { TaskStatusSchema, rankBetween, type Repeat, type UpdateTaskBody } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { GoalsService } from './goals.service.js';
import { ProjectsService } from './projects.service.js';
import { OPEN_STATUSES } from './task-cards.js';
import type { WorkActor } from './task-events.js';
import { TaskSeriesService } from './task-series.service.js';
import { TasksService } from './tasks.service.js';

/** How many tasks one `task_list` answer names; more is a note, not a page. */
const LIST_LIMIT = 50;

/** How much of a task's history `task_read` shows. */
const READ_EVENTS = 10;

/** Colours a bot-made project gets, chosen by its name so a rename keeps nothing stale. */
const PROJECT_COLORS = [
  '#4F46E5',
  '#0891B2',
  '#16A34A',
  '#CA8A04',
  '#DC2626',
  '#DB2777',
  '#7C3AED',
  '#475569',
];

export type TaskListInput = {
  readonly assignee?: string | undefined;
  readonly status?: string | undefined;
  readonly projectId?: string | undefined;
  readonly goalId?: string | undefined;
  readonly seriesId?: string | undefined;
  readonly occursFrom?: string | undefined;
  readonly occursThrough?: string | undefined;
};

export type TaskCreateInput = {
  readonly title: string;
  readonly brief?: string | undefined;
  readonly projectId?: string | undefined;
  readonly goalId?: string | undefined;
  readonly parentId?: string | undefined;
  readonly assignee?: string | undefined;
  readonly after?: string | undefined;
  readonly repeat?: string | undefined;
};

export type TaskUpdateInput = {
  readonly taskId: string;
  readonly status?: string | undefined;
  readonly note?: string | undefined;
  readonly assignee?: string | null | undefined;
  readonly title?: string | undefined;
  readonly brief?: string | undefined;
  readonly projectId?: string | null | undefined;
  readonly goalId?: string | null | undefined;
  readonly repeat?: string | null | undefined;
};

/** A tool's answer when it could not do what was asked, in words the model can act on. */
export class ToolRefusal extends Error {}

/**
 * The Work tools' side of the database: plain reads and writes over
 * the calling bot's OWNER's rows, with no role attached. Any of the user's
 * bots may read or change any of the user's tasks; every write goes through
 * the same services the board uses, attributed to the bot and linked to the
 * reply it was made in.
 *
 * Answers are short text, not JSON: a tool result is re-sent on every later
 * step of the turn, and "id [STATUS] title · who" says the same in a third of
 * the tokens.
 */
@Injectable()
export class WorkToolsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(TaskSeriesService) private readonly series: TaskSeriesService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(GoalsService) private readonly goals: GoalsService,
  ) {}

  /** The acting bot, named as the activity log will name it. */
  async actor(userId: string, botId: string, messageId: string): Promise<WorkActor> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: { name: true },
    });
    return { kind: 'BOT', botId, botName: bot?.name ?? 'a bot', messageId };
  }

  async list(userId: string, botId: string, input: TaskListInput): Promise<string> {
    const where: Prisma.TaskWhereInput = {
      userId,
      status: { in: this.statuses(input.status) },
      ...(input.projectId !== undefined && { projectId: input.projectId }),
      ...(input.goalId !== undefined && { goalId: input.goalId }),
      ...(input.seriesId !== undefined && { seriesId: input.seriesId }),
      ...((input.occursFrom !== undefined || input.occursThrough !== undefined) && {
        occursOn: {
          ...(input.occursFrom !== undefined && { gte: input.occursFrom }),
          ...(input.occursThrough !== undefined && { lte: input.occursThrough }),
        },
      }),
    };
    const assignee = (input.assignee ?? 'me').trim();
    if (assignee === 'me') where.assigneeBotId = botId;
    else if (assignee === 'none') where.assigneeBotId = null;
    else if (assignee !== 'any') where.assigneeBotId = (await this.bot(userId, assignee)).id;

    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where: { ...where, userId },
        orderBy: [{ occursAt: 'asc' }, { createdAt: 'asc' }],
        take: LIST_LIMIT,
        include: { assigneeBot: { select: { name: true } } },
      }),
      this.prisma.task.count({ where: { ...where, userId } }),
    ]);
    if (rows.length === 0) return 'No tasks match.';
    const lines = rows.map((row) => this.line(row, row.assigneeBot?.name ?? null));
    if (total > rows.length) lines.push(`(${total - rows.length} more; narrow the filter)`);
    return lines.join('\n');
  }

  async read(userId: string, taskId: string): Promise<string> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId },
      include: {
        assigneeBot: { select: { name: true } },
        project: { select: { name: true } },
        goal: { select: { title: true } },
        series: { select: { cron: true, timezone: true, enabled: true } },
        subtasks: {
          orderBy: { rank: 'asc' },
          include: { assigneeBot: { select: { name: true } } },
        },
        events: { orderBy: { createdAt: 'desc' }, take: READ_EVENTS },
        deliverables: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (task === null) throw new ToolRefusal(`There is no task ${JSON.stringify(taskId)}.`);
    const where = [
      task.project === null ? null : `project ${task.project.name} (${task.projectId})`,
      task.goal === null ? null : `goal ${task.goal.title} (${task.goalId})`,
      task.dueOn === null ? null : `due ${task.dueOn}`,
      task.series === null
        ? null
        : `repeats ${task.series.cron} ${task.series.timezone}${task.series.enabled ? '' : ' (stopped)'}`,
    ].filter((part): part is string => part !== null);
    const out = [this.line(task, task.assigneeBot?.name ?? null)];
    if (where.length > 0) out.push(where.join(' · '));
    if (task.blockedReason !== null) out.push(`Blocked: ${task.blockedReason}`);
    out.push('', task.brief?.trim() || '(no brief)');
    if (task.subtasks.length > 0) {
      out.push(
        '',
        'Subtasks:',
        ...task.subtasks.map((sub) => this.line(sub, sub.assigneeBot?.name ?? null)),
      );
    }
    if (task.deliverables.length > 0) {
      out.push(
        '',
        'Deliverables:',
        ...task.deliverables.map(
          (item) =>
            `${item.title} (${item.kind}${item.sourcePath ? `, ${item.sourcePath}` : item.url ? `, ${item.url}` : ''})`,
        ),
      );
    }
    if (task.events.length > 0) {
      out.push(
        '',
        'Recent activity:',
        ...task.events.map(
          (event) =>
            `${event.createdAt.toISOString().slice(0, 16)} ${event.actorLabel} ${event.type} ${JSON.stringify(event.payload)}`,
        ),
      );
    }
    return out.join('\n');
  }

  async create(userId: string, actor: WorkActor, input: TaskCreateInput): Promise<string> {
    const assignee =
      input.assignee === undefined ? null : await this.assigneeOf(userId, actor, input.assignee);
    const rank = input.after === undefined ? undefined : await this.rankAfter(userId, input.after);
    const made = await this.tasks.create(userId, actor, {
      title: input.title,
      ...(input.brief !== undefined && { brief: input.brief }),
      ...(input.projectId !== undefined && { projectId: input.projectId }),
      ...(input.goalId !== undefined && { goalId: input.goalId }),
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      ...(assignee !== null && { assigneeBotId: assignee }),
      ...(rank !== undefined && { rank }),
      ...(input.repeat !== undefined && { repeat: parseRepeat(input.repeat) }),
    });
    if (made.series !== null && made.task === null) {
      return `Created recurring task ${made.series.id} "${made.series.title}" (${made.series.cron} ${made.series.timezone}). Its first occurrence appears when the schedule comes round.`;
    }
    if (made.task === null) throw new ToolRefusal('Nothing was created.');
    return `Created ${this.line(made.task, null)} in To do. Nothing was started.`;
  }

  async update(userId: string, actor: WorkActor, input: TaskUpdateInput): Promise<string> {
    const task = await this.prisma.task.findFirst({ where: { id: input.taskId, userId } });
    if (task === null) throw new ToolRefusal(`There is no task ${JSON.stringify(input.taskId)}.`);

    const body: { -readonly [K in keyof UpdateTaskBody]: UpdateTaskBody[K] } = {};
    if (input.status !== undefined) body.status = this.status(input.status);
    // The note on a move to BLOCKED is also the reason the card shows: one
    // field on the definition instead of two (PRD-WORK the budget), and a
    // blocked task's reason is exactly what that note says.
    if (body.status === 'BLOCKED' && input.note !== undefined && input.note.trim() !== '') {
      body.blockedReason = input.note.trim();
    }
    if (input.title !== undefined) body.title = input.title;
    if (input.brief !== undefined) body.brief = input.brief;
    if (input.projectId !== undefined) body.projectId = input.projectId;
    if (input.goalId !== undefined) body.goalId = input.goalId;
    if (input.assignee !== undefined) {
      body.assigneeBotId =
        input.assignee === null ? null : await this.assigneeOf(userId, actor, input.assignee);
    }

    const done: string[] = [];
    if (Object.keys(body).length > 0) {
      const card = await this.tasks.update(userId, actor, task.id, body);
      done.push(`Updated ${this.line(card, null)}.`);
    }
    if (input.note !== undefined && input.note.trim() !== '') {
      await this.tasks.addNote(userId, actor, task.id, input.note.trim());
      done.push('Note added.');
    }
    if (input.repeat !== undefined) {
      if (task.seriesId === null)
        throw new ToolRefusal('This task does not repeat; create a recurring task instead.');
      const repeat = input.repeat === null ? null : parseRepeat(input.repeat);
      await this.series.update(
        userId,
        task.seriesId,
        repeat === null
          ? { enabled: false }
          : {
              cron: repeat.cron,
              timezone: repeat.timezone,
              endsOn: repeat.endsOn ?? null,
              enabled: true,
            },
      );
      done.push(input.repeat === null ? 'It will not repeat again.' : 'Its schedule changed.');
    }
    return done.length > 0 ? done.join(' ') : 'Nothing to change.';
  }

  async createProject(
    userId: string,
    input: {
      readonly name: string;
      readonly description?: string | undefined;
      readonly goal?: string | undefined;
    },
  ): Promise<string> {
    const color = PROJECT_COLORS[hash(input.name) % PROJECT_COLORS.length] ?? '#4F46E5';
    const project = await this.projects.create(userId, {
      name: input.name,
      color,
      ...(input.description !== undefined && { description: input.description }),
    });
    if (input.goal === undefined || input.goal.trim() === '') {
      return `Created project ${project.id} "${project.name}".`;
    }
    const goal = await this.goals.create(userId, {
      title: input.goal.trim(),
      projectId: project.id,
    });
    return `Created project ${project.id} "${project.name}" with goal ${goal.id} "${goal.title}".`;
  }

  /** One task on one line: the id first, because every other tool takes it. */
  private line(
    task: Pick<Task, 'id' | 'status' | 'title' | 'dueOn' | 'occursOn'>,
    assignee: string | null,
  ): string {
    return [
      `${task.id} [${task.status}] ${task.title}`,
      assignee === null ? null : `@${assignee}`,
      task.dueOn === null ? null : `due ${task.dueOn}`,
      task.occursOn === null ? null : `on ${task.occursOn}`,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ');
  }

  private statuses(status: string | undefined): TaskStatus[] {
    const wanted = (status ?? 'open').trim();
    if (wanted === 'open') return [...OPEN_STATUSES];
    if (wanted === 'any') return [...TaskStatusSchema.options];
    return [this.status(wanted)];
  }

  private status(value: string): TaskStatus {
    const parsed = TaskStatusSchema.safeParse(value.trim().toUpperCase());
    if (!parsed.success) {
      throw new ToolRefusal(
        `Unknown status ${JSON.stringify(value)}. Use one of ${TaskStatusSchema.options.join(', ')}.`,
      );
    }
    return parsed.data;
  }

  /** "me", or one of the user's bots by name or id. */
  private async assigneeOf(userId: string, actor: WorkActor, wanted: string): Promise<string> {
    if (wanted.trim() === 'me' && actor.kind === 'BOT') return actor.botId;
    return (await this.bot(userId, wanted)).id;
  }

  private async bot(userId: string, wanted: string): Promise<{ id: string; name: string }> {
    const key = wanted.trim().replace(/^@+/, '').toLowerCase();
    const bots = await this.prisma.bot.findMany({
      where: { userId },
      select: { id: true, name: true },
    });
    const match = bots.filter((bot) => bot.id === wanted.trim() || bot.name.toLowerCase() === key);
    if (match.length === 1 && match[0] !== undefined) return match[0];
    throw new ToolRefusal(
      match.length > 1
        ? `More than one bot is called ${JSON.stringify(wanted)}; use its id.`
        : `There is no bot called ${JSON.stringify(wanted)}. Bots: ${bots.map((bot) => bot.name).join(', ')}.`,
    );
  }

  /** A rank just below `after` in its column, for "put it after that one". */
  private async rankAfter(userId: string, after: string): Promise<string> {
    const anchor = await this.prisma.task.findFirst({
      where: { id: after, userId },
      select: { rank: true, status: true, parentId: true },
    });
    if (anchor === null)
      throw new ToolRefusal(`There is no task ${JSON.stringify(after)} to place it after.`);
    const next = await this.prisma.task.findFirst({
      where: {
        userId,
        status: anchor.status,
        parentId: anchor.parentId,
        rank: { gt: anchor.rank },
      },
      orderBy: { rank: 'asc' },
      select: { rank: true },
    });
    return rankBetween(anchor.rank, next?.rank ?? null);
  }
}

/** A tool's failure as the one sentence the model reads. */
export function refusalText(error: unknown): string {
  if (error instanceof ToolRefusal) return error.message;
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null && 'message' in response) {
      const { message } = response;
      if (typeof message === 'string') return message;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * A tool's `repeat`: `<5-field cron> <IANA zone> [until YYYY-MM-DD]`, for
 * example `0 7 * * 1,3,5 America/New_York`. One string rather than an object
 * because the definition is re-sent on every step (PRD-WORK §8), and a nested
 * schema cost more than the rest of task_update together. The fields are then
 * validated exactly as a routine's are.
 */
export function parseRepeat(text: string): Repeat {
  const parts = text.trim().split(/\s+/);
  const until = parts.length >= 8 && parts[parts.length - 2] === 'until' ? parts.pop() : undefined;
  if (until !== undefined) parts.pop();
  if (parts.length !== 6) {
    throw new ToolRefusal(
      `repeat must be "<minute hour day month weekday> <timezone>", e.g. "0 7 * * 1,3,5 America/New_York"; got ${JSON.stringify(text)}.`,
    );
  }
  const timezone = parts.pop() ?? '';
  return { cron: parts.join(' '), timezone, ...(until !== undefined && { endsOn: until }) };
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}
