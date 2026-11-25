import type { ToolSandboxSession } from '@crewaid/sandbox-core';
import {
  VISUAL_MAX_CHART_POINTS,
  VISUAL_MAX_HBAR_POINTS,
  VISUAL_MAX_NOTE_CHARS,
  VISUAL_MAX_SERIES,
  VISUAL_MAX_TABLE_COLS,
  VISUAL_MAX_TABLE_ROWS,
  type VisualCell,
  type VisualChartBlock,
  type VisualChartBlockInput,
  type VisualTableBlock,
  type VisualTableBlockInput,
} from '@crewaid/shared';

/** Hard byte ceiling: checked with `stat`, then enforced on the read itself. */
export const VISUAL_SOURCE_MAX_BYTES = 512 * 1024;

export interface ParsedDataset {
  readonly headers: readonly string[];
  readonly records: readonly Readonly<Record<string, unknown>>[];
}

export type DatasetResult =
  | { readonly ok: true; readonly dataset: ParsedDataset }
  | { readonly ok: false; readonly reason: string };

export type BoundedReadResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

export type ResolvedBlockResult<T> =
  | { readonly ok: true; readonly block: T; readonly note?: string }
  | { readonly ok: false; readonly reason: string };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Inspect file type and byte size inside the sandbox before reading so a huge
 * file or special device (FIFO, `/dev/zero`) cannot exhaust orchestrator memory.
 */
export async function readBoundedWorkspaceText(
  session: ToolSandboxSession,
  path: string,
): Promise<BoundedReadResult> {
  const probed = await session.run({
    command: `stat -L -c '%F:%s' ${shellQuote(path)}`,
  });
  if (probed.exitCode !== 0) {
    return { ok: false, reason: `${path} does not exist or cannot be read.` };
  }
  const line = probed.stdout.trim().split('\n')[0]?.trim() ?? '';
  const sep = line.lastIndexOf(':');
  if (sep <= 0) {
    return { ok: false, reason: `could not determine the size of ${path}.` };
  }
  const fileType = line.slice(0, sep);
  const size = Number.parseInt(line.slice(sep + 1), 10);
  if (fileType !== 'regular file' && fileType !== 'regular empty file') {
    return { ok: false, reason: `${path} is a ${fileType}, not a regular file.` };
  }
  if (!Number.isFinite(size) || size < 0) {
    return { ok: false, reason: `could not determine the size of ${path}.` };
  }
  if (size > VISUAL_SOURCE_MAX_BYTES) {
    return {
      ok: false,
      reason:
        `${path} is ${size.toLocaleString('en-US')} bytes (limit ` +
        `${VISUAL_SOURCE_MAX_BYTES.toLocaleString('en-US')} bytes). ` +
        'Filter or aggregate it into a smaller CSV with Python first.',
    };
  }
  // `stat` alone is a check, not a bound: the sandbox can grow the file
  // between it and the read. `head -c` caps what crosses into this process at
  // one byte over the limit however large the file has become by then.
  const read = await session.run({
    command: `head -c ${VISUAL_SOURCE_MAX_BYTES + 1} -- ${shellQuote(path)}`,
  });
  if (read.exitCode !== 0) {
    return { ok: false, reason: `${path} does not exist or cannot be read.` };
  }
  const text = read.stdout;
  if (Buffer.byteLength(text, 'utf8') > VISUAL_SOURCE_MAX_BYTES) {
    return {
      ok: false,
      reason:
        `${path} exceeds the ${VISUAL_SOURCE_MAX_BYTES.toLocaleString('en-US')}-byte limit. ` +
        'Filter or aggregate it into a smaller CSV with Python first.',
    };
  }
  if (text.includes('\u0000')) {
    return {
      ok: false,
      reason: `${JSON.stringify(path)} contains binary data. Only UTF-8 CSV, TSV, or JSON array files are supported.`,
    };
  }
  return { ok: true, text };
}

function detectDelimiter(headerLine: string, filename: string): ',' | '\t' {
  if (/\.tsv$/i.test(filename)) return '\t';
  let commas = 0;
  let tabs = 0;
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i += 1) {
    const ch = headerLine[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (ch === ',') commas += 1;
      else if (ch === '\t') tabs += 1;
    }
  }
  return tabs > commas ? '\t' : ',';
}

