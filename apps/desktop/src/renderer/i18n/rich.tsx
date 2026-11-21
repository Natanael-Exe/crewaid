import { Fragment, type ReactNode } from 'react';

/**
 * A translated sentence with markup inside it — a `<code>` command, a
 * `<strong>` name — written in the catalog as `<code>…</code>` so the
 * translator can move it where their grammar puts it. Each tag name maps to
 * how it renders; a tag with no renderer reads as its plain text, so a
 * translation can never inject markup of its own.
 */
const TAG = /<(\w+)>(.*?)<\/\1>/gs;

export function rich(
  text: string,
  tags: Readonly<Record<string, (chunks: string) => ReactNode>>,
): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TAG)) {
    const [whole, name = '', inner = ''] = match;
    if (match.index > last) parts.push(text.slice(last, match.index));
    const render = tags[name];
    parts.push(
      <Fragment key={match.index}>{render === undefined ? inner : render(inner)}</Fragment>,
    );
    last = match.index + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : parts;
}
