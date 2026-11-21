import type { Goal, Prisma } from '@prisma/client';
import { goalProgress, seriesDoneRate, type GoalWithProgress } from '@crewaid/shared';

/**
 * A goal's derived numbers: progress over its one-off top-level tasks,
 * each recurring task's done rate since the goal started, and how many
 * routines work toward it. Never stored — computed per read with the same
 * shared functions the renderer uses, for a page of goals at a time.
 */
export async function goalSummaries(
  tx: Prisma.TransactionClient,
  userId: string,
  goals: readonly Goal[],
  now: Date = new Date(),
): Promise<GoalWithProgress[]> {
  if (goals.length === 0) return [];
  const goalIds = goals.map((goal) => goal.id);

  const tasks = await tx.task.findMany({
    where: { userId, goalId: { in: goalIds }, parentId: null, seriesId: null },
    select: { goalId: true, status: true, parentId: true, seriesId: true },
  });

  const series = await tx.taskSeries.findMany({
    where: { userId, goalId: { in: goalIds } },
    select: { id: true, goalId: true, title: true, enabled: true },
    orderBy: { createdAt: 'asc' },
  });
  const earliest = Math.min(...goals.map((goal) => goal.createdAt.getTime()));
  const occurrences =
    series.length === 0
      ? []
      : await tx.task.findMany({
          where: {
            userId,
            seriesId: { in: series.map((row) => row.id) },
            occursAt: { gte: new Date(earliest), lte: now },
          },
          select: { seriesId: true, status: true, occursAt: true },
        });

  const routines = await tx.routine.groupBy({
    by: ['goalId'],
    where: { goalId: { in: goalIds }, bot: { userId } },
    _count: { _all: true },
  });

  return goals.map((goal) => ({
    ...goal,
    progress: goalProgress(tasks.filter((task) => task.goalId === goal.id)),
    series: series
      .filter((row) => row.goalId === goal.id)
      .map((row) => ({
        seriesId: row.id,
        title: row.title,
        enabled: row.enabled,
        rate: seriesDoneRate(
          occurrences.filter((occurrence) => occurrence.seriesId === row.id),
          goal.createdAt,
          now,
        ),
      })),
    routineCount: routines.find((row) => row.goalId === goal.id)?._count._all ?? 0,
  }));
}
