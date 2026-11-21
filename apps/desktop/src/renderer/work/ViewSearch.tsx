import { Button } from '@heroui/react';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { useT } from '../i18n/i18n';

/**
 * Search within one Work view: a quiet icon until it is wanted, then a field
 * in the same place. It stays open while it holds a query, so the header
 * always shows why the view is narrowed; Esc clears the query, and a second
 * Esc — or leaving an empty field — folds it back into the icon.
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
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={label}
        data-view-search
        onPress={() => setOpen(true)}
        className="size-8 rounded-[10px] text-muted"
      >
        <IconSearch className="size-4" stroke={1.8} />
      </Button>
    );
  }
  return (
    <div
      data-view-search
      className="flex h-8 w-[240px] items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 focus-within:ring-2 focus-within:ring-focus/40"
    >
      <IconSearch className="size-3.5 shrink-0 text-muted" stroke={1.8} />
      <input
        ref={input}
        aria-label={label}
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
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
        className="min-w-0 flex-1 bg-transparent text-[12px]! outline-none placeholder:text-muted"
      />
      {value === '' ? null : (
        <button
          type="button"
          aria-label={t('work.viewSearch.clearSearch')}
          // Keeps the field focused: a click would otherwise blur it first.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
          className="shrink-0 rounded text-muted outline-none hover:text-foreground"
        >
          <IconX className="size-3.5" stroke={1.8} />
        </button>
      )}
    </div>
  );
}
