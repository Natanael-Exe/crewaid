import { compareRank, rankBetween, type TaskCard, type TaskStatus } from '@crewaid/shared';
import { t, currentLocale } from '../i18n/i18n';

/**
 * The Tasks board's arrangement, as pure functions. The
 * server owns every number on a card; this decides only which cards show,
 * where, and in what order — and where a dropped card lands.
 */

/** The board's columns, left to right. Cancelled tasks are not on the board. */
export const BOARD_COLUMNS: readonly TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'IN_REVIEW',
  'DONE',
];

// Getters, so each read is in the language in effect at that moment.
export const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  get TODO() {
    return t('work.status.todo');
  },
  get IN_PROGRESS() {
    return t('work.status.inProgress');
  },
  get BLOCKED() {
    return t('work.status.blocked');
  },
  get IN_REVIEW() {
    return t('work.status.review');
  },
  get DONE() {
    return t('work.status.done');
  },
  get CANCELLED() {
    return t('work.status.cancelled');
  },
};

/** How far back Done reaches until "Show all". */
export const DONE_WINDOW_DAYS = 14;

export function doneSince(now: Date, days = DONE_WINDOW_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export type GroupBy = 'status' | 'bot' | 'project';

/**
 * One card per recurring series: its newest occurrence, which carries the
 * series' history on `series`. Older occurrences are left to
 * the List view and the details, never dropped from the data.
 */
export function collapseSeries(cards: readonly TaskCard[]): TaskCard[] {
  return cards.filter((card) => card.series === null || card.series.newest);
}

/** The cards of one column, in rank order. */
export function columnCards(cards: readonly TaskCard[], status: TaskStatus): TaskCard[] {
  return cards
    .filter((card) => card.status === status)
    .sort((a, b) => compareRank(a.rank, b.rank) || a.createdAt.getTime() - b.createdAt.getTime());
}

export type Lane = { readonly key: string; readonly label: string; readonly cards: TaskCard[] };

/**
 * Swimlanes: one per assignee ("who is doing what"), or one per project.
 * Unassigned and No project come last, and lanes with no cards are dropped.
 */
export function lanes(
  cards: readonly TaskCard[],
  groupBy: GroupBy,
  names: {
    readonly bot: (id: string) => string | undefined;
    readonly project: (id: string) => string | undefined;
  },
): Lane[] {
  if (groupBy === 'status') return [{ key: 'all', label: '', cards: [...cards] }];
  const keyOf = (card: TaskCard) => (groupBy === 'bot' ? card.assigneeBotId : card.projectId);
  const byKey = new Map<string | null, TaskCard[]>();
  for (const card of cards) {
    const key = keyOf(card);
    byKey.set(key, [...(byKey.get(key) ?? []), card]);
  }
  const named = [...byKey.entries()]
    .filter((entry): entry is [string, TaskCard[]] => entry[0] !== null)
    .map(([key, rows]) => ({
      key,
      label:
        (groupBy === 'bot' ? names.bot(key) : names.project(key)) ?? t('work.boardState.unknown'),
      cards: rows,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const none = byKey.get(null);
  return none === undefined
    ? named
    : [
        ...named,
        {
          key: 'none',
          label:
            groupBy === 'bot' ? t('work.boardState.unassigned') : t('work.boardState.noProject'),
          cards: none,
        },
      ];
}

/** A due date before today, for a task that is still open. */
export function isOverdue(card: Pick<TaskCard, 'dueOn' | 'status'>, today: string): boolean {
  return (
    card.dueOn !== null &&
    card.dueOn < today &&
    card.status !== 'DONE' &&
    card.status !== 'CANCELLED'
  );
}

/** Today's date as the user's calendar reads it, for due-date comparisons. */
export function localToday(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The rank for a card dropped into a column at `index` (0 = top). The card
 * being moved is left out of the neighbours, so dropping it where it already
 * is asks for a rank between the same two cards it sits between.
 */
export function rankForDrop(
  column: readonly Pick<TaskCard, 'id' | 'rank'>[],
  movingId: string,
  index: number,
): string {
  const others = column.filter((card) => card.id !== movingId);
  const at = Math.max(0, Math.min(index, others.length));
  const before = at === 0 ? null : (others[at - 1]?.rank ?? null);
  const after = others[at]?.rank ?? null;
  if (before !== null && after !== null && before >= after) {
    // Two cards share a rank (created in one instant by two writers). Put
    // this one just after the earlier of them rather than failing the drop.
    return rankBetween(before, null);
  }
  return rankBetween(before, after);
}

/** A card's history chip for a recurring task: "4 of last 5". */
export function seriesChip(card: TaskCard): string | null {
  if (card.series === null || card.series.recent.total === 0) return null;
  return t('work.series.chip', {
    done: card.series.recent.done,
    total: card.series.recent.total,
  });
}

/** "Mar 3", or "Mar 3, 2027" outside this year — how a due date reads on a card. */
export function shortDate(date: string, now: Date = new Date()): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  const value = new Date(year, month - 1, day);
  return value.toLocaleDateString(currentLocale(), {
    month: 'short',
    day: 'numeric',
    ...(year !== now.getFullYear() && { year: 'numeric' }),
  });
}
