import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The task a delegated message is about.
 *
 * `send_message` carries it so the recipient's message says which task the
 * work came from, which is what files the recipient's attachments under that
 * task (D-136 rule 2). It is context, not a capability: owner-checked when the
 * sender names it, and again at delivery, since the task may be gone by then.
 */
@Injectable()
export class TaskContext {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The task the sending turn's own trigger message was about, if any. */
  async ofMessage(userId: string, messageId: string): Promise<string | null> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversation: { bot: { userId } } },
      select: { taskId: true },
    });
    return message?.taskId ?? null;
  }

  /** The task id if it is one of the user's tasks, else null. */
  async owned(userId: string, taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId },
      select: { id: true },
    });
    return task?.id ?? null;
  }
}
