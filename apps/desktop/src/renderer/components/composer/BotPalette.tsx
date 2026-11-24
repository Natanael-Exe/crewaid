import { BotAvatar } from '../BotAvatar';
import { ComposerPaletteShell } from './ComposerPaletteShell';
import type { MentionBot } from './botMention';
import { useT } from '../../i18n/i18n';

export const BOT_PALETTE_LIST_ID = 'crewaid-bot-palette-list';
export const botPaletteOptionId = (index: number): string => `crewaid-bot-palette-opt-${index}`;

/** The `@` teammate picker, parallel to the `/` tool picker. */
export function BotPalette({
  bots,
  selected,
  onPick,
  onSelectedChanged,
}: {
  bots: readonly MentionBot[];
  selected: number;
  onPick: (bot: MentionBot) => void;
  onSelectedChanged: (index: number) => void;
}) {
  const t = useT();
  return (
    <ComposerPaletteShell
      id={BOT_PALETTE_LIST_ID}
      label={t('composer.bots')}
      dataAttr="bot"
      widthClass="w-[min(460px,100%)]"
      selected={selected}
      rowSelector="[data-bot-row]"
    >
      {bots.map((bot, index) => (
        <div
          key={bot.id}
          id={botPaletteOptionId(index)}
          data-bot-row={bot.id}
          role="option"
          aria-selected={index === selected}
          tabIndex={-1}
          className={`mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ${
            index === selected ? 'bg-surface-secondary' : ''
          }`}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(bot);
          }}
          onMouseEnter={() => onSelectedChanged(index)}
        >
          <BotAvatar bot={bot} size="xs" />
          <span className="min-w-0">
            <span className="block truncate text-footnote font-medium">@{bot.name}</span>
            <span className="block truncate text-micro text-muted">{bot.role}</span>
          </span>
        </div>
      ))}
      {bots.length === 0 ? (
        <div className="px-3 py-3 text-caption text-muted">{t('composer.bot.noMatch')}</div>
      ) : null}
    </ComposerPaletteShell>
  );
}
