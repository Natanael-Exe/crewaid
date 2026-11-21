// PROBE — MUST FAIL LINT. D-013/D-176: SDK types must not cross the canonical execution port.
import type { ModelMessage } from 'ai';
export type LeakedHistory = readonly ModelMessage[];
