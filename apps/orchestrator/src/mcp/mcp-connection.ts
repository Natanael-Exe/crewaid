import { createMCPClient, type MCPClient } from '@tanstack/ai-mcp';
import type { McpTransport } from '@crewaid/shared';
import {
  createGuardedFetch,
  EndpointRefusedError,
  type AddressResolver,
} from '../providers/endpoint-guard.js';
import { toToolDescriptor, type McpToolDescriptor } from './mcp-tools.js';
import { mcpTransportConfig, parseMcpTransport } from './mcp-transport.js';

/**
 * the MCP client, orchestrator-side, HTTP and SSE only.
 *
 * This is the whole of what M6 talks to a plugin server WITH. Installing one,
 * connecting it, encrypting its credential, refreshing it, naming its tools,
 * gating them and surviving its failures are … ; each of them
 * needs exactly the three verbs below and none of them needs a second client.
 *
 * Where the credential is, and where it is not
 *
 * `headers` is how a resolved bearer reaches the server, and it is a parameter
 * rather than a field read here on purpose: the credential lifecycle (
 * /05) owns decryption and refresh, and this module never sees a `McpCredential`
 * row, a database handle, or an environment secret. What it holds for the life
 * of a connection is the header value the caller handed it — which is why the
 * connection is created, used and closed inside one operation rather than kept
 * in a process-wide cache for something else to read.
 *
 * R10 is the other half: nothing here is reachable from a sandbox. The MCP
 * client lives in `apps/orchestrator`, `packages/sandbox-docker` cannot import
 * it (lint-enforced, with a probe that proves the rule fires), and no method
 * here takes a session, a container, or anything else that could carry the
 * header across that boundary.
 *
 * ⚠️ The fetch is the guarded one by DEFAULT, because an MCP server URL is a
 * URL an unprivileged user typed — the same primitive closed for custom
 * model endpoints. A host is therefore admitted by shape (https, no
 * credentials in the URL) and re-resolved at request time, and redirects are
 * refused rather than followed. `deps.fetch` exists as a test seam and for a
 * caller that has already made that decision; omitting it must not silently
 * fall back to the platform fetch, so the default is constructed here.
 */

/** One server, as the things this client needs to open it. Never the row. */
export type McpServerTarget = {
  /** Absolute URL of the server endpoint. */
  readonly url: string;
  /** HTTP or SSE. A stdio target is refused by name. */
  readonly transport: McpTransport;
  /**
   * Request headers — a resolved bearer, today. Owned by the credential
   * lifecycle, never persisted or logged here.
   */
  readonly headers?: Readonly<Record<string, string>>;
};

export type McpConnectionDeps = {
  /**
   * The fetch every request goes through. Defaults to `createGuardedFetch`.
   *
   * Tests pass a fetch that can reach a local stub; a caller passes one only
   * when it has already admitted the URL itself.
   */
  readonly fetch?: typeof fetch;
  /** Test seam for address resolution; used only when `fetch` is not given. */
  readonly resolve?: AddressResolver;
  /** Name this client reports to the server during initialize. */
  readonly clientName?: string;
  /** Version reported alongside the name. */
  readonly clientVersion?: string;
};

/** What one `tools/call` answers, as the server sent it. */
export type CallToolResult = Awaited<ReturnType<MCPClient['callTool']>>;

/** An open, initialized connection. Close it; it holds a live socket. */
export type McpConnection = {
  /** Every tool the server offers, pagination followed ( caps them). */
  listTools(): Promise<McpToolDescriptor[]>;
  /** Call one tool by its OWN name, before namespacing. */
  callTool(
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
  /** Tear the transport down. Safe to call more than once. */
  close(): Promise<void>;
};

/**
 * Connect to one MCP server and initialize the session (: `@tanstack/ai-mcp`).
 *
 * Resolves only once the handshake has succeeded, so a caller that awaits this
 * holds a connection it can immediately list or call on. A server that is
 * down, refuses the transport, or answers with something that is not MCP
 * rejects here — with the client's own error, which records as the
 * server's `lastError`; reads `NEEDS_REAUTH` off the 401 the fetch saw.
 */
export async function openMcpConnection(
  target: McpServerTarget,
  deps: McpConnectionDeps = {},
): Promise<McpConnection> {
  const transport = parseMcpTransport(target.transport);
  const request = deps.fetch ?? createGuardedFetch(deps.resolve);
  const client = await createMCPClient({
    transport: mcpTransportConfig({
      url: target.url,
      transport,
      ...(target.headers === undefined ? {} : { headers: target.headers }),
      fetch: request,
    }),
    name: deps.clientName ?? 'crewaid',
    ...(deps.clientVersion === undefined ? {} : { version: deps.clientVersion }),
    // this app answers no input request from a server — no form for the
    // operator, no model sample — so it does not claim it can. The client
    // advertises both by default.
    clientOptions: { capabilities: { elicitation: undefined, sampling: undefined } },
  }).catch((error: unknown) => {
    throw guardRefusalIn(error) ?? error;
  });

  return {
    // The client follows the cursor and refuses a duplicate name; each tool is
    // still parsed here, because the shape M6 caches is ours to vouch for.
    listTools: async () =>
      (await client.tools()).map((tool) => {
        // The library types a discovered tool's schema as `any`; the parse decides.
        const inputSchema: unknown = tool.inputSchema;
        return toToolDescriptor({
          name: tool.metadata.mcp.serverToolName,
          description: tool.description,
          inputSchema,
          annotations: tool.metadata.mcp.annotations,
        });
      }),
    callTool: (name, args, signal) =>
      client.callTool(name, args, signal === undefined ? undefined : { signal }),
    close: () => client.close(),
  };
}

/**
 * The guarded fetch's refusal, wherever the client wrapped it.
 *
 * The client reports a failed handshake as its own error with the cause
 * underneath, and a refused endpoint is not a failed server: it is the
 * operator's URL, answered 400 rather than recorded as the server's error.
 */
function guardRefusalIn(error: unknown): EndpointRefusedError | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (current instanceof EndpointRefusedError) return current;
    current = current.cause;
  }
  return undefined;
}
