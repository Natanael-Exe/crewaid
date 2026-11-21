import { ListBox, Select } from '@heroui/react';
import type { ReactNode } from 'react';

export const FIELD_LABEL = 'mb-1.5 block text-[12px] text-muted';

/** The key a picker uses for "none", since a ListBox key cannot be null. */
const NONE = '__none__';

export type PickerOption = {
  readonly id: string;
  readonly label: string;
  readonly adornment?: ReactNode;
};

/**
 * One choice from a list, or none — an assignee, a goal, a project. Built on
 * the app's own Select so it looks and behaves like the routine form's
 * pickers rather than a native control.
 */
export function Picker({
  label,
  value,
  options,
  noneLabel,
  onChange,
  className,
}: {
  label: string;
  value: string | null;
  options: readonly PickerOption[];
  /** Offered first; choosing it answers null. Omit for a required choice. */
  noneLabel?: string;
  onChange: (value: string | null) => void;
  className?: string;
}) {
  return (
    <Select
      aria-label={label}
      value={value ?? NONE}
      onChange={(key) => {
        if (typeof key !== 'string') return;
        onChange(key === NONE ? null : key);
      }}
      className={className ?? 'min-w-0 w-full'}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {[...(noneLabel === undefined ? [] : [{ id: NONE, label: noneLabel }]), ...options].map(
            (option) => (
              <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
                <span className="flex min-w-0 items-center gap-2">
                  {'adornment' in option ? option.adornment : null}
                  <span className="truncate">{option.label}</span>
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ),
          )}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
