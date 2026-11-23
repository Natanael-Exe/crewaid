import { SearchField } from '@heroui/react';
import { IconSearch } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { IconButtonTooltip } from '../components/ui';
import { useT } from '../i18n/i18n';

/**
 * Search within one Work view: a quiet icon until it is wanted, then a HeroUI
 * SearchField in the same place. Esc clears the query, and a second Esc — or
 * leaving an empty field — folds it back into the icon.
 */
export function ViewSearch({
  label,
  placeholder,
  value,
  onChange,
}: {
  /** "Search tasks": the button's and the field's accessible name. */
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(value !== '');
  const input = useRef<HTMLInputElement>(null);

  if (!open && value === '') {
    return (
      <IconButtonTooltip
        label={label}
        data-view-search
        onPress={() => setOpen(true)}
        className="size-8 rounded-[10px] text-muted"
      >
        <IconSearch className="size-4" stroke={1.8} />
      </IconButtonTooltip>
    );
  }
  return (
    <SearchField
      data-view-search
      aria-label={label}
      variant="secondary"
      value={value}
      onChange={onChange}
      className="w-[240px]"
    >
      <SearchField.Group className="h-8 rounded-[10px]">
        <SearchField.SearchIcon />
        <SearchField.Input
          ref={input}
          aria-label={label}
          autoFocus
          placeholder={placeholder}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Handled here, so the key does not also close an open record.
            event.preventDefault();
            event.stopPropagation();
            if (value !== '') onChange('');
            else setOpen(false);
          }}
          onBlur={() => {
            if (value === '') setOpen(false);
          }}
          className="text-caption"
        />
        {value === '' ? null : (
          <SearchField.ClearButton
            aria-label={t('work.viewSearch.clearSearch')}
            onPress={() => {
              onChange('');
              input.current?.focus();
            }}
          />
        )}
      </SearchField.Group>
    </SearchField>
  );
}
