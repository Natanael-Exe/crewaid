import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type HostedVoice,
  VoiceAllowanceExhaustedError,
  type VoiceUsage,
} from '../../models/voice/hosted-voice.port.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { BillingConfig } from './billing.config.js';
import { BillingService } from './billing.service.js';
import { BILLING_CONFIG } from './billing.tokens.js';

const SETTLE_ATTEMPTS = 3;

const COLUMN = { listen: 'listenSeconds', speak: 'speakSeconds' } as const;
const KIND = { listen: 'LISTEN', speak: 'SPEAK' } as const;

/**
 * Speech on Crewaid's ElevenLabs key, counted against the plan's voice
 * allowance, in seconds of audio: heard for dictation and voice messages,
 * made for spoken replies.
 *
 * Its own allowance rather than the model allowance D-221 first drew on: a
 * person who talks to their bots a lot must not use up the budget the bots
 * need to answer. The two kinds are counted apart because they cost ten times
 * apart, and a plan offers hours of one and minutes of the other.
 *
 * The reservation is D-157's: one conditional update on the period's ledger
 * row, whose row lock serialises an account's requests, so concurrent ones
 * cannot all slip in under the same remaining balance.
 */
@Injectable()
export class HostedVoiceService implements HostedVoice {
  private readonly logger = new Logger(HostedVoiceService.name);
  readonly apiKey: string;

  constructor(
    @Inject(BILLING_CONFIG) config: BillingConfig,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {
    /* c8 ignore next 3 -- the module provides this service only with a key. */
    if (config.elevenlabsKey === null) {
      throw new Error('HostedVoiceService needs CREWAID_ELEVENLABS_API_KEY');
    }
    this.apiKey = config.elevenlabsKey;
  }

  async meter<T>(
    userId: string,
    usage: VoiceUsage,
    estimateSeconds: number,
    run: () => Promise<{ readonly value: T; readonly seconds: number }>,
  ): Promise<T> {
    const entitlement = await this.billing.entitlementFor(userId);
    if (entitlement.period === null) throw new VoiceAllowanceExhaustedError(usage);
    const limit =
      usage === 'listen' ? entitlement.listenLimitSeconds : entitlement.speakLimitSeconds;
    if (limit === 0) throw new VoiceAllowanceExhaustedError(usage);

    const chargeId = await this.reserve(
      userId,
      entitlement.period,
      usage,
      limit,
      Math.max(1, Math.ceil(estimateSeconds)),
    );
    if (chargeId === null) throw new VoiceAllowanceExhaustedError(usage);

    let outcome: { readonly value: T; readonly seconds: number };
    try {
      outcome = await run();
    } catch (error) {
      // A request that failed made or heard nothing we can measure.
      await this.settle(userId, chargeId, usage, 0);
      throw error;
    }
    await this.settle(userId, chargeId, usage, Math.max(0, Math.ceil(outcome.seconds)));
    return outcome.value;
  }

  /** `null`: refused, nothing reserved. A `null` limit is none, still itemised. */
  private reserve(
    userId: string,
    period: { readonly start: Date; readonly end: Date },
    usage: VoiceUsage,
    limit: number | null,
    seconds: number,
  ): Promise<string | null> {
    const column = COLUMN[usage];
    return this.prisma.$transaction(async (tx) => {
      await tx.usageLedger.upsert({
        where: { userId_periodStart: { userId, periodStart: period.start } },
        create: { userId, periodStart: period.start, periodEnd: period.end },
        update: {},
      });
      const admitted = await tx.usageLedger.updateMany({
        where: {
          userId,
          periodStart: period.start,
          ...(limit === null ? {} : { [column]: { lt: limit } }),
        },
        data: { [column]: { increment: seconds } },
      });
      if (admitted.count === 0) return null;
      const charge = await tx.voiceCharge.create({
        data: { userId, periodStart: period.start, kind: KIND[usage], seconds },
        select: { id: true },
      });
      return charge.id;
    });
  }

  /**
   * Settle a reservation to the real seconds. Idempotent, and never throws:
   * the audio is already made or heard, and an unsettled hold stays counted.
   */
  private async settle(
    userId: string,
    chargeId: string,
    usage: VoiceUsage,
    seconds: number,
  ): Promise<void> {
    const column = COLUMN[usage];
    for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const charge = await tx.voiceCharge.findFirst({
            where: { id: chargeId, userId, settledAt: null },
            select: { seconds: true, periodStart: true },
          });
          if (charge === null) return;
          const claimed = await tx.voiceCharge.updateMany({
            where: { id: chargeId, userId, settledAt: null },
            data: { seconds, settledAt: new Date() },
          });
          if (claimed.count === 0) return;
          await tx.usageLedger.updateMany({
            where: { userId, periodStart: charge.periodStart },
            data: { [column]: { increment: seconds - charge.seconds } },
          });
        });
        return;
      } catch (error: unknown) {
        if (attempt === SETTLE_ATTEMPTS) {
          this.logger.error(
            `voice charge ${chargeId} not settled; its reservation stands: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * 4 ** (attempt - 1)));
      }
    }
  }
}
