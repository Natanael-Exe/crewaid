/**
 * Reading a document's title out of its own text, for the preview card and
 * the reader. Pure, so the rules are tested without rendering anything.
 */

const HEADING = /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/;

/** Inline markdown that reads as noise in a plain-text title. */
function plainInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, '$2')
    .trim();
}

/**
 * The document's first level-one or level-two heading, when it opens the
 * document (only blank lines before it); otherwise the fallback, usually the
 * filename. A heading halfway down names a section, not the document.
 */
export function documentTitle(source: string, fallback: string): string {
  for (const line of source.split('\n')) {
    if (line.trim() === '') continue;
    const match = HEADING.exec(line);
    const title = match?.[1] === undefined ? '' : plainInline(match[1]);
    return title === '' ? fallback : title;
  }
  return fallback;
}

/**
 * The body without the opening heading `documentTitle` lifted out, so the
 * reader does not print the title twice — once in display type, once as the
 * markdown's own H1.
 */
export function withoutLeadingTitle(source: string): string {
  const lines = source.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1 || !HEADING.test(lines[first] ?? '')) return source;
  return lines
    .slice(first + 1)
    .join('\n')
    .replace(/^\s*\n/, '');
}
