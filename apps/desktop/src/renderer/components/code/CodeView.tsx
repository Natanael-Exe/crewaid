import type { CSSProperties, ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import { highlightLines, type DiffLineKind, type HighlightToken } from '../markdown/highlight';
import type { CodeRow } from './codeRows';

/** The largest amount of code one view renders; the rest is counted, not drawn. */
export const CODE_VIEW_MAX_CHARS = 4000;

function boundRows(
  rows: readonly CodeRow[],
  maxChars: number,
): { shown: readonly CodeRow[]; hidden: number } {
  let used = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    used += row.text.length + 1;
    if (used <= maxChars) continue;
    // A first line longer than the bound (minified code) is cut rather than
    // dropped, so the view never comes up empty.
    if (index === 0) {
      return {
        shown: [{ ...row, text: `${row.text.slice(0, maxChars)}…` }],
        hidden: rows.length - 1,
      };
    }
    return { shown: rows.slice(0, index), hidden: rows.length - index };
  }
  return { shown: rows, hidden: 0 };
}

/**
 * Tokens per row. A diff is highlighted as its two sides — the old file
 * (context and removed lines) and the new one (context and added lines) — so
 * a construct that spans lines is read in the file it belongs to.
 */
function rowTokens(rows: readonly CodeRow[], language: string | null): HighlightToken[][] {
  const plain = (row: CodeRow): HighlightToken[] =>
    row.text === '' ? [] : [{ text: row.text, className: null }];
  if (language === null) return rows.map(plain);
  if (!rows.some((row) => row.diff !== undefined)) {
    return highlightLines(
      rows.map((row) => row.text),
      language,
    );
  }
  const side = (kinds: ReadonlySet<DiffLineKind>): Map<number, HighlightToken[]> => {
    const indices = rows.flatMap((row, index) =>
      row.diff !== undefined && kinds.has(row.diff) ? [index] : [],
    );
    const highlighted = highlightLines(
      indices.map((index) => rows[index]?.text ?? ''),
      language,
    );
    return new Map(indices.map((rowIndex, position) => [rowIndex, highlighted[position] ?? []]));
  };
  const before = side(new Set(['context', 'deletion']));
  const after = side(new Set(['context', 'addition']));
  // Hunk and header rows are on neither side and stay plain.
  return rows.map(
    (row, index) => (row.diff === 'deletion' ? before : after).get(index) ?? plain(row),
  );
}

const MARKERS: Readonly<Record<DiffLineKind, string>> = {
  addition: '+',
  deletion: '-',
  context: '',
  hunk: '',
  header: '',
};

/**
 * Read-only code in the transcript outside a Markdown fence: a file a bot
 * read, with its line numbers, or an edit as a diff.
 *
 * The line number and the `+`/`-` marker are CSS generated content drawn from
 * data attributes, never text nodes, so selecting the code and copying it
 * gives back the code alone. Each line is its own block, like Streamdown's
 * fences, so a changed line's tint spans the row.
 */
export function CodeView({
  rows,
  language,
  maxChars = CODE_VIEW_MAX_CHARS,
  className,
}: {
  readonly rows: readonly CodeRow[];
  readonly language: string | null;
  readonly maxChars?: number | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const t = useT();
  const { shown, hidden } = boundRows(rows, maxChars);
  const tokens = rowTokens(shown, language);
  const widest = shown.reduce(
    (digits, row) => Math.max(digits, String(row.number ?? '').length),
    0,
  );
  const isDiff = shown.some((row) => row.diff !== undefined);
  return (
    <div className={className}>
      <pre
        className="crewaid-code-view crewaid-code"
        data-code-view={isDiff ? 'diff' : 'numbered'}
        data-language={language ?? undefined}
        data-gutter={widest > 0 ? '' : undefined}
        style={
          widest > 0 ? ({ '--crewaid-code-gutter': `${widest}ch` } as CSSProperties) : undefined
        }
      >
        <code>
          {shown.map((row, index) => {
            const line = tokens[index] ?? [];
            const marker = row.diff === undefined ? undefined : MARKERS[row.diff];
            return (
              <span
                key={index}
                className="crewaid-code-line"
                data-line={row.number ?? undefined}
                data-diff={row.diff}
                data-marker={marker}
              >
                {line.length === 0
                  ? '\n'
                  : line.map((token, position) =>
                      token.className === null ? (
                        token.text
                      ) : (
                        <span key={position} className={token.className}>
                          {token.text}
                        </span>
                      ),
                    )}
              </span>
            );
          })}
        </code>
      </pre>
      {hidden > 0 ? (
        <p className="m-0 mt-1 text-micro text-muted" data-code-hidden-lines={hidden}>
          {t('code.moreLines', { count: hidden })}
        </p>
      ) : null}
    </div>
  );
}
