// First: the core's auth instance is built when auth/better-auth is first
// imported (through AppModule), and the cloud plugins must be registered by then.
import './auth/register-cloud-auth.js';
import { Module } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { readEdition } from '../common/edition.config.js';
import { processBillingConfig } from './billing/billing.config.js';
import { BillingModule } from './billing/billing.module.js';

/** The billing module, for a cloud server with Stripe configured; none otherwise. */
function billingModules() {
  const config = processBillingConfig(readEdition(process.env));
  return config === null ? [] : [BillingModule.register(config)];
}

/**
 * The cloud edition's root module (D-238): the AGPL core plus the Enterprise
 * modules it leaves out.
 *
 * The core cannot load these itself — it may not import `ee/`, and CC-06 bans
 * dynamic `import()` in the orchestrator — so the cloud edition has its own
 * composition root instead. Without Stripe keys (cloud development) billing is
 * off and every account is unlimited, exactly as in the core.
 *
 * Decided at import, like the auth instance, so the route table is fixed for
 * the life of the process.
 */
@Module({
  imports: [AppModule, ...billingModules()],
})
export class CloudAppModule {}
