import { z } from 'zod';

import {
  CronSchema,
  CuidSchema,
  DateTimeSchema,
  HexColorSchema,
  TimezoneSchema,
} from './primitives.js';
import { MessageAuthorSchema, RunStatusSchema } from './enums.js';
import { AttachmentSchema } from './models.js';

/**
 * Work (D-132 … D-140, `docs/PRD-WORK.md`): projects, goals, tasks, recurring
 * series, the activity log, deliverables and search.
 *
 * Everything here is a RECORD the user and their bots read and write. Nothing
 * in these shapes triggers work, which is why none of them carries a botId the
 * gateway could route on: the four `*.changed` frames go to the client only.
 */

// Enums

export const ProjectStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const GoalStatusSchema = z.enum(['ACTIVE', 'ACHIEVED', 'ABANDONED']);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

/**
 * WORK §3.2. Anyone can set any of these; the statuses mean what
 * the user's prompts make them mean, and the app only records who set them.
 */
export const TaskStatusSchema = z.enum([
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Every status but CANCELLED, which the board hides. */
export const OPEN_BOARD_STATUSES: readonly TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'IN_REVIEW',
  'DONE',
];

/** Who created a task or series. Mirrors `Routine.origin`. */
export const TaskOriginSchema = z.enum(['OPERATOR', 'BOT']);
export type TaskOrigin = z.infer<typeof TaskOriginSchema>;

export const TaskActorSchema = z.enum(['USER', 'BOT']);
export type TaskActor = z.infer<typeof TaskActorSchema>;

export const TaskEventTypeSchema = z.enum([
  'CREATED',
  'EDITED',
  'ASSIGNED',
  'UNASSIGNED',
  'STARTED',
  'STATUS_CHANGED',
  'NOTE',
  'DELIVERABLE_LINKED',
]);
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;

export const DeliverableKindSchema = z.enum(['FILE', 'LINK', 'MESSAGE']);
export type DeliverableKind = z.infer<typeof DeliverableKindSchema>;

export const DeliverableReviewStateSchema = z.enum(['READY', 'REVIEWED', 'ARCHIVED']);
export type DeliverableReviewState = z.infer<typeof DeliverableReviewStateSchema>;

// Primitives

/** A calendar date, the same shape as `Routine.endsOn`. */
export const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/**
 * `Task.rank`: a lexicographic position within a column.
 *
 * Lowercase base-36 only. Postgres compares text under the database's
 * collation, and for digits and lowercase letters every common collation
 * agrees with plain code-unit order — so a rank sorts the same in SQL, in
 * JavaScript, and on either side of a collation change.
 */
export const RankSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9a-z]*[1-9a-z]$/, 'must be base-36 without a trailing 0');

const RANK_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

function rankMidpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Shared prefix first: the midpoint of "ab" and "ad" is "a" + mid("b","d").
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + rankMidpoint(a.slice(n), b.slice(n));
  }
  const low = a === '' ? 0 : RANK_DIGITS.indexOf(a.charAt(0));
  const high = b === null ? RANK_DIGITS.length : RANK_DIGITS.indexOf(b.charAt(0));
  if (high - low > 1) return RANK_DIGITS.charAt(Math.round((low + high) / 2));
  // Adjacent digits: take b's first digit when b continues past it, otherwise
  // keep a's digit and find room one place further right.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return RANK_DIGITS.charAt(low) + rankMidpoint(a.slice(1), null);
}

/**
 * A rank strictly between `before` and `after`; null means the open end.
 *
 * The board and the service both place cards with this, so a drag is one row
 * write and neither side can compute a different order from the other.
 */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) {
    throw new RangeError(`rankBetween: "${before}" is not before "${after}"`);
  }
  return rankMidpoint(before ?? '', after);
}

