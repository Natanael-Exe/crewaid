// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: M0-04 / D-159 §2.5
// packages/shared stays Zod-only; even a type import from the AI stack is a dependency.
import type { UIMessage } from '@tanstack/ai';

export type Probe = UIMessage;
