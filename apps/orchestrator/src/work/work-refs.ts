import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Bot, Goal, Prisma, Project, Task, TaskSeries } from '@prisma/client';

/**
 * Owner checks for every row a Work write links to.
 *
 * A `userId` on the new row proves nothing about the project, goal, parent,
 * series or bot it points at, so each reference is looked up through the
 * caller's own rows first. Absent and foreign are the same 404, as they are
 * for the route's own `:id` — a write must not become a way to learn
 * that somebody else's id exists.
 *
 * They take the transaction the write runs in, so the check and the link it
 * guards see the same snapshot.
 */

export async function ownedProject(
  tx: Prisma.TransactionClient,
  userId: string,
  projectId: string,
): Promise<Project> {
  const row = await tx.project.findFirst({ where: { id: projectId, userId } });
  if (row === null) throw new NotFoundException('Project not found');
  return row;
}

export async function ownedGoal(
  tx: Prisma.TransactionClient,
  userId: string,
  goalId: string,
): Promise<Goal> {
  const row = await tx.goal.findFirst({ where: { id: goalId, userId } });
  if (row === null) throw new NotFoundException('Goal not found');
  return row;
}

export async function ownedTask(
  tx: Prisma.TransactionClient,
  userId: string,
  taskId: string,
): Promise<Task> {
  const row = await tx.task.findFirst({ where: { id: taskId, userId } });
  if (row === null) throw new NotFoundException('Task not found');
  return row;
}

export async function ownedSeries(
  tx: Prisma.TransactionClient,
  userId: string,
  seriesId: string,
): Promise<TaskSeries> {
  const row = await tx.taskSeries.findFirst({ where: { id: seriesId, userId } });
  if (row === null) throw new NotFoundException('Recurring task not found');
  return row;
}

export async function ownedBot(
  tx: Prisma.TransactionClient,
  userId: string,
  botId: string,
): Promise<Bot> {
  const row = await tx.bot.findFirst({ where: { id: botId, userId } });
  if (row === null) throw new NotFoundException('Bot not found');
  return row;
}

/**
 * Where a task (or a recurring task) sits, checked and derived in the write's transaction:
 *
 * - a subtask takes its parent's project and goal, and a parent must itself
 * be top-level (one level, D-133);
 * - a task on a goal that belongs to a project is in that project — asking
 * for another project is refused rather than silently overridden;
 * - every referenced row is the caller's, or the write answers 404.
 */
export async function resolvePlacement(
  tx: Prisma.TransactionClient,
  userId: string,
  want: {
    parentId: string | null;
    projectId: string | null;
    goalId: string | null;
    explicitProject?: boolean;
  },
): Promise<{ parentId: string | null; projectId: string | null; goalId: string | null }> {
  if (want.parentId !== null) {
    const parent = await ownedTask(tx, userId, want.parentId);
    if (parent.parentId !== null) {
      throw new BadRequestException('Subtasks are one level deep.');
    }
    return { parentId: parent.id, projectId: parent.projectId, goalId: parent.goalId };
  }
  let projectId = want.projectId;
  if (want.goalId !== null) {
    const goal = await ownedGoal(tx, userId, want.goalId);
    if (goal.projectId !== null) {
      const asked = want.explicitProject !== false && want.projectId !== null;
      if (asked && want.projectId !== goal.projectId) {
        throw new BadRequestException('A task on a goal is in that goal’s project.');
      }
      projectId = goal.projectId;
    }
  }
  if (projectId !== null) await ownedProject(tx, userId, projectId);
  return { parentId: null, projectId, goalId: want.goalId };
}
