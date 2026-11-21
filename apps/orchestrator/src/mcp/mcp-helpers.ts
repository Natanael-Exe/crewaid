import { ConflictException, type Logger } from '@nestjs/common';
import type { McpServer } from '@prisma/client';
import type { McpServerSummary as WireServer } from '@crewaid/shared';
import { isMCPInputRequiredError } from '@tanstack/ai-mcp';
import { GIT_TOOL_NAMES, isCanonicalGitHub } from '../integrations/github-git/descriptors.js';
import { createGuardedFetch, type AddressResolver } from '../providers/endpoint-guard.js';
import {
  openMcpConnection,
  type CallToolResult,
  type McpConnection,
  type McpConnectionDeps,
} from './mcp-connection.js';
import { toPluginAccess } from './plugin-access.js';

/** Shared Prisma include for projecting an MCP server row into a wire summary. */
export const SERVER_SUMMARY_INCLUDE = {
  _count: { select: { tools: true } },
  bots: { select: { botId: true, enabled: true } },
  oauthFlows: { select: { expiresAt: true } },
} as const;

export type BearerAttemptResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly dispatched: boolean };

/** Renew bearers before expiry so the upcoming connect/list/call does not fail mid-flight. */
export const REFRESH_SKEW_MS = 60_000;

/** Maximum third-party error length stored in `McpServer.lastError`. */
export const MAX_FAILURE_CHARS = 2000;

/** An owned MCP server row carrying the tool count and bot grants downstream callers need. */
export type OwnedMcpServer = McpServer & {
  readonly _count: { readonly tools: number };
  readonly bots: { botId: string; enabled: boolean }[];
};

export type McpServerSummaryRow = OwnedMcpServer & {
  readonly oauthFlows: { expiresAt: Date }[];
};

/** A deadline enforced by the orchestrator rather than reported by a remote server. */
export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpTimeoutError';
  }
}

/** Bounds an operation with a timeout error rather than hanging indefinitely. */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpTimeoutError(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void work.catch(() => undefined);
  }
}

/** Truncate a third-party error message before storing or emitting it. */
export function bounded(message: string): string {
  return message.length > MAX_FAILURE_CHARS ? `${message.slice(0, MAX_FAILURE_CHARS)}…` : message;
}

/** Formats an error as a single bounded line, preserving undici's socket `cause`. */
export function describeFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.cause instanceof Error
        ? `${error.message}: ${error.cause.message}`
        : error.message
      : String(error);
  return bounded(message);
}

/** Structurally checks Prisma's unique-violation error code (P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** Structurally checks Prisma's missing-record error code (P2025). */
export function isMissingRow(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2025'
  );
}

/** Prisma can surface commit conflicts directly from the pg driver adapter. */
export function isSerializationConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === 'P2034') return true;
  if (!('cause' in error) || typeof error.cause !== 'object' || error.cause === null) return false;
  return 'kind' in error.cause && error.cause.kind === 'TransactionWriteConflict';
}

/** Returns true when a bearer has a known expiry within `skewMs` of now. */
export function expiresWithin(expiresAt: Date | null, skewMs: number): boolean {
  return expiresAt !== null && expiresAt.getTime() - Date.now() <= skewMs;
}

/**
 * Maps an MCP server row to the wire summary. `CONNECTING` is derived from any
 * unexpired OAuth flow so abandoned browser trips automatically clear on expiry.
 */
export function toSummary(row: McpServerSummaryRow): WireServer {
  const connectInFlight = row.oauthFlows.some((flow) => flow.expiresAt.getTime() > Date.now());
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    category: row.category,
    iconUrl: row.iconUrl,
    access: toPluginAccess(row),
    backend: row.backend,
    transport: row.transport,
    url: row.url,
    isPrivate: row.isPrivate,
    authType: row.authType,
    status: connectInFlight ? 'CONNECTING' : row.status,
    toolCount: row._count.tools,
    lastError: row.lastError,
  };
}

/**
 * Wraps fetch to record any 401 response without consuming the body, so the
 * auth retry ladder can detect token rejection even after the SDK wraps errors.
 */
export function recordingUnauthorized(
  base: typeof fetch,
  unauthorized: { seen: boolean },
): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.status === 401) unauthorized.seen = true;
    return response;
  };
}

