import { extname } from 'node:path';

/** The file types whose words search reads. */
const TEXT_LIKE = new Set(['.md', '.markdown', '.txt', '.csv', '.json']);

/**
 * How much of a file search keeps. Postgres refuses a tsvector over 1 MB, and
 * the index is rebuilt on every write to the row, so the extract is the head
 * of the file, not all of it: enough for a report's headings and first pages.
 */
export const SEARCH_TEXT_MAX_CHARS = 64_000;

/**
 * The searchable text of a deliverable's bytes, or null when the file is not
 * text-like or has nothing in it. Invalid UTF-8 is replaced rather than
 * refused, and NUL is dropped because a Postgres text column cannot hold it.
 */
export function extractSearchText(filename: string, bytes: Uint8Array): string | null {
  if (!TEXT_LIKE.has(extname(filename).toLowerCase())) return null;
  return boundedSearchText(new TextDecoder().decode(bytes.subarray(0, SEARCH_TEXT_MAX_CHARS * 4)));
}

/** A text's searchable head, or null when there is nothing to search. */
export function boundedSearchText(text: string): string | null {
  const head = text.replaceAll('\u0000', '').slice(0, SEARCH_TEXT_MAX_CHARS);
  return head.trim() === '' ? null : head;
}
