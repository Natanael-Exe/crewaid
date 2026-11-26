import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/renderer/api/apiClient';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { ModelOption, StartCallResponse, UserSettings } from '@crewaid/shared';
import { formatMessage, placeholdersOf } from '../src/renderer/i18n/format';
import { activateLocale, AVAILABLE_LOCALES, currentLocale, t } from '../src/renderer/i18n/i18n';
import { deviceLocale, readLanguageChoice } from '../src/renderer/i18n/localePreference';
import {
  listMicrophones,
  readMicrophoneChoice,
  resolveMicrophone,
  type MediaDevicesPort,
} from '../src/renderer/voice/microphonePreference';
import {
  VoiceRecorder,
  type AudioConstraint,
  type RecorderDeps,
} from '../src/renderer/voice/recorder';
import { CallSession, type CallDeps } from '../src/renderer/voice/callSession';
import {
  accountSettingsBusy,
  defaultTimezone,
  deviceReport,
  loadAccountSettings,
} from '../src/renderer/settings/accountSettings';
import {
  AUTO_DETECT,
  FOLLOW_SYSTEM,
  languageItems,
  languageName,
  timezoneItems,
} from '../src/renderer/settings/preferenceChoices';
import { GeneralPane } from '../src/renderer/settings/GeneralPane';
import {
  codingModelItems,
  INHERIT_CODING_MODEL,
} from '../src/renderer/settings/codingModelChoices';
import { BotCodingModelField } from '../src/renderer/bots/BotCodingModelField';

describe('D-234 — formatting a message', () => {
  it('fills placeholders, writing numbers the language’s way', () => {
    expect(formatMessage('Hello {name}', { name: 'Quill' }, 'en')).toBe('Hello Quill');
    // French groups thousands with a narrow no-break space.
    expect(formatMessage('{n} rows', { n: 1234.5 }, 'fr')).toBe('1\u202f234,5 rows');
  });

  it('leaves a missing parameter visible rather than silently empty', () => {
    expect(formatMessage('Hi {name}', {}, 'en')).toBe('Hi {name}');
  });

  it('picks the plural form the language’s own rules name', () => {
    const models = { one: '{count} model', other: '{count} models' };
    expect(formatMessage(models, { count: 1 }, 'en')).toBe('1 model');
    expect(formatMessage(models, { count: 3 }, 'en')).toBe('3 models');
    // Russian: 3 is "few", 5 is "many"; a missing category falls back to other.
    const files = { one: '{count} файл', few: '{count} файла', other: '{count} файлов' };
    expect(formatMessage(files, { count: 3 }, 'ru')).toBe('3 файла');
    expect(formatMessage(files, { count: 5 }, 'ru')).toBe('5 файлов');
  });

  it('lists every placeholder in every variant', () => {
    expect([...placeholdersOf({ one: '{count} by {who}', other: '{count}' })].sort()).toEqual([
      'count',
      'who',
    ]);
  });
});

