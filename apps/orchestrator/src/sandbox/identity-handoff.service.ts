import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SeatControlService } from '../screen/seat-control.service.js';
import { IdentityService } from './identity.service.js';
import { SeatService } from './seat.service.js';

@Injectable()
export class IdentityHandoffService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeatControlService) private readonly control: SeatControlService,
    @Inject(IdentityService) private readonly identities: IdentityService,
    @Inject(SeatService) private readonly seats: SeatService,
  ) {}

  async release(userId: string, botId: string): Promise<void> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: { sandboxId: true },
    });
    if (bot === null) throw new NotFoundException('Bot not found');
    if (bot.sandboxId === null) return;
    const admission = await this.control.seats.admitIdentityRelease(botId);
    if (!admission.ok) throw new ConflictException(admission.refusal.message);
    try {
      await this.identities.release(userId, botId);
      await this.seats.releaseSeatForBot(botId, true);
    } catch (error: unknown) {
      // A failed close must not be reported as a completed transfer. Revocation
      // may already be durable; allocation will reconcile that selection next.
      throw new ConflictException(error instanceof Error ? error.message : 'Login release failed');
    } finally {
      admission.release();
    }
  }
}
