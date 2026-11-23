import { ListBox, Select } from '@heroui/react';
import type { ReactNode } from 'react';
import { InlineSelect } from '../components/ui';

export const FIELD_LABEL = 'mb-1.5 block text-caption text-muted';

/** The key a picker uses for "none", since a ListBox key cannot be null. */
const NONE = '__none__';

export type PickerOption = {
  readonly id: string;
  readonly label: string;
  readonly adornment?: ReactNode;
};

/**
 * One choice from a list, or none — an assignee, a goal, a project.
 * `variant="inline"` renders the compact InlineSelect for dense detail
 * rails; `variant="secondary"` (default) uses HeroUI Select.
 */
export function Picker({
  label,
  value,
  options,
  noneLabel,
  onChange,
  className,
  appearance = 'default',
}: {
  label: string;
  value: string | null;
  options: readonly PickerOption[];
  /** Offered first; choosing it answers null. Omit for a required choice. */
  noneLabel?: string;
  onChange: (value: string | null) => void;
  className?: string;
  appearance?: 'default' | 'inline';
}) {
  const allOptions = [
    ...(noneLabel === undefined ? [] : [{ id: NONE, label: noneLabel }]),
    ...options,
  ];
  const handleChange = (key: unknown) => {
    if (typeof key !== 'string') return;
    onChange(key === NONE ? null : key);
  };

  if (appearance === 'inline') {
    return (
      <InlineSelect.Root
        aria-label={label}
        value={value ?? NONE}
        onChange={handleChange}
        className={className ?? 'min-w-0 w-full'}
      >
        <InlineSelect.Trigger className="w-full justify-between">
          <InlineSelect.Value className="truncate" />
          <InlineSelect.Indicator />
        </InlineSelect.Trigger>
        <InlineSelect.Popover>
          <ListBox>
            {allOptions.map((option) => (
              <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
                <span className="flex min-w-0 items-center gap-2">
                  {'adornment' in option ? option.adornment : null}
                  <span className="truncate">{option.label}</span>
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </InlineSelect.Popover>
      </InlineSelect.Root>
    );
  }

  return (
    <Select
      aria-label={label}
      variant="secondary"
      value={value ?? NONE}
      onChange={handleChange}
      className={className ?? 'min-w-0 w-full'}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {allOptions.map((option) => (
            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
              <span className="flex min-w-0 items-center gap-2">
                {'adornment' in option ? option.adornment : null}
                <span className="truncate">{option.label}</span>
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