/** RFC-4180 CSV/TSV parser supporting quoted fields, escaped quotes, and embedded newlines. */
export function parseDelimitedRows(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a workspace UTF-8 text file as either a JSON array of objects or CSV/TSV. */
export function parseVisualDataset(rawText: string, filename: string): DatasetResult {
  const stripped = rawText.startsWith('\uFEFF') ? rawText.slice(1) : rawText;
  const trimmed = stripped.trim();
  if (trimmed === '') {
    return { ok: false, reason: `${filename} is empty.` };
  }

  const looksJson = /\.json$/i.test(filename) || trimmed.startsWith('[') || trimmed.startsWith('{');
  if (looksJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'invalid JSON';
      return { ok: false, reason: `${filename} is not valid JSON (${detail}).` };
    }
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        reason: `${filename} must contain a top-level JSON array of objects (e.g. [{"month":"Jan","rev":12}]).`,
      };
    }
    if (parsed.length === 0) {
      return { ok: false, reason: `${filename} contains an empty JSON array.` };
    }
    const headers: string[] = [];
    const seen = new Set<string>();
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < parsed.length; i += 1) {
      const item: unknown = parsed[i];
      if (!isPlainObject(item)) {
        return {
          ok: false,
          reason: `${filename} item ${i} is not a JSON object. Only arrays of flat objects are supported.`,
        };
      }
      for (const key of Object.keys(item)) {
        if (!seen.has(key)) {
          seen.add(key);
          headers.push(key);
        }
      }
      records.push(item);
    }
    if (headers.length === 0) {
      return { ok: false, reason: `${filename} objects have no columns.` };
    }
    return { ok: true, dataset: { headers, records } };
  }

  const firstNewline = stripped.indexOf('\n');
  const firstLine = firstNewline === -1 ? stripped : stripped.slice(0, firstNewline);
  const delimiter = detectDelimiter(firstLine, filename);
  const rows = parseDelimitedRows(stripped, delimiter);
  if (rows.length < 2) {
    return {
      ok: false,
      reason: `${filename} needs a header row and at least one data row.`,
    };
  }
  const rawHeaders = rows[0]!;
  const headers = rawHeaders.map((header, idx) => {
    const clean = header.trim();
    return clean === '' ? `col_${idx + 1}` : clean;
  });
  const records: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]!;
    const record: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c]!;
      record[key] = cells[c]?.trim() ?? '';
    }
    records.push(record);
  }
  return { ok: true, dataset: { headers, records } };
}

/** Parse finite numbers and standard currency/comma/percent numeric strings. */
export function parseNumericCell(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || /^(?:-|—|n\/?a|null|none)$/i.test(trimmed)) return null;
  let normalized = trimmed;
  let negative = false;
  if (normalized.startsWith('(') && normalized.endsWith(')')) {
    negative = true;
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.replace(/^[-+]?\s*[$€£¥]\s*/, (match) =>
    match.trim().startsWith('-') ? '-' : '',
  );
  normalized = normalized.replace(/%$/, '').replace(/,/g, '').trim();
  if (normalized === '') return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function toVisualCell(value: unknown): VisualCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return clip(value, 400);
  if (typeof value === 'bigint') return clip(value.toString(), 400);
  try {
    return clip(JSON.stringify(value) ?? '', 400);
  } catch {
    return null;
  }
}

function formatXLabel(value: unknown, index: number): string {
  if (value === null || value === undefined) return `Row ${index + 1}`;
  let text: string;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    text = `${value}`;
  else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = '';
    }
  }
  return text === '' ? `Row ${index + 1}` : clip(text, 80);
}

