import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  callSiteKey,
  discoverPrismaCallSites,
  SOURCE_ROOT,
  unlistedCallSites,
  type AllowlistEntry,
  type ExemptAllowlistEntry,
  type ScopedAllowlistEntry,
} from '../prisma-call-sites.js';

/**
 * R7's Prisma call-site audit over the Enterprise code (D-238).
 *
 * The same walker and the same rules as the core allowlist, over
 * `src/ee/` alone, so the core's list never names an `ee/` file and the core
 * audit still passes with `ee/` deleted.
 */

const SCOPED_ALLOWLIST: ScopedAllowlistEntry[] = [
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.accountOf',
    receiver: 'prisma',
    model: 'user',
    operation: 'findUniqueOrThrow',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.addComputeSeconds',
    receiver: 'prisma',
    model: 'usageLedger',
    operation: 'upsert',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.computeSecondsUsed',
    receiver: 'prisma',
    model: 'usageLedger',
    operation: 'findUnique',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.customerFor',
    receiver: 'prisma',
    model: 'user',
    operation: 'findUniqueOrThrow',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.customerFor',
    receiver: 'prisma',
    model: 'user',
    operation: 'updateMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.modelMicroUsdUsed',
    receiver: 'prisma',
    model: 'usageLedger',
    operation: 'findUnique',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.portal',
    receiver: 'prisma',
    model: 'user',
    operation: 'findUniqueOrThrow',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.reserveModelCharge',
    receiver: 'prisma',
    model: '$client',
    operation: '$transaction',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.reserveModelCharge',
    receiver: 'tx',
    model: 'modelCharge',
    operation: 'create',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.reserveModelCharge',
    receiver: 'tx',
    model: 'usageLedger',
    operation: 'updateMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.reserveModelCharge',
    receiver: 'tx',
    model: 'usageLedger',
    operation: 'upsert',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.settleModelCharge',
    receiver: 'prisma',
    model: '$client',
    operation: '$transaction',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.settleModelCharge',
    receiver: 'tx',
    model: 'modelCharge',
    operation: 'findFirst',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.settleModelCharge',
    receiver: 'tx',
    model: 'modelCharge',
    operation: 'updateMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.settleModelCharge',
    receiver: 'tx',
    model: 'usageLedger',
    operation: 'update',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.status',
    receiver: 'prisma',
    model: 'usageLedger',
    operation: 'findUnique',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/billing.service.ts',
    scope: 'BillingService.subscriptionsOf',
    receiver: 'prisma',
    model: 'subscription',
    operation: 'findMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/hosted-voice.service.ts',
    scope: 'HostedVoiceService.reserve',
    receiver: 'prisma',
    model: '$client',
    operation: '$transaction',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/hosted-voice.service.ts',
    scope: 'HostedVoiceService.reserve',
    receiver: 'tx',
    model: 'usageLedger',
    operation: 'updateMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/hosted-voice.service.ts',
    scope: 'HostedVoiceService.reserve',
    receiver: 'tx',
    model: 'usageLedger',
    operation: 'upsert',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/hosted-voice.service.ts',
    scope: 'HostedVoiceService.reserve',
    receiver: 'tx',
    model: 'voiceCharge',
    operation: 'create',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/hosted-voice.service.ts',
    scope: 'HostedVoiceService.settle',
    receiver: 'prisma',
    model: '$client',
    operation: '$transaction',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/hosted-voice.service.ts',
    scope: 'HostedVoiceService.settle',
    receiver: 'tx',
    model: 'usageLedger',
    operation: 'updateMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/hosted-voice.service.ts',
    scope: 'HostedVoiceService.settle',
    receiver: 'tx',
    model: 'voiceCharge',
    operation: 'findFirst',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/hosted-voice.service.ts',
    scope: 'HostedVoiceService.settle',
    receiver: 'tx',
    model: 'voiceCharge',
    operation: 'updateMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.ensureFor',
    receiver: 'prisma',
    model: '$client',
    operation: '$transaction',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.ensureFor',
    receiver: 'prisma',
    model: 'providerConnection',
    operation: 'findFirst',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.ensureFor',
    receiver: 'tx',
    model: '$client',
    operation: '$executeRaw',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.provision',
    receiver: 'tx',
    model: 'providerConnection',
    operation: 'count',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.provision',
    receiver: 'tx',
    model: 'providerConnection',
    operation: 'create',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.provision',
    receiver: 'tx',
    model: 'providerConnection',
    operation: 'findFirst',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.provision',
    receiver: 'tx',
    model: 'providerModel',
    operation: 'findFirst',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.provision',
    receiver: 'tx',
    model: 'userSettings',
    operation: 'findFirst',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.provision',
    receiver: 'tx',
    model: 'userSettings',
    operation: 'upsert',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/voice-calls.service.ts',
    scope: 'VoiceCallsService.rows',
    receiver: 'prisma',
    model: 'voiceCall',
    operation: 'findMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/voice-calls.service.ts',
    scope: 'VoiceCallsService.settle',
    receiver: 'prisma',
    model: 'voiceCall',
    operation: 'updateMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/voice-calls.service.ts',
    scope: 'VoiceCallsService.start',
    receiver: 'prisma',
    model: 'bot',
    operation: 'findFirst',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/voice-calls.service.ts',
    scope: 'VoiceCallsService.start',
    receiver: 'prisma',
    model: 'voiceCall',
    operation: 'create',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/voice-calls.service.ts',
    scope: 'VoiceCallsService.update',
    receiver: 'prisma',
    model: 'voiceCall',
    operation: 'updateMany',
    policy: 'scoped',
    ownershipToken: 'userId',
  },
];