/** Races an in-flight MCP call against an AbortSignal so late handshakes cannot dispatch. */
export async function withCallCancellation<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('TOOL_CANCELLED: remote call aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Surfaces unsupported mid-call MCP elicitation/sampling as a tool error rather than a server strike. */
export function inputRefused(serverName: string, kind: 'form' | 'sampling'): CallToolResult {
  const asked = kind === 'form' ? 'for input from a person' : 'to use a model';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `PLUGIN_INPUT_UNSUPPORTED: "${serverName}" asked ${asked} part-way through this call, which this app cannot provide. Nothing further was sent to it.`,
      },
    ],
  };
}

export function buildConnectionDeps(
  mcpFetch: typeof fetch | undefined,
  resolver: AddressResolver | undefined,
): McpConnectionDeps {
  return {
    ...(mcpFetch === undefined ? {} : { fetch: mcpFetch }),
    ...(resolver === undefined ? {} : { resolve: resolver }),
  };
}

export function buildAttemptDeps(
  mcpFetch: typeof fetch | undefined,
  resolver: AddressResolver | undefined,
  unauthorized: { seen: boolean },
  beforeRequest?: () => Promise<void>,
): McpConnectionDeps {
  const base = mcpFetch ?? createGuardedFetch(resolver);
  return {
    fetch: async (input, init) => {
      await beforeRequest?.();
      return recordingUnauthorized(base, unauthorized)(input, init);
    },
    ...(resolver === undefined ? {} : { resolve: resolver }),
  };
}

/** Closes a connection after an operation finishes without overriding its outcome. */
export async function closeQuietly(
  connection: { close(): Promise<void> },
  serverName: string,
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  try {
    await connection.close();
  } catch (error: unknown) {
    logger.warn(
      `mcp: closing the connection to "${serverName}" failed after the operation: ${describeFailure(error)}`,
    );
  }
}

/** Rejects direct MCP dispatch for GitHub write invariants and local Crewaid Git tools. */
export function assertCallableTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): void {
  if (
    isCanonicalGitHub(server) &&
    toolName === 'create_pull_request' &&
    typeof args['draft'] !== 'boolean'
  ) {
    throw new ConflictException('PR draft status must be normalized before authorization.');
  }
  if (GIT_TOOL_NAMES.some((name) => name === toolName)) {
    throw new ConflictException('Crewaid Git tools require bot-scoped dispatch.');
  }
}

/** Combines an optional caller AbortSignal with a per-call timeout signal. */
export function combineCallSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/** Opens one bearer-authenticated MCP connection, runs `run`, and detects any 401 response. */
export async function attemptWithBearer<T>(
  serverName: string,
  endpoint: { readonly url: string; readonly transport: 'HTTP' | 'SSE' },
  accessToken: string,
  run: (connection: McpConnection) => Promise<T>,
  deps: {
    readonly mcpFetch: typeof fetch | undefined;
    readonly resolver: AddressResolver | undefined;
    readonly logger: Pick<Logger, 'warn'>;
    readonly beforeRequest?: (() => Promise<void>) | undefined;
  },
): Promise<BearerAttemptResult<T>> {
  const unauthorized = { seen: false };
  let connection: McpConnection | undefined;
  let dispatched = false;
  try {
    connection = await openMcpConnection(
      { ...endpoint, headers: { authorization: `Bearer ${accessToken}` } },
      buildAttemptDeps(deps.mcpFetch, deps.resolver, unauthorized, deps.beforeRequest),
    );
    dispatched = true;
    const value = await run(connection);
    if (!unauthorized.seen) return { ok: true, value };
  } catch (error: unknown) {
    if (!unauthorized.seen) throw error;
  } finally {
    if (connection !== undefined) await closeQuietly(connection, serverName, deps.logger);
  }
  return { ok: false, dispatched };
}

/** Dispatches a single MCP tool call on an open connection, translating mid-call input prompts. */
export async function invokeMcpTool(
  connection: McpConnection,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  signal.throwIfAborted();
  try {
    return await connection.callTool(toolName, args, signal);
  } catch (error: unknown) {
    if (!isMCPInputRequiredError(error)) throw error;
    return inputRefused(serverName, error.kind);
  }
}
