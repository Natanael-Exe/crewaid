import { IconPaperclip, IconRepeat } from '@tabler/icons-react';
import type { BotWithSandbox, ProjectWithCounts, TaskCard } from '@crewaid/shared';
import { BotAvatar } from '../components/BotAvatar';
import { StatusDot } from '../components/Chips';
import { isOverdue, seriesChip, shortDate } from './boardState';
import { useT } from '../i18n/i18n';

/**
 * One card on the board: title, assignee, project dot,
 * subtask progress, deliverable count, due date (red when overdue), and the
 * assignee's live status while it is working. A recurring task's card adds
 * its history chip and how many older occurrences are still open.
 */
export function TaskCardView({
  card,
  assignee,
  project,
  today,
  selected,
  onOpen,
  onDragStart,
  onMoveColumn,
}: {
  card: TaskCard;
  assignee: BotWithSandbox | undefined;
  project: ProjectWithCounts | undefined;
  today: string;
  selected: boolean;
  onOpen: () => void;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onMoveColumn?: (delta: -1 | 1) => void;
}) {
  const t = useT();
  const chip = seriesChip(card);
  const working =
    assignee !== undefined && assignee.status !== 'IDLE' && card.status === 'IN_PROGRESS';
  return (
    <button
      type="button"
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart}
      onClick={onOpen}
      onKeyDown={
        onMoveColumn === undefined
          ? undefined
          : (event) => {
              if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
              const step: -1 | 1 = event.key === 'ArrowRight' ? (rtl ? -1 : 1) : rtl ? 1 : -1;
              onMoveColumn(step);
            }
      }
      aria-keyshortcuts={onMoveColumn !== undefined ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined}
      aria-pressed={selected}
      className={`crewaid-task-card group flex w-full flex-col gap-2 rounded-[10px] border bg-surface p-2.5 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/40 ${
        selected ? 'border-accent/60' : 'border-border hover:border-foreground/20'
      }`}
    >
      <span className="flex min-w-0 items-start gap-1.5">
        {project !== undefined ? (
          <span
            aria-label={project.name}
            title={project.name}
            className="mt-[5px] size-2 shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
          />
        ) : null}
        <span className="min-w-0 flex-1 text-footnote leading-[18px] text-foreground">
          {card.title}
        </span>
      </span>
      {card.status === 'BLOCKED' && card.blockedReason !== null ? (
        <span className="line-clamp-2 text-micro leading-4 text-warning">{card.blockedReason}</span>
      ) : null}
      <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-micro text-muted">
        {assignee !== undefined ? (
          <span className="flex min-w-0 items-center gap-1">
            <BotAvatar bot={assignee} size="sm" />
            <span className="max-w-[90px] truncate">{assignee.name}</span>
            {working ? <StatusDot status={assignee.status} /> : null}
          </span>
        ) : null}
        {card.subtasks.total > 0 ? (
          <span
            className="tabular-nums"
            aria-label={t('work.card.subtasks', {
              done: card.subtasks.done,
              total: card.subtasks.total,
            })}
          >
            {card.subtasks.done}/{card.subtasks.total}
          </span>
        ) : null}
        {card.deliverableCount > 0 ? (
          <span
            className="flex items-center gap-0.5 tabular-nums"
            aria-label={t('work.card.deliverables', { count: card.deliverableCount })}
          >
            <IconPaperclip className="size-3" stroke={1.8} />
            {card.deliverableCount}
          </span>
        ) : null}
        {chip !== null ? (
          <span
            className="flex items-center gap-0.5 tabular-nums"
            aria-label={t('work.card.recurring', { chip })}
          >
            <IconRepeat className="size-3" stroke={1.8} />
            {chip}
          </span>
        ) : card.seriesId !== null ? (
          <IconRepeat
            aria-label={t('work.goalDetailsPane.recurring')}
            className="size-3"
            stroke={1.8}
          />
        ) : null}
        {card.series !== null && card.series.olderOpenCount > 0 ? (
          <span className="tabular-nums text-warning">
            {t('work.card.olderOpen', { count: card.series.olderOpenCount })}
          </span>
        ) : null}
        {card.dueOn !== null ? (
          <span
            className={`tabular-nums ${isOverdue(card, today) ? 'font-medium text-danger' : ''}`}
          >
            {isOverdue(card, today)
              ? t('work.card.overdue', { date: shortDate(card.dueOn) })
              : t('work.card.due', { date: shortDate(card.dueOn) })}
          </span>
        ) : card.occursOn !== null ? (
          <span className="tabular-nums">{shortDate(card.occursOn)}</span>
        ) : null}
      </span>
    </button>
  );
}
