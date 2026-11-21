// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: PRD R1 / D-159 §3.12
// A provider adapter in the renderer is a provider credential in the renderer.
import { createOpenaiChat } from '@tanstack/ai-openai';

export const probe = createOpenaiChat;
