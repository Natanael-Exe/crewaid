import { Button } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { TaskCard } from '@crewaid/shared';
import type { ApiClient } from '../api/apiClient';
import { listTasks } from '../api/work';
import { STATUS_LABELS } from './boardState';
import { useT } from '../i18n/i18n';

/** How many open tasks the rail lists before "See all". */
const SHOWN = 5;

/**
 * A bot's open tasks in its rail, between the screen and its
 * routines — and nothing at all when it has none, so a bot nobody gives tasks
 * to looks exactly as it did before Work existed.
 */
export function BotTasksSection({
  client,
  botId,
  revision,
  onOpenTask,
  onSeeAll,
}: {
  client: ApiClient;
  botId: string;
  revision: number;
  onOpenTask: (taskId: string) => void;
  onSeeAll: () => void;
}) {
  const t = useT();
  const [cards, setCards] = useState<readonly TaskCard[]>([]);

  useEffect(() => {
    let live = true;
    listTasks(client, {
      assigneeBotId: botId,
      status: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW'],
    })
      .then((rows) => {
        if (live) setCards(rows);
      })
      // An older server has no /tasks; the rail simply shows no section.
      .catch(() => {
        if (live) setCards([]);
      });
    return () => {
      live = false;
    };
  }, [client, botId, revision]);

  if (cards.length === 0) return null;
  return (
    <section
      aria-label={t('work.botTasksSection.tasks')}
      className="crewaid-bot-tasks flex flex-col gap-2"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{t('work.botTasksSection.tasks')}</h3>
        <Button
          size="sm"
          variant="ghost"
          onPress={onSeeAll}
          className="h-6 min-w-0 px-2 text-micro text-muted tabular-nums hover:text-foreground"
        >
          {cards.length > SHOWN
            ? t('work.seeAllCount', { count: cards.length })
            : t('work.botTasksSection.seeAll')}
        </Button>
      </div>
      <ul className="flex flex-col gap-1">
        {cards.slice(0, SHOWN).map((card) => (
          <li key={card.id}>
            <button
              type="button"
              onClick={() => onOpenTask(card.id)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-start transition-colors hover:border-foreground/20 hover:bg-surface-secondary"
            >
              <span className="min-w-0 flex-1 truncate text-footnote">{card.title}</span>
              <span
                className={`shrink-0 text-micro ${
                  card.status === 'BLOCKED'
                    ? 'text-warning'
                    : card.status === 'IN_REVIEW'
                      ? 'text-accent-soft-foreground'
                      : 'text-muted'
                }`}
              >
                {STATUS_LABELS[card.status]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
