import type { McpToolDescriptor } from './mcp-tools.js';

/**
 * is this tool a read?
 *
 * MCP plugins states the ladder and the default in one sentence: "`McpTool.readOnly`
 * is set at list time from the server's `readOnlyHint` annotation when
 * present, falling back to a name pattern (`get_*`, `list_*`, `search_*`,
 * `read_*`, `fetch_*`). Anything unmatched is treated as writing."
 *
 * The default is the whole point
 *
 * The answer decides an approval default: a read runs, a
 * write asks. So the two ways to be wrong are not equal. Classifying a read as
 * a write costs an interruption the operator can undo in one click — and MCP plugins
 * gives them the mechanism, since "the user may add per-bot rules either way
 * using the existing M5 auto-review matcher". Classifying a WRITE as a read
 * spends money, sends mail, or deletes something, and the operator finds out
 * afterwards. Everything below leans the first way on purpose.
 *
 * Why the prefixes are exactly the five §6/m6 names
 *
 * A tool called `search` — no underscore — is common, and it is tempting to
 * match the bare verb too. That is the unsafe direction: the same relaxation
 * that admits `search` admits `read`, and a server that names a destructive
 * tool `reset` is one prefix away from a family that already reads as safe.
 * The five patterns are a heuristic the PRD chose over a whitelist, and
 * widening a heuristic whose failure mode is an unapproved write is not a
 * judgement call this file gets to make. A server whose naming does not fit
 * gets one approval prompt and one rule.
 *
 * Case is folded, which is normalization rather than widening: `Get_Issue` and
 * `get_issue` are the same name written twice.
 */

/** MCP plugins list, verbatim. Matched as a prefix on the server's OWN tool name. */
const READ_PREFIXES = ['get_', 'list_', 'search_', 'read_', 'fetch_'] as const;

/**
 * Whether one listed tool is a read.
 *
 * Takes the descriptor rather than a name and a hint, so a caller cannot
 * accidentally drop the annotation and fall through to the pattern — which
 * would be the silent downgrade this ladder exists to prevent.
 */
export function isReadOnlyTool(tool: McpToolDescriptor): boolean {
  // An explicit hint is the server's own claim about its own tool, either way.
  // `false` does NOT fall through to the pattern: a server that says
  // `readOnlyHint: false` on something called `get_report` knows something the
  // name does not say, and a heuristic that overrules it is a heuristic
  // deciding a tool writes nothing when its author said otherwise. (The
  // difference between absent and `false` is why `McpToolDescriptor` carries
  // `boolean | undefined` rather than a defaulted boolean —.)
  if (tool.readOnlyHint !== undefined) return tool.readOnlyHint;

  const name = tool.name.toLowerCase();
  return READ_PREFIXES.some((prefix) => name.startsWith(prefix));
}