describe('D-234 — the active language', () => {
  it('starts in English and offers only languages whose catalog ships', () => {
    expect(currentLocale()).toBe('en');
    expect(AVAILABLE_LOCALES).toContain('en');
    expect(t('settings.timezone.autoDetect', { zone: 'UTC' })).toBe('Auto-detect (UTC)');
  });

  it('loads a language’s catalog on demand and reads in it, then back in English', async () => {
    await activateLocale('fr');
    expect(currentLocale()).toBe('fr');
    expect(t('settings.timezone.autoDetect', { zone: 'UTC' })).not.toBe('Auto-detect (UTC)');
    expect(t('settings.timezone.autoDetect', { zone: 'UTC' })).toContain('UTC');
    await activateLocale('en');
    expect(currentLocale()).toBe('en');
    expect(t('settings.timezone.autoDetect', { zone: 'UTC' })).toBe('Auto-detect (UTC)');
  });

  it('follows the computer among the languages it speaks, else English', () => {
    expect(deviceLocale(['fr-HT', 'en-US'])).toBe('fr');
    expect(deviceLocale(['is-IS'])).toBe('en');
  });

  it('reads only a real language from storage', () => {
    const store = (value: string | null) => ({
      getItem: () => value,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(readLanguageChoice(store('fr'))).toBe('fr');
    expect(readLanguageChoice(store('klingon'))).toBeNull();
    expect(readLanguageChoice(null)).toBeNull();
  });
});

describe('D-234 — the language and timezone lists', () => {
  it('names each language in itself first, and in the app’s language beside it', () => {
    expect(languageName('fr', 'fr')).toBe('Français');
    expect(languageName('fr', 'en')).toBe('French');
    const items = languageItems(['en', 'fr', 'de', 'ja'], 'en');
    expect(items[0]).toMatchObject({ id: FOLLOW_SYSTEM, label: 'Follow system' });
    // Sorted by the name in the app's language: English, French, German, Japanese.
    expect(items.slice(1).map((item) => item.id)).toEqual(['en', 'fr', 'de', 'ja']);
    expect(items.find((item) => item.id === 'ja')).toMatchObject({
      label: '日本語',
      detail: 'Japanese',
    });
  });

  it('offers every zone the runtime knows, plus UTC, after Auto-detect', () => {
    const now = new Date('2026-10-22T11:41:00.000Z');
    const items = timezoneItems('en', 'America/Port-au-Prince', null, now);
    expect(items[0]).toMatchObject({
      id: AUTO_DETECT,
      label: 'Auto-detect (America/Port-au-Prince)',
      detail: '7:41 AM',
    });
    const ids = items.slice(1).map((item) => item.id);
    expect(ids).toContain('UTC');
    for (const zone of Intl.supportedValuesOf('timeZone')) expect(ids).toContain(zone);
    expect(ids.length).toBe(new Set(ids).size);
    expect(items.find((item) => item.id === 'Africa/Addis_Ababa')).toMatchObject({
      label: 'Africa/Addis Ababa',
      detail: '2:41 PM',
    });
  });

  it('keeps a saved zone the runtime lists under another name', () => {
    const items = timezoneItems('en', 'UTC', 'US/Eastern');
    expect(items.some((item) => item.id === 'US/Eastern')).toBe(true);
  });
});

describe('D-234 — the account’s settings in this window', () => {
  const base: UserSettings = {
    userId: 'clx9z8y7x6w5v4u3t2s1r0q9',
    defaultModelId: null,
    codingModelId: null,
    language: null,
    timezone: null,
    systemLanguage: 'en',
    systemTimezone: 'UTC',
    updatedAt: new Date(0),
  };

  it('keeps controls busy during loading and ignores a read from an unmounted account', async () => {
    let finish: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const client = new ApiClient({
      credentialsProvider: async () => ({
        orchestratorBaseUrl: 'https://example.com',
        orchestratorToken: 'test',
      }),
      fetchFn: async () => response,
    });
    const controller = new AbortController();
    const loading = loadAccountSettings(client, controller.signal);
    expect(accountSettingsBusy()).toBe(true);
    controller.abort();
    finish?.(
      new Response(JSON.stringify({ settings: { ...base, timezone: 'Asia/Tokyo' } }), {
        status: 200,
      }),
    );
    await loading;
    expect(accountSettingsBusy()).toBe(false);
    expect(defaultTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('reports this computer only where the server has something else', () => {
    expect(deviceReport(base, { language: 'en', timezone: 'UTC' })).toBeNull();
    expect(deviceReport(base, { language: 'fr', timezone: 'Europe/Paris' })).toEqual({
      systemLanguage: 'fr',
      systemTimezone: 'Europe/Paris',
    });
  });

  it('starts a new routine in the chosen zone, else this computer’s', () => {
    expect(defaultTimezone({ ...base, timezone: 'Asia/Tokyo' })).toBe('Asia/Tokyo');
    expect(defaultTimezone(null)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

/** A computer with the given microphones; names stay blank until the app asks once. */
function devices(ids: readonly string[], options: { namedBeforeAsking?: boolean } = {}) {
  let allowed = options.namedBeforeAsking === true;
  let asked = 0;
  const port: MediaDevicesPort = {
    enumerateDevices: async () => [
      ...ids.map((id) => ({ deviceId: id, kind: 'audioinput' as const, label: allowed ? id : '' })),
      { deviceId: 'speaker', kind: 'audiooutput' as const, label: '' },
    ],
    getUserMedia: async () => {
      asked += 1;
      allowed = true;
      return { getTracks: () => [{ stop: () => undefined }] };
    },
  };
  return { port, asked: () => asked };
}

describe('D-234 — the microphone', () => {
  it('lists real inputs only, never the default and communications aliases', async () => {
    const computer = devices(['default', 'communications', 'usb-mic', 'built-in'], {
      namedBeforeAsking: true,
    });
    expect((await listMicrophones(computer.port)).map((mic) => mic.id)).toEqual([
      'usb-mic',
      'built-in',
    ]);
  });

  it('asks for the names only when the list is opened', async () => {
    const computer = devices(['usb-mic']);
    expect(await listMicrophones(computer.port)).toEqual([{ id: 'usb-mic', label: '' }]);
    expect(computer.asked()).toBe(0);
    expect(await listMicrophones(computer.port, { askForNames: true })).toEqual([
      { id: 'usb-mic', label: 'usb-mic' },
    ]);
    expect(computer.asked()).toBe(1);
  });

  it('requests permission when device ids are hidden before the first recording', async () => {
    let allowed = false;
    let stopped = false;
    const port: MediaDevicesPort = {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: allowed ? 'usb-mic' : '', label: allowed ? 'USB' : '' },
      ],
      getUserMedia: async () => {
        allowed = true;
        return {
          getTracks: () => [
            {
              stop: () => {
                stopped = true;
              },
            },
          ],
        };
      },
    };
    expect(await listMicrophones(port)).toEqual([]);
    expect(allowed).toBe(false);
    expect(await listMicrophones(port, { askForNames: true })).toEqual([
      { id: 'usb-mic', label: 'USB' },
    ]);
    expect(stopped).toBe(true);
  });

  it('asks for the chosen device only while it is plugged in', async () => {
    const computer = devices(['usb-mic']);
    expect(await resolveMicrophone('usb-mic', computer.port)).toBe('usb-mic');
    expect(await resolveMicrophone('headset', computer.port)).toBeUndefined();
    expect(await resolveMicrophone(null, computer.port)).toBeUndefined();
  });

  it('reads a blank stored choice as the system default', () => {
    const store = (value: string | null) => ({
      getItem: () => value,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(readMicrophoneChoice(store(''))).toBeNull();
    expect(readMicrophoneChoice(store('usb-mic'))).toBe('usb-mic');
  });

  it('records from that device, and from the default when there is none', async () => {
    const asked: AudioConstraint[] = [];
    const deps: RecorderDeps = {
      getUserMedia: async ({ audio }) => {
        asked.push(audio);
        return { getTracks: () => [] };
      },
      createRecorder: () => ({
        mimeType: 'audio/webm',
        start: () => undefined,
        stop: () => undefined,
        listen: () => undefined,
      }),
      isTypeSupported: () => true,
      now: () => 0,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined,
    };
    await new VoiceRecorder(deps, {
      maxDurationMs: 1_000,
      microphone: async () => 'usb-mic',
    }).start();
    await new VoiceRecorder(deps, { maxDurationMs: 1_000 }).start();
    expect(asked).toEqual([{ deviceId: { exact: 'usb-mic' } }, true]);
  });

  it('opens a call on that device', async () => {
    const started: StartCallResponse = {
      callId: 'clxcall0000000000000001a',
      signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a',
      remainingSeconds: 600,
      overrides: {
        prompt: 'p',
        firstMessage: 'Bonjour.',
        voiceId: 'v',
        maxDurationSeconds: 600,
        language: 'fr',
      },
    };
    const connected: Array<Parameters<CallDeps['connect']>[0]> = [];
    const deps: CallDeps = {
      start: async () => started,
      update: async () => undefined,
      connect: async (input) => {
        connected.push(input);
        return {
          sendUserMessage: () => undefined,
          sendContextualUpdate: () => undefined,
          sendUserActivity: () => undefined,
          setMicMuted: () => undefined,
          endSession: async () => undefined,
        };
      },
      microphone: async () => 'usb-mic',
      sendToBot: async () => null,
      now: () => 0,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined,
      setIntervalFn: () => 0,
      clearIntervalFn: () => undefined,
    };
    await new CallSession(deps, { id: 'b', name: 'Quill' }, () => undefined).start();
    expect(connected[0]?.inputDeviceId).toBe('usb-mic');
    expect(connected[0]?.overrides.language).toBe('fr');
  });
});

describe('D-234 — the settings rows', () => {
  it('shows Language with Theme, a System section for the microphone, and Bots for the zone', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <GeneralPane edition="cloud" />
      </I18nProvider>,
    );
    expect(markup).toContain('Language');
    expect(markup).toContain('Follow system');
    expect(markup).toContain('System');
    expect(markup).toContain('Microphone');
    expect(markup).toContain('System default');
    expect(markup).toContain('Bots');
    expect(markup).toContain('Timezone');
    expect(markup).toContain('Coding model');
    expect(markup).toContain('Same as bot’s model');
    expect(markup).toContain(
      `Auto-detect (${Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ')})`,
    );
    // In the order the screenshot gives them.
    expect(markup.indexOf('Language')).toBeLessThan(markup.indexOf('Microphone'));
    expect(markup.indexOf('Microphone')).toBeLessThan(markup.indexOf('Timezone'));
    expect(markup.indexOf('Timezone')).toBeLessThan(markup.indexOf('Coding model'));
  });

  it('filters coding model choices to tool-capable models while retaining an unavailable saved selection', () => {
    const models: ModelOption[] = [
      {
        id: 'clx1111111111111111111111',
        connectionId: 'clxaaaaaaaaaaaaaaaaaaaaaa',
        connectionName: 'OpenAI',
        kind: 'openai',
        upstreamModelId: 'gpt-5.2',
        label: 'GPT-5.2',
        contextWindow: 200_000,
        capabilities: { tools: true, vision: true, reasoning: true },
        available: true,
        connectionState: 'ACTIVE',
      },
      {
        id: 'clx2222222222222222222222',
        connectionId: 'clxaaaaaaaaaaaaaaaaaaaaaa',
        connectionName: 'OpenAI',
        kind: 'openai',
        upstreamModelId: 'o1-text-only',
        label: 'Text Only',
        contextWindow: 128_000,
        capabilities: { tools: false, vision: false, reasoning: false },
        available: true,
        connectionState: 'ACTIVE',
      },
      {
        id: 'clx3333333333333333333333',
        connectionId: 'clxbbbbbbbbbbbbbbbbbbbbbb',
        connectionName: 'Anthropic',
        kind: 'anthropic',
        upstreamModelId: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        contextWindow: 200_000,
        capabilities: { tools: true, vision: true, reasoning: true },
        available: false,
        connectionState: 'NEEDS_KEY',
      },
    ];

    const items = codingModelItems(models, {
      inheritLabel: 'Same as bot’s model',
      currentId: 'clx3333333333333333333333',
      currentFallbackLabel: 'Current model',
      unavailableLabel: 'Unavailable',
    });

    expect(items.map((item) => item.id)).toEqual([
      INHERIT_CODING_MODEL,
      'clx1111111111111111111111',
      'clx3333333333333333333333',
    ]);
    expect(items[2]?.detail).toBe('Anthropic · Unavailable');

    const fieldHtml = renderToStaticMarkup(
      <I18nProvider>
        <BotCodingModelField value={null} onChange={() => undefined} />
      </I18nProvider>,
    );
    expect(fieldHtml).toContain('data-bot-coding-model-field');
    expect(fieldHtml).toContain('Coding model');
  });
});
