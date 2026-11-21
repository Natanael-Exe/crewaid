/**
 * How one catalog message becomes text. Pure, so it is tested without
 * a catalog or a locale store.
 *
 * A message is a string with `{name}` placeholders, or a plural message: one
 * string per `Intl.PluralRules` category the language uses, chosen by the
 * `count` parameter. `other` is the one category every language has, so it is
 * the one a plural message must carry.
 */

export type PluralMessage = Readonly<
  Partial<Record<Intl.LDMLPluralRule, string>> & { readonly other: string }
>;
export type Message = string | PluralMessage;
export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Numbers are written the language's way ("1 234" in French), and a missing
 * parameter stays visible as `{name}`: a gap in a sentence is a bug someone
 * should see, not one an empty string should hide.
 */
export function formatMessage(
  message: Message,
  params: MessageParams | undefined,
  locale: string,
): string {
  const text =
    typeof message === 'string' ? message : pluralVariant(message, params?.['count'], locale);
  if (params === undefined) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : value;
  });
}

function pluralVariant(
  message: PluralMessage,
  count: string | number | undefined,
  locale: string,
): string {
  if (typeof count !== 'number') return message.other;
  return message[new Intl.PluralRules(locale).select(count)] ?? message.other;
}

/** Every `{name}` a message uses, in every variant — what the catalog check compares. */
export function placeholdersOf(message: Message): ReadonlySet<string> {
  const texts = typeof message === 'string' ? [message] : Object.values(message);
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}
