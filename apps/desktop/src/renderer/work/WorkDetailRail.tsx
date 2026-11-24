import { IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { IconButtonTooltip } from '../components/ui';

/**
 * Shared right-rail detail frame for Task, Goal, and Deliverable inspection
 * panes. Standardizes header geometry, window-drag strip, and Tooltip-paired
 * close control.
 */
export function WorkDetailRail({
  ariaLabel,
  title,
  closeLabel,
  onClose,
  bodyClassName = 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4',
  children,
}: {
  readonly ariaLabel: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly bodyClassName?: string;
  readonly children: ReactNode;
}) {
  return (
    <aside aria-label={ariaLabel} className="crewaid-work-detail flex h-full min-h-0 flex-col">
      <header className="window-drag flex min-h-16 shrink-0 items-center justify-between px-5">
        <span className="crewaid-rail-title">{title}</span>
        <IconButtonTooltip
          label={closeLabel}
          onPress={onClose}
          className="window-no-drag size-7 rounded-lg text-muted"
        >
          <IconX className="size-4" stroke={1.8} />
        </IconButtonTooltip>
      </header>
      <div className={bodyClassName}>{children}</div>
    </aside>
  );
}