const EXEMPT_ALLOWLIST: ExemptAllowlistEntry[] = [
  {
    file: 'apps/orchestrator/src/ee/billing/included-models.service.ts',
    scope: 'IncludedModelsService.provision',
    receiver: 'tx',
    model: 'providerModel',
    operation: 'createMany',
    policy: 'exempt',
    reason:
      "Included models added to a connection this transaction just read or created for the account, by that connection's id, under the account's lock.",
  },
  {
    file: 'apps/orchestrator/src/ee/billing/subscription-sync.service.ts',
    scope: 'SubscriptionSyncService.ownerOf',
    receiver: 'prisma',
    model: 'user',
    operation: 'findFirst',
    policy: 'exempt',
    reason:
      'Stripe webhook, signature-verified: finds the user who owns the Stripe customer, which is the only identity the event carries.',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/subscription-sync.service.ts',
    scope: 'SubscriptionSyncService.sync',
    receiver: 'prisma',
    model: 'subscription',
    operation: 'upsert',
    policy: 'exempt',
    reason:
      'Stripe webhook, signature-verified: the row is keyed by Stripe subscription id and its owner was resolved from the Stripe customer the checkout wrote to that user.',
  },
  {
    file: 'apps/orchestrator/src/ee/billing/sandbox-meter.service.ts',
    scope: 'SandboxMeterService.meter',
    receiver: 'prisma',
    model: 'sandbox',
    operation: 'updateMany',
    policy: 'exempt',
    reason:
      "Background meter: moves one computer's watermark by compare-and-swap on its id and previous value; no principal exists.",
  },
  {
    file: 'apps/orchestrator/src/ee/billing/sandbox-meter.service.ts',
    scope: 'SandboxMeterService.sweep',
    receiver: 'prisma',
    model: 'sandbox',
    operation: 'findMany',
    policy: 'exempt',
    reason:
      'Background meter over every computer holding a host slot, like the idle and health sweeps; each row is charged to its own userId.',
  },
];

const PRISMA_ALLOWLIST: AllowlistEntry[] = [...SCOPED_ALLOWLIST, ...EXEMPT_ALLOWLIST];

describe('Prisma call-site ownership allowlist — Enterprise code', () => {
  it('allowlists every ee/ Prisma call site by enclosing scope and checks ownership tokens', () => {
    const actual = discoverPrismaCallSites(join(SOURCE_ROOT, 'ee'));
    const actualKeys = actual.map(callSiteKey).sort();
    const listedKeys = PRISMA_ALLOWLIST.map(callSiteKey).sort();

    // A zero-length walk would make every assertion below vacuously true.
    expect(actual.length).toBeGreaterThan(0);
    expect(new Set(listedKeys).size).toBe(listedKeys.length);
    expect(actualKeys).toEqual(listedKeys);
    expect(unlistedCallSites(actual, PRISMA_ALLOWLIST)).toEqual([]);

    for (const entry of SCOPED_ALLOWLIST) {
      const site = actual.find((candidate) => callSiteKey(candidate) === callSiteKey(entry));
      expect(site, `missing scoped call site ${callSiteKey(entry)}`).toBeDefined();
      expect(site?.sourceText).toContain(entry.ownershipToken);
    }

    for (const entry of EXEMPT_ALLOWLIST) {
      expect(entry.reason.length, `uncommented exemption ${callSiteKey(entry)}`).toBeGreaterThan(
        20,
      );
    }
  });
});
