// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: M2-BE-02 churn firewall
// This is the exact probe that linted CLEAN when the orchestrator block
// silently replaced the global ban (see eslint.config.mjs header note).
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness';

export type Probe = HarnessV1SandboxProvider;
