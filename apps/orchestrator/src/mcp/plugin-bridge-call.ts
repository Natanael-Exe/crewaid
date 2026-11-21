import { PluginBridgeCallSchema } from '@crewaid/shared';

export { FIND_PLUGIN_TOOLS, USE_PLUGIN_TOOL } from '@crewaid/shared';

/**
 * the shape of a call through the plugin bridge, and the two names it
 * is made of.
 *
 * Why this is its own file and not part of the bridge
 *
 * Three callers have to agree about this vocabulary and no two of them may
 * import each other:
 *
 * `mcp/mcp-indirect-tools.ts` BUILDS the doors — it defines them under these
 * names and reads a call's payload to know which tool it is really about.
 *
 * `agent/tool-approval.ts` READS the same payload off the SDK's transcript
 * part, so the operator is told which plugin tool they are being asked
 * about instead of the name of the door.
 *
 * The RENDERER reads it off a WebSocket tool part for the same reason, which is
 * why the names and the payload schema live in `@crewaid/shared` and this file
 * re-exports them: a wire shape has one source of truth, and a bridge call
 * became a wire shape the moment it reached a transcript.
 *
 * A leaf that imports only the contract package is what lets all three speak
 * it without an edge `agent → mcp → agent`, which is the cycle `TurnPlugins`
 * and `TurnEventsModule` already exist to keep broken.
 *
 * The payload is deliberately dumb
 *
 * `{tool, arguments}` and nothing else. The approval side needs to read it
 * WITHOUT the bot's catalogue — it runs while a turn is suspended, off a
 * message part, with no server rows in hand — so the name it recovers has to
 * be recoverable from the call alone. What it does NOT recover is the
 * classification: `readOnly` is a property of the server's listing, and the
 * side that decides whether to ask reads that from the binding itself rather
 * than from a string the model produced.
 */

/** What one bridge call is asking for, as far as its own arguments can say. */
export type PluginToolRequest = {
  /** The namespaced name, `<slug>__<tool>`, exactly as a direct tool would be. */
  readonly name: string;
  readonly args: Record<string, unknown>;
};

/**
 * The tool a bridge call names, or `undefined` when the arguments do not name
 * one.
 *
 * Total and unthrowing, for the same reason `decideAutoReview` is: it is
 * reached from inside a turn, and MCP plugins first rule is that one broken plugin
 * must never fail a turn. A payload this build cannot read is `undefined`
 * rather than an exception, and every caller has a safe answer for that —
 * refuse the call, or fall back to the door's own name in a prompt.
 *
 * `safeParse` rather than a hand-rolled walk over the record, because the
 * shape is a published schema now and two readings of it would be two
 * definitions of what a bridge call is.
 */
export function pluginToolRequest(args: unknown): PluginToolRequest | undefined {
  const parsed = PluginBridgeCallSchema.safeParse(args);
  if (!parsed.success) return undefined;
  return { name: parsed.data.tool, args: parsed.data.arguments ?? {} };
}
