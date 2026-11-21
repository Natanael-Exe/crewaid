import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ownedGoal, ownedProject, ownedTask } from './work-refs.js';

export type Filing = {
  readonly taskId: string | null;
  readonly goalId: string | null;
  readonly projectId: string | null;
};

const UNFILED: Filing = { taskId: null, goalId: null, projectId: null };

/**
 * Where a new deliverable is filed. The first rule that matches wins:
 *
 * 1. an explicit task or goal the caller named — owner-checked, and when
 * both are named they must agree; a foreign or conflicting id is refused,
 * never filed somewhere else;
 * 2. the task the turn's trigger message is about — a Start brief, or work
 * another bot delegated with `send_message({taskId})`;
 * 3. the goal of the routine that posted the trigger message;
 * 4. nothing: the views call it Unfiled.
 *
 * A task implies its goal and project, and a goal its project, so filters
 * read one indexed column. Only the trigger counts: a later, unrelated
 * message in the same conversation does not inherit a task the bot once had.
 */
export async function resolveFiling(
  tx: Prisma.TransactionClient,
  userId: string,
  want: {
    readonly taskId?: string | null | undefined;
    readonly goalId?: string | null | undefined;
    readonly triggerMessageId: string | null;
  },
): Promise<Filing> {
  if (want.taskId || want.goalId) {
    const task = want.taskId ? await ownedTask(tx, userId, want.taskId) : null;
    const goal = want.goalId ? await ownedGoal(tx, userId, want.goalId) : null;
    if (task !== null && goal !== null && task.goalId !== goal.id) {
      throw new BadRequestException('That task is not on that goal.');
    }
    if (task !== null) return { taskId: task.id, goalId: task.goalId, projectId: task.projectId };
    if (goal !== null) return { taskId: null, goalId: goal.id, projectId: goal.projectId };
  }
  if (want.triggerMessageId === null) return UNFILED;

  const trigger = await tx.message.findFirst({
    where: { id: want.triggerMessageId, conversation: { bot: { userId } } },
    select: { taskId: true, routine: { select: { goalId: true } } },
  });
  if (trigger?.taskId) {
    const task = await tx.task.findFirst({ where: { id: trigger.taskId, userId } });
    if (task !== null) return { taskId: task.id, goalId: task.goalId, projectId: task.projectId };
  }
  const routineGoal = trigger?.routine?.goalId ?? null;
  if (routineGoal !== null) {
    const goal = await tx.goal.findFirst({ where: { id: routineGoal, userId } });
    if (goal !== null) return { taskId: null, goalId: goal.id, projectId: goal.projectId };
  }
  return UNFILED;
}

/**
 * Re-filing by hand (`PATCH /deliverables/:id`): the most specific id named
 * wins and the rest derive from it. Naming a goal files it under that goal
 * and under no task; naming a project files it under that project alone.
 * Clearing one level keeps the others as they were.
 */
export async function refile(
  tx: Prisma.TransactionClient,
  userId: string,
  current: Filing,
  want: {
    readonly taskId?: string | null | undefined;
    readonly goalId?: string | null | undefined;
    readonly projectId?: string | null | undefined;
  },
): Promise<Filing> {
  if (want.taskId)
    return resolveFiling(tx, userId, {
      taskId: want.taskId,
      goalId: want.goalId,
      triggerMessageId: null,
    });
  if (want.goalId)
    return resolveFiling(tx, userId, { goalId: want.goalId, triggerMessageId: null });
  if (want.projectId) {
    const project = await ownedProject(tx, userId, want.projectId);
    return { taskId: null, goalId: null, projectId: project.id };
  }
  return {
    taskId: want.taskId === null ? null : current.taskId,
    goalId: want.goalId === null ? null : current.goalId,
    projectId: want.projectId === null ? null : current.projectId,
  };
}
