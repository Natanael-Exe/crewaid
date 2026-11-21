// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: PRD R2 (D-200)
// If this file ever lints CLEAN, the dockerode ban is not firing.
import Docker from 'dockerode';

export const probe = Docker;
