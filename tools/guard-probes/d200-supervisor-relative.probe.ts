// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: D-200
import { createSupervisorServer } from '../../packages/sandbox-supervisor/src/server.js';
export const probe = createSupervisorServer;
