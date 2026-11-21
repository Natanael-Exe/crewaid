import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BotGroup } from '@prisma/client';
import type { CreateBotGroupBody, UpdateBotGroupBody } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';

/**
 * Bot groups: a name, some instructions every member reads, and a
 * folder on the machine. Nothing here gives a group any power over its bots —
 * it is a label and a brief.
 *
 * Every query is scoped by `userId`, and a group that is absent and one
 * that is somebody else's are the same 404.
 */
@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {}

  /** `GET /groups` — sidebar order. */
  list(userId: string) {
    return this.prisma.botGroup.findMany({
      where: { userId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** New groups go below the existing ones, the way a new bot does. */
  async create(userId: string, input: CreateBotGroupBody) {
    const last = await this.prisma.botGroup.aggregate({
      where: { userId },
      _max: { sortOrder: true },
    });
    return this.prisma.botGroup.create({
      data: {
        userId,
        name: input.name,
        instructions: input.instructions ?? '',
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
  }

  async update(userId: string, groupId: string, input: UpdateBotGroupBody) {
    await this.findOwned(userId, groupId);
    return this.prisma.botGroup.update({
      where: { id: groupId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.instructions !== undefined && { instructions: input.instructions }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        ...(input.collapsed !== undefined && { collapsed: input.collapsed }),
      },
    });
  }

  /**
   * `DELETE /groups/:id`. The members go back to Unassigned through the
   * foreign key's SET NULL; no bot is deleted. The group's folder on the
   * machine is left alone: it holds the bots' work, and a file is not the
   * app's to throw away because a sidebar header went.
   */
  async remove(userId: string, groupId: string): Promise<void> {
    await this.findOwned(userId, groupId);
    const members = await this.prisma.bot.findMany({
      where: { userId, groupId },
      select: { id: true },
    });
    await this.prisma.botGroup.delete({ where: { id: groupId } });
    // Each member's `groupId` just changed, and another window showing the
    // roster only learns that from a frame. Observational, like every other
    // `bots.changed`: the rows are committed either way.
    for (const member of members) {
      try {
        this.events.emitBotsChanged(userId, member.id, 'updated');
      } catch (error) {
        this.logger.warn(
          `group ${groupId}: member ${member.id} could not be announced: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** The scoped lookup every by-id path goes through; 404 for absent and foreign alike. */
  private async findOwned(userId: string, groupId: string): Promise<BotGroup> {
    const group = await this.prisma.botGroup.findFirst({ where: { id: groupId, userId } });
    if (group === null) throw new NotFoundException('Group not found');
    return group;
  }
}
