import { useMemo, useState } from 'react';
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconCopy,
  IconMarkdown,
  IconSearch,
} from '@tabler/icons-react';
import type { VisualAlign, VisualCell, VisualTableBlock } from '@crewaid/shared';
import { useT } from '../../i18n/i18n';
import { formatChartNumber, IconButtonTooltip } from '../ui';
import { copyToClipboard, tableToCsv, tableToMarkdown } from './visualExport';

type SortState = { readonly col: number; readonly dir: 'asc' | 'desc' } | null;

function compareCells(a: VisualCell | undefined, b: VisualCell | undefined): number {
  const aNull = a === null || a === undefined || a === '';
  const bNull = b === null || b === undefined || b === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const aNum = typeof a === 'string' ? Number(a.replace(/[$€£¥,%]/g, '')) : Number.NaN;
  const bNum = typeof b === 'string' ? Number(b.replace(/[$€£¥,%]/g, '')) : Number.NaN;
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function alignClass(align: VisualAlign | undefined, numeric: boolean): string {
  if (align === 'r' || (align === undefined && numeric)) return 'text-end';
  if (align === 'c') return 'text-center';
  return 'text-start';
}

export function TableBlock({
  block,
  compact = false,
}: {
  readonly block: VisualTableBlock;
  readonly compact?: boolean;
}) {
  const t = useT();
  const [sort, setSort] = useState<SortState>(null);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<'csv' | 'md' | null>(null);

  const numericCols = useMemo(
    () =>
      block.cols.map((_, colIdx) => {
        const nonNull = block.rows
          .map((row) => row[colIdx])
          .filter((cell) => cell !== null && cell !== undefined && cell !== '');
        return nonNull.length > 0 && nonNull.every((cell) => typeof cell === 'number');
      }),
    [block.cols, block.rows],
  );

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered =
      q === ''
        ? block.rows
        : block.rows.filter((row) =>
            row.some((cell) => cell !== null && String(cell).toLowerCase().includes(q)),
          );
    if (sort === null) return filtered;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => compareCells(a[sort.col], b[sort.col]) * factor);
  }, [block.rows, query, sort]);

  const toggleSort = (colIdx: number) => {
    setSort((prev) => {
      if (prev === null || prev.col !== colIdx) return { col: colIdx, dir: 'asc' };
      if (prev.dir === 'asc') return { col: colIdx, dir: 'desc' };
      return null;
    });
  };

  const handleCopy = async (kind: 'csv' | 'md') => {
    // Both formats copy what the table shows: the filtered rows, in sort order.
    const text =
      kind === 'csv'
        ? tableToCsv(block.cols, visibleRows)
        : tableToMarkdown({ ...block, rows: visibleRows });
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(kind);
    window.setTimeout(() => setCopied((prev) => (prev === kind ? null : prev)), 1500);
  };

  const showFilter = !compact && block.rows.length > 6;

  return (
    <section data-visual-block="table" className="flex flex-col gap-2">
      {!compact ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {block.title !== undefined ? (
            <h4 className="m-0 min-w-0 flex-1 truncate text-footnote font-medium text-muted">
              {block.title}
            </h4>
          ) : (
            <span className="flex-1" />
          )}
          <div className="flex items-center gap-1">
            {showFilter ? (
              <div className="relative flex items-center">
                <IconSearch
                  aria-hidden
                  className="pointer-events-none absolute start-2 size-3.5 text-muted"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('visuals.filterPlaceholder')}
                  aria-label={t('visuals.filterLabel')}
                  className="h-7 w-36 rounded-lg border border-field-border bg-field-background pe-2 ps-7 text-caption text-foreground placeholder:text-field-placeholder focus:outline-2 focus:outline-focus"
                />
              </div>
            ) : null}
            <IconButtonTooltip
              label={copied === 'csv' ? t('visuals.copied') : t('visuals.copyCsv')}
              onPress={() => {
                void handleCopy('csv');
              }}
            >
              {copied === 'csv' ? (
                <IconCheck aria-hidden className="size-3.5 text-success" />
              ) : (
                <IconCopy aria-hidden className="size-3.5" />
              )}
            </IconButtonTooltip>
            <IconButtonTooltip
              label={copied === 'md' ? t('visuals.copied') : t('visuals.copyMarkdown')}
              onPress={() => {
                void handleCopy('md');
              }}
            >
              {copied === 'md' ? (
                <IconCheck aria-hidden className="size-3.5 text-success" />
              ) : (
                <IconMarkdown aria-hidden className="size-3.5" />
              )}
            </IconButtonTooltip>
          </div>
        </div>
      ) : null}

      <div className="max-h-72 overflow-auto rounded-[12px] border border-separator">
        <table className="w-full border-collapse text-caption">
          <thead className="sticky top-0 bg-surface-secondary">
            <tr className="border-b border-separator">
              {block.cols.map((col, idx) => {
                const isSorted = sort?.col === idx;
                const align = alignClass(block.align?.[idx], numericCols[idx] === true);
                return (
                  <th
                    key={`${col}-${idx}`}
                    scope="col"
                    aria-sort={
                      isSorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                    className={`whitespace-nowrap px-3 py-2 font-medium text-muted ${align}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(idx)}
                      aria-label={t('visuals.sortBy', { column: col })}
                      className="inline-flex cursor-[var(--cursor-interactive)] items-center gap-1 font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <span>{col}</span>
                      {isSorted ? (
                        sort.dir === 'asc' ? (
                          <IconArrowUp aria-hidden className="size-3 text-foreground" />
                        ) : (
                          <IconArrowDown aria-hidden className="size-3 text-foreground" />
                        )
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td
                  colSpan={block.cols.length}
                  className="px-3 py-4 text-center text-caption text-muted"
                >
                  {t('visuals.noMatchingRows')}
                </td>
              </tr>
            ) : (
              visibleRows.map((row, rIdx) => (
                <tr key={rIdx} className="border-b border-separator/70 last:border-b-0">
                  {block.cols.map((_, cIdx) => {
                    const cell = row[cIdx];
                    const numeric = numericCols[cIdx] === true || typeof cell === 'number';
                    const align = alignClass(block.align?.[cIdx], numeric);
                    const text =
                      cell === null || cell === undefined
                        ? '—'
                        : typeof cell === 'boolean'
                          ? cell
                            ? t('visuals.yes')
                            : t('visuals.no')
                          : typeof cell === 'number'
                            ? formatChartNumber(cell)
                            : cell;
                    return (
                      <td
                        key={cIdx}
                        className={`px-3 py-2 text-foreground ${align} ${numeric ? 'tabular-nums' : ''}`}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
