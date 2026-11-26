import {
  IconAlertTriangleFilled,
  IconCircle,
  IconCircleCheckFilled,
  IconCircleMinus,
  IconCircleXFilled,
} from '@tabler/icons-react';
import type { VisualCheckStatus, VisualChecksBlock } from '@crewaid/shared';
import { useT } from '../../i18n/i18n';
import { formatPreviewInternalPaths } from '../markdown/internalPaths';

function CheckStatusIcon({ status }: { readonly status: VisualCheckStatus }) {
  const t = useT();
  const label = t(`visuals.checks.status.${status}`);
  switch (status) {
    case 'done':
      return (
        <IconCircleCheckFilled
          role="img"
          aria-label={label}
          className="mt-0.5 size-[17px] shrink-0 text-success"
        />
      );
    case 'warning':
      return (
        <IconAlertTriangleFilled
          role="img"
          aria-label={label}
          className="mt-0.5 size-[17px] shrink-0 text-warning"
        />
      );
    case 'failed':
      return (
        <IconCircleXFilled
          role="img"
          aria-label={label}
          className="mt-0.5 size-[17px] shrink-0 text-danger"
        />
      );
    case 'skipped':
      return (
        <IconCircleMinus
          role="img"
          aria-label={label}
          className="mt-0.5 size-[17px] shrink-0 text-muted"
          stroke={1.8}
        />
      );
    case 'pending':
      return (
        <IconCircle
          role="img"
          aria-label={label}
          className="mt-0.5 size-[17px] shrink-0 text-muted"
          stroke={1.8}
        />
      );
  }
}

/**
 * Compact completed-steps / verification checklist block:
 *   ✓ Orders → 27 pulled
 *   ✓ Payments → 27 matched
 */
export function ChecksBlock({ block }: { readonly block: VisualChecksBlock }) {
  const t = useT();
  const pathLabel = t('tools.path');
  const clean = (value: string) => formatPreviewInternalPaths(value, pathLabel);

  return (
    <section data-visual-block="checks" className="flex flex-col gap-2">
      {block.title !== undefined ? (
        <h4 className="m-0 text-footnote font-medium text-muted">{clean(block.title)}</h4>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {block.items.map((item, idx) => {
          const muted = item.status === 'skipped' || item.status === 'pending';
          return (
            <li
              key={`${item.label}-${idx}`}
              data-check-item
              data-check-status={item.status}
              className="flex items-start gap-2 text-callout leading-[21px] tabular-nums"
            >
              <CheckStatusIcon status={item.status} />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className={muted ? 'font-medium text-muted' : 'font-medium text-foreground'}>
                  {clean(item.label)}
                </span>
                {item.result !== undefined ? (
                  <>
                    <span aria-hidden className="mx-1.5 text-muted">
                      →
                    </span>
                    <span className={muted ? 'text-muted' : 'text-foreground/85'}>
                      {clean(item.result)}
                    </span>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
