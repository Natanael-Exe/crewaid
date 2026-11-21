import {
  Autocomplete,
  Button,
  Calendar,
  DateField,
  DatePicker,
  Dropdown,
  Label,
  ListBox,
  ListLayout,
  Modal,
  NumberField,
  Radio,
  RadioGroup,
  SearchField,
  Select,
  Switch,
  TimeField,
  ToggleButton,
  ToggleButtonGroup,
  Virtualizer,
  useFilter,
  useOverlayState,
} from '@heroui/react';
import { Time, parseDate } from '@internationalized/date';
import { IconChevronDown, IconPlus, IconRepeat } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { describeSchedule } from './routinesState';
import {
  CUSTOM_STEPS,
  PRESETS,
  choiceLabel,
  cronForCustom,
  cronForPreset,
  defaultEndDate,
  scheduleParts,
  snapFrequency,
  timezoneChoices,
  todayInTimezone,
  type Preset,
  type RepeatUnit,
  type ScheduleParts,
} from './scheduleChoices';
import { useLocale, useT, t } from '../i18n/i18n';
import { weekdayInitials, weekdayName } from '../i18n/dates';

/**
 * The routine form's "when": an Add-schedule menu of repeats, the few details
 * each repeat needs, and a Custom Repeat dialog. None of it shows a cron — the
 * form writes one (`scheduleChoices.ts`) and the operator never has to read it.
 */

const LABEL = 'text-[12px] font-medium text-foreground';
const UNITS: ReadonlyArray<{ readonly id: RepeatUnit; readonly label: string }> = (
  ['minutes', 'hours', 'days', 'weeks', 'months'] as const
).map((id) => ({
  id,
  get label() {
    return t(`routines.unit.${id}`);
  },
}));

