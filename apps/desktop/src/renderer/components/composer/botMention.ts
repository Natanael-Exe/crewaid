export type MentionBot = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly avatarColor: string;
};

export type CompletedBotMention = {
  readonly start: number;
  readonly end: number;
  readonly value: string;
};

/** The stable text range created by choosing a row from the bot palette. */
export function completedBotMention(name: string, caret: number): CompletedBotMention {
  const value = `@${name.trim()} `;
  return { start: caret - value.length, end: caret, value };
}

/**
 * Whether the caret has moved on from a mention selected in the palette.
 * Editing the stored range makes it a query again; text after it does not.
 */
export function isAfterCompletedBotMention(
  draft: string,
  caret: number,
  active: { readonly start: number } | null,
  completed: CompletedBotMention | null,
): boolean {
  return (
    active !== null &&
    completed !== null &&
    active.start === completed.start &&
    caret >= completed.end &&
    draft.slice(completed.start, completed.end) === completed.value
  );
}

/** The `@query` at the caret, when the operator is addressing a bot. */
export function activeBotQuery(
  draft: string,
  caret: number,
): { readonly query: string; readonly start: number } | null {
  const before = draft.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  // Mentions may contain spaces because bot names may. A newline or sentence
  // punctuation ends the address instead of keeping a stale palette open.
  if (/\r|\n|[.,;:!?()[\]{}]/.test(query)) return null;
  return { query, start: at };
}

export function filterBots(bots: readonly MentionBot[], query: string): readonly MentionBot[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return bots;
  return bots.filter(
    (bot) => bot.name.toLowerCase().startsWith(needle) || bot.role.toLowerCase().startsWith(needle),
  );
}

/** Replace only the active query; the rest of the draft stays byte-for-byte. */
export function applyBotMention(
  draft: string,
  caret: number,
  name: string,
): { readonly draft: string; readonly caret: number } {
  const active = activeBotQuery(draft, caret);
  const start = active?.start ?? caret;
  const mention = `@${name.trim()} `;
  const next = `${draft.slice(0, start)}${mention}${draft.slice(caret)}`;
  return { draft: next, caret: start + mention.length };
}

export type MentionSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'mention'; readonly value: string; readonly bot: MentionBot };

function isWord(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

/**
 * Finds roster-backed mentions in ordinary markdown text.
 *
 * Duplicate names are intentionally not linked: the backend refuses that
 * ambiguity too, and opening an arbitrary conversation would be worse than a
 * tag that stays plain text.
 */
export function mentionSegments(text: string, bots: readonly MentionBot[]): MentionSegment[] {
  const byName = new Map<string, MentionBot[]>();
  for (const bot of bots) {
    const key = bot.name.trim().toLowerCase();
    if (key === '') continue;
    byName.set(key, [...(byName.get(key) ?? []), bot]);
  }
  const names = [...byName.entries()]
    .filter(([, matches]) => matches.length === 1)
    .sort(([left], [right]) => right.length - left.length);
  if (names.length === 0 || !text.includes('@')) return [{ kind: 'text', value: text }];

  const lower = text.toLowerCase();
  const segments: MentionSegment[] = [];
  let cursor = 0;
  let scan = 0;
  while (scan < text.length) {
    const at = text.indexOf('@', scan);
    if (at < 0) break;
    if (isWord(text[at - 1])) {
      scan = at + 1;
      continue;
    }
    const match = names.find(([name]) => {
      if (!lower.startsWith(name, at + 1)) return false;
      return !isWord(text[at + 1 + name.length]);
    });
    if (match === undefined) {
      scan = at + 1;
      continue;
    }
    if (cursor < at) segments.push({ kind: 'text', value: text.slice(cursor, at) });
    const end = at + 1 + match[0].length;
    segments.push({ kind: 'mention', value: text.slice(at, end), bot: match[1][0]! });
    cursor = end;
    scan = end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) });
  return segments.length === 0 ? [{ kind: 'text', value: text }] : segments;
}
