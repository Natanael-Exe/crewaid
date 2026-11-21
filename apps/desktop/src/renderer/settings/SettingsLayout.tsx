import type { ReactNode } from 'react';

/**
 * The two shapes every settings pane is built from.
 *
 * A labelled group of rows inside one rounded surface, per docs/UI-SPEC.md's
 * token sheet. Kept here rather than inlined per pane so a pane added later
 * inherits the spacing instead of re-deriving it by eye.
 */

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="crewaid-settings-section mb-6">
      <h3 className="mb-2 px-1 text-[12px] font-medium text-muted">{title}</h3>
      <div className="crewaid-settings-surface divide-y divide-separator overflow-hidden rounded-card bg-surface-secondary">
        {children}
      </div>
    </section>
  );
}

/**
 * One row: label and optional description on the left, control on the right.
 *
 * `stacked` drops the control onto its own line, which is what a text field
 * needs — a full-width input squeezed into the right column of a two-column
 * row is the layout that makes a URL unreadable at the sidebar's minimum width.
 */
export function SettingsRow({
  label,
  description,
  control,
  stacked = false,
  htmlFor,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  stacked?: boolean;
  htmlFor?: string;
}) {
  return (
    <div className={`px-4 py-3.5 ${stacked ? '' : 'flex items-center justify-between gap-4'}`}>
      <div className="min-w-0">
        {htmlFor === undefined ? (
          <div className="text-[13px] font-medium text-foreground">{label}</div>
        ) : (
          <label htmlFor={htmlFor} className="block text-[13px] font-medium text-foreground">
            {label}
          </label>
        )}
        {description === undefined ? null : (
          <div className="mt-1 text-[12px] leading-[17px] text-muted">{description}</div>
        )}
      </div>
      {control === undefined ? null : (
        <div className={stacked ? 'mt-2.5' : 'shrink-0'}>{control}</div>
      )}
    </div>
  );
}

/** The field styling the sidebar search already uses, so the app has one input. */
export const SETTINGS_INPUT_CLASS =
  'h-9 w-full rounded-[10px] border border-field-border bg-field px-3 text-[13px] text-field-foreground outline-none transition-colors placeholder:text-muted focus:ring-2 focus:ring-focus/15';
