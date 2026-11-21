import type { ToolInfo } from '@crewaid/shared';
import { t } from '../../i18n/i18n';

/**
 * The `/` palette's text mechanics, as pure functions.
 *
 * Typing `/` opens a palette of the orchestrator's tools; picking one inserts
 * a mention into the draft. What gets inserted is the tool's ALIAS —
 * `/read-page`, not `/browser_read` — because the token stays in the
 * operator's message and they are the one who has to read it. The mention
 * travels as ordinary text (the transcript shows exactly what was typed) and
 * the ORCHESTRATOR resolves the alias back to the internal tool before
 * telling the model about it (see its `tool-mentions.ts`).
 *
 * What lives here is only what the COMPOSER needs to know: when the palette
 * is open, what it filters to, and what selecting does to the draft. Pure and
 * DOM-free so the static-markup suite can drive every rule without a textarea.
 */

/**
 * The active `/` query, or null when the palette should be closed.
 *
 * A query is the `/token` the caret currently sits in, and it is only a
 * palette trigger at a token START or after whitespace — mid-word slashes
 * (a path like `docs/readme`, a URL fragment) are the user's text, not an
 * invocation. The caret matters as much as the text: a `/` typed three
 * paragraphs back must not reopen the palette over the operator's head.
 */
export function activeSlashQuery(
  draft: string,
  caret: number,
): { readonly query: string; readonly start: number } | null {
  const before = draft.slice(0, caret);
  const match = /(^|\s)\/([A-Za-z0-9_-]*)$/.exec(before);
  if (match === null || match.index === undefined) return null;
  const slashIndex = match.index + (match[1]?.length ?? 0);
  return { query: match[2] ?? '', start: slashIndex };
}

/**
 * The palette's rows: the tools whose alias, label or internal name starts
 * with what was typed. All three spellings answer, because all three are
 * things an operator might reach for — the alias they saw, the label they
 * read, and the name a power user learned from a transcript's details.
 */
export function filterTools(tools: readonly ToolInfo[], query: string): readonly ToolInfo[] {
  const needle = query.toLowerCase();
  if (needle === '') return tools;
  return tools.filter(
    (tool) =>
      tool.alias.toLowerCase().startsWith(needle) ||
      tool.name.toLowerCase().startsWith(needle) ||
      tool.label.toLowerCase().startsWith(needle),
  );
}

/**
 * Replace the active `/query` token with the picked mention, and say where
 * the caret lands — after the trailing space the mention ends with, so the
 * operator keeps typing their sentence without reaching for the arrow keys.
 *
 * `token` is the tool's ALIAS: what gets typed is what the palette showed.
 */
export function applyToolMention(
  draft: string,
  caret: number,
  token: string,
): { readonly draft: string; readonly caret: number } {
  const active = activeSlashQuery(draft, caret);
  const start = active?.start ?? caret;
  const mention = `/${token} `;
  const next = `${draft.slice(0, start)}${mention}${draft.slice(caret)}`;
  return { draft: next, caret: start + mention.length };
}

/**
 * The row's one-line body: the curated summary, or — for a tool this build
 * has no words for — the description's first sentence.
 */
export function toolSummary(tool: ToolInfo): string {
  if (tool.summary.trim() !== '') return tool.summary.trim();
  const sentence = tool.description.split(/(?<=[.!?])\s/)[0] ?? tool.description;
  const first = sentence.trim();
  return first === ''
    ? tool.reach === 'sensitive'
      ? t('composer.tool.asksApproval')
      : t('composer.tool.runsDirectly')
    : first;
}
