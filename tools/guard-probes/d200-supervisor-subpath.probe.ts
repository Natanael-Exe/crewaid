// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: D-200
import type { SupervisorConfig } from '@crewaid/sandbox-supervisor/src/admission.js';
export type Probe = SupervisorConfig;
