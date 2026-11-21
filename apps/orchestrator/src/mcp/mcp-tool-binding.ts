import { pluginArgumentValidator } from '../agent/policy/validate-arguments.js';
import { pluginRevision } from '../agent/policy/resource-revision.js';
import { jsonSchema, tool } from '../agent/tool-contract.js';
type JsonSchemaDocument = Record<string, unknown>;
import type { CallToolResult } from './mcp-connection.js';
import { z } from 'zod';

import type { RegisteredTool, ToolBehavior } from '../agent/tool-registry.js';
import { namespacedToolName } from './mcp-namespace.js';

/**
 * a cached MCP tool, as something the model can be offered.
 *
 * This is the projection describes: a `McpTool` row plus the server it
 * belongs to becomes a `RegisteredTool` whose name is `<slug>__<toolName>` and
 * whose `execute` routes the call back to the server and tool it came from.
 * Nothing here touches the process-wide `ToolRegistry` — the result is built
 * for one turn and discarded with it, which is what keeps two users' `gmail`
 * servers out of one namespace and what makes a newly enabled plugin reachable
 * on the next turn without a restart.
 *
 * The round trip is a closure, not a parse
 *
 * `gmail__send_email` could be split back into `gmail` and `send_email` and
 * looked up — `parseNamespacedToolName` does exactly that, and the approval
 * prompt and the transcript will want it. It is the wrong mechanism for
 * DISPATCH. A slug is unique per user, so a parse answers "which server" only
 * in company with the principal, and it answers "which tool" only while every
 * server's tool names survive namespacing unchanged. The binding below closes
 * over the server id and the server's OWN tool name, so a call reaches the
 * right server and the right tool by construction, and a tool whose name had
 * to be refused simply has no binding to call.
 */

/** One `McpTool` row, as much of it as a binding needs. */
export type CachedMcpTool = {
  /** The server's own name for it, before namespacing. */
  readonly name: string;
  /** Empty when the server sent none; `McpTool.description` is not nullable. */
  readonly description: string;
  /** `McpTool.inputSchema`, the document the server published. */
  readonly inputSchema: JsonSchemaDocument;
  /**
   * `McpTool.readOnly`'s ladder classified it at list time.
   *
   * Read from the row rather than re-derived here: the ladder's first rung is
   * the server's annotation, which only the listing saw, so a second
   * classification at binding time could only ever be the weaker half of it.
   */
  readonly readOnly: boolean;
  readonly source?: 'REMOTE' | 'CREWAID_GIT';
};

/** The server a binding belongs to, named for the sentences it appears in. */
export type McpToolServer = {
  readonly id: string;
  /** What the operator called it — "Gmail". */
  readonly name: string;
  /** `McpServer.slug` — the first half of every tool name it contributes. */
  readonly slug: string;
};

/** One call, as the thing that dials a server receives it. */
export type McpToolCall = {
  readonly serverId: string;
  /** The SERVER's name for the tool, never the namespaced one. */
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /**
   * The ceiling on this call, carried from the descriptor.
   *
   * Passed rather than looked up, so the number the caller enforces is the
   * number the registry published — one source, and a test can change it in
   * one place. The ENFORCEMENT is the caller's, because it owns the socket
   * and is the only party that can close one that is not answering.
   */
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
};

/**
 * Whatever actually opens a socket and calls the tool.
 *
 * A port rather than a direct dependency on `McpServersService`, for the usual
 * reason and one more: wraps this with the 30 s call timeout and the
 * three-strike count, and it can only do that if there is a single function to
 * wrap. Throwing is this function's privilege; the binding turns a throw into
 * a tool result the model can read, which is `failure: isolate` on this path.
 */
export type McpToolCaller = (call: McpToolCall) => Promise<CallToolResult>;

/**
 * A tool the model can be offered, or the reason it cannot be.
 *
 * Both are returned, and a refusal is not an exception: a server is a third
 * party, and one tool whose name does not survive namespacing must not cost a
 * bot the other fourteen that do. The caller reports the refusals — a
 * capability a bot silently does not have is exactly what MCP plugins failure
 * isolation exists to keep visible.
 */
export type McpToolBinding =
  | { readonly ok: true; readonly tool: RegisteredTool }
  | { readonly ok: false; readonly toolName: string; readonly reason: string };

/**
 * How far an MCP tool's effects reach's classification.
 *
 * MCP plugins in two sentences: "Every MCP tool defaults to `ask`. Tools classified
 * `readOnly` default to `allow`." `reach` is where that lands, because it is
 * the field the approval matcher consults when no rule matches — and it is
 * also what `GET /tools` publishes to the operator, where the ratified schema
 * documents `contained` as "does not ask" and `sensitive` as "asks first".
 *
 * `contained` here does NOT mean the tool only touches the bot's own
 * container. A read of the operator's mailbox reaches well outside it. What
 * the two values answer — the question wrote them for — is "would a
 * careful person want to be asked about this before it happens", and MCP plugins
 * answers `no` for a read and `yes` for a write. A third value would say the
 * extra thing precisely, and `ToolInfoSchema.reach` is a ratified two-value
 * enum on the wire (§0 rule 2, ), so saying it would cost a contract
 * revision to record a distinction nothing acts on.
 *
 * Exported because the bridge needs the same answer about the same tool:
 * a call through `use_plugin_tool` is classified by the descriptor of
 * the plugin tool it names, and deriving it twice — once for a direct binding
 * and once for a catalogue entry — is how the two would come to disagree about
 * whether the operator is asked.
 */
