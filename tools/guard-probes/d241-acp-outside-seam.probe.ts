// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013 & D-241.
// Rule: no-restricted-imports · Guard: D-241 ACP single-seam boundary
import type { ClientApp } from '@agentclientprotocol/sdk';

export type Probe = ClientApp;
