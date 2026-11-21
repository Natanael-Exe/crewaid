// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: D-160 — TanStack AI enters the orchestrator through its seams
// Linted under the orchestrator's block, outside every seam directory.
import { chat } from '@tanstack/ai';

export const probe = chat;