export function mcpToolBehavior(serverId: string, readOnly: boolean): ToolBehavior {
  return {
    origin: { kind: 'mcp', serverId },
    failure: {
      kind: 'isolate-remote',
      callTimeoutMs: MCP_CALL_TIMEOUT_MS,
      strikeLimit: MCP_STRIKE_LIMIT,
    },
    // A tool its server marks read-only only looks.
    effect: readOnly ? 'read' : 'unknown',
    authority: false,
  };
}

/**
 * "MCP tool call ≤ 30 s". A bound on how long a turn waits for somebody
 * else's server, not a promise about how long a tool takes.
 */
export const MCP_CALL_TIMEOUT_MS = 30_000;

/**
 * "Three consecutive failures move the server to `ERROR`."
 *
 * Three rather than one because a single failure is usually weather — a
 * dropped socket, a deploy, a rate limit — and disabling a plugin over it
 * costs the operator a reconnect they did not need. Three rather than ten
 * because the point is to stop paying 30 s per turn for a server that is gone.
 */
export const MCP_STRIKE_LIMIT = 3;

/**
 * `McpTool.inputSchema` as the SDK's JSON Schema type.
 *
 * WHAT THIS CHECKS, AND WHAT IT CANNOT. A JSON Schema document is arbitrary
 * JSON by definition, and `JsonSchemaDocument` describes that JSON rather than
 * constraining it in any way this orchestrator could re-derive — validating it
 * properly means implementing the draft-7 metaschema, which the provider is
 * about to do anyway and will reject what it dislikes. So the only thing
 * asserted here is the one that is both checkable and load-bearing: it is a
 * JSON object. A `null`, an array or a string reaching `jsonSchema` produces
 * a definition the provider refuses for the WHOLE request, taking every other
 * tool in the turn down with it.
 *
 * A `z.custom` rather than an `as`: the claim is the same, but this one fails
 * closed at the boundary and says so, instead of compiling and being wrong
 * later somewhere that cannot tell.
 */
const JsonSchemaDocumentSchema = z.custom<JsonSchemaDocument>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  { message: 'an MCP inputSchema must be a JSON object' },
);

/**
 * Read a stored `inputSchema` column into the shape a definition needs.
 *
 * Substitutes the empty object schema rather than throwing when the column
 * holds something else: an unusable schema makes a tool that takes no
 * arguments, which is wrong but callable, where a throw is a turn that loses
 * every tool from a server because one row is malformed.
 */
export function toMcpInputSchema(value: unknown): JsonSchemaDocument {
  const parsed = JsonSchemaDocumentSchema.safeParse(value);
  return withObjectType(parsed.success ? parsed.data : {});
}

/**
 * The providers require a tool's input to be an object schema, and MCP leaves
 * `type` optional in practice — `toToolDescriptor` substitutes `{}` when a
 * server sends no schema at all. Saying it here rather than at every call site
 * keeps a bare `{}` from being rejected for the whole request.
 */
function withObjectType(document: JsonSchemaDocument): JsonSchemaDocument {
  return document.type === undefined ? { ...document, type: 'object' } : document;
}

/**
 * One entry of an MCP result's content list, as much of it as rendering needs.
 *
 * Parsed rather than narrowed off `CallToolResult`. The SDK's schemas are
 * `$loose`, so every member of that union carries an index signature and
 * TypeScript can tell none of them apart — `'content' in result` narrows
 * nothing, and `result.content` is `unknown`. A parse here is the same answer
 * `mcp-tools.ts` gives for `tools/list`: one `safeParse` decides what
 * a legal payload is, and an unrecognised part is described rather than cast.
 */
const McpContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), mimeType: z.string() }),
  z.object({
    type: z.literal('resource'),
    resource: z.union([
      z.object({ uri: z.string(), text: z.string() }),
      z.object({ uri: z.string() }),
    ]),
  }),
  z.object({ type: z.literal('resource_link'), uri: z.string(), name: z.string() }),
]);

/**
 * The two result shapes the SDK parses: a content list, or the legacy
 * `{toolResult}`. Both fields are optional here because which one arrives is
 * the server's choice, and the difference is what `mcpResultText` branches on.
 */
const McpCallResultSchema = z.object({
  content: z.array(z.unknown()).optional(),
  isError: z.boolean().optional(),
  toolResult: z.unknown().optional(),
});

