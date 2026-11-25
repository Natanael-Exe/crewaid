import {
  API_ROUTES,
  CreateTaskResponseSchema,
  DeliverableViewSchema,
  GoalDetailResponseSchema,
  GoalWithProgressSchema,
  ListDeliverablesResponseSchema,
  ListGoalsResponseSchema,
  ListProjectsResponseSchema,
  ListTasksResponseSchema,
  ProjectWithCountsSchema,
  SearchResponseSchema,
  StartTaskResponseSchema,
  TaskCardSchema,
  TaskDetailResponseSchema,
  TaskEventSchema,
  TaskSeriesDetailResponseSchema,
  TaskSeriesSchema,
  type CreateDeliverableBody,
  type CreateGoalBody,
  type CreateProjectBody,
  type CreateTaskBody,
  type CreateTaskResponse,
  type DeliverableView,
  type GoalDetailResponse,
  type GoalStatus,
  type GoalWithProgress,
  type ListDeliverablesResponse,
  type ProjectStatus,
  type ProjectWithCounts,
  type SearchResponse,
  type SearchType,
  type StartTaskResponse,
  type TaskCard,
  type TaskDetailResponse,
  type TaskEvent,
  type TaskSeries,
  type TaskSeriesDetailResponse,
  type TaskStatus,
  type UpdateDeliverableBody,
  type UpdateGoalBody,
  type UpdateProjectBody,
  type UpdateTaskBody,
  type UpdateTaskSeriesBody,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * Work: projects, tasks, recurring series, goals, deliverables and
 * search. One function per route, every answer parsed by its shared schema,
 * and nothing derived here — counts and progress are the server's.
 */

// Projects

export function listProjects(
  client: ApiClient,
  status?: ProjectStatus,
): Promise<ProjectWithCounts[]> {
  return client.request(API_ROUTES.projects.list, {
    query: { status },
    schema: ListProjectsResponseSchema,
  });
}

export function createProject(
  client: ApiClient,
  body: CreateProjectBody,
): Promise<ProjectWithCounts> {
  return client.request(API_ROUTES.projects.create, { body, schema: ProjectWithCountsSchema });
}

export function updateProject(
  client: ApiClient,
  id: string,
  body: UpdateProjectBody,
): Promise<ProjectWithCounts> {
  return client.request(API_ROUTES.projects.update, {
    params: { id },
    body,
    schema: ProjectWithCountsSchema,
  });
}

export function deleteProject(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.projects.remove, { params: { id } });
}

// Tasks

export type TaskListFilter = {
  readonly projectId?: string;
  readonly inbox?: boolean;
  readonly goalId?: string;
  readonly assigneeBotId?: string;
  readonly status?: readonly TaskStatus[];
  readonly parentId?: string;
  readonly seriesId?: string;
  readonly occursFrom?: string;
  readonly occursThrough?: string;
  readonly doneSince?: Date;
};

export function listTasks(client: ApiClient, filter: TaskListFilter = {}): Promise<TaskCard[]> {
  return client.request(API_ROUTES.tasks.list, {
    query: {
      projectId: filter.projectId,
      inbox: filter.inbox === undefined ? undefined : String(filter.inbox),
      goalId: filter.goalId,
      assigneeBotId: filter.assigneeBotId,
      status: filter.status === undefined ? undefined : filter.status.join(','),
      parentId: filter.parentId,
      seriesId: filter.seriesId,
      occursFrom: filter.occursFrom,
      occursThrough: filter.occursThrough,
      doneSince: filter.doneSince?.toISOString(),
    },
    schema: ListTasksResponseSchema,
  });
}

export function createTask(client: ApiClient, body: CreateTaskBody): Promise<CreateTaskResponse> {
  return client.request(API_ROUTES.tasks.create, { body, schema: CreateTaskResponseSchema });
}

export function getTask(client: ApiClient, id: string): Promise<TaskDetailResponse> {
  return client.request(API_ROUTES.tasks.get, { params: { id }, schema: TaskDetailResponseSchema });
}

export function updateTask(client: ApiClient, id: string, body: UpdateTaskBody): Promise<TaskCard> {
  return client.request(API_ROUTES.tasks.update, { params: { id }, body, schema: TaskCardSchema });
}

export function deleteTask(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.tasks.remove, { params: { id } });
}

/**
 * One key per press of Start, reused if the same press is retried, so
 * a double click or a retry can never post a second brief.
 */
export function startTask(
  client: ApiClient,
  id: string,
  idempotencyKey: string,
): Promise<StartTaskResponse> {
  return client.request(API_ROUTES.tasks.start, {
    params: { id },
    idempotencyKey,
    schema: StartTaskResponseSchema,
  });
}

