import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BillingConfig } from '../src/billing/billing.config.js';
import type { BillingService } from '../src/billing/billing.service.js';
import type { Entitlement } from '../src/billing/entitlement.js';
import { HostedVoiceService } from '../src/billing/hosted-voice.service.js';
import { VoiceAllowanceExhaustedError } from '../src/models/voice/hosted-voice.port.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const PERIOD = { start: new Date('2026-10-01'), end: new Date('2026-11-01') };

const CONFIG: BillingConfig = {
  secretKey: 'sk_test',
  webhookSecret: 'whsec',
  prices: { starter: 'price_a', pro: 'price_b' },
  automaticTax: false,
  returnUrl: 'https://crewaid.io/billing/done',
  openrouterKey: null,
  elevenlabsKey: 'sk_el_hosted',
  elevenlabsAgentId: null,
};

/**
 * D-223 — speech on Crewaid's key is metered in seconds of audio, against the
 * plan's voice allowance and not its model allowance, over a real ledger.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'D-223 — the voice allowance',
  () => {
    let prisma: PrismaService;
    let service: HostedVoiceService;
    const user = `voice-meter-${randomUUID()}`;
    let limits: { listen: number | null; speak: number | null; period: boolean } = {
      listen: 600,
      speak: 60,
      period: true,
    };
    const billing = {
      entitlementFor: async (): Promise<Partial<Entitlement>> => ({
        period: limits.period ? PERIOD : null,
        listenLimitSeconds: limits.listen,
        speakLimitSeconds: limits.speak,
      }),
    } as unknown as BillingService;

    const ledger = () =>
      prisma.usageLedger.findFirst({
        where: { userId: user, periodStart: PERIOD.start },
        select: { listenSeconds: true, speakSeconds: true, modelMicroUsd: true },
      });

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      await prisma.user.create({
        data: { id: user, name: 'voice', email: `${user}@test.invalid` },
      });
      service = new HostedVoiceService(CONFIG, billing, prisma);
    });

    beforeEach(async () => {
      limits = { listen: 600, speak: 60, period: true };
      await prisma.voiceCharge.deleteMany({ where: { userId: user } });
      await prisma.usageLedger.deleteMany({ where: { userId: user } });
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { id: user } });
      await prisma.$disconnect();
    });

    it('reserves the estimate, then settles to the seconds the audio really took', async () => {
      const heard = await service.meter(user, 'listen', 30, async () => ({
        value: 'transcript',
        seconds: 12.2,
      }));
      expect(heard).toBe('transcript');
      expect(await ledger()).toEqual({ listenSeconds: 13, speakSeconds: 0, modelMicroUsd: 0n });
      const charge = await prisma.voiceCharge.findFirst({ where: { userId: user } });
      expect(charge).toMatchObject({ kind: 'LISTEN', seconds: 13 });
      expect(charge?.settledAt).not.toBeNull();
    });

    it('counts heard and made apart: spoken replies cannot spend dictation minutes', async () => {
      limits.speak = 10;
      await service.meter(user, 'speak', 5, async () => ({ value: 1, seconds: 10 }));
      await expect(
        service.meter(user, 'speak', 5, async () => ({ value: 2, seconds: 5 })),
      ).rejects.toBeInstanceOf(VoiceAllowanceExhaustedError);
      // Listening still has all of its allowance.
      await expect(
        service.meter(user, 'listen', 5, async () => ({ value: 'ok', seconds: 5 })),
      ).resolves.toBe('ok');
      expect(await ledger()).toMatchObject({ listenSeconds: 5, speakSeconds: 10 });
    });

    it('refuses before calling ElevenLabs once the allowance is spent', async () => {
      limits.listen = 20;
      await service.meter(user, 'listen', 20, async () => ({ value: 1, seconds: 20 }));
      let called = false;
      await expect(
        service.meter(user, 'listen', 5, async () => {
          called = true;
          return { value: 2, seconds: 5 };
        }),
      ).rejects.toMatchObject({ usage: 'listen' });
      expect(called).toBe(false);
    });

    it('refuses a plan with none of that kind, and an account with no plan', async () => {
      limits.speak = 0;
      await expect(
        service.meter(user, 'speak', 5, async () => ({ value: 1, seconds: 5 })),
      ).rejects.toBeInstanceOf(VoiceAllowanceExhaustedError);
      limits = { listen: 600, speak: 60, period: false };
      await expect(
        service.meter(user, 'listen', 5, async () => ({ value: 1, seconds: 5 })),
      ).rejects.toBeInstanceOf(VoiceAllowanceExhaustedError);
      expect(await ledger()).toBeNull();
    });

    it('settles a failed request to nothing and passes the failure on', async () => {
      await expect(
        service.meter(user, 'speak', 30, async () => {
          throw new Error('upstream down');
        }),
      ).rejects.toThrow('upstream down');
      expect(await ledger()).toMatchObject({ speakSeconds: 0 });
    });

    it('never refuses a plan with no limit, and still counts what it used', async () => {
      limits = { listen: null, speak: null, period: true };
      await service.meter(user, 'speak', 4000, async () => ({ value: 1, seconds: 3600 }));
      expect(await ledger()).toMatchObject({ speakSeconds: 3600 });
    });

    it('lets only one of two concurrent requests through the last of the allowance', async () => {
      limits.speak = 10;
      await service.meter(user, 'speak', 9, async () => ({ value: 0, seconds: 9 }));
      const outcomes = await Promise.allSettled(
        [1, 2].map((n) =>
          service.meter(user, 'speak', 5, async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { value: n, seconds: 5 };
          }),
        ),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    });
  },
);
