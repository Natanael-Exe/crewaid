import type { Prisma, Task, TaskStatus } from '@prisma/client';
import type { TaskCard } from '@crewaid/shared';

/** Statuses that still owe something. */
export const OPEN_STATUSES: readonly TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW'];

/** How far back "4 of last 5" looks. */
const RECENT_OCCURRENCES = 5;

/**
 * Task rows → board cards: each with its subtask progress, deliverable count
 * and, for an occurrence, what its series looks like.
 *
 * Everything a card shows as a number is computed here, once, for the whole
 * page of rows: three grouped reads plus two for recurring tasks, however many
 * cards there are. The renderer draws the numbers and never derives them
 * (R1), so a board and a details rail cannot disagree about "3/5".
 */
export async function taskCards(
  tx: Prisma.TransactionClient,
  userId: string,
  tasks: readonly Task[],
): Promise<TaskCard[]> {
  if (tasks.length === 0) return [];
  const ids = tasks.map((task) => task.id);

  const subtaskRows = await tx.task.groupBy({
    by: ['parentId', 'status'],
    where: { userId, parentId: { in: ids } },
    _count: { _all: true },
  });
  const subtasks = new Map<string, { done: number; total: number }>();
  for (const row of subtaskRows) {
    if (row.parentId === null || row.status === 'CANCELLED') continue;
    const count = subtasks.get(row.parentId) ?? { done: 0, total: 0 };
    count.total += row._count._all;
    if (row.status === 'DONE') count.done += row._count._all;
    subtasks.set(row.parentId, count);
  }

  const deliverableRows = await tx.deliverable.groupBy({
    by: ['taskId'],
    where: { userId, taskId: { in: ids } },
    _count: { _all: true },
  });
  const deliverables = new Map(deliverableRows.map((row) => [row.taskId, row._count._all]));

  const series = await seriesSummaries(tx, userId, tasks);

  return tasks.map((task) => ({
    ...task,
    subtasks: subtasks.get(task.id) ?? { done: 0, total: 0 },
    deliverableCount: deliverables.get(task.id) ?? 0,
    series: series(task),
  }));
}

/**
 * For the occurrences among `tasks`, a function answering each one's series
 * summary; null for a one-off task.
 *
 * Cancelled occurrences are left out of all three numbers: the user said that
 * one would not happen, so it is neither a miss nor the card to show.
 */
async function seriesSummaries(
  tx: Prisma.TransactionClient,
  userId: string,
  tasks: readonly Task[],
): Promise<(task: Task) => TaskCard['series']> {
  const seriesIds = [
    ...new Set(tasks.flatMap((task) => (task.seriesId === null ? [] : [task.seriesId]))),
  ];
  if (seriesIds.length === 0) return () => null;

  // The newest five live occurrences per series, in one pass.
  const recent = await tx.$queryRaw<{ seriesId: string; status: TaskStatus; occursAt: Date }[]>`
    SELECT "seriesId", status, "occursAt" FROM (
      SELECT "seriesId", status, "occursAt",
             row_number() OVER (PARTITION BY "seriesId" ORDER BY "occursAt" DESC) AS rn
      FROM "Task"
      WHERE "userId" = ${userId} AND "seriesId" = ANY(${seriesIds}) AND status <> 'CANCELLED'
    ) ranked
    WHERE rn <= ${RECENT_OCCURRENCES}
  `;
  const bySeries = new Map<string, { done: number; total: number; newest: number }>();
  for (const row of recent) {
    const entry = bySeries.get(row.seriesId) ?? { done: 0, total: 0, newest: 0 };
    entry.total += 1;
    if (row.status === 'DONE') entry.done += 1;
    entry.newest = Math.max(entry.newest, row.occursAt.getTime());
    bySeries.set(row.seriesId, entry);
  }

  const open = await tx.task.findMany({
    where: { userId, seriesId: { in: seriesIds }, status: { in: [...OPEN_STATUSES] } },
    select: { seriesId: true, occursAt: true },
  });

  return (task) => {
    if (task.seriesId === null) return null;
    const entry = bySeries.get(task.seriesId) ?? { done: 0, total: 0, newest: 0 };
    const at = task.occursAt?.getTime() ?? 0;
    return {
      recent: { done: entry.done, total: entry.total },
      olderOpenCount: open.filter(
        (row) => row.seriesId === task.seriesId && (row.occursAt?.getTime() ?? 0) < at,
      ).length,
      newest: at >= entry.newest,
    };
  };
}
