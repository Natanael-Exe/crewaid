import { Button } from '@heroui/react';
import { IconArrowRight, IconChevronLeft, IconChevronsRight } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import type { Bot } from '@crewaid/shared';
import { MemoryView } from '../experience/MemoryView';
import { BotFields } from './BotFields';
import { BotVoiceField } from './BotVoiceField';
import type { BotMutation } from '../state/useChat';
import {
  draftChanged,
  draftFromBot,
  draftIssue,
  toUpdateBody,
  writeFailureMessage,
  type BotDraft,
} from './botProfileForm';
import { useT } from '../i18n/i18n';

/**
 * The rail's bot profile pane.
 *
 * This is what the rail's gear opens. It edits the SELECTED BOT, not the
 * application — app settings live behind the account menu, and conflating the
 * two is the mistake this pane exists to correct.
 *
 * Saving is explicit rather than on blur. The reference app persists as you
 * type, which is pleasant until a write fails: there is no dirty state left to
 * retry from and no obvious moment to report the failure against. An enabled
 * Save button is the smaller promise, and it is the one this pane can keep.
 */

export function BotProfilePane({
  bot,
  onBack,
  onCollapse,
  onSave,
}: {
  bot: Bot;
  onBack: () => void;
  onCollapse: () => void;
  onSave: (botId: string, body: ReturnType<typeof toUpdateBody>) => Promise<BotMutation<Bot>>;
}) {
  const t = useT();
  // What this bot remembers opens inside its settings, not over them.
  const [memoryOpen, setMemoryOpen] = useState(false);
  useEffect(() => setMemoryOpen(false), [bot.id]);
  const stored = draftFromBot(bot);
  const [draft, setDraft] = useState<BotDraft>(stored);
  // The voice is not part of the create form, so it is kept beside the
  // shared draft rather than in it, and saved by the same button.
  const [voiceId, setVoiceId] = useState<string | null>(bot.voiceId);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Re-seed when the rail switches to another bot, or when a save elsewhere
  // changes this one. Keyed on the id AND the stored values so an external
  // patch is not silently masked by a stale draft.
  const seededFor = useRef<string>('');
  const signature = `${bot.id}|${stored.name}|${stored.role}|${stored.systemPrompt}|${stored.avatarColor}|${bot.voiceId ?? ''}`;
  useEffect(() => {
    if (seededFor.current === signature) return;
    seededFor.current = signature;
    setDraft(stored);
    setVoiceId(bot.voiceId);
    setFailure(null);
  }, [signature, stored, bot.voiceId]);

  const issue = draftIssue(draft);
  const voiceChanged = voiceId !== bot.voiceId;
  const dirty = draftChanged(draft, stored) || voiceChanged;
  const canSave = dirty && issue === null && !saving;

  async function save(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    setFailure(null);
    const result = await onSave(bot.id, {
      ...toUpdateBody(draft, stored),
      ...(voiceChanged && { voiceId }),
    });
    setSaving(false);
    if (!result.ok) setFailure(writeFailureMessage(result.failure));
  }

  return (
    <aside
      aria-label={t('bots.botProfilePane.botProfile')}
      data-pane-rail-state="profile"
      className="crewaid-profile-pane flex h-full w-full flex-col"
    >
      <div className="window-drag flex h-12 shrink-0 items-center gap-0.5 px-3">
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          aria-label={
            memoryOpen
              ? t('bots.botProfilePane.backToSettings')
              : t('bots.botProfilePane.backToDetails')
          }
          onPress={memoryOpen ? () => setMemoryOpen(false) : onBack}
          className="window-no-drag size-7 rounded-lg text-muted"
        >
          <IconChevronLeft className="size-4 rtl:-scale-x-100" stroke={1.8} />
        </Button>
        <span className="flex-1 text-center text-[13px] font-medium">
          {memoryOpen ? t('bots.botProfilePane.memory') : t('bots.botProfilePane.settings')}
        </span>
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          aria-label={t('bots.botProfilePane.collapsePanel')}
          onPress={onCollapse}
          className="window-no-drag size-7 rounded-lg text-muted"
        >
          <IconChevronsRight className="size-4 rtl:-scale-x-100" stroke={1.8} />
        </Button>
      </div>

      {memoryOpen ? (
        <MemoryView botId={bot.id} botName={bot.name} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {/* BotFields renders its fields bare; the column spaces them, as the
              create dialog's does. */}
          <div className="flex flex-col gap-4 pt-2">
            <BotFields
              draft={draft}
              onChange={setDraft}
              idPrefix={`bot-profile-${bot.id}`}
              fallbackName={bot.name}
              mainAssistant={bot.kind === 'MAIN'}
            />
          </div>

          <BotVoiceField value={voiceId} onChange={setVoiceId} />

          {issue === null ? null : (
            <p role="alert" className="text-[12px] text-danger">
              {issue}
            </p>
          )}
          {failure === null ? null : (
            <p role="alert" className="text-[12px] text-danger">
              {failure}
            </p>
          )}

          <button
            type="button"
            onClick={() => setMemoryOpen(true)}
            className="flex flex-col gap-1 border-y border-separator py-3 text-start"
          >
            <span className="flex items-center justify-between text-[13px] font-medium">
              {t('bots.knowsAboutYou', { name: bot.name })}
              <IconArrowRight className="size-4 text-muted rtl:-scale-x-100" aria-hidden />
            </span>
            <span className="text-[12px] text-muted">
              {t('bots.botProfilePane.reviewSharedAndPrivateContext')}
            </span>
          </button>

          <Button
            variant="primary"
            size="sm"
            isDisabled={!canSave}
            onPress={() => void save()}
            className="h-8 shrink-0 rounded-[10px] text-[12px] font-medium"
          >
            {saving ? t('bots.botProfilePane.saving') : t('bots.botProfilePane.save')}
          </Button>
        </div>
      )}
    </aside>
  );
}
