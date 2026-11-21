import { z } from 'zod';
import { JsonSchemaObjectSchema, type Json } from '@crewaid/shared';

/**
 * what `tools/list` says, in the shape the rest of M6 needs.
 *
 * Why this parses instead of casting
 *
 * The SDK validates the JSON-RPC envelope and hands back `ListToolsResult`,
 * but its `annotations` schema is deliberately loose — the MCP spec's
 * `ToolAnnotations` carries `readOnlyHint` and this SDK version only names
 * `title` on the type. So the field MCP plugins read-only classification is built
 * on is, from TypeScript's point of view, of unknown shape. `as` would compile
 * and would also compile after the server stopped sending it; a parse is what
 * makes "the annotation was absent" and "the annotation was a string" the same
 * answer here (no hint) instead of two different runtime surprises in the
 * classifier.
 *
 * Nothing here decides anything. `readOnlyHint` is carried through raw, and
 * the fallback ladder MCP plugins describes — annotation, then name pattern, then
 * treat as a write — belongs to, which is also where the safe default
 * lives.
 */

export class McpProtocolError extends Error {
  readonly code = 'MCP_PROTOCOL' as const;

  constructor(message: string) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

/** One tool as reported by one server, before namespacing. */
export type McpToolDescriptor = {
  /** The server's own name, exactly as it will be called. */
  readonly name: string;
  /** Empty when the server sent none; the column is not nullable. */
  readonly description: string;
  /** The JSON Schema the model will be given, verbatim. */
  readonly inputSchema: Record<string, Json>;
  /**
   * The server's `readOnlyHint`, when it sent one.
   *
   * `undefined` means "no claim" — not "false". needs the difference:
   * absent falls through to the name pattern, `false` does not.
   */
  readonly readOnlyHint: boolean | undefined;
};

/**
 * What the server said about one tool.
 *
 * Optional fields are optional because the spec makes them optional: a tool
 * may carry no description and no input schema (`inputSchema` defaults to the
 * empty object schema), and a server is not obliged to annotate anything.
 */
const ServerToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: JsonSchemaObjectSchema.optional(),
  annotations: z.unknown().optional(),
});

/** The one annotation M6 reads today. Loose: future spec keys pass through unread. */
const ToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
});

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'it did not match the tool schema';
  const path = issue.path.join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

/**
 * One tool from the wire, or a refusal naming why it cannot be used.
 *
 * Refusing the listing rather than skipping the tool is deliberate: a tool
 * dropped silently here is a capability the model will never be told it lost,
 * and the operator finds out by watching a bot fail to do something it says it
 * can do. A server that reports an unusable tool is a server to fix.
 */
export function toToolDescriptor(tool: unknown): McpToolDescriptor {
  const parsed = ServerToolSchema.safeParse(tool);
  if (!parsed.success) {
    throw new McpProtocolError(
      `tools/list returned a tool this client cannot use — ${describeIssue(parsed.error)}.`,
    );
  }
  const annotations = ToolAnnotationsSchema.safeParse(parsed.data.annotations);
  return {
    name: parsed.data.name,
    description: parsed.data.description ?? '',
    inputSchema: parsed.data.inputSchema ?? {},
    readOnlyHint: annotations.success ? annotations.data.readOnlyHint : undefined,
  };
}
