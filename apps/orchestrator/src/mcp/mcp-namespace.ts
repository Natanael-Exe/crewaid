import { SlugSchema } from '@crewaid/shared';

/**
 * what an MCP tool is CALLED once the model can see it.
 *
 * MCP plugins fixes the shape: every MCP tool reaches the model as
 * `<serverSlug>__<toolName>` — `gmail__send_message` — and "collisions across
 * servers are impossible by construction". This file is the construction. It
 * is pure string rules over two inputs, so the same sentence is used by the
 * install route that refuses a slug, the projection that names a bot's tools,
 * and anything that later has to read a name back.
 *
 * Why the process-wide registry is not where these names live
 *
 * `ToolRegistry` keys one `Map` on the bare tool name and throws on a
 * duplicate, which is exactly right for a built-in: `shell` is one definition
 * for every user of this orchestrator, registered once at boot. `McpServer` is
 * `@@unique([userId, slug])` — slugs are unique PER USER, not globally — so
 * two users who each install a server called "Gmail" both produce
 * `gmail__send_message`. Registering those into the singleton would throw on
 * the second legitimate user, and R7 says v1's one hardcoded user is a guard
 * swap away from real auth, so that is a defect waiting on a login page.
 *
 * The answer is neither a scoped key nor a per-principal partition of the
 * registry: an MCP tool is not a process-wide fact at all. It belongs to one
 * user's server, it changes when that server is re-listed, and it must reach
 * a turn without a restart (MCP plugins acceptance criteria). So it is resolved
 * PER TURN, for one `(userId, botId)`, and thrown away with the turn —
 * `mcp-tool-binding.ts` builds that projection. Two users are then never in
 * one namespace, because a turn only ever holds one user's servers.
 *
 * What the registry still owes this file is the one thing that IS global: the
 * built-in names. A slug colliding with a built-in prefix is refused at
 * install time, against the live registry rather than a copied list.
 */

/** MCP plugins separator. Two underscores, and the reason both halves are checked. */
export const MCP_NAMESPACE_SEPARATOR = '__';

/**
 * The name shape the model providers accept, mirrored from `ToolRegistry`.
 *
 * Duplicated deliberately rather than imported: this module answers "would
 * that name be usable?" BEFORE anything is registered, and it has to give the
 * reason as a sentence rather than as a thrown registration error. The
 * registry's own check stays where it is — it is the fence, this is the
 * forecast — and `mcp-namespace.test.ts` pins the two against each other so
 * they cannot drift apart silently.
 */
const PROVIDER_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/** Anthropic's documented ceiling, and the lowest of the three providers'. */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * A namespaced name, or the reason there is none.
 *
 * A result rather than a throw because BOTH outcomes are ordinary. A server
 * is a third party: it may offer a tool called `search.documents`, or one
 * whose name plus the slug is 71 characters. Neither is a bug in this
 * orchestrator, and neither may take down the other fourteen tools that
 * server offers — so the caller drops one tool and says which, instead of
 * catching an exception around a listing.
 */
export type NamespacedToolName =
  { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string };

/**
 * `<slug>__<toolName>`, when the result is a name a provider will accept.
 *
 * The slug is checked too, and not because a caller is expected to pass a bad
 * one: `McpServer.slug` is written by `deriveMcpSlug` or by the curated
 * constant, so a slug that fails here means one of those two changed shape.
 * Checking is cheaper than the failure it prevents, which is a tool name that
 * a provider rejects mid-turn as a 400 the model cannot act on.
 */
export function namespacedToolName(slug: string, toolName: string): NamespacedToolName {
  if (!SlugSchema.safeParse(slug).success) {
    return {
      ok: false,
      reason: `"${slug}" is not a usable server namespace`,
    };
  }
  if (toolName === '') {
    return { ok: false, reason: 'the server reported a tool with no name' };
  }
  if (!PROVIDER_TOOL_NAME.test(toolName)) {
    return {
      ok: false,
      reason:
        `"${toolName}" uses characters the model providers do not accept in a tool name ` +
        '(letters, digits, underscore and dash only)',
    };
  }
  const name = `${slug}${MCP_NAMESPACE_SEPARATOR}${toolName}`;
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    return {
      ok: false,
      reason:
        `"${name}" is ${String(name.length)} characters and a tool name may be at most ` +
        `${String(MAX_TOOL_NAME_LENGTH)} — a shorter server name would fit it`,
    };
  }
  return { ok: true, name };
}

/**
 * Read a namespaced name back into the server and tool it was built from.
 *
 * Split on the FIRST separator, which is what makes this unambiguous: a slug
 * can contain a single `_` (`SlugSchema` allows it as a separator) but never a
 * double one, while a tool name may contain as many as it likes. So
 * `a_b__c__d` is the server `a_b` and the tool `c__d`, and there is no second
 * reading.
 *
 * `null` for anything that is not a namespaced MCP name, which includes every
 * built-in: none of them carries a `__`, and a slug half that is not a legal
 * slug is refused rather than guessed at.
 */
export function parseNamespacedToolName(
  name: string,
): { readonly slug: string; readonly toolName: string } | null {
  const at = name.indexOf(MCP_NAMESPACE_SEPARATOR);
  if (at <= 0) return null;
  const slug = name.slice(0, at);
  const toolName = name.slice(at + MCP_NAMESPACE_SEPARATOR.length);
  if (toolName === '') return null;
  if (!SlugSchema.safeParse(slug).success) return null;
  return { slug, toolName };
}

/**
 * The namespace a built-in tool name already occupies.
 *
 * §6/M6 says the registry "rejects a server whose slug collides with a
 * built-in tool prefix", and the prefix of a built-in is everything before its
 * first underscore: `browser_click` claims `browser`, `shell` claims `shell`.
 * A server slugged `browser` would offer `browser__click` beside the
 * orchestrator's own `browser_click`, and the two differ by one character in
 * the middle — which is a distinction for a parser, not for the model choosing
 * between them or the operator reading an approval prompt.
 */
function builtinPrefix(builtinName: string): string {
  const at = builtinName.indexOf('_');
  return at === -1 ? builtinName : builtinName.slice(0, at);
}

/**
 * The built-in whose namespace this slug would take, or `undefined`.
 *
 * Returns the offending NAME rather than a boolean so the refusal can quote
 * the tool the operator would have shadowed — "browser_click" says what
 * "reserved prefix" does not.
 */
export function collidingBuiltinTool(
  slug: string,
  builtinNames: Iterable<string>,
): string | undefined {
  for (const name of builtinNames) {
    if (builtinPrefix(name) === slug) return name;
  }
  return undefined;
}
