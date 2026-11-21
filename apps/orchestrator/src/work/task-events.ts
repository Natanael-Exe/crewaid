import type { Prisma, TaskEvent } from '@prisma/client';
import { TaskEventPayloadSchemas, type TaskEventType } from '@crewaid/shared';
import type { z } from 'zod';

/**
 * Who changed a task: the user on the board, or one of their bots
 * through a tool. The app records who, when, and — for a bot — the reply the
 * change was made in, so the activity log can jump to it. It never decides
 * whether they were allowed to: any of the user's bots may change any of the
 * user's tasks.
 */
export type WorkActor =
  | { readonly kind: 'USER' }
  | {
      readonly kind: 'BOT';
      readonly botId: string;
      readonly botName: string;
      /** The reply the tool call belongs to, when it has been created yet. */
      readonly messageId: string | null;
    };

export const USER_ACTOR: WorkActor = { kind: 'USER' };

/** How the log names the user. The operator reads their own log. */
const USER_LABEL = 'You';

type Payload<T extends TaskEventType> = z.input<(typeof TaskEventPayloadSchemas)[T]>;

/**
 * Appends one activity row. The payload is parsed through the shared schema
 * for its type before it is written, so a row the renderer cannot read is a
 * failed write here rather than a blank line in someone's activity log.
 */
export function writeTaskEvent<T extends TaskEventType>(
  tx: Prisma.TransactionClient,
  userId: string,
  taskId: string,
  actor: WorkActor,
  type: T,
  payload: Payload<T>,
  extra: { readonly startKey?: string; readonly messageId?: string } = {},
): Promise<TaskEvent> {
  const parsed: unknown = TaskEventPayloadSchemas[type].parse(payload);
  return tx.taskEvent.create({
    data: {
      taskId,
      userId,
      type,
      payload: parsed as Prisma.InputJsonValue,
      actor: actor.kind,
      actorBotId: actor.kind === 'BOT' ? actor.botId : null,
      actorLabel: actor.kind === 'BOT' ? actor.botName : USER_LABEL,
      startKey: extra.startKey ?? null,
      messageId: extra.messageId ?? (actor.kind === 'BOT' ? actor.messageId : null),
    },
  });
}
