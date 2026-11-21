// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: PRD R10
// Plugin credentials must never reach a bot container.
import { Client } from '@modelcontextprotocol/sdk';

export const probe = Client;
