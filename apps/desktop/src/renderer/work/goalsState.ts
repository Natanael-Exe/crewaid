import type { DoneCount, GoalWithProgress } from '@crewaid/shared';
import { t } from '../i18n/i18n';

/**
 * The Goals view's small derivations. The numbers are
 * the server's; these only turn them into what a card says.
 */

/** Whole percent, or null for a goal with no one-off tasks to measure. */
export function percent(count: DoneCount): number | null {
  return count.total === 0 ? null : Math.round((count.done / count.total) * 100);
}

/** "12/20 tasks" — or null when there are none. */
export function progressText(count: DoneCount): string | null {
  return count.total === 0 ? null : t('work.goal.tasks', { done: count.done, total: count.total });
}

/**
 * *Ready to close*: every one-off task done, and still open. A goal never
 * closes itself; this is only the nudge that it could.
 */
export function readyToClose(goal: Pick<GoalWithProgress, 'progress' | 'status'>): boolean {
  return (
    goal.status === 'ACTIVE' &&
    goal.progress.total > 0 &&
    goal.progress.done === goal.progress.total
  );
}

/** "Work out 11/12" — how often a recurring task was done since the goal began. */
export function rateText(title: string, rate: DoneCount): string {
  return t('work.goal.rate', { title, done: rate.done, total: rate.total });
}

/** Active goals first, by target date (undated last), then the closed ones. */
export function orderGoals(goals: readonly GoalWithProgress[]): GoalWithProgress[] {
  const rank = (goal: GoalWithProgress) => (goal.status === 'ACTIVE' ? 0 : 1);
  return [...goals].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.targetOn ?? '9999').localeCompare(b.targetOn ?? '9999') ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
}