export function addTaskNote(client: ApiClient, id: string, text: string): Promise<TaskEvent> {
  return client.request(API_ROUTES.tasks.addNote, {
    params: { id },
    body: { text },
    schema: TaskEventSchema,
  });
}

export function getTaskSeries(client: ApiClient, id: string): Promise<TaskSeriesDetailResponse> {
  return client.request(API_ROUTES.taskSeries.get, {
    params: { id },
    schema: TaskSeriesDetailResponseSchema,
  });
}

export function updateTaskSeries(
  client: ApiClient,
  id: string,
  body: UpdateTaskSeriesBody,
): Promise<TaskSeries> {
  return client.request(API_ROUTES.taskSeries.update, {
    params: { id },
    body,
    schema: TaskSeriesSchema,
  });
}

export function deleteTaskSeries(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.taskSeries.remove, { params: { id } });
}

// Goals

export function listGoals(
  client: ApiClient,
  filter: { readonly status?: GoalStatus; readonly projectId?: string } = {},
): Promise<GoalWithProgress[]> {
  return client.request(API_ROUTES.goals.list, {
    query: { status: filter.status, projectId: filter.projectId },
    schema: ListGoalsResponseSchema,
  });
}

export function createGoal(client: ApiClient, body: CreateGoalBody): Promise<GoalWithProgress> {
  return client.request(API_ROUTES.goals.create, { body, schema: GoalWithProgressSchema });
}

export function getGoal(client: ApiClient, id: string): Promise<GoalDetailResponse> {
  return client.request(API_ROUTES.goals.get, { params: { id }, schema: GoalDetailResponseSchema });
}

export function updateGoal(
  client: ApiClient,
  id: string,
  body: UpdateGoalBody,
): Promise<GoalWithProgress> {
  return client.request(API_ROUTES.goals.update, {
    params: { id },
    body,
    schema: GoalWithProgressSchema,
  });
}

export function deleteGoal(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.goals.remove, { params: { id } });
}

// Deliverables

export type DeliverableFilter = {
  readonly projectId?: string;
  readonly goalId?: string;
  readonly taskId?: string;
  readonly botId?: string;
  /** The deliverable a file attachment was filed as, whichever bot published it. */
  readonly attachmentId?: string;
  readonly kind?: DeliverableView['kind'];
  readonly unfiled?: boolean;
  /** Words in the title or summary. */
  readonly q?: string;
  readonly before?: string;
  readonly limit?: number;
};

export function listDeliverables(
  client: ApiClient,
  filter: DeliverableFilter = {},
): Promise<ListDeliverablesResponse> {
  return client.request(API_ROUTES.deliverables.list, {
    query: {
      projectId: filter.projectId,
      goalId: filter.goalId,
      taskId: filter.taskId,
      botId: filter.botId,
      attachmentId: filter.attachmentId,
      kind: filter.kind,
      unfiled: filter.unfiled === undefined ? undefined : String(filter.unfiled),
      q: filter.q,
      before: filter.before,
      limit: filter.limit,
    },
    schema: ListDeliverablesResponseSchema,
  });
}

export function getDeliverable(client: ApiClient, id: string): Promise<DeliverableView> {
  return client.request(API_ROUTES.deliverables.get, {
    params: { id },
    schema: DeliverableViewSchema,
  });
}

/** A link the user records, or a transcript message saved as a deliverable. */
export function createDeliverable(
  client: ApiClient,
  body: CreateDeliverableBody,
): Promise<DeliverableView> {
  return client.request(API_ROUTES.deliverables.create, { body, schema: DeliverableViewSchema });
}

export function updateDeliverable(
  client: ApiClient,
  id: string,
  body: UpdateDeliverableBody,
): Promise<DeliverableView> {
  return client.request(API_ROUTES.deliverables.update, {
    params: { id },
    body,
    schema: DeliverableViewSchema,
  });
}

export function deleteDeliverable(client: ApiClient, id: string): Promise<void> {
  return client.request(API_ROUTES.deliverables.remove, { params: { id } });
}

// Search

export function searchEverything(
  client: ApiClient,
  q: string,
  options: { readonly types?: readonly SearchType[]; readonly signal?: AbortSignal } = {},
): Promise<SearchResponse> {
  return client.request(API_ROUTES.search, {
    query: { q, types: options.types?.join(',') },
    schema: SearchResponseSchema,
    ...(options.signal !== undefined && { signal: options.signal }),
  });
}