export function ScheduleField({
  cron,
  timezone,
  endsOn,
  onCronChange,
  onEndsChange,
}: {
  readonly cron: string;
  readonly timezone: string;
  readonly endsOn: string | null;
  readonly onCronChange: (cron: string) => void;
  readonly onEndsChange: (endsOn: string | null) => void;
}) {
  const t = useT();
  const parts = scheduleParts(cron);
  const [custom, setCustom] = useState<CustomDraft | null>(null);

  // A menu, not a <select>: choosing "Custom…" must open the dialog every
  // time, including when the schedule is already custom — a select fires no
  // change for the option it already shows.
  const choose = (key: Preset | 'custom') => {
    if (key === 'custom') {
      setCustom({
        parts:
          parts.choice === 'custom'
            ? parts
            : {
                ...parts,
                choice: 'custom',
                frequency: 1,
                unit: unitFor(parts),
                ...(parts.choice === 'weekdays' && { weekdays: [1, 2, 3, 4, 5] }),
              },
        endsOn,
      });
    } else {
      onCronChange(cronForPreset(key, parts));
    }
  };
  const update = (patch: Partial<ScheduleParts>) => {
    const next = { ...parts, ...patch };
    if (next.choice === 'custom') {
      const written = cronForCustom(next);
      if (written !== null) onCronChange(written);
    } else if (next.choice !== 'none' && next.choice !== 'current') {
      onCronChange(cronForPreset(next.choice, next));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className={LABEL}>{t('routines.routineScheduleFields.schedule')}</span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Dropdown>
          <Dropdown.Trigger
            aria-label={
              parts.choice === 'none'
                ? t('routines.routineScheduleFields.addSchedule')
                : t('routines.routineScheduleFields.changeSchedule')
            }
            className="flex h-9 w-fit items-center gap-1.5 rounded-[10px] border border-field-border bg-field px-3 text-[13px] text-field-foreground outline-none data-[hovered]:bg-background-secondary data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/40"
          >
            {parts.choice === 'none' ? (
              <IconPlus className="size-3.5 text-muted" stroke={2} />
            ) : (
              <IconRepeat className="size-3.5 text-muted" stroke={1.8} />
            )}
            <span>{choiceLabel(parts.choice)}</span>
            {parts.choice === 'none' ? null : (
              <IconChevronDown className="size-3.5 text-muted" stroke={1.8} />
            )}
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start" className="min-w-[200px] rounded-xl">
            <Dropdown.Menu
              aria-label={t('routines.routineScheduleFields.repeat')}
              onAction={(key) => choose(String(key) as Preset | 'custom')}
            >
              {PRESETS.map((preset) => (
                <Dropdown.Item
                  key={preset.id}
                  id={preset.id}
                  textValue={preset.label}
                  className="rounded-lg"
                >
                  {preset.label}
                </Dropdown.Item>
              ))}
              <Dropdown.Item
                id="custom"
                textValue={t('routines.routineScheduleFields.custom')}
                className="rounded-lg"
              >
                {t('routines.routineScheduleFields.custom2')}
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>

        <ScheduleDetails
          parts={parts}
          cron={cron}
          onChange={update}
          onEditCustom={() => choose('custom')}
        />
      </div>
      {parts.choice === 'monthly' && parts.monthDay > 28 ? (
        <p className="text-[11px] text-muted">
          {t('routines.skippedDays', { day: parts.monthDay })}
        </p>
      ) : null}

      <CustomRepeatDialog
        draft={custom}
        timezone={timezone}
        onCancel={() => setCustom(null)}
        onConfirm={(confirmed) => {
          const written = cronForCustom(confirmed.parts);
          if (written !== null) onCronChange(written);
          onEndsChange(confirmed.endsOn);
          setCustom(null);
        }}
      />
    </div>
  );
}

/** What the Custom Repeat dialog starts from: the unit closest to what is chosen now. */
function unitFor(parts: ScheduleParts): RepeatUnit {
  if (parts.choice === 'hourly') return 'hours';
  if (parts.choice === 'weekly' || parts.choice === 'weekdays') return 'weeks';
  if (parts.choice === 'monthly') return 'months';
  return 'days';
}

/**
 * The details the chosen repeat needs, and nothing else — inline after the
 * menu, joined by the words a person would say ("on", "at").
 */
function ScheduleDetails({
  parts,
  cron,
  onChange,
  onEditCustom,
}: {
  readonly parts: ScheduleParts;
  readonly cron: string;
  readonly onChange: (patch: Partial<ScheduleParts>) => void;
  readonly onEditCustom: () => void;
}) {
  const t = useT();
  switch (parts.choice) {
    case 'none':
      return null;
    case 'current':
      return (
        <p className="basis-full text-[12px] leading-4 text-muted" title={cron}>
          {t('routines.routineScheduleFields.thisRoutineHasACustom')}
        </p>
      );
    case 'custom':
      return (
        <>
          <span className="text-[12px] text-foreground">{describeSchedule(cron)}</span>
          <Button
            variant="ghost"
            size="sm"
            onPress={onEditCustom}
            className="h-7 rounded-lg px-2 text-[12px] text-accent"
          >
            {t('routines.routineScheduleFields.edit')}
          </Button>
        </>
      );
    case 'hourly':
      return (
        <>
          <Part word={t('routines.word.atMinute')}>
            <MinuteField value={parts.minute} onChange={(minute) => onChange({ minute })} />
          </Part>
        </>
      );
    case 'daily':
    case 'weekdays':
      return (
        <>
          <Part word={t('routines.word.at')}>
            <TimeOfDay parts={parts} onChange={onChange} />
          </Part>
        </>
      );
    case 'weekly':
      return (
        <>
          <Part word="on">
            <WeekdayToggles
              value={parts.weekdays}
              onChange={(weekdays) => onChange({ weekdays })}
            />
          </Part>
          <Part word={t('routines.word.at')}>
            <TimeOfDay parts={parts} onChange={onChange} />
          </Part>
        </>
      );
    case 'monthly':
      return (
        <>
          <Part word={t('routines.word.onDay')}>
            <MonthDayField value={parts.monthDay} onChange={(monthDay) => onChange({ monthDay })} />
          </Part>
          <Part word={t('routines.word.at')}>
            <TimeOfDay parts={parts} onChange={onChange} />
          </Part>
        </>
      );
  }
}

/** A connecting word and its control, kept on one line when the row wraps. */
function Part({ word, children }: { readonly word: string; readonly children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-[12px] text-muted">{word}</span>
      {children}
    </span>
  );
}

function TimeOfDay({
  parts,
  label,
  onChange,
}: {
  readonly parts: ScheduleParts;
  readonly label?: string;
  readonly onChange: (patch: Partial<ScheduleParts>) => void;
}) {
  const t = useT();
  return (
    <TimeField
      {...(label === undefined && { 'aria-label': t('routines.routineScheduleFields.time') })}
      value={new Time(parts.hour, parts.minute)}
      onChange={(time) => {
        if (time !== null) onChange({ hour: time.hour, minute: time.minute });
      }}
      className="w-[120px]"
    >
      {label !== undefined ? <Label className={LABEL}>{label}</Label> : null}
      <TimeField.Group>
        <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
      </TimeField.Group>
    </TimeField>
  );
}

function MinuteField({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (minute: number) => void;
}) {
  const t = useT();
  return (
    <NumberField
      aria-label={t('routines.routineScheduleFields.minutesPastTheHour')}
      value={value}
      minValue={0}
      maxValue={59}
      onChange={(minute) => {
        if (Number.isInteger(minute)) onChange(minute);
      }}
      className="w-[120px]"
    >
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input className="w-full" />
        <NumberField.IncrementButton />
      </NumberField.Group>
    </NumberField>
  );
}

function MonthDayField({
  value,
  label,
  onChange,
}: {
  readonly value: number;
  readonly label?: string;
  readonly onChange: (day: number) => void;
}) {
  const t = useT();
  return (
    <NumberField
      {...(label === undefined && { 'aria-label': t('routines.routineScheduleFields.dayOfMonth') })}
      value={value}
      minValue={1}
      maxValue={31}
      onChange={(day) => {
        if (Number.isInteger(day)) onChange(day);
      }}
      className="w-[120px]"
    >
      {label !== undefined ? <Label className={LABEL}>{label}</Label> : null}
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input className="w-full" />
        <NumberField.IncrementButton />
      </NumberField.Group>
    </NumberField>
  );
}

function WeekdayToggles({
  value,
  label,
  onChange,
}: {
  readonly value: readonly number[];
  readonly label?: string;
  readonly onChange: (days: number[]) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      {label !== undefined ? <span className={LABEL}>{label}</span> : null}
      <ToggleButtonGroup
        aria-label={t('routines.routineScheduleFields.repeatOn')}
        selectionMode="multiple"
        // A weekly repeat on no day would never run.
        disallowEmptySelection
        size="sm"
        selectedKeys={new Set(value.map(String))}
        onSelectionChange={(keys) => onChange([...keys].map(Number).sort((a, b) => a - b))}
      >
        {[0, 1, 2, 3, 4, 5, 6].map((index) => (
          <ToggleButton
            key={index}
            id={String(index)}
            aria-label={weekdayName(index)}
            className="min-w-9 px-0 text-[12px]"
          >
            {index > 0 ? <ToggleButtonGroup.Separator /> : null}
            {weekdayInitials(index)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </div>
  );
}

// ── Ends ─────────────────────────────────────────────────────────────────

/**
 * The form's end date: a switch, and a date picker once it is on. Read in the
 * routine's own timezone (D-127).
 */
export function EndsField({
  endsOn,
  timezone,
  onChange,
}: {
  readonly endsOn: string | null;
  readonly timezone: string;
  readonly onChange: (endsOn: string | null) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <span className={LABEL}>{t('routines.routineScheduleFields.ends')}</span>
      <div className="flex min-h-9 flex-wrap items-center gap-3">
        <Switch
          size="sm"
          aria-label={t('routines.routineScheduleFields.endOnADate')}
          isSelected={endsOn !== null}
          onChange={(on) => onChange(on ? defaultEndDate(timezone) : null)}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <span className="text-[13px] text-foreground">
              {endsOn === null
                ? t('routines.routineScheduleFields.neverEnds')
                : t('routines.routineScheduleFields.endsOn')}
            </span>
          </Switch.Content>
        </Switch>
        {endsOn !== null ? (
          <EndDatePicker
            value={endsOn}
            min={todayInTimezone(timezone)}
            isDisabled={false}
            onChange={onChange}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The Custom Repeat dialog's end date, as the design draws it: "Never ends"
 * or "Ends" beside a date picker that is live once "Ends" is chosen.
 */
function EndsRadio({
  endsOn,
  timezone,
  onChange,
}: {
  readonly endsOn: string | null;
  readonly timezone: string;
  readonly onChange: (endsOn: string | null) => void;
}) {
  const t = useT();
  const today = todayInTimezone(timezone);
  const fallback = defaultEndDate(timezone);
  return (
    <RadioGroup
      value={endsOn === null ? 'never' : 'on'}
      onChange={(value) => onChange(value === 'never' ? null : (endsOn ?? fallback))}
      // The group spaces its radios with a top margin sized for a page, not a
      // compact form; the gap here does it instead.
      className="flex flex-col gap-2 [&_[data-slot=radio]]:mt-0"
    >
      <Label className={LABEL}>{t('routines.routineScheduleFields.ends')}</Label>
      <Radio value="never">
        <Radio.Content>
          <Radio.Control>
            <Radio.Indicator />
          </Radio.Control>
          <span className="text-[13px] text-foreground">
            {t('routines.routineScheduleFields.neverEnds')}
          </span>
        </Radio.Content>
      </Radio>
      <div className="flex flex-wrap items-center gap-3">
        <Radio value="on">
          <Radio.Content>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            <span className="text-[13px] text-foreground">
              {t('routines.routineScheduleFields.ends')}
            </span>
          </Radio.Content>
        </Radio>
        <EndDatePicker
          value={endsOn ?? fallback}
          min={today}
          isDisabled={endsOn === null}
          onChange={onChange}
        />
      </div>
    </RadioGroup>
  );
}

function EndDatePicker({
  value,
  min,
  isDisabled,
  onChange,
}: {
  readonly value: string;
  readonly min: string;
  readonly isDisabled: boolean;
  readonly onChange: (date: string) => void;
}) {
  const t = useT();
  return (
    <DatePicker
      aria-label={t('routines.routineScheduleFields.endDate')}
      value={parseDate(value)}
      minValue={parseDate(min)}
      isDisabled={isDisabled}
      onChange={(date) => {
        // A CalendarDate prints as YYYY-MM-DD, the shape `endsOn` takes.
        if (date !== null) onChange(date.toString());
      }}
      className="w-[170px]"
    >
      <DateField.Group fullWidth>
        <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateField.Suffix>
          <DatePicker.Trigger>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <DatePicker.Popover>
        <Calendar aria-label={t('routines.routineScheduleFields.endDate')}>
          <Calendar.Header>
            <Calendar.YearPickerTrigger>
              <Calendar.YearPickerTriggerHeading />
              <Calendar.YearPickerTriggerIndicator />
            </Calendar.YearPickerTrigger>
            <Calendar.NavButton slot="previous" />
            <Calendar.NavButton slot="next" />
          </Calendar.Header>
          <Calendar.Grid>
            <Calendar.GridHeader>
              {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
            </Calendar.GridHeader>
            <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
          </Calendar.Grid>
          <Calendar.YearPickerGrid>
            <Calendar.YearPickerGridBody>
              {({ year }) => <Calendar.YearPickerCell year={year} />}
            </Calendar.YearPickerGridBody>
          </Calendar.YearPickerGrid>
        </Calendar>
      </DatePicker.Popover>
    </DatePicker>
  );
}

// ── Custom Repeat ────────────────────────────────────────────────────────

type CustomDraft = { readonly parts: ScheduleParts; readonly endsOn: string | null };

/**
 * The dialog edits a copy; nothing reaches the form until Confirm, so Cancel
 * leaves the schedule and the end date exactly as they were.
 */
function CustomRepeatDialog({
  draft,
  timezone,
  onCancel,
  onConfirm,
}: {
  readonly draft: CustomDraft | null;
  readonly timezone: string;
  readonly onCancel: () => void;
  readonly onConfirm: (draft: CustomDraft) => void;
}) {
  const t = useT();
  const overlay = useOverlayState({
    isOpen: draft !== null,
    onOpenChange: (open) => {
      if (!open) onCancel();
    },
  });
  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container
          size="cover"
          placement="center"
          className="h-fit sm:w-auto"
          scroll="inside"
        >
          <Modal.Dialog
            aria-label={t('routines.routineScheduleFields.customRepeat')}
            className="flex h-fit max-h-[85vh] w-[420px] max-w-[92vw] flex-col gap-5 overflow-y-auto rounded-card bg-surface p-5"
          >
            {/* Remounted per opening, so each one starts from the form's schedule. */}
            {draft !== null ? (
              <CustomRepeatBody
                initial={draft}
                timezone={timezone}
                onCancel={onCancel}
                onConfirm={onConfirm}
              />
            ) : null}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function CustomRepeatBody({
  initial,
  timezone,
  onCancel,
  onConfirm,
}: {
  readonly initial: CustomDraft;
  readonly timezone: string;
  readonly onCancel: () => void;
  readonly onConfirm: (draft: CustomDraft) => void;
}) {
  const t = useT();
  const [parts, setParts] = useState(initial.parts);
  const [endsOn, setEndsOn] = useState(initial.endsOn);
  const patch = (next: Partial<ScheduleParts>) => setParts((old) => ({ ...old, ...next }));
  const steps = CUSTOM_STEPS[parts.unit];
  const written = cronForCustom(parts);

  return (
    <>
      <h2 className="text-[16px] font-semibold text-foreground">
        {t('routines.routineScheduleFields.customRepeat2')}
      </h2>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-foreground">
          {t('routines.routineScheduleFields.repetitionFrequency')}
        </span>
        <div className="flex items-center gap-2">
          <NumberField
            aria-label={t('routines.routineScheduleFields.repeatEvery')}
            value={parts.frequency}
            minValue={steps[0] ?? 1}
            maxValue={steps[steps.length - 1] ?? 1}
            // A unit with one allowed interval has nothing to step through;
            // say so rather than offer a stepper that snaps back.
            isDisabled={steps.length === 1}
            onChange={(wanted) =>
              patch({ frequency: snapFrequency(parts.unit, wanted, parts.frequency) })
            }
            className="w-[140px]"
          >
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input className="w-full" />
              <NumberField.IncrementButton />
            </NumberField.Group>
          </NumberField>
          <Select
            aria-label={t('routines.routineScheduleFields.repeatUnit')}
            value={parts.unit}
            onChange={(unit) => {
              if (typeof unit === 'string') patch({ unit: unit as RepeatUnit, frequency: 1 });
            }}
            className="min-w-0 flex-1"
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {UNITS.map((unit) => (
                  <ListBox.Item key={unit.id} id={unit.id} textValue={unit.label}>
                    {unit.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
        <p className="text-[11px] leading-4 text-muted">{unitHint(parts.unit)}</p>
      </div>

      {parts.unit === 'weeks' ? (
        <WeekdayToggles
          label={t('routines.label.on')}
          value={parts.weekdays}
          onChange={(weekdays) => patch({ weekdays })}
        />
      ) : null}
      {parts.unit === 'months' ? (
        <div className="flex flex-wrap items-end gap-2">
          <MonthDayField
            label={t('routines.routineScheduleFields.onDay')}
            value={parts.monthDay}
            onChange={(monthDay) => patch({ monthDay })}
          />
          <TimeOfDay label={t('routines.label.at')} parts={parts} onChange={patch} />
        </div>
      ) : parts.unit === 'days' || parts.unit === 'weeks' ? (
        <TimeOfDay label={t('routines.label.at')} parts={parts} onChange={patch} />
      ) : null}

      <EndsRadio endsOn={endsOn} timezone={timezone} onChange={setEndsOn} />

      {written !== null ? (
        <p className="text-[12px] text-muted">{describeSchedule(written)}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="tertiary" size="sm" onPress={onCancel}>
          {t('routines.routineScheduleFields.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          isDisabled={written === null}
          onPress={() => onConfirm({ parts, endsOn })}
        >
          {t('routines.routineScheduleFields.confirm')}
        </Button>
      </div>
    </>
  );
}

/** Why the stepper stops where it does, said once, under it. */
function unitHint(unit: RepeatUnit): string {
  switch (unit) {
    case 'minutes':
      return t('routines.routineScheduleFields.stepsThroughIntervalsThatDivide');
    case 'hours':
      return t('routines.routineScheduleFields.stepsThroughIntervalsThatDivide2');
    case 'days':
      return t('routines.routineScheduleFields.routinesCanRepeatEveryDay');
    case 'weeks':
      return t('routines.routineScheduleFields.routinesCanRepeatEveryWeek');
    case 'months':
      return t('routines.routineScheduleFields.stepsThroughIntervalsThatDivide3');
  }
}

// ── Timezone ─────────────────────────────────────────────────────────────

export function TimezonePicker({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (timezone: string) => void;
}) {
  const t = useT();
  const { contains } = useFilter({ sensitivity: 'base' });
  const [query, setQuery] = useState('');
  const locale = useLocale();
  const zones = useMemo(() => timezoneChoices(value), [value, locale]);
  const filtered = useMemo(
    () =>
      query === ''
        ? zones
        : zones.filter(
            (zone) =>
              contains(zone.label, query) ||
              contains(zone.id, query) ||
              contains(zone.offset, query),
          ),
    [zones, contains, query],
  );

  return (
    <Autocomplete
      fullWidth
      selectionMode="single"
      value={value}
      onChange={(key) => {
        if (typeof key === 'string') onChange(key);
      }}
    >
      <Label className={LABEL}>{t('routines.routineScheduleFields.timezone')}</Label>
      <Autocomplete.Trigger className="flex h-9 w-full items-center justify-between gap-2 rounded-[10px] border border-field-border bg-field px-3 text-start text-[13px] text-field-foreground outline-none">
        <Autocomplete.Value className="truncate" />
        <Autocomplete.Indicator className="size-3.5 shrink-0" />
      </Autocomplete.Trigger>
      <Autocomplete.Popover className="min-w-[min(360px,calc(100vw-32px))] rounded-xl">
        <Autocomplete.Filter inputValue={query} onInputChange={setQuery}>
          <SearchField
            autoFocus
            aria-label={t('routines.routineScheduleFields.searchTimezones')}
            name="timezone-search"
            variant="secondary"
            className="sticky top-0 z-10"
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input
                placeholder={t('routines.routineScheduleFields.searchACityOrGmt')}
              />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight: 36 }}>
            <ListBox
              aria-label={t('routines.routineScheduleFields.timezones')}
              items={filtered}
              renderEmptyState={() => (
                <p className="px-3 py-3 text-[12px] text-muted">
                  {t('routines.routineScheduleFields.noMatchingTimezone')}
                </p>
              )}
            >
              {(zone) => (
                <ListBox.Item id={zone.id} textValue={`${zone.label} (${zone.offset})`}>
                  <span className="min-w-0 flex-1 truncate">{zone.label}</span>
                  <span className="ms-2 shrink-0 text-[12px] text-muted">{zone.offset}</span>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              )}
            </ListBox>
          </Virtualizer>
        </Autocomplete.Filter>
      </Autocomplete.Popover>
    </Autocomplete>
  );
}
