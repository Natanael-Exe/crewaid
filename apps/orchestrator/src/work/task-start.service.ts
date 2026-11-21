import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { startBriefClosing, type StartTaskResponse } from '@crewaid/shared';
import { triggerRowColumns } from '../agent/persistence/transcript.js';
import { TanStackTurns } from '../agent/tanstack-turns.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { writeTaskEvent, USER_ACTOR } from './task-events.js';
import { WorkEvents } from './work-events.js';
import { ownedTask } from './work-refs.js';

/**
 * How far back boot recovery looks for a brief that was committed and never
 * dispatched. A Start is something the user just pressed; a day-old brief
 * that never ran is better left for them to press again than answered out of
 * nowhere after a long outage.
 */
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

type Claimed = { readonly messageId: string; readonly fresh: boolean };

/**
 * The Start button: the user's convenience for "post this task's
 * brief to its assignee". A bot never needs it; nothing else calls it.
 *
 * One owner-scoped transaction claims the TODO row, writes the USER brief with
 * `Message.taskId`, sets IN_PROGRESS and records STARTED with the request's
 * key, so two presses — concurrent or retried — cannot make two briefs. After
 * commit the ordinary turn path dispatches the brief, exactly as it would a
 * message the user typed. A crash between the two leaves one pending brief,
 * which a retry with the same key or the next boot dispatches, keyed by its
 * message id and never twice.
 *
 * The brief is a message, not instructions: nothing here touches a bot's
 * system prompt, so the cached prefix is unchanged by it.
 */
