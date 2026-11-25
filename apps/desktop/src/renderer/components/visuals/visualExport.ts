import type { VisualCell, VisualChartBlock, VisualTableBlock } from '@crewaid/shared';

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function cellText(value: VisualCell | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Text a spreadsheet would run as a formula once the copied CSV is pasted.
 * Cells come from bot research and workspace files, which can carry text from
 * any web page, so a leading `'` keeps them as text. Numbers stay numbers.
 */
function csvText(value: VisualCell | undefined): string {
  const text = cellText(value);
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** RFC-4180 CSV serialization for tabular data. */
export function tableToCsv(
  cols: readonly string[],
  rows: readonly (readonly VisualCell[])[],
): string {
  const header = cols.map((col) => escapeCsvCell(csvText(col))).join(',');
  const body = rows.map((row) => cols.map((_, idx) => escapeCsvCell(csvText(row[idx]))).join(','));
  return [header, ...body].join('\n');
}

/** RFC-4180 CSV serialization for a resolved chart block. */
export function chartToCsv(block: VisualChartBlock, categoryHeader: string): string {
  const cols = [categoryHeader, ...block.series.map((s) => s.name)];
  const rows: VisualCell[][] = block.x.map((label, idx) => [
    label,
    ...block.series.map((s) => s.y[idx] ?? null),
  ]);
  return tableToCsv(cols, rows);
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** GitHub-flavored Markdown table serialization. */
export function tableToMarkdown(block: VisualTableBlock): string {
  const header = `| ${block.cols.map(escapeMarkdownCell).join(' | ')} |`;
  const divider = `| ${block.cols
    .map((_, idx) => {
      const align = block.align?.[idx];
      if (align === 'r') return '---:';
      if (align === 'c') return ':---:';
      return '---';
    })
    .join(' | ')} |`;
  const lines = block.rows.map(
    (row) =>
      `| ${block.cols.map((_, idx) => escapeMarkdownCell(cellText(row[idx]))).join(' | ')} |`,
  );
  return [header, divider, ...lines].join('\n');
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
