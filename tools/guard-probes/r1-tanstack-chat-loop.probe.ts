// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: PRD R1 / D-159 §3.12
// The renderer takes types and defineInterrupt from @tanstack/ai; chat() is the orchestrator's.
import { chat } from '@tanstack/ai';

export const probe = chat;
