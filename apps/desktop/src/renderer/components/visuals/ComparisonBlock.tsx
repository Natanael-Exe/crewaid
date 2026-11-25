import { Chip } from '@heroui/react';
import { IconCheck, IconMinus, IconPlus, IconX } from '@tabler/icons-react';
import type { VisualCell, VisualComparisonBlock } from '@crewaid/shared';
import { useT } from '../../i18n/i18n';
import { formatChartNumber } from '../ui';

function CriterionCell({ value }: { readonly value: VisualCell | undefined }) {
  const t = useT();
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1 text-success" aria-label={t('visuals.yes')}>
        <IconCheck aria-hidden className="size-3.5" />
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="inline-flex items-center gap-1 text-muted" aria-label={t('visuals.no')}>
        <IconX aria-hidden className="size-3.5" />
      </span>
    );
  }
  if (value === null || value === undefined) {
    return <span className="text-muted">{'—'}</span>;
  }
  if (typeof value === 'number') {
    return <span className="tabular-nums">{formatChartNumber(value)}</span>;
  }
  return <span>{value}</span>;
}

export function ComparisonBlock({ block }: { readonly block: VisualComparisonBlock }) {
  const t = useT();
  const hasOptionDetails = block.options.some(
    (opt) =>
      opt.summary !== undefined ||
      (opt.pros !== undefined && opt.pros.length > 0) ||
      (opt.cons !== undefined && opt.cons.length > 0),
  );

  return (
    <section data-visual-block="comparison" className="flex flex-col gap-3">
      {block.title !== undefined ? (
        <h4 className="m-0 text-footnote font-medium text-muted">{block.title}</h4>
      ) : null}

      {hasOptionDetails ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-2.5">
          {block.options.map((option, idx) => {
            const badgeText =
              option.badge ?? (option.highlight === true ? t('visuals.recommended') : undefined);
            return (
              <div
                key={`${option.name}-${idx}`}
                data-highlighted={option.highlight === true ? 'true' : undefined}
                className={
                  option.highlight === true
                    ? 'flex min-w-0 flex-col gap-2 rounded-[12px] border border-accent/35 bg-surface-secondary px-3.5 py-3'
                    : 'flex min-w-0 flex-col gap-2 rounded-[12px] bg-surface-secondary px-3.5 py-3'
                }
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-callout font-semibold text-foreground">
                    {option.name}
                  </span>
                  {badgeText !== undefined ? (
                    <Chip
                      size="sm"
                      variant="soft"
                      color={option.highlight === true ? 'accent' : 'default'}
                      className="w-fit shrink-0"
                    >
                      <Chip.Label>{badgeText}</Chip.Label>
                    </Chip>
                  ) : null}
                </div>

                {option.summary !== undefined ? (
                  <p className="m-0 text-caption leading-snug text-muted">{option.summary}</p>
                ) : null}

                {option.pros !== undefined && option.pros.length > 0 ? (
                  <ul
                    aria-label={t('visuals.pros')}
                    className="m-0 flex list-none flex-col gap-1 p-0"
                  >
                    {option.pros.map((pro, pIdx) => (
                      <li
                        key={pIdx}
                        className="flex items-start gap-1.5 text-caption leading-snug text-foreground"
                      >
                        <IconPlus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
                        <span className="min-w-0 flex-1">{pro}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {option.cons !== undefined && option.cons.length > 0 ? (
                  <ul
                    aria-label={t('visuals.cons')}
                    className="m-0 flex list-none flex-col gap-1 p-0"
                  >
                    {option.cons.map((con, cIdx) => (
                      <li
                        key={cIdx}
                        className="flex items-start gap-1.5 text-caption leading-snug text-muted"
                      >
                        <IconMinus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-danger" />
                        <span className="min-w-0 flex-1">{con}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {block.criteria !== undefined && block.criteria.length > 0 ? (
        <div className="overflow-x-auto rounded-[12px] border border-separator">
          <table className="w-full border-collapse text-start text-caption">
            <thead>
              <tr className="border-b border-separator bg-surface-secondary">
                <th className="px-3 py-2 text-start font-medium text-muted">
                  {t('visuals.criteria')}
                </th>
                {block.options.map((option, idx) => (
                  <th
                    key={`${option.name}-${idx}`}
                    className="px-3 py-2 text-start font-semibold text-foreground"
                  >
                    {option.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.criteria.map((criterion, cIdx) => (
                <tr
                  key={`${criterion.label}-${cIdx}`}
                  className="border-b border-separator/70 last:border-b-0"
                >
                  <th scope="row" className="px-3 py-2 text-start font-medium text-muted">
                    {criterion.label}
                  </th>
                  {block.options.map((_, oIdx) => (
                    <td key={oIdx} className="px-3 py-2 text-foreground">
                      <CriterionCell value={criterion.values[oIdx]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
