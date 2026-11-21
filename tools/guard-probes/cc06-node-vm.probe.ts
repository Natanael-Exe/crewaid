// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: PRD §7.3 / CC-06
// node:vm is NOT a security boundary. Skill scripts run in the sandbox.
import vm from 'node:vm';

export const probe = vm;
