// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-imports · Guard: PRD R10 / D-159 §3.12
// The TanStack MCP client is an MCP client: orchestrator only.
import { createMCPClient } from '@tanstack/ai-mcp';

export const probe = createMCPClient;
