import { formatFileSize } from '../i18n/fileSize';
/**
 * Deliverables' small derivations: CSV into rows for the
 * preview's table, and a byte size in words. Pure and bounded, because a
 * preview is a glance at a file, not an editor for it.
 */

/** Rows past this are summarised, not rendered. */
export const CSV_PREVIEW_ROWS = 200;

/**
 * RFC 4180-ish: commas, double-quoted fields, doubled quotes inside them,
 * CRLF or LF. Enough to show a bot's export as a table; anything stranger
 * still has Download.
 */
export function parseCsv(
  text: string,
  maxRows = CSV_PREVIEW_ROWS,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), truncated: true };
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
}

export function byteSize(bytes: number): string {
  return formatFileSize(bytes);
}

/** Text files larger than this are not rendered in the rail; Download still works. */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
