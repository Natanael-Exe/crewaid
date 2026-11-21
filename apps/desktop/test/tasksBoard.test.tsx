import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { compareRank, type BotWithSandbox, type TaskCard } from '@crewaid/shared';

import { Board, TaskList } from '../src/renderer/work/TasksView';
import {
  collapseSeries,
  columnCards,
  isOverdue,
  lanes,
  rankForDrop,
  seriesChip,
} from '../src/renderer/work/boardState';

/**
 * M10-FE-02 — the Tasks board and list (PRD-WORK §7.2).
 */
const NOW = new Date('2026-09-23T12:00:00Z');
let serial = 0;
function card(title: string, over: Partial<TaskCard> = {}): TaskCard {
  serial += 1;
  return {
    id: `t${serial}`,
    userId: 'u',
    projectId: null,
    goalId: null,
    parentId: null,
    title,
    brief: null,
    status: 'TODO',
    blockedReason: null,
    assigneeBotId: null,
    origin: 'OPERATOR',
    seriesId: null,
    occursAt: null,
    occursOn: null,
    createdByBotId: null,
    dueOn: null,
    rank: 'i',
    startedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    subtasks: { done: 0, total: 0 },
    deliverableCount: 0,
    series: null,
    ...over,
  };
}

const bot = {
  id: 'b1',
  name: 'Backend',
  avatarColor: '#2563EB',
  status: 'IDLE',
} as unknown as BotWithSandbox;

describe('board arrangement', () => {
  it('shows one card per recurring series — its newest — and keeps one-off tasks', () => {
    const series = (newest: boolean) => ({
      recent: { done: 1, total: 2 },
      olderOpenCount: 0,
      newest,
    });
    const shown = collapseSeries([
      card('one-off'),
      card('old', { seriesId: 's', series: series(false) }),
      card('new', { seriesId: 's', series: series(true) }),
    ]);
    expect(shown.map((row) => row.title)).toEqual(['one-off', 'new']);
  });

  it('orders a column by rank and groups lanes by bot, Unassigned last', () => {
    const cards = [
      card('b', { rank: 'm', assigneeBotId: 'b1' }),
      card('a', { rank: 'c' }),
      card('c', { rank: 'x', status: 'DONE' }),
    ];
    expect(columnCards(cards, 'TODO').map((row) => row.title)).toEqual(['a', 'b']);
    const byBot = lanes(cards, 'bot', { bot: () => 'Backend', project: () => undefined });
    expect(byBot.map((lane) => lane.label)).toEqual(['Backend', 'Unassigned']);
    expect(lanes(cards, 'status', { bot: () => undefined, project: () => undefined })).toHaveLength(
      1,
    );
  });

  it('places a dropped card between its new neighbours, leaving itself out', () => {
    const column = [card('a', { rank: 'c' }), card('b', { rank: 'm' }), card('c', { rank: 't' })];
    const moving = column[2]!;
    const top = rankForDrop(column, moving.id, 0);
    expect(compareRank(top, 'c')).toBe(-1);
    const between = rankForDrop(column, moving.id, 1);
    expect(compareRank('c', between)).toBe(-1);
    expect(compareRank(between, 'm')).toBe(-1);
    expect(compareRank('m', rankForDrop(column, 'other', 3))).toBe(-1);
  });

  it('marks overdue only for open tasks with a past due date', () => {
    expect(isOverdue({ dueOn: '2026-09-20', status: 'TODO' }, '2026-09-23')).toBe(true);
    expect(isOverdue({ dueOn: '2026-09-20', status: 'DONE' }, '2026-09-23')).toBe(false);
    expect(isOverdue({ dueOn: '2026-09-23', status: 'TODO' }, '2026-09-23')).toBe(false);
  });

  it('writes the series chip from the server’s numbers', () => {
    expect(
      seriesChip(
        card('x', { series: { recent: { done: 4, total: 5 }, olderOpenCount: 1, newest: true } }),
      ),
    ).toBe('4 of last 5');
    expect(seriesChip(card('x'))).toBeNull();
  });
});

describe('Board', () => {
  const render = (cards: TaskCard[], showAllDone = false) =>
    renderToStaticMarkup(
      <Board
        cards={cards}
        groupBy="status"
        botById={new Map([[bot.id, bot]])}
        projectById={new Map()}
        today="2026-09-23"
        selectedTaskId={null}
        onOpenTask={() => {}}
        onMove={() => {}}
        onQuickAdd={() => {}}
        showAllDone={showAllDone}
        onShowAllDone={() => {}}
      />,
    );

  it('draws a column per status, with the card’s numbers and quick add in To do', () => {
    const html = render([
      card('API auth', {
        status: 'IN_PROGRESS',
        assigneeBotId: 'b1',
        deliverableCount: 2,
        subtasks: { done: 1, total: 3 },
      }),
      card('Stripe webhook', { status: 'BLOCKED', blockedReason: 'Waiting on keys' }),
    ]);
    for (const column of ['To do', 'In progress', 'Blocked', 'Review', 'Done'])
      expect(html).toContain(column);
    expect(html).not.toContain('Cancelled');
    expect(html).toContain('Add a task');
    expect(html).toContain('1 of 3 subtasks done');
    expect(html).toContain('2 deliverables');
    expect(html).toContain('Waiting on keys');
    expect(html).toContain('Backend');
    expect(html).toContain('draggable="true"');
  });

  it('offers Show all under Done until it is chosen', () => {
    expect(render([card('x')])).toContain('Show all');
    expect(render([card('x')], true)).not.toContain('Show all');
  });
});

describe('TaskList', () => {
  it('lists every occurrence of a recurring task on its own row', () => {
    const series = (newest: boolean) => ({
      recent: { done: 0, total: 2 },
      olderOpenCount: 1,
      newest,
    });
    const html = renderToStaticMarkup(
      <TaskList
        cards={[
          card('Work out', { seriesId: 's', occursOn: '2026-09-21', series: series(false) }),
          card('Work out', { seriesId: 's', occursOn: '2026-09-23', series: series(true) }),
        ]}
        botById={new Map()}
        projectById={new Map()}
        today="2026-09-23"
        selectedTaskId={null}
        onOpenTask={() => {}}
      />,
    );
    expect(html.match(/Work out/g)).toHaveLength(2);
    expect(html).toContain('Sep 21');
  });
});
