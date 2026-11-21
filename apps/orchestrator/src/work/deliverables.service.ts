import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Deliverable, Prisma } from '@prisma/client';
import type {
  CreateDeliverableBody,
  DeliverableView,
  ListDeliverablesQuery,
  ListDeliverablesResponse,
  UpdateDeliverableBody,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { refile, resolveFiling } from './deliverable-filing.js';
import { deliverableViews } from './deliverable-views.js';
import { boundedSearchText } from './search-text.js';
import { writeTaskEvent, USER_ACTOR } from './task-events.js';
import { WorkEvents } from './work-events.js';

/**
 * Deliverables: an index of what bots produced, filed by where the
 * work came from. Records point at what already exists — an attachment, a
 * URL, a message — so deleting a deliverable deletes only the record; the
 * file stays in the transcript it was attached in.
 */
@Injectable()
export class DeliverablesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkEvents) private readonly events: WorkEvents,
  ) {}

  /** `GET /deliverables` — newest first, a page at a time. */
  async list(userId: string, query: ListDeliverablesQuery): Promise<ListDeliverablesResponse> {
    const where: Prisma.DeliverableWhereInput = {
      userId,
      ...(query.projectId !== undefined && { projectId: query.projectId }),
      ...(query.goalId !== undefined && { goalId: query.goalId }),
      ...(query.taskId !== undefined && { taskId: query.taskId }),
      ...(query.botId !== undefined && { botId: query.botId }),
      ...(query.kind !== undefined && { kind: query.kind }),
      ...(query.unfiled === true && { taskId: null, goalId: null, projectId: null }),
      // Under AND, because the cursor below adds an OR of its own.
      ...(query.q !== undefined && {
        AND: [
          {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' as const } },
              { summary: { contains: query.q, mode: 'insensitive' as const } },
            ],
          },
        ],
      }),
    };
    const cursor =
      query.before === undefined
        ? null
        : await this.prisma.deliverable.findFirst({
            where: { id: query.before, userId },
            select: { id: true, createdAt: true },
          });
    const page =
      cursor === null
        ? where
        : {
            ...where,
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          };
    const [items, total] = await Promise.all([
      deliverableViews(this.prisma, userId, page, query.limit + 1),
      this.prisma.deliverable.count({ where: { ...where, userId } }),
    ]);
    const more = items.length > query.limit;
    const shown = more ? items.slice(0, query.limit) : items;
    return { items: shown, nextCursor: more ? (shown.at(-1)?.id ?? null) : null, total };
  }

  /**
   * `POST /deliverables` — the user records a LINK, or saves a transcript
   * MESSAGE as a deliverable. Filed by the ids named,
   * else — for a message — by where that message's work came from, as a file
   * the same turn attached would have been. A saved bot reply is
   * attributed to that bot; a link or a user's own message to nobody.
   */
  async create(userId: string, input: CreateDeliverableBody): Promise<DeliverableView> {
    const row = await this.prisma.$transaction(async (tx) => {
      let botId: string | null = null;
      let provenance: string | null = null;
      let searchText: string | null = null;
      if (input.kind === 'MESSAGE') {
        const message = await tx.message.findFirst({
          where: { id: input.messageId, conversation: { bot: { userId } } },
          select: {
            author: true,
            content: true,
            conversation: { select: { botId: true } },
            run: { select: { triggerMessageId: true } },
          },
        });
        if (message === null) throw new NotFoundException('Message not found');
        if (message.author === 'BOT') botId = message.conversation.botId;
        provenance = message.run?.triggerMessageId ?? input.messageId;
        searchText = boundedSearchText(message.content);
      }
      const place = await resolveFiling(tx, userId, {
        taskId: input.taskId,
        goalId: input.goalId,
        triggerMessageId: provenance,
      });
      const created = await tx.deliverable.create({
        data: {
          userId,
          kind: input.kind,
          title: input.title,
          summary: input.summary ?? null,
          botId,
          url: input.kind === 'LINK' ? input.url : null,
          messageId: input.kind === 'MESSAGE' ? input.messageId : null,
          searchText,
          ...place,
        },
      });
      if (place.taskId !== null) {
        await writeTaskEvent(tx, userId, place.taskId, USER_ACTOR, 'DELIVERABLE_LINKED', {
          deliverableId: created.id,
          title: created.title,
        });
      }
      return created;
    });
    this.announce(row, row);
    const [view] = await deliverableViews(this.prisma, userId, { id: row.id }, 1);
    if (view === undefined) throw new NotFoundException('Deliverable not found');
    return view;
  }

  /** `PATCH /deliverables/:id` — rename, summarise or re-file. */
  async update(
    userId: string,
    deliverableId: string,
    input: UpdateDeliverableBody,
  ): Promise<DeliverableView> {
    const before = await this.findOwned(userId, deliverableId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const refiling =
        input.taskId !== undefined || input.goalId !== undefined || input.projectId !== undefined;
      const filing = refiling ? await refile(tx, userId, before, input) : null;
      const row = await tx.deliverable.update({
        where: { id: deliverableId, userId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.summary !== undefined && { summary: input.summary }),
          ...(filing !== null && filing),
        },
      });
      if (filing?.taskId && filing.taskId !== before.taskId) {
        await writeTaskEvent(tx, userId, filing.taskId, USER_ACTOR, 'DELIVERABLE_LINKED', {
          deliverableId,
          title: row.title,
        });
      }
      return row;
    });
    this.announce(before, updated);
    const [view] = await deliverableViews(this.prisma, userId, { id: deliverableId }, 1);
    if (view === undefined) throw new NotFoundException('Deliverable not found');
    return view;
  }

  /** `DELETE /deliverables/:id` — the record only; the file stays in its transcript. */
  async remove(userId: string, deliverableId: string): Promise<void> {
    const before = await this.findOwned(userId, deliverableId);
    await this.prisma.deliverable.delete({ where: { id: deliverableId, userId } });
    this.events.deliverable(userId, deliverableId, true);
    if (before.taskId !== null) this.events.task(userId, before.taskId);
    if (before.goalId !== null) this.events.goal(userId, before.goalId);
  }

  private announce(before: Deliverable, after: Deliverable): void {
    const { userId } = after;
    this.events.deliverable(userId, after.id);
    for (const taskId of new Set([before.taskId, after.taskId]))
      if (taskId) this.events.task(userId, taskId);
    for (const goalId of new Set([before.goalId, after.goalId]))
      if (goalId) this.events.goal(userId, goalId);
    for (const projectId of new Set([before.projectId, after.projectId])) {
      if (projectId) this.events.project(userId, projectId);
    }
  }

  private async findOwned(userId: string, deliverableId: string): Promise<Deliverable> {
    const row = await this.prisma.deliverable.findFirst({ where: { id: deliverableId, userId } });
    if (row === null) throw new NotFoundException('Deliverable not found');
    return row;
  }
}
