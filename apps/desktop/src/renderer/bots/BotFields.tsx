import { IconLock } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { BotAvatar, MascotFace } from '../components/BotAvatar';
import { SETTINGS_INPUT_CLASS } from '../settings/SettingsLayout';
import { AVATAR_COLORS, AVATAR_SHAPES, type BotDraft } from './botProfileForm';
import { useT, t } from '../i18n/i18n';

/**
 * The bot form's fields, shared by the create dialog and the rail's profile
 * pane.
 *
 * Extracted for two reasons. The obvious one is that two copies of the same
 * four controls drift. The load-bearing one is that this is testable: React
 * Aria mounts a dialog into a portal, which `renderToStaticMarkup` has
 * nowhere to put, so a test that went through either overlay would assert
 * against an empty string and pass whatever the fields contained.
 *
 * `idPrefix` exists because both surfaces can be mounted at once — the rail's
 * pane stays open behind the create dialog — and two `<label for>` pairs with
 * the same id point at whichever input the document reaches first.
 */
export function BotFields({
  draft,
  onChange,
  idPrefix,
  promptRows = 7,
  fallbackName = t('bots.newBot'),
  mainAssistant = false,
}: {
  draft: BotDraft;
  onChange: (next: BotDraft) => void;
  idPrefix: string;
  promptRows?: number;
  fallbackName?: string;
  /**
   * The account's main assistant keeps its name and label; its prompt
   * is the person's preferences for how it works with them, so it is asked
   * for in those words.
   */
  mainAssistant?: boolean;
}) {
  const t = useT();
  const nameId = `${idPrefix}-name`;
  const roleId = `${idPrefix}-role`;
  const promptId = `${idPrefix}-prompt`;

  return (
    <>
      <div className="flex flex-col items-center gap-3">
        {/* Previews the draft rather than the saved row, so a colour choice is
            visible before it is committed. */}
        <BotAvatar
          bot={{
            name: draft.name || fallbackName,
            avatarColor: draft.avatarColor,
            avatarShape: draft.avatarShape,
          }}
          size="md"
        />
        {/* Shape first, then colour: the preview above shows both, and the
            shape is the one an operator has to look for — the colour reads as
            a swatch on its own, the silhouette only in context. */}
        <div
          role="radiogroup"
          aria-label={t('bots.botFields.avatarShape')}
          className="grid grid-cols-8 gap-1.5"
        >
          {AVATAR_SHAPES.map((shape) => (
            <button
              key={shape}
              type="button"
              role="radio"
              aria-checked={draft.avatarShape === shape}
              aria-label={t('bots.avatarShape', { shape })}
              onClick={() => onChange({ ...draft, avatarShape: shape })}
              className={`grid size-8 place-items-center rounded-lg p-1 outline-none transition-colors ${
                draft.avatarShape === shape
                  ? 'bg-background-tertiary ring-2 ring-focus'
                  : 'hover:bg-background-secondary'
              }`}
            >
              <MascotFace name={draft.name} color={draft.avatarColor} shape={shape} />
            </button>
          ))}
        </div>

        <div
          role="radiogroup"
          aria-label={t('bots.botFields.avatarColour')}
          className="flex flex-wrap justify-center gap-1.5"
        >
          {AVATAR_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={draft.avatarColor === color}
              aria-label={t('bots.avatarColour', { color })}
              onClick={() => onChange({ ...draft, avatarColor: color })}
              style={{ backgroundColor: color }}
              className={`size-5 rounded-full outline-none transition-transform ${
                draft.avatarColor === color
                  ? 'ring-2 ring-focus ring-offset-2 ring-offset-background'
                  : 'hover:scale-110'
              }`}
            />
          ))}
        </div>
      </div>

      {mainAssistant ? (
        <dl className="flex flex-col gap-2 text-[13px]">
          <LockedRow label={t('bots.botFields.name')} value={draft.name} />
          <LockedRow label={t('bots.botFields.label')} value={draft.role} />
        </dl>
      ) : (
        <>
          <Field id={nameId} label={t('bots.botFields.name')}>
            <input
              id={nameId}
              value={draft.name}
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
              className={SETTINGS_INPUT_CLASS}
            />
          </Field>

          {/* "Label" is the reference app's word for what PRD §3 calls `role`. The
              reference marks it optional; the column is not, so neither is this. */}
          <Field id={roleId} label={t('bots.botFields.label')}>
            <input
              id={roleId}
              value={draft.role}
              onChange={(event) => onChange({ ...draft, role: event.target.value })}
              className={SETTINGS_INPUT_CLASS}
            />
          </Field>
        </>
      )}

      {/* The bot's system prompt. "Description" is the reference's label, and
          the friendlier one — but this text is what the model is told, not a
          note about the bot, so the placeholder says so.

          CC-50: it used to ask what the bot is FOR, and got job descriptions
          back. A brief that names a function produces a bot that reads like a
          function; the same field asked for a person produces a colleague, and
          it is the single largest lever this product has over how its bots
          come across. Empty is still allowed — D-094 gives that case a
          character rather than leaving it with none. */}
      <Field
        id={promptId}
        label={
          mainAssistant
            ? t('bots.mainPrompt', { name: draft.name })
            : t('bots.botFields.description')
        }
      >
        <textarea
          id={promptId}
          rows={promptRows}
          placeholder={
            mainAssistant
              ? t('bots.botFields.keepAnswersBriefChallengeWeak')
              : t('bots.botFields.whoThisBotIsNot')
          }
          value={draft.systemPrompt}
          onChange={(event) => onChange({ ...draft, systemPrompt: event.target.value })}
          className={`${SETTINGS_INPUT_CLASS} h-auto resize-none py-2 leading-[18px]`}
        />
        {mainAssistant ? (
          <p className="mt-1.5 text-[12px] text-muted">
            {t('bots.mainPromptPrivate', { name: draft.name })}
          </p>
        ) : null}
      </Field>
    </>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12px] text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function LockedRow({ label, value }: { label: string; value: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3">
      <dt className="w-[72px] shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate">{value}</dd>
      <IconLock className="size-3.5 shrink-0 text-muted" aria-label={t('bots.botFields.fixed')} />
    </div>
  );
}
