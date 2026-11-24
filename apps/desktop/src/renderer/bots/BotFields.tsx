import { ColorSwatchPicker, Disclosure, Input, TextArea } from '@heroui/react';
import { IconLock } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { BotAvatar, MascotFace } from '../components/BotAvatar';
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
  defaultLookOpen = true,
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
  /** Whether the avatar shape and colour start laid out (a new bot) or folded. */
  defaultLookOpen?: boolean;
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
        {/* The look is a once-in-a-while choice, so a profile opened to edit
            the brief keeps it folded; a new bot opens with it laid out. */}
        <Disclosure defaultExpanded={defaultLookOpen} className="w-full">
          <Disclosure.Heading className="flex justify-center">
            <Disclosure.Trigger className="crewaid-look-trigger flex cursor-[var(--cursor-interactive)] items-center gap-1.5 rounded-full bg-surface/60 px-3 py-1 text-caption font-medium text-muted outline-none data-[hovered]:bg-surface/90 data-[hovered]:text-foreground data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/40">
              {t('bots.botFields.customizeAppearance')}
              <Disclosure.Indicator className="size-3.5" />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="flex flex-col items-center gap-3 pt-3">
              {/* Shape first, then colour: the preview above shows both, and
                  the shape is the one an operator has to look for — the colour
                  reads as a swatch on its own, the silhouette only in context. */}
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
                    className={`grid size-8 cursor-[var(--cursor-interactive)] place-items-center rounded-lg p-1 outline-none ${
                      draft.avatarShape === shape
                        ? 'bg-background-tertiary ring-2 ring-focus'
                        : 'hover:bg-background-secondary'
                    }`}
                  >
                    <MascotFace name={draft.name} color={draft.avatarColor} shape={shape} />
                  </button>
                ))}
              </div>

              <ColorSwatchPicker
                aria-label={t('bots.botFields.avatarColour')}
                value={draft.avatarColor}
                onChange={(color) => {
                  // The picker answers in its own hex casing; the palette's
                  // spelling is the one the server stores.
                  const hex = color.toString('hex').toLowerCase();
                  const match = AVATAR_COLORS.find((candidate) => candidate === hex);
                  if (match !== undefined) onChange({ ...draft, avatarColor: match });
                }}
                size="sm"
                className="flex-wrap justify-center"
              >
                {AVATAR_COLORS.map((color) => (
                  <ColorSwatchPicker.Item
                    key={color}
                    color={color}
                    aria-label={t('bots.avatarColour', { color })}
                  >
                    <ColorSwatchPicker.Swatch colorName={t('bots.avatarColour', { color })} />
                    <ColorSwatchPicker.Indicator />
                  </ColorSwatchPicker.Item>
                ))}
              </ColorSwatchPicker>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      </div>

      {mainAssistant ? (
        <dl className="flex flex-col gap-2 text-footnote">
          <LockedRow label={t('bots.botFields.name')} value={draft.name} />
          <LockedRow label={t('bots.botFields.label')} value={draft.role} />
        </dl>
      ) : (
        <>
          <Field id={nameId} label={t('bots.botFields.name')}>
            <Input
              id={nameId}
              variant="secondary"
              value={draft.name}
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
              className="w-full"
            />
          </Field>

          {/* "Label" is the reference app's word for what PRD §3 calls `role`. The
              reference marks it optional; the column is not, so neither is this. */}
          <Field id={roleId} label={t('bots.botFields.label')}>
            <Input
              id={roleId}
              variant="secondary"
              value={draft.role}
              onChange={(event) => onChange({ ...draft, role: event.target.value })}
              className="w-full"
            />
          </Field>
        </>
      )}

      {/* The bot's system prompt. "Description" is the reference's label, and
          the friendlier one — but this text is what the model is told, not a
          note about the bot, so the placeholder says so.

          It used to ask what the bot is FOR, and got job descriptions
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
        <TextArea
          id={promptId}
          variant="secondary"
          rows={promptRows}
          placeholder={
            mainAssistant
              ? t('bots.botFields.keepAnswersBriefChallengeWeak')
              : t('bots.botFields.whoThisBotIsNot')
          }
          value={draft.systemPrompt}
          onChange={(event) => onChange({ ...draft, systemPrompt: event.target.value })}
          className="w-full resize-none"
        />
        {mainAssistant ? (
          <p className="mt-1.5 text-caption text-muted">
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
      <label htmlFor={id} className="mb-1.5 block text-caption text-muted">
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
