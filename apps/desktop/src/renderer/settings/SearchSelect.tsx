import {
  Autocomplete,
  ListBox,
  ListLayout,
  SearchField,
  Virtualizer,
  useFilter,
} from '@heroui/react';
import { IconCheck } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

export type SearchSelectItem = {
  readonly id: string;
  /** What the row and the trigger say. */
  readonly label: string;
  /** Muted, at the row's end: a language's name in the app's language, a zone's time now. */
  readonly detail?: string;
  /** Extra words the search matches but the row does not show. */
  readonly keywords?: string;
};

/**
 * A setting chosen from a long list by typing: the Language and
 * Timezone rows. The trigger names the choice from props rather than from the
 * collection, so it reads the same in the app and in a static render, where
 * the popover holding the collection has not mounted.
 *
 * Virtualised because the zone list is every zone the runtime knows — a few
 * hundred rows, which the person searches rather than scrolls.
 */
export function SearchSelect({
  label,
  value,
  items,
  searchPlaceholder,
  emptyText,
  onChange,
  onOpen,
  isDisabled = false,
}: {
  readonly label: string;
  readonly isDisabled?: boolean;
  readonly value: string;
  readonly items: readonly SearchSelectItem[];
  readonly searchPlaceholder: string;
  readonly emptyText: string;
  readonly onChange: (id: string) => void;
  /** Called as the list opens, for rows whose detail goes stale (a zone's time). */
  readonly onOpen?: () => void;
}) {
  const { contains } = useFilter({ sensitivity: 'base' });
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () =>
      query === ''
        ? items
        : items.filter(
            (item) =>
              contains(item.label, query) ||
              contains(item.id, query) ||
              (item.detail !== undefined && contains(item.detail, query)) ||
              (item.keywords !== undefined && contains(item.keywords, query)),
          ),
    [items, contains, query],
  );
  const selected = items.find((item) => item.id === value);

  return (
    <Autocomplete
      isDisabled={isDisabled}
      aria-label={label}
      selectionMode="single"
      value={value}
      onChange={(key) => {
        if (typeof key === 'string' && key !== value) onChange(key);
      }}
      onOpenChange={(open) => {
        if (!open) return;
        setQuery('');
        onOpen?.();
      }}
    >
      <Autocomplete.Trigger
        data-search-select={label}
        className="max-w-[min(340px,50vw)] items-center gap-1.5 text-[13px]"
      >
        <span className="min-w-0 truncate">{selected?.label ?? value}</span>
        <Autocomplete.Indicator className="size-3.5 shrink-0 text-muted" />
      </Autocomplete.Trigger>
      {/* Wider than the trigger, whose width HeroUI would otherwise impose:
          "Auto-detect (America/Port-au-Prince)" and its time share a row. */}
      <Autocomplete.Popover
        placement="bottom end"
        className="w-[min(440px,calc(100vw-32px))] max-w-[calc(100vw-32px)] rounded-xl"
      >
        <Autocomplete.Filter inputValue={query} onInputChange={setQuery}>
          <SearchField
            autoFocus
            aria-label={searchPlaceholder}
            variant="secondary"
            className="sticky top-0 z-10"
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={searchPlaceholder} />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight: 36 }}>
            <ListBox
              aria-label={label}
              items={filtered}
              renderEmptyState={() => (
                <p className="px-3 py-3 text-[12px] text-muted">{emptyText}</p>
              )}
            >
              {(item) => (
                <ListBox.Item id={item.id} textValue={item.label}>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.detail === undefined ? null : (
                    <span className="ms-3 shrink-0 text-[12px] text-muted">{item.detail}</span>
                  )}
                  {/* In its own slot after the detail: HeroUI's indicator is
                      absolutely placed and lands on top of the time. */}
                  <span className="ms-2 flex size-4 shrink-0 items-center justify-center">
                    {item.id === value ? <IconCheck className="size-3.5" stroke={2} /> : null}
                  </span>
                </ListBox.Item>
              )}
            </ListBox>
          </Virtualizer>
        </Autocomplete.Filter>
      </Autocomplete.Popover>
    </Autocomplete>
  );
}