@Injectable()
export class TaskStartService {
  /** In-process single flight per brief: a dispatch in progress is not repeated. */
  private readonly dispatching = new Map<string, Promise<void>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TanStackTurns) private readonly turns: TanStackTurns,
    @Inject(TurnEventBus) private readonly bus: TurnEventBus,
    @Inject(WorkEvents) private readonly events: WorkEvents,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  async start(userId: string, taskId: string, startKey: string): Promise<StartTaskResponse> {
    const claimed = await this.prisma.$transaction((tx) =>
      this.claim(tx, userId, taskId, startKey),
    );
    if (claimed.fresh) {
      const message = await this.prisma.message.findFirst({
        where: { id: claimed.messageId, conversation: { bot: { userId } } },
        include: { attachments: true, conversation: { select: { botId: true } } },
      });
      if (message !== null) {
        const { conversation, ...row } = message;
        this.bus.emitCreated(conversation.botId, row);
      }
      this.events.task(userId, taskId);
    }
    // A retry is also how a brief left pending by a failed dispatch gets its
    // turn: the dispatch below is a no-op for a brief that already has one.
    this.dispatch(userId, claimed.messageId);
    return { messageId: claimed.messageId };
  }

  /**
   * Boot recovery: every recent brief with no turn that nothing has happened
   * after. "Nothing after" — no turn of that bot started since the brief was
   * written — is what tells a brief that never ran from one whose bot has
   * since moved on, and only the first is owed a turn.
   */
  async recoverPendingStarts(): Promise<number> {
    const since = new Date(Date.now() - RECOVERY_WINDOW_MS);
    const started = await this.prisma.taskEvent.findMany({
      where: { type: 'STARTED', createdAt: { gte: since }, messageId: { not: null } },
      select: {
        userId: true,
        messageId: true,
        message: {
          select: { createdAt: true, conversation: { select: { botId: true } } },
        },
      },
    });
    let recovered = 0;
    for (const event of started) {
      if (event.messageId === null || event.message === null) continue;
      const later = await this.prisma.agentTurn.count({
        where: {
          botId: event.message.conversation.botId,
          bot: { userId: event.userId },
          OR: [
            { triggerMessageId: event.messageId },
            { startedAt: { gte: event.message.createdAt } },
          ],
        },
      });
      if (later > 0) continue;
      this.dispatch(event.userId, event.messageId);
      recovered += 1;
    }
    if (recovered > 0) this.logger.info('task.start.recovered', { count: recovered });
    return recovered;
  }

  /**
   * The claim, inside one transaction. The conditional UPDATE is what makes
   * concurrent presses safe: the second blocks on the row until the first
   * commits, then matches nothing, and reads back the first one's key.
   */
  private async claim(
    tx: Prisma.TransactionClient,
    userId: string,
    taskId: string,
    startKey: string,
  ): Promise<Claimed> {
    const recorded = await this.recorded(tx, userId, taskId, startKey);
    if (recorded !== null) return recorded;

    const task = await ownedTask(tx, userId, taskId);
    if (task.assigneeBotId === null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'TASK_UNASSIGNED',
        message: 'Assign this task to a bot before starting it.',
      });
    }
    const won = await tx.task.updateMany({
      where: { id: taskId, userId, status: 'TODO' },
      data: { status: 'IN_PROGRESS', startedAt: task.startedAt ?? new Date(), completedAt: null },
    });
    if (won.count === 0) {
      const raced = await this.recorded(tx, userId, taskId, startKey);
      if (raced !== null) return raced;
      throw new ConflictException({
        statusCode: 409,
        code: 'TASK_NOT_STARTABLE',
        message: 'Only a task in To do can be started. Move it back to To do to run it again.',
      });
    }

    const conversation =
      (await tx.conversation.findFirst({
        where: { botId: task.assigneeBotId, bot: { userId } },
        select: { id: true },
      })) ??
      (await tx.conversation.create({
        data: { botId: task.assigneeBotId },
        select: { id: true },
      }));
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        // A Start brief is a trigger, so it is written as the model
        // message it is. `taskId` is what files the deliverables the turn
        // produces.
        ...triggerRowColumns(task.assigneeBotId, await this.brief(tx, userId, task)),
        taskId,
      },
    });
    await writeTaskEvent(
      tx,
      userId,
      taskId,
      USER_ACTOR,
      'STARTED',
      {},
      {
        startKey,
        messageId: message.id,
      },
    );
    return { messageId: message.id, fresh: true };
  }

  /** A key this user already used: its brief, or a refusal if it was another task's. */
  private async recorded(
    tx: Prisma.TransactionClient,
    userId: string,
    taskId: string,
    startKey: string,
  ): Promise<Claimed | null> {
    const event = await tx.taskEvent.findFirst({
      where: { userId, startKey },
      select: { taskId: true, messageId: true },
    });
    if (event === null) return null;
    if (event.taskId !== taskId || event.messageId === null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'START_KEY_REUSED',
        message: 'This Start request key was already used for another task.',
      });
    }
    return { messageId: event.messageId, fresh: false };
  }

  /**
   * The brief as PRD-WORK §3.3 writes it, closed by the line naming the
   * task and asking the bot to report back on it:
   *
   * Task: API auth
   * Project: Acme SaaS · Goal: Ship the MVP · Due: 2026-10-03
   *
   * <the brief>
   *
   * Task id: <id>. When you finish, use task_update to move it to Review…
   */
  private async brief(
    tx: Prisma.TransactionClient,
    userId: string,
    task: {
      id: string;
      title: string;
      brief: string | null;
      projectId: string | null;
      goalId: string | null;
      dueOn: string | null;
    },
  ): Promise<string> {
    const [project, goal] = await Promise.all([
      task.projectId === null
        ? null
        : tx.project.findFirst({ where: { id: task.projectId, userId }, select: { name: true } }),
      task.goalId === null
        ? null
        : tx.goal.findFirst({ where: { id: task.goalId, userId }, select: { title: true } }),
    ]);
    const context = [
      project === null ? null : `Project: ${project.name}`,
      goal === null ? null : `Goal: ${goal.title}`,
      task.dueOn === null ? null : `Due: ${task.dueOn}`,
    ].filter((part): part is string => part !== null);
    const head = [`Task: ${task.title}`, ...(context.length > 0 ? [context.join(' · ')] : [])];
    const body = task.brief?.trim() ?? '';
    return [head.join('\n'), ...(body === '' ? [] : [body]), startBriefClosing(task.id)].join(
      '\n\n',
    );
  }

  /**
   * Hands a brief to the ordinary turn path, at most once. A brief that
   * already has a turn — running, settled or deferred behind one — is left
   * alone; a dispatch already in flight for it in this process is not
   * repeated. Not awaited by the request, for the same reason `POST
   * /messages` does not await its turn: the user gets their 202 now.
   */
  private dispatch(userId: string, messageId: string): void {
    if (this.dispatching.has(messageId)) return;
    const run = (async () => {
      const turn = await this.prisma.agentTurn.findFirst({
        where: { triggerMessageId: messageId, bot: { userId } },
        select: { id: true },
      });
      if (turn !== null) return;
      const message = await this.prisma.message.findFirst({
        where: { id: messageId, conversation: { bot: { userId } } },
        select: {
          id: true,
          content: true,
          chainId: true,
          conversation: { select: { botId: true } },
        },
      });
      if (message === null) return;
      await this.turns.startStored(userId, message.conversation.botId, {
        id: message.id,
        content: message.content,
        chainId: message.chainId,
        hopCount: 0,
      });
    })()
      .catch((error: unknown) => {
        this.logger.error('task.start.dispatch.failed', {
          messageId,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      })
      .finally(() => this.dispatching.delete(messageId));
    this.dispatching.set(messageId, run);
  }

  /** For tests and shutdown: resolves once every dispatch this process began has settled. */
  async settled(): Promise<void> {
    await Promise.all([...this.dispatching.values()]);
  }
}
