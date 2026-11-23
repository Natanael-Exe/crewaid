// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: D-238
import { BillingModule } from '../../apps/orchestrator/src/ee/billing/billing.module.js';
export const probe = BillingModule;
