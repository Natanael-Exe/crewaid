/**
 * Detects and collapses internal sandbox filesystem paths (`/home/bot/...`) in
 * rendered chat prose, inline code, and one-line previews so raw container
 * directories and Prisma CUIDs stay out of conversation text while remaining
 * inspectable on hover.
 */

const INTERNAL_PATH_SCAN_RE =
  /(^|[\s([{"'`:,;=])(\/home\/bot(?:\/[^\s"'<>`()[\]{}]+)?)/g;
const STANDALONE_INTERNAL_PATH_RE = /^\/home\/bot(?:\/[^\s"'<>`()[\]{}]+)?$/;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;
const BARE_INTERNAL_DIR_RE = /^\/home\/bot(?:\/(?:shared|agents|groups)(?:\/[^/]+)?)?$/;
const CUID_LIKE_SEGMENT_RE = /^c[a-z0-9]{18,}$/i;

export type InternalPathSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'path'; readonly value: string };

/**
 * Human-readable short label for an internal sandbox path, or `null` when the
 * path points only to an internal root or CUID-keyed directory (in which case
 * callers render the localized "path" affordance rather than leaking an ID).
 */
export function readableInternalPathName(filePath: string): string | null {
  const trimmed = filePath.trim().replace(/\/+$/, '');
  if (trimmed === '' || BARE_INTERNAL_DIR_RE.test(trimmed)) return null;
  const parts = trimmed.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (last === undefined || CUID_LIKE_SEGMENT_RE.test(last)) return null;
  return last;
}

/** Splits ordinary text into prose runs and internal sandbox paths. */
export function internalPathSegments(text: string): InternalPathSegment[] {
  if (!text.includes('/home/bot')) return [{ kind: 'text', value: text }];

  const segments: InternalPathSegment[] = [];
  let cursor = 0;
  INTERNAL_PATH_SCAN_RE.lastIndex = 0;

  let match = INTERNAL_PATH_SCAN_RE.exec(text);
  while (match !== null) {
    const prefix = match[1] ?? '';
    const raw = match[2] ?? '';
    const pathStart = match.index + prefix.length;
    const cleaned = raw.replace(TRAILING_PUNCT_RE, '');
    if (cleaned === '') {
      match = INTERNAL_PATH_SCAN_RE.exec(text);
      continue;
    }
    if (cursor < pathStart) {
      segments.push({ kind: 'text', value: text.slice(cursor, pathStart) });
    }
    segments.push({ kind: 'path', value: cleaned });
    cursor = pathStart + cleaned.length;
    // Rewind past any stripped trailing punctuation so adjacent delimiters
    // (e.g. `,` or `:`) remain available as a boundary for a following path.
    INTERNAL_PATH_SCAN_RE.lastIndex = cursor;
    match = INTERNAL_PATH_SCAN_RE.exec(text);
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', value: text.slice(cursor) });
  }
  return segments.length === 0 ? [{ kind: 'text', value: text }] : segments;
}

/**
 * Replaces raw `/home/bot/...` paths in single-line previews (such as sidebar
 * snippets) with their clean filename or a fallback word.
 */
export function formatPreviewInternalPaths(text: string, fallbackLabel = 'path'): string {
  if (!text.includes('/home/bot')) return text;
  return internalPathSegments(text)
    .map((segment) =>
      segment.kind === 'text'
        ? segment.value
        : (readableInternalPathName(segment.value) ?? fallbackLabel),
    )
    .join('');
}

/** Minimal mdast node shape touched by the remark plugin. */
type MdNode = { type: string; value?: string; children?: MdNode[]; data?: unknown };

/**
 * Remark plugin that turns internal sandbox paths (`/home/bot/...`) in prose
 * and standalone inline code into `<sandboxpath path="...">` elements, leaving
 * links and fenced code blocks literal.
 */
export function remarkInternalPaths() {
  const walk = (node: MdNode): void => {
    const children = node.children;
    if (children === undefined || node.type === 'link' || node.type === 'code') return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      if (child.type === 'inlineCode' && child.value !== undefined) {
        const trimmed = child.value.trim();
        if (STANDALONE_INTERNAL_PATH_RE.test(trimmed)) {
          children[index] = {
            type: 'internalPath',
            data: { hName: 'sandboxpath', hProperties: { path: trimmed } },
            children: [{ type: 'text', value: trimmed }],
          };
        }
        continue;
      }
      if (child.type !== 'text' || child.value === undefined) {
        walk(child);
        continue;
      }
      const segments = internalPathSegments(child.value);
      if (segments.every((segment) => segment.kind === 'text')) continue;
      const replacement: MdNode[] = segments.map((segment) =>
        segment.kind === 'text'
          ? { type: 'text', value: segment.value }
          : {
              type: 'internalPath',
              data: { hName: 'sandboxpath', hProperties: { path: segment.value } },
              children: [{ type: 'text', value: segment.value }],
            },
      );
      children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
    }
  };
  return () => (tree: MdNode) => walk(tree);
}
