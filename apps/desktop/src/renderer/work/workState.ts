import type { ProjectWithCounts, TaskCard } from '@crewaid/shared';
import type { TaskListFilter } from '../api/work';
import { t } from '../i18n/i18n';

/**
 * The Work views' state that is not server data: which view the
 * centre pane shows, and which projects it is scoped to. Pure, so the shell
 * and its tests agree on what each choice means.
 */

export type WorkView = 'tasks' | 'goals' | 'deliverables';

export const WORK_VIEWS: readonly WorkView[] = ['tasks', 'goals', 'deliverables'];

export const WORK_VIEW_LABELS: Readonly<Record<WorkView, string>> = {
  get tasks() {
    return t('work.view.tasks');
  },
  get goals() {
    return t('work.view.goals');
  },
  get deliverables() {
    return t('work.view.deliverables');
  },
};

/** What each view is for, said once on its empty state. */
export const WORK_VIEW_PURPOSE: Readonly<Record<WorkView, { title: string; body: string }>> = {
  tasks: {
    get title() {
      return t('work.workState.noTasksYet');
    },
    get body() {
      return t('work.workState.keepTrackOfWhatYou');
    },
  },
  goals: {
    get title() {
      return t('work.workState.noGoalsYet');
    },
    get body() {
      return t('work.workState.aGoalCollectsTheTasks');
    },
  },
  deliverables: {
    get title() {
      return t('work.workState.noDeliverablesYet');
    },
    get body() {
      return t('work.workState.everyFileABotAttaches');
    },
  },
};

/** Which projects a view shows: all of them, the Inbox, or one. */
export type ProjectScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'inbox' }
  | { readonly kind: 'project'; readonly projectId: string };

export const ALL_PROJECTS: ProjectScope = { kind: 'all' };

export function scopeKey(scope: ProjectScope): string {
  return scope.kind === 'project' ? `project:${scope.projectId}` : scope.kind;
}

export function scopeFromKey(key: string): ProjectScope {
  if (key === 'inbox') return { kind: 'inbox' };
  if (key.startsWith('project:'))
    return { kind: 'project', projectId: key.slice('project:'.length) };
  return ALL_PROJECTS;
}

export function scopeLabel(scope: ProjectScope, projects: readonly ProjectWithCounts[]): string {
  if (scope.kind === 'all') return t('work.workPane.allProjects');
  if (scope.kind === 'inbox') return t('work.tasksView.inbox');
  return (
    projects.find((project) => project.id === scope.projectId)?.name ??
    t('work.deliverablePane.project')
  );
}

/**
 * A scope whose project was deleted or archived is no longer on offer; the
 * view falls back to all projects rather than showing an empty board for a
 * project the picker cannot name.
 */
export function liveScope(
  scope: ProjectScope,
  projects: readonly ProjectWithCounts[],
): ProjectScope {
  if (scope.kind !== 'project') return scope;
  const project = projects.find((row) => row.id === scope.projectId);
  return project === undefined || project.status === 'ARCHIVED' ? ALL_PROJECTS : scope;
}

/** The task query a scope stands for. */
export function scopeTaskFilter(scope: ProjectScope): Pick<TaskListFilter, 'projectId' | 'inbox'> {
  if (scope.kind === 'inbox') return { inbox: true };
  if (scope.kind === 'project') return { projectId: scope.projectId };
  return {};
}

/**
 * The Tasks row's badge: cards waiting on someone — in Review or Blocked.
 * Zero draws nothing, which is what keeps Work quiet for someone who never
 * uses it.
 */
export function attentionCount(cards: readonly Pick<TaskCard, 'status'>[]): number {
  return cards.filter((card) => card.status === 'IN_REVIEW' || card.status === 'BLOCKED').length;
}

/** Colours a new project can take, in the order the picker offers them. */
export const PROJECT_COLORS = [
  '#4F46E5',
  '#0891B2',
  '#16A34A',
  '#CA8A04',
  '#DC2626',
  '#DB2777',
  '#7C3AED',
  '#475569',
] as const;

/** The next colour for a new project: the first not yet used, else by count. */
export function nextProjectColor(projects: readonly Pick<ProjectWithCounts, 'color'>[]): string {
  const used = new Set(projects.map((project) => project.color.toUpperCase()));
  return (
    PROJECT_COLORS.find((color) => !used.has(color)) ??
    PROJECT_COLORS[projects.length % PROJECT_COLORS.length] ??
    PROJECT_COLORS[0]
  );
}

/** Tokens, short: 940, 12.4k, 1.2M. */
function compactCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Number((count / 1000).toFixed(count < 10_000 ? 1 : 0))}k`;
  return `${Number((count / 1_000_000).toFixed(1))}M`;
}

/**
 * What a task's or goal's turns cost, or null when none have run —
 * work nobody started costs nothing, and saying "0 turns" is furniture.
 */
export function usageText(usage: {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}): string | null {
  if (usage.turns === 0) return null;
  return t('work.usage', {
    turns: t('work.usage.turns', { count: usage.turns }),
    input: compactCount(usage.inputTokens),
    output: compactCount(usage.outputTokens),
  });
}

/**
 * A view's search: every word of the query appears somewhere in
 * the fields, in any case and any order, so "auth jwt" finds a task titled
 * "API auth" whose brief mentions JWT. An empty query matches everything.
 */
export function matchesQuery(
  query: string,
  fields: readonly (string | null | undefined)[],
): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return true;
  const haystack = fields
    .filter((field): field is string => typeof field === 'string')
    .join('\n')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
