/**
 * `/tool` mentions in the user's message — the composer's palette contract.
 *
 * The operator can name a tool explicitly (typing `/` in the composer opens
 * the palette; picking one inserts `/tool_name` into the text). The mention
 * travels as ordinary message text — the stored row keeps the user's words
 * verbatim — but the PROMPT has to turn it into a directive, or the mention
 * is just punctuation the model may politely ignore: a model told "use
 * /capture_screen" in prose reads it as emphasis, not instruction.
 *
 * The hint is appended to the trigger content (prompt-only, never stored),
 * bracketed so it reads as an operator-side note rather than something the
 * user literally typed, and it does three things: name the tools, bind the
 * choice ("rather than working around them" — the whole point of naming one),
 * and say what to do about missing inputs. That last clause is what makes
 * "tools will ask for questions or inputs" true: the tool's own schema has
 * the parameters, the model has the mention, and a parameter the model cannot
 * fill becomes a question to the user instead of an invented value.
 */

/**
 * The tool names the user explicitly mentioned, in the order they appear.
 *
 * A `/` token is a mention only when `resolveTool` can name the tool behind
 * it — the palette's ALIAS (`/read-page`) or the internal name — so prose
 * containing paths, versions and invented words produces no directives.
 * Duplicates collapse; the first mention's position is the one the hint
 * preserves.
 *
 * `resolveTool` returns the INTERNAL name, because that is what the hint must
 * say: the model calls `browser_read`, never `read-page`.
 */
export function explicitToolMentions(
  content: string,
  resolveTool: (token: string) => string | null,
): string[] {
  const mentioned: string[] = [];
  const seen = new Set<string>();
  const pattern = /(^|\s)\/([A-Za-z0-9_-]+)/g;
  for (const match of content.matchAll(pattern)) {
    const token = match[2];
    if (token === undefined || seen.has(token)) continue;
    const name = resolveTool(token);
    if (name === null) continue;
    seen.add(token);
    if (!mentioned.includes(name)) mentioned.push(name);
  }
  return mentioned;
}

/** The prompt copy a non-empty mention list rides on. */
export function withToolMentionHint(content: string, mentions: readonly string[]): string {
  if (mentions.length === 0) return content;
  return (
    `${content}\n\n[The user explicitly asked you to use these tools in this reply: ` +
    `${mentions.join(', ')}. Use them for this task rather than working around them. ` +
    'If one needs inputs you do not have, ask the user for them rather than inventing values.]'
  );
}
