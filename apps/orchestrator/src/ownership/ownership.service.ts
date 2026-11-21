import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { OwnedResourceKind } from './owned-resource.decorator.js';

/** Resolves to the row when the principal owns it, else null. */
type OwnershipFinder = (userId: Principal['userId'], id: string) => Promise<unknown>;

/**
 * Resource ownership boundary for every direct-by-ID route.
 *
 * Each lookup resolves the resource through the authenticated principal's
 * ownership relation before a controller can perform handler logic. Unknown
 * and foreign IDs deliberately return null so the guard can expose one
 * non-leaking 404 shape.
 *
 * The finders are one record keyed by `OwnedResourceKind`, and `satisfies`
 * makes that record total: a family a route can name is a family with a
 * relation here, checked by the compiler rather than by a reviewer noticing.
 */
@Injectable()
export class OwnershipService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Arrow functions, so `this.prisma` is read when a lookup runs rather than
   * when the field initializes — field-initializer ordering against a
   * constructor parameter property is not something to depend on.
   */
  private readonly finders = {
    bot: (userId, id) => this.prisma.bot.findFirst({ where: { id, userId } }),
    skill: (userId, id) => this.prisma.skill.findFirst({ where: { id, bot: { userId } } }),
    skillRun: (userId, id) =>
      this.prisma.skillRun.findFirst({ where: { id, skill: { bot: { userId } } } }),
    recording: (userId, id) => this.prisma.recording.findFirst({ where: { id, bot: { userId } } }),
    // An unclaimed upload is owned outright; once claimed, ownership
    // rides the message it was attached to.
    attachment: (userId, id) =>
      this.prisma.attachment.findFirst({
        where: {
          id,
          OR: [
            { ownerId: userId, messageId: null },
            { message: { conversation: { bot: { userId } } } },
          ],
        },
      }),
    mcpServer: (userId, id) => this.prisma.mcpServer.findFirst({ where: { id, userId } }),
    routine: (userId, id) => this.prisma.routine.findFirst({ where: { id, bot: { userId } } }),
    // A connection is owned outright…
    providerConnection: (userId, id) =>
      this.prisma.providerConnection.findFirst({ where: { id, userId } }),
    // …and a model through the connection it hangs off. Walking the relation
    // rather than trusting the connection id in the path is the point: the
    // model routes are flat (`/providers/models/:modelId`) precisely so that
    // no handler can trust a path segment it did not verify.
    providerModel: (userId, id) =>
      this.prisma.providerModel.findFirst({ where: { id, connection: { userId } } }),
    botGroup: (userId, id) => this.prisma.botGroup.findFirst({ where: { id, userId } }),
    project: (userId, id) => this.prisma.project.findFirst({ where: { id, userId } }),
    goal: (userId, id) => this.prisma.goal.findFirst({ where: { id, userId } }),
    task: (userId, id) => this.prisma.task.findFirst({ where: { id, userId } }),
    taskSeries: (userId, id) => this.prisma.taskSeries.findFirst({ where: { id, userId } }),
    deliverable: (userId, id) => this.prisma.deliverable.findFirst({ where: { id, userId } }),
    voiceCall: (userId, id) => this.prisma.voiceCall.findFirst({ where: { id, userId } }),
  } satisfies Record<OwnedResourceKind, OwnershipFinder>;

  /**
   * The single entry point the guard calls. Returns null for both an unknown
   * id and a foreign one — the guard must not be able to tell them apart, or
   * the 404 leaks existence.
   */
  async findOwned(
    kind: OwnedResourceKind,
    userId: Principal['userId'],
    id: string,
  ): Promise<unknown> {
    return this.finders[kind](userId, id);
  }
}