/** `a` before `b` in rank order — code-unit comparison, never a locale one. */
export function compareRank(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Models

export const ProjectSchema = z.object({
  id: CuidSchema,
  userId: CuidSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  color: HexColorSchema,
  status: ProjectStatusSchema,
  sortOrder: z.number().int(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

/** `GET /projects` rows: the project plus what it holds. */
export const ProjectWithCountsSchema = ProjectSchema.extend({
  /** Top-level tasks not DONE or CANCELLED. */
  openTaskCount: z.number().int().nonnegative(),
  goalCount: z.number().int().nonnegative(),
});
export type ProjectWithCounts = z.infer<typeof ProjectWithCountsSchema>;

export const GoalSchema = z.object({
  id: CuidSchema,
  userId: CuidSchema,
  /** Optional: a personal goal stands alone. */
  projectId: CuidSchema.nullable(),
  title: z.string().min(1),
  outcome: z.string().nullable(),
  targetOn: CalendarDateSchema.nullable(),
  status: GoalStatusSchema,
  closedAt: DateTimeSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type Goal = z.infer<typeof GoalSchema>;

export const TaskSchema = z.object({
  id: CuidSchema,
  userId: CuidSchema,
  /** Null is Inbox. */
  projectId: CuidSchema.nullable(),
  goalId: CuidSchema.nullable(),
  /** One level: a parent's own parentId is always null. */
  parentId: CuidSchema.nullable(),
  title: z.string().min(1),
  brief: z.string().nullable(),
  status: TaskStatusSchema,
  blockedReason: z.string().nullable(),
  /** Null is the user's own. */
  assigneeBotId: CuidSchema.nullable(),
  origin: TaskOriginSchema,
  seriesId: CuidSchema.nullable(),
  /** The scheduled instant this occurrence was created for. */
  occursAt: DateTimeSchema.nullable(),
  /** That instant's calendar date in the series' timezone. */
  occursOn: CalendarDateSchema.nullable(),
  createdByBotId: CuidSchema.nullable(),
  dueOn: CalendarDateSchema.nullable(),
  rank: RankSchema,
  startedAt: DateTimeSchema.nullable(),
  completedAt: DateTimeSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type Task = z.infer<typeof TaskSchema>;

/** Done out of a set, the shape of every Work fraction (`3/5`, `11/12`). */
export const DoneCountSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type DoneCount = z.infer<typeof DoneCountSchema>;

/**
 * What a recurring task's newest occurrence says about its series on the
 * board: "4 of last 5", and how many older ones are still open.
 */
export const SeriesSummarySchema = z.object({
  /** Done among the last five occurrences, cancelled ones excluded. */
  recent: DoneCountSchema,
  /** Occurrences older than this one that are not DONE or CANCELLED. */
  olderOpenCount: z.number().int().nonnegative(),
  /** True on the series' newest occurrence, the one the board shows. */
  newest: z.boolean(),
});
export type SeriesSummary = z.infer<typeof SeriesSummarySchema>;

/** A board or list row. Counts are the server's; the card only draws them. */
export const TaskCardSchema = TaskSchema.extend({
  subtasks: DoneCountSchema,
  deliverableCount: z.number().int().nonnegative(),
  /** Set on an occurrence of a series, null on a one-off task. */
  series: SeriesSummarySchema.nullable(),
});
export type TaskCard = z.infer<typeof TaskCardSchema>;

export const TaskSeriesSchema = z.object({
  id: CuidSchema,
  userId: CuidSchema,
  title: z.string().min(1),
  brief: z.string().nullable(),
  assigneeBotId: CuidSchema.nullable(),
  projectId: CuidSchema.nullable(),
  goalId: CuidSchema.nullable(),
  cron: CronSchema,
  timezone: TimezoneSchema,
  endsOn: CalendarDateSchema.nullable(),
  enabled: z.boolean(),
  lastFiredAt: DateTimeSchema.nullable(),
  origin: TaskOriginSchema,
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type TaskSeries = z.infer<typeof TaskSeriesSchema>;

// The activity log

/** A bot named as it was when the event happened, so history outlives it. */
const NamedBotSchema = z.object({ botId: CuidSchema, botName: z.string() });

/**
 * One payload shape per event type. `TaskEvent.payload` is a Json column, and
 * this map is the one place that decides what a legal payload is — the service
 * builds events through it and the wire parses them through it.
 */
export const TaskEventPayloadSchemas = {
  CREATED: z.object({}),
  /** The fields that changed, by their §3 names. */
  EDITED: z.object({ fields: z.array(z.string().min(1)).min(1) }),
  ASSIGNED: NamedBotSchema,
  /** `reason` says the bot was deleted rather than reassigned by someone. */
  UNASSIGNED: NamedBotSchema.extend({ reason: z.enum(['BOT_DELETED']).optional() }),
  STARTED: z.object({}),
  STATUS_CHANGED: z.object({
    from: TaskStatusSchema,
    to: TaskStatusSchema,
    blockedReason: z.string().optional(),
  }),
  NOTE: z.object({ text: z.string().min(1) }),
  DELIVERABLE_LINKED: z.object({ deliverableId: CuidSchema, title: z.string() }),
} as const satisfies Record<TaskEventType, z.ZodType>;

const taskEventBase = {
  id: CuidSchema,
  taskId: CuidSchema,
  userId: CuidSchema,
  actor: TaskActorSchema,
  /** Null for the user, and for a bot deleted since. */
  actorBotId: CuidSchema.nullable(),
  /** The actor's name at the time. */
  actorLabel: z.string(),
  startKey: z.string().nullable(),
  /** The bot's reply for a tool edit, the brief for STARTED; null for board edits. */
  messageId: CuidSchema.nullable(),
  createdAt: DateTimeSchema,
};

export const TaskEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...taskEventBase,
    type: z.literal('CREATED'),
    payload: TaskEventPayloadSchemas.CREATED,
  }),
  z.object({
    ...taskEventBase,
    type: z.literal('EDITED'),
    payload: TaskEventPayloadSchemas.EDITED,
  }),
  z.object({
    ...taskEventBase,
    type: z.literal('ASSIGNED'),
    payload: TaskEventPayloadSchemas.ASSIGNED,
  }),
  z.object({
    ...taskEventBase,
    type: z.literal('UNASSIGNED'),
    payload: TaskEventPayloadSchemas.UNASSIGNED,
  }),
  z.object({
    ...taskEventBase,
    type: z.literal('STARTED'),
    payload: TaskEventPayloadSchemas.STARTED,
  }),
  z.object({
    ...taskEventBase,
    type: z.literal('STATUS_CHANGED'),
    payload: TaskEventPayloadSchemas.STATUS_CHANGED,
  }),
  z.object({ ...taskEventBase, type: z.literal('NOTE'), payload: TaskEventPayloadSchemas.NOTE }),
  z.object({
    ...taskEventBase,
    type: z.literal('DELIVERABLE_LINKED'),
    payload: TaskEventPayloadSchemas.DELIVERABLE_LINKED,
  }),
]);
export type TaskEvent = z.infer<typeof TaskEventSchema>;

// Deliverables

export const DeliverableSchema = z.object({
  id: CuidSchema,
  userId: CuidSchema,
  kind: DeliverableKindSchema,
  title: z.string().min(1),
  summary: z.string().nullable(),
  /** The producing bot. Null only for a LINK the user recorded. */
  botId: CuidSchema.nullable(),
  attachmentId: CuidSchema.nullable(),
  messageId: CuidSchema.nullable(),
  url: z.string().nullable(),
  /** Where in the workspace the file was attached from, for `fs_read`. */
  sourcePath: z.string().nullable(),
  taskId: CuidSchema.nullable(),
  goalId: CuidSchema.nullable(),
  /** Denormalised from the task or goal. */
  projectId: CuidSchema.nullable(),
  reviewState: DeliverableReviewStateSchema.default('READY'),
  supersededById: CuidSchema.nullable().default(null),
  createdAt: DateTimeSchema,
});
export type Deliverable = z.infer<typeof DeliverableSchema>;

const TitledRefSchema = z.object({ id: CuidSchema, title: z.string() });

/**
 * A deliverable as the views show it: with the file it points at, and the
 * titles of what it is filed under, so a chip needs no second request.
 */
export const DeliverableViewSchema = DeliverableSchema.extend({
  /**
   * `messageId` is null once the message the file came with was deleted: the
   * deliverable holds the file from then on, so it still downloads
   * but there is no conversation to open it in.
   */
  attachment: AttachmentSchema.extend({ messageId: CuidSchema.nullable() }).nullable(),
  task: TitledRefSchema.nullable(),
  goal: TitledRefSchema.nullable(),
  publisherName: z.string().nullable().optional(),
  revisionNumber: z.number().int().positive().optional(),
});
export type DeliverableView = z.infer<typeof DeliverableViewSchema>;

// Derivations
// The service computes these for every response; the renderer calls the same
// functions only to redraw between a `task.changed` and the refetch it causes.

type ProgressTask = Pick<Task, 'status' | 'parentId' | 'seriesId'>;

/**
 * A goal's progress: done ÷ (all − cancelled) over its ONE-OFF, TOP-LEVEL
 * tasks. Subtasks are their parent's business, and a recurring task's
 * occurrences are counted by done rate instead, or one missed workout would
 * move the MVP's progress bar.
 */
export function goalProgress(tasks: readonly ProgressTask[]): DoneCount {
  let done = 0;
  let total = 0;
  for (const task of tasks) {
    if (task.parentId !== null || task.seriesId !== null || task.status === 'CANCELLED') continue;
    total += 1;
    if (task.status === 'DONE') done += 1;
  }
  return { done, total };
}

/** A parent's `3/5`: its subtasks, cancelled ones left out. */
export function subtaskProgress(subtasks: readonly Pick<Task, 'status'>[]): DoneCount {
  let done = 0;
  let total = 0;
  for (const task of subtasks) {
    if (task.status === 'CANCELLED') continue;
    total += 1;
    if (task.status === 'DONE') done += 1;
  }
  return { done, total };
}

/**
 * How often a series was done: done occurrences ÷ occurrences so far, from
 * `since` (when the goal started) up to `now`. A missed occurrence counts
 * against it — that is what "missed" means — and a cancelled one does not
 * count at all, because the user said it would not happen.
 */
export function seriesDoneRate(
  occurrences: readonly Pick<Task, 'status' | 'occursAt'>[],
  since: Date,
  now: Date,
): DoneCount {
  let done = 0;
  let total = 0;
  for (const task of occurrences) {
    if (task.occursAt === null || task.status === 'CANCELLED') continue;
    if (task.occursAt < since || task.occursAt > now) continue;
    total += 1;
    if (task.status === 'DONE') done += 1;
  }
  return { done, total };
}

/** A goal's recurring task and its done rate ("Work out 11/12"). */
export const SeriesRateSchema = z.object({
  seriesId: CuidSchema,
  title: z.string(),
  enabled: z.boolean(),
  rate: DoneCountSchema,
});
export type SeriesRate = z.infer<typeof SeriesRateSchema>;

/** `GET /goals` rows. */
export const GoalWithProgressSchema = GoalSchema.extend({
  progress: DoneCountSchema,
  series: z.array(SeriesRateSchema),
  routineCount: z.number().int().nonnegative(),
});
export type GoalWithProgress = z.infer<typeof GoalWithProgressSchema>;

// REST bodies and responses

const TitleSchema = z.string().trim().min(1).max(200);
const LongTextSchema = z.string().max(20_000);

/** Query booleans arrive as strings; only the two literal spellings count. */
const QueryBooleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

/** A comma-separated list of statuses in a query string. */
const StatusListQuerySchema = z
  .string()
  .transform((value) => value.split(',').filter((part) => part !== ''))
  .pipe(z.array(TaskStatusSchema).min(1));

export const ListProjectsQuerySchema = z.object({
  status: ProjectStatusSchema.optional(),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;

export const ListProjectsResponseSchema = z.array(ProjectWithCountsSchema);
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

export const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: LongTextSchema.nullish(),
  color: HexColorSchema,
});
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

export const UpdateProjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: LongTextSchema.nullable(),
    color: HexColorSchema,
    status: ProjectStatusSchema,
    sortOrder: z.number().int(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be provided');
export type UpdateProjectBody = z.infer<typeof UpdateProjectBodySchema>;

export const ProjectResponseSchema = ProjectWithCountsSchema;

/** The schedule of a recurring task, validated exactly as a routine's. */
export const RepeatSchema = z.object({
  cron: CronSchema,
  timezone: TimezoneSchema,
  endsOn: CalendarDateSchema.nullish(),
});
export type Repeat = z.infer<typeof RepeatSchema>;

export const ListTasksQuerySchema = z.object({
  projectId: CuidSchema.optional(),
  /** Only tasks in no project. */
  inbox: QueryBooleanSchema.optional(),
  goalId: CuidSchema.optional(),
  assigneeBotId: CuidSchema.optional(),
  /** Comma-separated. Absent means every status but CANCELLED. */
  status: StatusListQuerySchema.optional(),
  /** Subtasks of this task. Without it only top-level tasks are listed. */
  parentId: CuidSchema.optional(),
  seriesId: CuidSchema.optional(),
  /** Inclusive calendar-date bounds on `occursOn`. */
  occursFrom: CalendarDateSchema.optional(),
  occursThrough: CalendarDateSchema.optional(),
  /** DONE tasks completed before this instant are left out (the board's 14 days). */
  doneSince: DateTimeSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

export const ListTasksResponseSchema = z.array(TaskCardSchema);
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

export const CreateTaskBodySchema = z.object({
  title: TitleSchema,
  brief: LongTextSchema.nullish(),
  projectId: CuidSchema.nullish(),
  goalId: CuidSchema.nullish(),
  parentId: CuidSchema.nullish(),
  assigneeBotId: CuidSchema.nullish(),
  dueOn: CalendarDateSchema.nullish(),
  /** Where in *To do* it goes. Absent puts it at the top. */
  rank: RankSchema.optional(),
  /** Makes it a recurring task: a series, and its first occurrence when due. */
  repeat: RepeatSchema.optional(),
});
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;

export const UpdateTaskBodySchema = z
  .object({
    title: TitleSchema,
    brief: LongTextSchema.nullable(),
    status: TaskStatusSchema,
    blockedReason: LongTextSchema.nullable(),
    assigneeBotId: CuidSchema.nullable(),
    projectId: CuidSchema.nullable(),
    goalId: CuidSchema.nullable(),
    dueOn: CalendarDateSchema.nullable(),
    rank: RankSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be provided');
export type UpdateTaskBody = z.infer<typeof UpdateTaskBodySchema>;

/** `POST /tasks` answers the task; with `repeat`, its series too. */
export const CreateTaskResponseSchema = z.object({
  /** Null when a recurring task's first firing is still in the future. */
  task: TaskCardSchema.nullable(),
  series: TaskSeriesSchema.nullable(),
});
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>;

export const TaskResponseSchema = TaskCardSchema;

/**
 * What a task or goal has cost: the summed tokens of the turns
 * its messages started — a Start brief, a delegated message about the task, a
 * routine run linked to the goal. Defaults to nothing so a newer app reading
 * an older orchestrator shows no cost rather than failing the contract.
 */
export const WorkUsageSchema = z.object({
  turns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type WorkUsage = z.infer<typeof WorkUsageSchema>;
const NO_USAGE: WorkUsage = { turns: 0, inputTokens: 0, outputTokens: 0 };

/** `GET /tasks/:id`: everything the details rail shows, in one read. */
export const TaskDetailResponseSchema = TaskCardSchema.extend({
  subtaskRows: z.array(TaskCardSchema),
  /** Newest first, at most 100. */
  events: z.array(TaskEventSchema),
  deliverables: z.array(DeliverableViewSchema),
  seriesRow: TaskSeriesSchema.nullable(),
  /**
   * The assignee's most recent message linked to this task — the brief or a
   * delegated instruction — for "Open conversation". Null opens the transcript
   * at its end.
   */
  lastLinkedMessageId: CuidSchema.nullable(),
  /** The task's and its subtasks' turns. */
  usage: WorkUsageSchema.default(NO_USAGE),
});
export type TaskDetailResponse = z.infer<typeof TaskDetailResponseSchema>;

export const AddTaskNoteBodySchema = z.object({
  text: z.string().trim().min(1).max(4_000),
});
export type AddTaskNoteBody = z.infer<typeof AddTaskNoteBodySchema>;

/** `POST /tasks/:id/start` → 202. */
export const StartTaskResponseSchema = z.object({ messageId: CuidSchema });
export type StartTaskResponse = z.infer<typeof StartTaskResponseSchema>;

/** The `Idempotency-Key` header Start requires. */
export const IdempotencyKeySchema = z.uuid();

/**
 * The closing paragraph of a Start brief: which task the message is,
 * and that the bot reports back on it. Without it a bot did the work, replied,
 * and left the task In progress, because nothing in the message said it was a
 * tracked task or which one. It is part of the message, never of the bot's
 * instructions, and the renderer's card leaves it out: it is addressed to the
 * bot, not to the user reading the transcript.
 */
export const START_BRIEF_CLOSING_PREFIX = 'Task id: ';

export function startBriefClosing(taskId: string): string {
  return (
    `${START_BRIEF_CLOSING_PREFIX}${taskId}. When you finish, use task_update to move it to ` +
    'Review, or to Done if there is nothing for the user to check, with a one-line note. ' +
    'If you cannot finish, move it to Blocked and say what you need.'
  );
}

export const UpdateTaskSeriesBodySchema = z
  .object({
    title: TitleSchema,
    brief: LongTextSchema.nullable(),
    assigneeBotId: CuidSchema.nullable(),
    projectId: CuidSchema.nullable(),
    goalId: CuidSchema.nullable(),
    cron: CronSchema,
    timezone: TimezoneSchema,
    endsOn: CalendarDateSchema.nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be provided');
export type UpdateTaskSeriesBody = z.infer<typeof UpdateTaskSeriesBodySchema>;

/** `GET /task-series/:id`: the series and its recent occurrences, newest first. */
export const TaskSeriesDetailResponseSchema = TaskSeriesSchema.extend({
  occurrences: z.array(TaskCardSchema),
});
export type TaskSeriesDetailResponse = z.infer<typeof TaskSeriesDetailResponseSchema>;

export const ListGoalsQuerySchema = z.object({
  status: GoalStatusSchema.optional(),
  projectId: CuidSchema.optional(),
});
export type ListGoalsQuery = z.infer<typeof ListGoalsQuerySchema>;

export const ListGoalsResponseSchema = z.array(GoalWithProgressSchema);
export type ListGoalsResponse = z.infer<typeof ListGoalsResponseSchema>;

export const CreateGoalBodySchema = z.object({
  title: TitleSchema,
  outcome: LongTextSchema.nullish(),
  targetOn: CalendarDateSchema.nullish(),
  projectId: CuidSchema.nullish(),
});
export type CreateGoalBody = z.infer<typeof CreateGoalBodySchema>;

export const UpdateGoalBodySchema = z
  .object({
    title: TitleSchema,
    outcome: LongTextSchema.nullable(),
    targetOn: CalendarDateSchema.nullable(),
    projectId: CuidSchema.nullable(),
    status: GoalStatusSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be provided');
export type UpdateGoalBody = z.infer<typeof UpdateGoalBodySchema>;

export const GoalResponseSchema = GoalWithProgressSchema;

/** A routine as a goal lists it: enough for its schedule and last result. */
export const GoalRoutineSchema = z.object({
  id: CuidSchema,
  botId: CuidSchema,
  name: z.string(),
  cron: CronSchema,
  timezone: TimezoneSchema,
  enabled: z.boolean(),
  lastRunAt: DateTimeSchema.nullable(),
  lastStatus: RunStatusSchema.nullable(),
});
export type GoalRoutine = z.infer<typeof GoalRoutineSchema>;

/** `GET /goals/:id`. */
export const GoalDetailResponseSchema = GoalWithProgressSchema.extend({
  tasks: z.array(TaskCardSchema),
  routines: z.array(GoalRoutineSchema),
  /** Newest 50. */
  deliverables: z.array(DeliverableViewSchema),
  /** The turns of every task on the goal, and of its routines' runs. */
  usage: WorkUsageSchema.default(NO_USAGE),
});
export type GoalDetailResponse = z.infer<typeof GoalDetailResponseSchema>;

export const ListDeliverablesQuerySchema = z.object({
  projectId: CuidSchema.optional(),
  goalId: CuidSchema.optional(),
  taskId: CuidSchema.optional(),
  botId: CuidSchema.optional(),
  /** The deliverable a file attachment was filed as — whichever bot published it. */
  attachmentId: CuidSchema.optional(),
  kind: DeliverableKindSchema.optional(),
  /** Only deliverables filed under nothing. */
  unfiled: QueryBooleanSchema.optional(),
  /** Words in the title or summary, any case. */
  q: z.string().trim().min(1).max(200).optional(),
  /** Cursor: the last id of the previous page. */
  before: CuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListDeliverablesQuery = z.infer<typeof ListDeliverablesQuerySchema>;

export const ListDeliverablesResponseSchema = z.object({
  items: z.array(DeliverableViewSchema),
  nextCursor: CuidSchema.nullable(),
  /**
   * How many match the filter across every page — what a bot's delete
   * confirmation states ("its 14 deliverables will be deleted"). Defaulted
   * for a server that predates it.
   */
  total: z.number().int().nonnegative().default(0),
});
export type ListDeliverablesResponse = z.infer<typeof ListDeliverablesResponseSchema>;

/** `POST /deliverables`: what a user records by hand. A FILE is never posted. */
export const CreateDeliverableBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('LINK'),
    url: z.url({ protocol: /^https?$/ }),
    title: TitleSchema,
    summary: LongTextSchema.nullish(),
    taskId: CuidSchema.nullish(),
    goalId: CuidSchema.nullish(),
  }),
  z.object({
    kind: z.literal('MESSAGE'),
    messageId: CuidSchema,
    title: TitleSchema,
    summary: LongTextSchema.nullish(),
    taskId: CuidSchema.nullish(),
    goalId: CuidSchema.nullish(),
  }),
]);
export type CreateDeliverableBody = z.infer<typeof CreateDeliverableBodySchema>;

/**
 * `PATCH /deliverables/:id`. Filing is by task, goal or project; the server
 * derives the rest (a task implies its goal and project), so a body that names
 * a task and a different project is refused rather than half-applied.
 */
export const UpdateDeliverableBodySchema = z
  .object({
    title: TitleSchema,
    summary: LongTextSchema.nullable(),
    taskId: CuidSchema.nullable(),
    goalId: CuidSchema.nullable(),
    projectId: CuidSchema.nullable(),
    reviewState: DeliverableReviewStateSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be provided');
export type UpdateDeliverableBody = z.infer<typeof UpdateDeliverableBodySchema>;

export const DeliverableResponseSchema = DeliverableViewSchema;

// Search

export const SearchTypeSchema = z.enum(['task', 'goal', 'project', 'deliverable', 'message']);
export type SearchType = z.infer<typeof SearchTypeSchema>;

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  /** Comma-separated; absent searches every type. */
  types: z
    .string()
    .transform((value) => value.split(',').filter((part) => part !== ''))
    .pipe(z.array(SearchTypeSchema).min(1))
    .optional(),
  botId: CuidSchema.optional(),
  projectId: CuidSchema.optional(),
  /** Hits per group. */
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/**
 * A `ts_headline` excerpt: at most two fragments, matches wrapped in `<<` and
 * `>>` exactly as the transcript search writes them. Plain text otherwise
 * — the renderer splits on the markers and never parses it as HTML.
 */
const ExcerptSchema = z.string().nullable();

export const SearchResponseSchema = z.object({
  tasks: z.array(
    z.object({
      id: CuidSchema,
      title: z.string(),
      status: TaskStatusSchema,
      assigneeBotId: CuidSchema.nullable(),
      projectId: CuidSchema.nullable(),
      excerpt: ExcerptSchema,
    }),
  ),
  goals: z.array(
    z.object({
      id: CuidSchema,
      title: z.string(),
      status: GoalStatusSchema,
      projectId: CuidSchema.nullable(),
      excerpt: ExcerptSchema,
    }),
  ),
  projects: z.array(
    z.object({
      id: CuidSchema,
      name: z.string(),
      color: HexColorSchema,
      status: ProjectStatusSchema,
    }),
  ),
  deliverables: z.array(
    z.object({
      id: CuidSchema,
      kind: DeliverableKindSchema,
      title: z.string(),
      botId: CuidSchema.nullable(),
      taskId: CuidSchema.nullable(),
      goalId: CuidSchema.nullable(),
      projectId: CuidSchema.nullable(),
      createdAt: DateTimeSchema,
      excerpt: ExcerptSchema,
    }),
  ),
  messages: z.array(
    z.object({
      id: CuidSchema,
      botId: CuidSchema,
      author: MessageAuthorSchema,
      createdAt: DateTimeSchema,
      excerpt: z.string(),
    }),
  ),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// The refusals D-134 names

export const WorkErrorCodeSchema = z.enum([
  'PROJECT_NOT_EMPTY',
  'TASK_UNASSIGNED',
  'TASK_NOT_STARTABLE',
  'START_KEY_REUSED',
]);
export type WorkErrorCode = z.infer<typeof WorkErrorCodeSchema>;
