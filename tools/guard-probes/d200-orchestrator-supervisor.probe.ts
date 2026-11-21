// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: D-200
// If this file ever lints CLEAN, the orchestrator could load the supervisor —
// and with it the Docker client the socket was taken away from.
import { createSupervisorServer } from '@crewaid/sandbox-supervisor';

export const probe = createSupervisorServer;
