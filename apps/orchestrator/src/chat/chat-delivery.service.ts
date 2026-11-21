import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  checkRunEventJoin,
  createRunEventLog,
  RunEventLogError,
} from '../agent/persistence/run-event-log.js';
import { hydrateOwnedChat } from '../agent/persistence/owned-chat-hydration.js';
import { RunEventWakeupsService } from './run-event-wakeups.service.js';

/** Joins one run's delivery log for its bot's owner. Never starts or bills a producer. */
@Injectable()
export class ChatDeliveryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RunEventWakeupsService) private readonly wakeups: RunEventWakeupsService,
  ) {}

  private async thread(userId: string, botId: string): Promise<{ id: string }> {
    const thread = await this.prisma.conversation.findFirst({
      where: { botId, bot: { userId } },
      select: { id: true },
    });
    if (thread === null) throw new NotFoundException();
    return thread;
  }

  /** A thread id that is not this bot's conversation is a 404 ( §3.1). */
  async hydrate(userId: string, botId: string, threadId: string, request: Request) {
    const thread = await this.thread(userId, botId);
    if (thread.id !== threadId) throw new NotFoundException();
    return hydrateOwnedChat(this.prisma, userId, thread.id, request);
  }

  async join(userId: string, botId: string, runId: string, offset: string) {
    const thread = await this.thread(userId, botId);
    const scope = { userId, botId, threadId: thread.id, runId };
    try {
      await checkRunEventJoin(this.prisma, scope, offset);
    } catch (error) {
      if (!(error instanceof RunEventLogError)) throw error;
      // Absent, foreign and on-another-thread all answer the same 404.
      if (error.code === 'RUN_NOT_OWNED') throw new NotFoundException();
      if (error.code === 'OFFSET_EXPIRED')
        throw new HttpException({ code: 'OFFSET_EXPIRED' }, HttpStatus.GONE);
      throw new HttpException({ code: 'OFFSET_UNKNOWN' }, HttpStatus.BAD_REQUEST);
    }
    return createRunEventLog(this.prisma, scope, { wakeups: this.wakeups, resumeFrom: offset });
  }
}
