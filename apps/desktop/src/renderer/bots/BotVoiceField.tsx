import { useEffect, useState } from 'react';
import { Button, Popover, Spinner } from '@heroui/react';
import {
  IconCheck,
  IconChevronDown,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
} from '@tabler/icons-react';
import type { VoiceListResponse, VoiceOption } from '@crewaid/shared';
import { failureOf, listVoices, useApiClient } from '../api';
import { FIELD_LABEL } from '../work/Fields';
import { useVoicePreview } from '../voice/useVoicePreview';
import { useT } from '../i18n/i18n';

function voiceNameParts(name: string) {
  const divider = name.indexOf(' - ');
  return divider < 0
    ? { name, tags: '' }
    : { name: name.slice(0, divider), tags: name.slice(divider + 3) };
}

/**
 * Conversational voices, with independent buttons to choose and hear each one.
 *
 * The list is the account's own (`GET /voice/voices`), so with no key there is
 * nothing to choose from and the field says where to add one instead.
 */
export function BotVoiceField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (voiceId: string | null) => void;
}) {
  const t = useT();
  const client = useApiClient();
  const [catalog, setCatalog] = useState<VoiceListResponse | 'loading' | 'unavailable'>('loading');
  const [open, setOpen] = useState(false);
  const { audio, preview, error, play, stop, fail } = useVoicePreview();

  useEffect(() => {
    const controller = new AbortController();
    listVoices(client, controller.signal).then(
      (response) => !controller.signal.aborted && setCatalog(response),
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        // A missing key is the expected reason; anything else reads the same
        // to the person, who can only retry by reopening the pane.
        void failureOf(failure);
        setCatalog('unavailable');
      },
    );
    return () => controller.abort();
  }, [client]);

  useEffect(() => stop(), [value, stop]);

  const voices = typeof catalog === 'string' ? [] : catalog.voices;
  const defaultVoice =
    typeof catalog === 'string'
      ? undefined
      : voices.find((voice) => voice.id === catalog.defaultVoiceId);
  const selected = voices.find((voice) => voice.id === value);
  const label =
    catalog === 'loading'
      ? t('bots.botVoiceField.loadingVoices')
      : value === null
        ? t('bots.botVoiceField.defaultVoice')
        : (selected?.name ?? t('bots.botVoiceField.currentVoice'));

  function choose(id: string | null) {
    stop();
    onChange(id);
    setOpen(false);
  }

  function previewButton(voice: VoiceOption | undefined, name: string) {
    const active = voice !== undefined && preview?.id === voice.id;
    return (
      <span
        className="shrink-0"
        title={
          voice?.previewUrl === undefined
            ? t('bots.botVoiceField.previewUnavailable')
            : active
              ? t('bots.botVoiceField.stopPreview')
              : t('bots.botVoiceField.previewVoice')
        }
      >
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={
            active ? t('bots.voice.stopPreview', { name }) : t('bots.voice.preview', { name })
          }
          isDisabled={voice?.previewUrl === undefined}
          onPress={() => {
            if (voice !== undefined) void play(voice);
          }}
          className="size-8 min-w-8 shrink-0 rounded-full bg-black text-white data-[hovered]:bg-black/80"
        >
          {active && preview.loading ? (
            <Spinner size="sm" color="current" aria-hidden />
          ) : active ? (
            <IconPlayerStopFilled aria-hidden className="size-3.5" />
          ) : (
            <IconPlayerPlayFilled aria-hidden className="size-3.5" />
          )}
        </Button>
      </span>
    );
  }

  return (
    <div data-bot-voice-field>
      <span className={FIELD_LABEL}>{t('bots.botVoiceField.voice')}</span>
      {catalog === 'unavailable' ? (
        <p className="text-[12px] text-muted">{t('bots.botVoiceField.addAnElevenlabsKeyIn')}</p>
      ) : (
        <Popover
          isOpen={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) stop();
          }}
        >
          <Button
            variant="secondary"
            aria-label={t('bots.voice.label', { name: label })}
            isDisabled={catalog === 'loading'}
            className="flex min-h-10 w-full items-center justify-between gap-2 rounded-[10px] border border-border bg-background-secondary px-3 py-2 text-[13px] text-foreground outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/40"
          >
            <span className="min-w-0 truncate">{voiceNameParts(label).name}</span>
            <IconChevronDown aria-hidden className="size-4 shrink-0 text-muted" stroke={1.8} />
          </Button>
          <Popover.Content
            placement="bottom end"
            className="w-[420px] max-w-[calc(100vw-32px)] rounded-xl"
          >
            <Popover.Dialog aria-label={t('bots.botVoiceField.chooseVoice')} className="p-2">
              <Popover.Heading className="px-2 pt-1 pb-2 text-[12px] font-medium text-muted">
                {t('bots.botVoiceField.conversationalVoices')}
              </Popover.Heading>
              <div className="max-h-[min(50vh,360px)] overflow-y-auto overscroll-contain">
                <div className="flex items-center gap-1 rounded-lg hover:bg-background-secondary">
                  {previewButton(defaultVoice, t('bots.voice.default'))}
                  <button
                    type="button"
                    aria-label={t('bots.botVoiceField.chooseDefaultVoice')}
                    aria-pressed={value === null}
                    onClick={() => choose(null)}
                    className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px]">
                        {t('bots.botVoiceField.defaultVoice')}
                      </span>
                      {defaultVoice === undefined ? null : (
                        <span className="block truncate text-[11px] text-muted">
                          {defaultVoice.name}
                        </span>
                      )}
                    </span>
                    {value === null ? <IconCheck aria-hidden className="size-4 shrink-0" /> : null}
                  </button>
                </div>
                {voices.map((voice) => (
                  <div
                    key={voice.id}
                    className="flex items-center gap-1 rounded-lg hover:bg-background-secondary"
                  >
                    {previewButton(voice, voice.name)}
                    <button
                      type="button"
                      aria-label={t('bots.voice.choose', { name: voice.name })}
                      aria-pressed={value === voice.id}
                      onClick={() => choose(voice.id)}
                      className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-start text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-focus/40"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block">{voiceNameParts(voice.name).name}</span>
                        {voiceNameParts(voice.name).tags === '' ? null : (
                          <span data-voice-tags className="mt-0.5 block text-[11px] text-muted">
                            {voiceNameParts(voice.name).tags}
                          </span>
                        )}
                      </span>
                      {value === voice.id ? (
                        <IconCheck aria-hidden className="size-4 shrink-0" />
                      ) : null}
                    </button>
                  </div>
                ))}
                {voices.length === 0 ? (
                  <p className="px-2 py-2 text-[12px] text-muted">
                    {t('bots.botVoiceField.noConversationalVoicesAreAvailable')}
                  </p>
                ) : null}
              </div>
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
      )}
      <p className="mt-1.5 text-[12px] text-muted">
        {t('bots.botVoiceField.naturalVoicesForConversationPreview')}
      </p>
      {error === null ? null : (
        <p role="alert" className="mt-1.5 text-[12px] text-danger">
          {error}
        </p>
      )}
      <audio ref={audio} preload="none" onEnded={stop} onError={fail} />
    </div>
  );
}
