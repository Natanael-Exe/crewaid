import { classifyDiffLines, type DiffLineKind } from '../markdown/highlight';

/** One line of read-only code, as `CodeView` draws it. */
export type CodeRow = {
  readonly text: string;
  /** The line's number in its file, shown in the gutter; `null` leaves the gutter blank. */
  readonly number?: number | null | undefined;
  readonly diff?: DiffLineKind | undefined;
};

/** `cat -n`-style output split into its numbered lines and the notes around them. */
export type NumberedCode = {
  /** Lines before the first numbered one, such as an edit's summary line. */
  readonly before: readonly string[];
  readonly rows: readonly CodeRow[];
  /** Lines after the last numbered one, such as a read's `[lines 1–40 of 300]` footer. */
  readonly after: readonly string[];
};

const NUMBERED_LINE = /^ *(\d+)\t/;

/**
 * Split `12\tcode` lines (what `fs_read` returns, and the context after an
 * `fs_edit`) into a gutter number and the code. Returns `null` when no line
 * carries a number, so the caller keeps its plain rendering.
 */
export function parseNumberedCode(text: string): NumberedCode | null {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => NUMBERED_LINE.test(line));
  if (first === -1) return null;
  let last = lines.length - 1;
  while (last > first && !NUMBERED_LINE.test(lines[last] ?? '')) last -= 1;
  return {
    before: lines.slice(0, first).filter((line) => line.trim() !== ''),
    rows: lines.slice(first, last + 1).map((line) => {
      const match = NUMBERED_LINE.exec(line);
      return match === null
        ? { text: line, number: null }
        : { text: line.slice(match[0].length), number: Number(match[1]) };
    }),
    after: lines.slice(last + 1).filter((line) => line.trim() !== ''),
  };
}

/** Rows of a unified diff, each without its marker column. */
export function parseUnifiedDiff(text: string): CodeRow[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const kinds = classifyDiffLines(lines);
  return lines.map((line, index) => {
    const diff = kinds[index] ?? 'context';
    const marked =
      diff === 'addition' || diff === 'deletion' || (diff === 'context' && line.startsWith(' '));
    return { text: marked ? line.slice(1) : line, diff };
  });
}

/** Rows for a search-and-replace edit: every old line removed, every new line added. */
export function replacementDiff(
  oldText: string | undefined,
  newText: string | undefined,
): CodeRow[] {
  const rows = (text: string | undefined, diff: DiffLineKind): CodeRow[] =>
    // Deleting text replaces it with '', which adds no line.
    text === undefined || text === '' ? [] : text.split('\n').map((line) => ({ text: line, diff }));
  return [...rows(oldText, 'deletion'), ...rows(newText, 'addition')];
}
