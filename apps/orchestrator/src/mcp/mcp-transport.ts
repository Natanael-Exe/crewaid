import type { HttpTransportConfig, SseTransportConfig } from '@tanstack/ai-mcp';
import { McpTransportSchema, type McpTransport } from '@crewaid/shared';

/** The client's URL-transport configs: never stdio, which is refused below. */
type McpTransportConfig = HttpTransportConfig | SseTransportConfig;

/**
 * the transports MCP plugins admits, and the one it refuses.
 *
 * "Transports: `HTTP` and `SSE` only. `stdio` is out of scope" is not a
 * preference about protocols. A stdio server is a command line this process
 * would spawn and talk to over its own pipes, which is to say: an arbitrary
 * third-party program running inside the orchestrator — the process that holds
 * every MCP credential and every provider key. The PRD states
 * the consequence exactly: if a stdio server is ever needed it runs in its own
 * container, never here.
 *
 * Why a runtime check when the type already says so
 *
 * `McpServerTarget.transport` is typed as the shared `McpTransport` union, so
 * a caller with a `McpServer` row cannot pass `stdio` without a cast. The value
 * still crosses a boundary this code does not own: a Prisma enum is a string
 * column, and rule is that schema and code deploy together OR NOT AT
 * ALL — a row written by a build that admits a third transport, read by this
 * one, arrives here as a string that merely claims to be an enum. Refusing at
 * the one place the transport becomes a socket is what makes that a named
 * error instead of a spawned process.
 */

export class McpTransportError extends Error {
  readonly code = 'MCP_TRANSPORT_UNSUPPORTED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'McpTransportError';
  }
}

/** The client's spelling of each transport this build admits. */
const SDK_TRANSPORT_TYPE: Record<McpTransport, McpTransportConfig['type']> = {
  HTTP: 'http',
  SSE: 'sse',
};

/**
 * Refuse anything that is not HTTP or SSE, naming what was refused.
 *
 * `value` is `unknown` on purpose: the caller's type is a claim, and this is
 * the check that does not take it on faith.
 */
export function parseMcpTransport(value: unknown): McpTransport {
  const parsed = McpTransportSchema.safeParse(value);
  if (!parsed.success) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : typeof value;
    throw new McpTransportError(
      `Unsupported MCP transport (${shown}). §6/M6 admits HTTP and SSE only: a stdio server ` +
        'is an arbitrary third-party process, and this is the process that holds the ' +
        'credentials. If one becomes necessary it runs in its own container, never here.',
    );
  }
  return parsed.data;
}

/**
 * The client transport config for one server.
 *
 * ── THE FETCH IS PASSED IN, NEVER DEFAULTED HERE ────────────────────────────
 *
 * The caller supplies it, because the caller is what decides what a URL this
 * process has never seen is allowed to reach (D-085). `openMcpConnection`
 * defaults that to the guarded fetch; this function defaults nothing, so there
 * is no path through this module that reaches the platform `fetch` by simply
 * omitting an argument.
 *
 * Every request is sent with `redirect: 'error'`, whatever fetch it goes
 * through: a permitted host that answers `302` to an internal address defeats
 * a check that only inspected the original URL, and this is the same refusal
 * D-085 made for custom model endpoints. It also keeps the credential headers
 * — which the transport attaches to every request — from following a redirect
 * to a host the operator never typed. The client has no redirect option of its
 * own, so it is set on the request.
 */
export function mcpTransportConfig(config: {
  readonly url: string;
  readonly transport: McpTransport;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch: typeof fetch;
}): McpTransportConfig {
  const request = config.fetch;
  return {
    type: SDK_TRANSPORT_TYPE[config.transport],
    url: config.url,
    // Copied rather than stored by reference: the client reads this object per
    // request, and a caller that later mutated the record it passed would be
    // mutating live request headers.
    headers: { ...config.headers },
    fetch: (input, init) => request(input, { ...init, redirect: 'error' }),
  };
}
