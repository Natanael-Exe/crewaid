import { Surface } from '@heroui/react';
import { useEffect, useRef } from 'react';
import { BotAvatar } from '../BotAvatar';
import type { MentionBot } from './botMention';
import { useT } from '../../i18n/i18n';

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
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rows = listRef.current?.querySelectorAll('[data-bot-row]');
    rows?.[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <Surface
      variant="default"
      data-bot-palette
      className="absolute bottom-full start-0 z-40 mb-2 w-[min(460px,100%)] overflow-hidden rounded-card shadow-lg"
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={t('composer.bots')}
        className="max-h-72 overflow-y-auto py-1"
      >
        {bots.map((bot, index) => (
          <div
            key={bot.id}
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
              <span className="block truncate text-[13px] font-medium">@{bot.name}</span>
              <span className="block truncate text-[11px] text-muted">{bot.role}</span>
            </span>
          </div>
        ))}
        {bots.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-muted">{t('composer.bot.noMatch')}</div>
        ) : null}
      </div>
      <div className="border-t border-divider px-3 py-1.5 text-[10px] text-foreground-faint">
        {t('composer.palette.hint')}
      </div>
    </Surface>
  );
}