/**
 * What the model reads back from one call.
 *
 * MCP content is a list of parts and the model is handed text, so the parts
 * that are not text are NAMED rather than dropped or inlined: a base64 image
 * pasted into a tool result is tens of thousands of tokens of nothing, and a
 * silently dropped one is a model reasoning about a page it was told it
 * received.
 *
 * 100 KB ceiling is applied above this, by the registry, so nothing
 * here cuts anything.
 */
export function mcpResultText(result: unknown): string {
  const parsed = McpCallResultSchema.safeParse(result);
  if (!parsed.success) {
    return 'The server answered in a shape this build cannot read.';
  }
  const { content, isError, toolResult } = parsed.data;
  if (content === undefined) {
    // The legacy `{toolResult}` shape. JSON, because there is no content list
    // to render and the shape of what is there is the server's.
    return JSON.stringify(toolResult ?? null);
  }
  const rendered = content.map(describePart).filter((part) => part !== '');
  const body = rendered.length === 0 ? 'The server returned no content.' : rendered.join('\n');
  // `isError` is the SERVER saying this call failed, not the transport saying
  // it never happened. The model is told which, and gets another step.
  return isError === true ? `The tool reported an error.\n${body}` : body;
}

function describePart(part: unknown): string {
  const parsed = McpContentPartSchema.safeParse(part);
  if (!parsed.success) {
    // A content type this build does not know. Said rather than dropped, for
    // the same reason an image is named: the model has to know something came
    // back that it is not being shown.
    return '[content of a kind this build cannot render]';
  }
  const value = parsed.data;
  switch (value.type) {
    case 'text':
      return value.text;
    case 'image':
      return `[${value.mimeType} image returned by the tool; it is not shown here]`;
    case 'resource':
      return 'text' in value.resource
        ? `[${value.resource.uri}]\n${value.resource.text}`
        : `[${value.resource.uri}: binary content, not shown here]`;
    case 'resource_link':
      return `[link: ${value.name} — ${value.uri}]`;
  }
}

/**
 * Bind one server's cached tools into per-turn definitions.
 *
 * The order of the input is preserved in the output, refusals included, so a
 * caller can report "3 of 15 tools from Gmail were not offered" against the
 * listing the operator can see.
 */
export function bindMcpTools(
  server: McpToolServer,
  tools: readonly CachedMcpTool[],
  call: McpToolCaller,
): McpToolBinding[] {
  return tools.map((cached) => bindMcpTool(server, cached, call));
}

/** One cached tool, bound. Exported for the cases that only have one. */
export function bindMcpTool(
  server: McpToolServer,
  cached: CachedMcpTool,
  callTool: McpToolCaller,
): McpToolBinding {
  const named = namespacedToolName(server.slug, cached.name);
  if (!named.ok) {
    return { ok: false, toolName: cached.name, reason: named.reason };
  }
  const name = named.name;
  return {
    ok: true,
    tool: {
      name,
      behavior: mcpToolBehavior(server.id, cached.readOnly),
      validate: pluginArgumentValidator(cached.inputSchema),
      resource: { toolName: cached.name, revision: pluginRevision(server.id, cached) },
      // Nothing about an MCP tool varies per turn: the definition is the
      // server's, the routing is the closure's, and the turn's bot appears
      // nowhere in either. The argument is ignored rather than absent because
      // `RegisteredTool` is one shape for every kind of tool.
      build: () =>
        tool({
          description: describeTool(server, cached),
          inputSchema: jsonSchema<Record<string, unknown>>(cached.inputSchema),
          execute: async (args: Record<string, unknown>, options) => {
            const valid = await pluginArgumentValidator(cached.inputSchema)(args);
            if (!valid.ok) return `INVALID_ARGUMENTS: ${valid.reason}`;
            try {
              return await callTool({
                serverId: server.id,
                toolName: cached.name,
                args,
                timeoutMs: MCP_CALL_TIMEOUT_MS,
                ...(options.abortSignal !== undefined && { abortSignal: options.abortSignal }),
              });
            } catch (error: unknown) {
              // `isolate-remote` — the model reads a refusal and gets another
              // step; the turn does not end because a third party's server
              // did. This is the one line the "one broken plugin must
              // never fail a turn" ultimately rests on, and it is deliberately
              // a `catch (unknown)` rather than a filter: a shape nobody
              // anticipated must not be the one that escapes.
              return `${name} could not be called: ${reasonFor(error)}`;
            }
          },
          toModelOutput: ({ output }) => ({
            type: 'text',
            value: typeof output === 'string' ? output : mcpResultText(output),
          }),
        }),
    },
  };
}

/**
 * The description the model is given.
 *
 * The server's own text, plus one clause naming the plugin it came from. Two
 * installed servers can both offer `search`, and the namespaced NAME says
 * which — but a model choosing between tools reads descriptions, and "from the
 * Linear plugin" is the cheapest sentence that answers it. A server that sent
 * no description gets that clause as the whole description, which is worse
 * than a real one and better than an empty string the provider may reject.
 */
function describeTool(server: McpToolServer, cached: CachedMcpTool): string {
  const from = `(from the "${server.name}" plugin)`;
  return cached.description === '' ? `${cached.name} ${from}` : `${cached.description} ${from}`;
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
