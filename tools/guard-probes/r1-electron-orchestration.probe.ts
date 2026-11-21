// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: PRD R1
// The client speaks HTTP and WebSocket only, even in local dev.
import { streamText } from 'ai';

export const probe = streamText;