export function resolveChartFromDataset(
  block: VisualChartBlockInput,
  dataset: ParsedDataset,
  filename: string,
): ResolvedBlockResult<VisualChartBlock> {
  const source = block.source;
  if (source?.x === undefined || source.y === undefined || source.y.length === 0) {
    return { ok: false, reason: 'Chart source requires both x and y column names.' };
  }
  const available = new Set(dataset.headers);
  const missing: string[] = [];
  if (!available.has(source.x)) missing.push(source.x);
  for (const col of source.y) {
    if (!available.has(col)) missing.push(col);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `column ${missing.map((c) => JSON.stringify(c)).join(', ')} not found in ${filename} (available: ${dataset.headers.join(', ')}).`,
    };
  }

  const yCols = source.y.slice(0, VISUAL_MAX_SERIES);
  const maxPoints = block.chartType === 'hbar' ? VISUAL_MAX_HBAR_POINTS : VISUAL_MAX_CHART_POINTS;
  const limit = Math.min(source.limit ?? maxPoints, maxPoints);
  const slice = dataset.records.slice(0, limit);
  if (slice.length === 0) {
    return { ok: false, reason: `${filename} has no rows to plot.` };
  }

  const x = slice.map((row, idx) => formatXLabel(row[source.x!], idx));
  let anyNumeric = false;
  const series = yCols.map((col) => {
    const y = slice.map((row) => {
      const parsed = parseNumericCell(row[col]);
      if (parsed !== null) anyNumeric = true;
      return parsed;
    });
    return { name: clip(col, 60), y };
  });

  if (block.chartType === 'donut' && series.some((s) => s.y.some((v) => v !== null && v < 0))) {
    return {
      ok: false,
      reason: `${yCols.join(', ')} in ${filename} has negative values, which a donut chart cannot show; use a bar chart instead.`,
    };
  }

  if (!anyNumeric) {
    return {
      ok: false,
      reason: `none of the selected y columns (${yCols.join(', ')}) in ${filename} contain numeric values.`,
    };
  }

  const note =
    dataset.records.length > limit
      ? `Showing first ${limit} of ${dataset.records.length} rows from ${filename}.`
      : undefined;

  return {
    ok: true,
    block: {
      kind: 'chart',
      chartType: block.chartType,
      ...(block.title !== undefined && { title: block.title }),
      ...(block.unit !== undefined && { unit: block.unit }),
      ...(block.stacked !== undefined && { stacked: block.stacked }),
      x,
      series,
    },
    // Notes embed the filename, which may be long; the payload caps each note.
    ...(note !== undefined && { note: clip(note, VISUAL_MAX_NOTE_CHARS) }),
  };
}

export function resolveTableFromDataset(
  block: VisualTableBlockInput,
  dataset: ParsedDataset,
  filename: string,
): ResolvedBlockResult<VisualTableBlock> {
  const source = block.source;
  const available = new Set(dataset.headers);
  let selectedCols: string[];
  let colsTruncated = false;

  if (source?.cols !== undefined && source.cols.length > 0) {
    const missing = source.cols.filter((col) => !available.has(col));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `column ${missing.map((c) => JSON.stringify(c)).join(', ')} not found in ${filename} (available: ${dataset.headers.join(', ')}).`,
      };
    }
    selectedCols = source.cols.slice(0, VISUAL_MAX_TABLE_COLS);
  } else {
    colsTruncated = dataset.headers.length > VISUAL_MAX_TABLE_COLS;
    selectedCols = dataset.headers.slice(0, VISUAL_MAX_TABLE_COLS);
  }

  const limit = Math.min(source?.limit ?? VISUAL_MAX_TABLE_ROWS, VISUAL_MAX_TABLE_ROWS);
  const slice = dataset.records.slice(0, limit);
  const cols = selectedCols.map((col) => clip(col, 80));
  const rows: VisualCell[][] = slice.map((record) =>
    selectedCols.map((col) => toVisualCell(record[col])),
  );

  const notes: string[] = [];
  if (dataset.records.length > limit) {
    notes.push(`Showing first ${limit} of ${dataset.records.length} rows from ${filename}.`);
  }
  if (colsTruncated) {
    notes.push(
      `Showing first ${VISUAL_MAX_TABLE_COLS} of ${dataset.headers.length} columns from ${filename}.`,
    );
  }
  const note = notes.length > 0 ? notes.join(' ') : undefined;

  return {
    ok: true,
    block: {
      kind: 'table',
      ...(block.title !== undefined && { title: block.title }),
      cols,
      rows,
      ...(block.align !== undefined && { align: block.align.slice(0, cols.length) }),
    },
    // Notes embed the filename, which may be long; the payload caps each note.
    ...(note !== undefined && { note: clip(note, VISUAL_MAX_NOTE_CHARS) }),
  };
}
