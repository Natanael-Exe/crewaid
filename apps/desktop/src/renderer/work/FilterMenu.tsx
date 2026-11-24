import { Button, Chip, Popover, Switch } from '@heroui/react';
import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import type { ProjectWithCounts } from '@crewaid/shared';
import { FIELD_LABEL, Picker, type PickerOption } from './Fields';
import { scopeKey, type ProjectScope } from './workState';
import { t, useT } from '../i18n/i18n';

/** One control in the filter menu: a choice from a list, or an on/off. */
export type FilterField =
  | {
      readonly kind: 'select';
      readonly key: string;
      readonly label: string;
      readonly options: readonly PickerOption[];
      /** Offered first; choosing it answers null. Omit for a required choice. */
      readonly noneLabel?: string;
      readonly defaultValue: string | null;
      readonly footer?: (close: () => void) => ReactNode;
    }
  | {
      readonly kind: 'toggle';
      readonly key: string;
      readonly label: string;
      readonly defaultValue: boolean;
    };

export type FilterValues = Readonly<Record<string, string | boolean | null>>;

/** Every field at its default: what Reset applies. */
export function filterDefaults(fields: readonly FilterField[]): FilterValues {
  return Object.fromEntries(fields.map((field) => [field.key, field.defaultValue]));
}

/** How many fields differ from their default, for the count on the button. */
export function activeFilterCount(fields: readonly FilterField[], values: FilterValues): number {
  return fields.filter(
    (field) =>
      (field.key in values ? values[field.key] : field.defaultValue) !== field.defaultValue,
  ).length;
}

/** Active non-default filter labels shown beside the Filter trigger. */
function activeFilterSummaries(
  fields: readonly FilterField[],
  values: FilterValues,
): Array<{ readonly key: string; readonly label: string }> {
  const summaries: Array<{ readonly key: string; readonly label: string }> = [];
  for (const field of fields) {
    const current = field.key in values ? values[field.key] : field.defaultValue;
    if (current === field.defaultValue) continue;
    if (field.kind === 'toggle') {
      summaries.push({ key: field.key, label: field.label });
    } else if (typeof current === 'string') {
      const option = field.options.find((candidate) => candidate.id === current);
      if (option !== undefined) summaries.push({ key: field.key, label: option.label });
    }
  }
  return summaries;
}

/**
 * The Work views' one filter control: a button that opens every filter the
 * view has as a draft, plus visible chips for active filters beside the trigger.
 */
export function FilterMenu({
  fields,
  values,
  onApply,
}: {
  fields: readonly FilterField[];
  values: FilterValues;
  onApply: (values: FilterValues) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FilterValues>(values);
  const count = activeFilterCount(fields, values);
  const activeChips = activeFilterSummaries(fields, values);

  const apply = (next: FilterValues) => {
    onApply(next);
    setOpen(false);
  };

  return (
    <div className="flex items-center gap-1.5">
      {activeChips.length > 0 ? (
        <div className="hidden items-center gap-1 lg:flex">
          {activeChips.slice(0, 2).map((chip) => (
            <Chip key={chip.key} size="sm" variant="soft" color="accent">
              <Chip.Label className="max-w-[110px] truncate">{chip.label}</Chip.Label>
            </Chip>
          ))}
        </div>
      ) : null}
      <Popover
        isOpen={open}
        onOpenChange={(next) => {
          if (next) setDraft(values);
          setOpen(next);
        }}
      >
        <Popover.Trigger
          aria-label={
            count === 0 ? t('work.filterMenu.filter') : t('work.filter.active', { count })
          }
          data-filter-menu
          className="flex h-8 cursor-default items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 text-caption font-medium text-foreground outline-none data-[hovered]:bg-background-secondary data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/40"
        >
          <IconAdjustmentsHorizontal className="size-3.5 text-muted" stroke={1.8} />
          {t('work.filterMenu.filter')}
          {count === 0 ? null : (
            <span className="grid min-w-4 place-items-center rounded-full bg-accent px-1 text-micro leading-4 font-semibold text-accent-foreground tabular-nums">
              {count}
            </span>
          )}
        </Popover.Trigger>
        <Popover.Content placement="bottom end" className="w-[300px] rounded-xl">
          <Popover.Dialog
            aria-label={t('work.filterMenu.filter')}
            className="flex flex-col gap-3 p-3"
          >
            {fields.map((field) =>
              field.kind === 'select' ? (
                <div key={field.key}>
                  <span className={FIELD_LABEL}>{field.label}</span>
                  <Picker
                    label={field.label}
                    value={(draft[field.key] as string | null | undefined) ?? null}
                    options={field.options}
                    {...(field.noneLabel !== undefined && { noneLabel: field.noneLabel })}
                    onChange={(value) =>
                      setDraft((current) => ({ ...current, [field.key]: value }))
                    }
                  />
                  {field.footer === undefined ? null : (
                    <div className="mt-1.5 flex gap-2">{field.footer(() => setOpen(false))}</div>
                  )}
                </div>
              ) : (
                <Switch
                  key={field.key}
                  size="sm"
                  isSelected={draft[field.key] === true}
                  onChange={(selected) =>
                    setDraft((current) => ({ ...current, [field.key]: selected }))
                  }
                  className="w-full"
                >
                  <Switch.Content className="flex w-full items-center justify-between gap-3">
                    <span className="text-footnote">{field.label}</span>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              ),
            )}
            <div className="mt-1 flex justify-end gap-2 border-t border-separator pt-3">
              <Button
                variant="tertiary"
                size="sm"
                onPress={() => apply(filterDefaults(fields))}
                className="h-8 rounded-[10px] text-caption font-medium"
              >
                {t('work.filterMenu.reset')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onPress={() => apply(draft)}
                className="h-8 rounded-[10px] text-caption font-medium"
              >
                {t('work.filterMenu.apply')}
              </Button>
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  );
}

/** What a Work view needs to offer the project scope in its filter menu. */
export type ProjectFilter = {
  readonly scope: ProjectScope;
  readonly projects: readonly ProjectWithCounts[];
  readonly onScopeChange: (scope: ProjectScope) => void;
  readonly onNewProject: () => void;
  readonly onManageProjects: () => void;
};

export function projectFilterField(filter: ProjectFilter): FilterField {
  return {
    kind: 'select',
    key: 'project',
    label: t('work.deliverablePane.project'),
    defaultValue: scopeKey({ kind: 'all' }),
    options: [
      { id: scopeKey({ kind: 'all' }), label: t('work.workPane.allProjects') },
      ...filter.projects
        .filter((project) => project.status === 'ACTIVE')
        .map((project) => ({
          id: scopeKey({ kind: 'project', projectId: project.id }),
          label: project.name,
          adornment: (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: project.color }}
            />
          ),
        })),
      { id: scopeKey({ kind: 'inbox' }), label: t('work.filterMenu.inboxNoProject') },
    ],
    footer: (close) => (
      <>
        <FooterLink
          onPress={() => {
            close();
            filter.onNewProject();
          }}
        >
          {t('work.filterMenu.newProject')}
        </FooterLink>
        <FooterLink
          onPress={() => {
            close();
            filter.onManageProjects();
          }}
        >
          {t('work.filterMenu.manageProjects')}
        </FooterLink>
      </>
    ),
  };
}

function FooterLink({ onPress, children }: { onPress: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={onPress}
      className="h-6 rounded-md px-1.5 text-caption text-accent"
    >
      {children}
    </Button>
  );
}
