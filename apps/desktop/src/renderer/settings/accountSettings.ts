import { useEffect, useSyncExternalStore } from 'react';
import type { UpdateUserSettingsBody, UserSettings } from '@crewaid/shared';
import { getSettings, updateSettings, type ApiClient } from '../api';
import { currentLanguageChoice, deviceLocale, setLanguageChoice } from '../i18n/localePreference';
import { localTimezone } from '../routines/routinesState';

/**
 * The account's settings row, read once per signed-in window and
 * shared by every surface that needs it — the Settings rows, and the forms
 * that start a routine or a task in the person's zone.
 *
 * The server holds the choice because bots read it. This window holds two
 * things only it can know: what its computer is set to, which it reports so a
 * bot following "Auto-detect" has a value, and the local copy of the language
 * that lets the app open in it before the server answers.
 */

const listeners = new Set<() => void>();
let current: UserSettings | null = null;
let pending = 0;

function pendingChanged(delta: number): void {
  pending += delta;
  for (const listener of listeners) listener();
}

export function accountSettingsBusy(): boolean {
  return pending > 0;
}

/** A second selection must not race a full-row response from the first. */
export function useAccountSettingsBusy(): boolean {
  return useSyncExternalStore(subscribe, accountSettingsBusy, () => false);
}

function publish(settings: UserSettings | null): void {
  current = settings;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): UserSettings | null {
  return current;
}

export function useAccountSettings(): UserSettings | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/**
 * The zone a new routine or task starts in: the person's choice, else this
 * computer's. Not the server's `systemTimezone` — that may be another
 * computer's, and "Auto-detect" means the one in front of them.
 */
export function defaultTimezone(settings: UserSettings | null = current): string {
  return settings?.timezone ?? localTimezone();
}

/**
 * What this computer should report, or null when the server already has it.
 * Sent only on a difference, so an unchanged computer opening the app writes
 * nothing.
 */
export function deviceReport(
  settings: UserSettings,
  device: { readonly language: UserSettings['systemLanguage']; readonly timezone: string } = {
    language: deviceLocale(),
    timezone: localTimezone(),
  },
): UpdateUserSettingsBody | null {
  const body: UpdateUserSettingsBody = {
    ...(settings.systemLanguage !== device.language && { systemLanguage: device.language }),
    ...(settings.systemTimezone !== device.timezone && { systemTimezone: device.timezone }),
  };
  return Object.keys(body).length === 0 ? null : body;
}

/**
 * Read the row, adopt the account's language in this window, and report this
 * computer. The account's language wins over the local copy: it is the one a
 * choice made on another computer changed.
 */
export async function loadAccountSettings(client: ApiClient, signal?: AbortSignal): Promise<void> {
  pendingChanged(1);
  try {
    const settings = await getSettings(client, signal);
    if (signal?.aborted === true) return;
    publish(settings);
    if (settings.language !== currentLanguageChoice()) {
      void setLanguageChoice(settings.language);
    }
    const report = deviceReport(settings);
    if (report !== null) {
      const reported = await updateSettings(client, report);
      if (!signal?.aborted) publish(reported);
    }
  } finally {
    pendingChanged(-1);
  }
}

/**
 * Save a change, showing it at once and putting the old value back if the
 * server refuses — so a row never shows a setting the bots are not using.
 */
export async function saveAccountSettings(
  client: ApiClient,
  body: UpdateUserSettingsBody,
): Promise<void> {
  pendingChanged(1);
  const before = current;
  if (before !== null) publish(merged(before, body));
  try {
    publish(await updateSettings(client, body));
  } catch (error) {
    publish(before);
    throw error;
  } finally {
    pendingChanged(-1);
  }
}

/** Load once per signed-in shell. A failed read leaves every row on its default. */
export function useSyncAccountSettings(client: ApiClient): void {
  useEffect(() => {
    const controller = new AbortController();
    loadAccountSettings(client, controller.signal).catch(() => undefined);
    return () => {
      controller.abort();
      publish(null);
    };
  }, [client]);
}

function merged(settings: UserSettings, body: UpdateUserSettingsBody): UserSettings {
  return {
    ...settings,
    ...(body.defaultModelId !== undefined && { defaultModelId: body.defaultModelId }),
    ...(body.language !== undefined && { language: body.language }),
    ...(body.timezone !== undefined && { timezone: body.timezone }),
    ...(body.systemLanguage !== undefined && { systemLanguage: body.systemLanguage }),
    ...(body.systemTimezone !== undefined && { systemTimezone: body.systemTimezone }),
  };
}
