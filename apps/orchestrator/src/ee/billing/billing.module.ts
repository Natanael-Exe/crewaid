import { type DynamicModule, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { TurnEventsModule } from '../../agent/turn-events.module.js';
import { SandboxModule } from '../../sandbox/sandbox.module.js';
import type { BillingConfig } from './billing.config.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { SubscriptionSyncService } from './subscription-sync.service.js';
import { BillingComputePolicy } from './billing-compute.policy.js';
import { COMPUTE_POLICY } from '../../sandbox/compute-policy.js';
import { INCLUDED_MODELS } from '../../models/included-models.port.js';
import { IncludedModelsService } from './included-models.service.js';
import { HOSTED_VOICE } from '../../models/voice/hosted-voice.port.js';
import { HostedVoiceService } from './hosted-voice.service.js';
import { CALL_AGENT_FACTORY, elevenLabsCallAgent } from '../voice/elevenlabs-agent.js';
import { VoiceCallsController } from './voice-calls.controller.js';
import { VoiceCallsService } from './voice-calls.service.js';
import { BILLING_CONFIG, STRIPE_CLIENT } from './billing.tokens.js';
import { createStripeClient } from './stripe-client.js';
import { SandboxMeterService } from './sandbox-meter.service.js';

/**
 * The hosted service's plans.
 *
 * Registered by `CloudAppModule` (D-238) only when `processBillingConfig`
 * answers, which is a cloud server with Stripe configured.
 * Anywhere else its routes do not exist and answer 404, so a self-hosted
 * server has no billing surface to misconfigure or probe.
 *
 * Global, for two exports the rest of the server asks for optionally:
 * `COMPUTE_POLICY` for the sandbox lifecycle, and `INCLUDED_MODELS` for the
 * model layer when Crewaid's own OpenRouter key is configured, and `HOSTED_VOICE` when its ElevenLabs key is. Global rather than imported by `SandboxModule`, because the
 * lifecycle must not depend on billing — where this module is absent the
 * token is simply unregistered and nothing is limited.
 */
function callsOn(config: BillingConfig): boolean {
  return config.elevenlabsKey !== null && config.elevenlabsAgentId !== null;
}

@Module({})
export class BillingModule {
  static register(config: BillingConfig): DynamicModule {
    return {
      module: BillingModule,
      global: true,
      // SandboxModule for the meter, which stops a computer whose owner is out
      // of hours. No cycle: the sandbox lifecycle asks for COMPUTE_POLICY only
      // optionally, through this module being global.
      imports: [PrismaModule, TurnEventsModule, SandboxModule],
      // Calls, only with Crewaid's ElevenLabs key and its voice agent.
      controllers: [BillingController, ...(callsOn(config) ? [VoiceCallsController] : [])],
      providers: [
        { provide: BILLING_CONFIG, useValue: config },
        { provide: STRIPE_CLIENT, useValue: createStripeClient(config) },
        BillingService,
        SubscriptionSyncService,
        BillingComputePolicy,
        { provide: COMPUTE_POLICY, useExisting: BillingComputePolicy },
        // Counts computer time against each owner's plan.
        SandboxMeterService,
        // The included models, only with Crewaid's own OpenRouter key.
        ...(config.openrouterKey === null
          ? []
          : [
              IncludedModelsService,
              { provide: INCLUDED_MODELS, useExisting: IncludedModelsService },
            ]),
        // Speech on Crewaid's own key, only with that key.
        ...(config.elevenlabsKey === null
          ? []
          : [HostedVoiceService, { provide: HOSTED_VOICE, useExisting: HostedVoiceService }]),
        ...(callsOn(config)
          ? [{ provide: CALL_AGENT_FACTORY, useValue: elevenLabsCallAgent }, VoiceCallsService]
          : []),
      ],
      exports: [
        BillingService,
        COMPUTE_POLICY,
        ...(config.openrouterKey === null ? [] : [INCLUDED_MODELS]),
        ...(config.elevenlabsKey === null ? [] : [HOSTED_VOICE]),
      ],
    };
  }
}
