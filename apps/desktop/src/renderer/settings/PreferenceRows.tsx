import { ListBox, ListBoxItem, Select } from '@heroui/react';
import { IconCheck } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LocaleSchema, type UpdateUserSettingsBody } from '@crewaid/shared';
import { useApiClient } from '../api';
import { AVAILABLE_LOCALES, useLocale, useT } from '../i18n/i18n';
import { setLanguageChoice, useLanguageChoice } from '../i18n/localePreference';
import { localTimezone } from '../routines/routinesState';
import {
  listMicrophones,
  setMicrophoneChoice,
  useMicrophoneChoice,
  type Microphone,
} from '../voice/microphonePreference';
import { saveAccountSettings, useAccountSettings, useAccountSettingsBusy } from './accountSettings';
import { AUTO_DETECT, FOLLOW_SYSTEM, languageItems, timezoneItems } from './preferenceChoices';
import { SearchSelect } from './SearchSelect';
import { SettingsRow, SettingsSection } from './SettingsLayout';

/**
 * D-234's three settings. Language and Timezone are the account's — bots read
 * them — and are saved to the server; Microphone is this computer's.
 */

/** A save that failed, said under the row it belongs to rather than nowhere. */
function useSaveProblem(): [string | null, (body: UpdateUserSettingsBody) => Promise<boolean>] {
  const client = useApiClient();
  const t = useT();
  const [problem, setProblem] = useState<string | null>(null);
  const save = useCallback(
    async (body: UpdateUserSettingsBody) => {
      setProblem(null);
      try {
        await saveAccountSettings(client, body);
        return true;
      } catch {
        setProblem(t('settings.saveFailed'));
        return false;
      }
    },
    [client, t],
  );
  return [problem, save];
}

function Problem({ text }: { text: string | null }) {
  return text === null ? null : <span className="text-danger">{text}</span>;
}

export function LanguageRow() {
  const t = useT();
  const locale = useLocale();
  const choice = useLanguageChoice();
  const [problem, save] = useSaveProblem();
  const isDisabled = useAccountSettingsBusy();
  const items = useMemo(() => languageItems(AVAILABLE_LOCALES, locale), [locale]);

  const choose = (id: string) => {
    const previous = choice;
    const parsed = LocaleSchema.safeParse(id);
    const next = parsed.success ? parsed.data : null;
    // The window switches at once; the account follows, and a refused save
    // puts the window back so it never disagrees with what the bots read.
    void setLanguageChoice(next);
    void save({ language: next }).then((saved) => {
      if (!saved) void setLanguageChoice(previous);
    });
  };

  return (
    <SettingsRow
      label={t('settings.language.label')}
      description={
        <>
          {t('settings.language.description')} <Problem text={problem} />
        </>
      }
      control={
        <SearchSelect
          isDisabled={isDisabled}
          label={t('settings.language.label')}
          value={choice ?? FOLLOW_SYSTEM}
          items={items}
          searchPlaceholder={t('settings.language.search')}
          emptyText={t('settings.language.empty')}
          onChange={choose}
        />
      }
    />
  );
}

export function SystemSection() {
  const t = useT();
  return (
    <SettingsSection title={t('settings.system.title')}>
      <MicrophoneRow />
    </SettingsSection>
  );
}

function MicrophoneRow() {
  const t = useT();
  const choice = useMicrophoneChoice();
  const [microphones, setMicrophones] = useState<readonly Microphone[] | null>(null);

  const refresh = useCallback((askForNames: boolean) => {
    listMicrophones(undefined, { askForNames }).then(setMicrophones, () => setMicrophones([]));
  }, []);
  useEffect(() => {
    refresh(false);
    const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (devices === undefined) return;
    // Plugging a headset in while Settings is open should show it.
    const changed = () => refresh(false);
    devices.addEventListener('devicechange', changed);
    return () => devices.removeEventListener('devicechange', changed);
  }, [refresh]);

  const present = choice !== null && microphones?.some((mic) => mic.id === choice) === true;
  const missing = choice !== null && microphones !== null && !present;
  const options = [
    { id: FOLLOW_SYSTEM, label: t('settings.microphone.systemDefault') },
    ...(microphones ?? []).map((mic, index) => ({
      id: mic.id,
      label: mic.label === '' ? t('settings.microphone.unnamed', { number: index + 1 }) : mic.label,
    })),
  ];
  const selectedKey = present ? choice : FOLLOW_SYSTEM;
  const selectedLabel = options.find((option) => option.id === selectedKey)?.label ?? '';

  return (
    <SettingsRow
      label={t('settings.microphone.label')}
      description={
        missing ? t('settings.microphone.disconnected') : t('settings.microphone.description')
      }
      control={
        <Select
          aria-label={t('settings.microphone.label')}
          selectedKey={selectedKey}
          onSelectionChange={(key) => {
            if (key === null) return;
            setMicrophoneChoice(key === FOLLOW_SYSTEM ? null : String(key));
          }}
          onOpenChange={(open) => {
            // Names stay hidden until the microphone has been allowed once.
            if (open) refresh(true);
          }}
        >
          <Select.Trigger
            data-search-select={t('settings.microphone.label')}
            className="max-w-[min(340px,50vw)] items-center gap-1.5 text-[13px]"
          >
            {/* From props, as SearchSelect does, so a static render reads the same. */}
            <span className="min-w-0 truncate">{selectedLabel}</span>
            <Select.Indicator className="size-3.5 shrink-0 text-muted" />
          </Select.Trigger>
          <Select.Popover placement="bottom end" className="max-h-72 min-w-56 overflow-auto">
            <ListBox items={options}>
              {(option: { id: string; label: string }) => (
                <ListBoxItem
                  key={option.id}
                  id={option.id}
                  textValue={option.label}
                  className="flex cursor-default items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[13px] text-foreground data-[focused]:bg-background-secondary"
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {option.id === selectedKey ? (
                      <IconCheck className="size-3.5" stroke={2} />
                    ) : null}
                  </span>
                </ListBoxItem>
              )}
            </ListBox>
          </Select.Popover>
        </Select>
      }
    />
  );
}

export function BotsSection() {
  const t = useT();
  return (
    <SettingsSection title={t('settings.bots.title')}>
      <TimezoneRow />
    </SettingsSection>
  );
}

function TimezoneRow() {
  const t = useT();
  const locale = useLocale();
  const settings = useAccountSettings();
  const [problem, save] = useSaveProblem();
  const isDisabled = useAccountSettingsBusy();
  // The times beside each zone are read when the list opens, not every render.
  const [now, setNow] = useState(() => new Date());
  const chosen = settings?.timezone ?? null;
  const detected = localTimezone();
  const items = useMemo(
    () => timezoneItems(locale, detected, chosen, now),
    [locale, detected, chosen, now],
  );

  return (
    <SettingsRow
      label={t('settings.timezone.label')}
      description={
        <>
          {t('settings.timezone.description')} <Problem text={problem} />
        </>
      }
      control={
        <SearchSelect
          isDisabled={isDisabled}
          label={t('settings.timezone.label')}
          value={chosen ?? AUTO_DETECT}
          items={items}
          searchPlaceholder={t('settings.timezone.search')}
          emptyText={t('settings.timezone.empty')}
          onOpen={() => setNow(new Date())}
          onChange={(id) => void save({ timezone: id === AUTO_DETECT ? null : id })}
        />
      }
    />
  );
}
