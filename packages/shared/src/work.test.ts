import { describe, expect, it } from 'vitest';

import { MessageSchema, RoutineSchema } from './models.js';
import {
  RankSchema,
  compareRank,
  goalProgress,
  rankBetween,
  seriesDoneRate,
  subtaskProgress,
  type TaskStatus,
} from './work.js';

describe('rankBetween', () => {
  it('places a first card, and cards at either end', () => {
    const first = rankBetween(null, null);
    const top = rankBetween(null, first);
    const bottom = rankBetween(first, null);
    expect(compareRank(top, first)).toBe(-1);
    expect(compareRank(first, bottom)).toBe(-1);
  });

  it('always finds room between neighbours, and every rank it writes is legal', () => {
    // Repeatedly insert at the same spot — the worst case for key growth —
    // and between random neighbours, checking order and shape each time.
    const ranks = [rankBetween(null, null)];
    let seed = 7;
    const random = () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    for (let i = 0; i < 400; i += 1) {
      const at = i % 3 === 0 ? 1 : Math.floor(random() * (ranks.length + 1));
      const before = at === 0 ? null : (ranks[at - 1] ?? null);
      const after = ranks[at] ?? null;
      const rank = rankBetween(before, after);
      expect(RankSchema.safeParse(rank).success, rank).toBe(true);
      if (before !== null) expect(compareRank(before, rank)).toBe(-1);
      if (after !== null) expect(compareRank(rank, after)).toBe(-1);
      ranks.splice(at, 0, rank);
    }
    expect([...ranks].sort(compareRank)).toEqual(ranks);
    expect(Math.max(...ranks.map((rank) => rank.length))).toBeLessThanOrEqual(128);
  });

  it('refuses neighbours given out of order', () => {
    expect(() => rankBetween('m', 'c')).toThrow(RangeError);
    expect(() => rankBetween('m', 'm')).toThrow(RangeError);
  });
});

const task = (status: TaskStatus, extra: { parentId?: string; seriesId?: string } = {}) => ({
  status,
  parentId: extra.parentId ?? null,
  seriesId: extra.seriesId ?? null,
});

describe('goalProgress', () => {
  it('is done over all but cancelled, among one-off top-level tasks', () => {
    expect(
      goalProgress([
        task('DONE'),
        task('DONE'),
        task('IN_PROGRESS'),
        task('CANCELLED'),
        // A subtask is its parent's business.
        task('DONE', { parentId: 'p' }),
        // An occurrence counts toward its series' done rate instead.
        task('TODO', { seriesId: 's' }),
      ]),
    ).toEqual({ done: 2, total: 3 });
  });

  it('is 0/0 for an empty goal, and for one holding only recurring tasks', () => {
    expect(goalProgress([])).toEqual({ done: 0, total: 0 });
    expect(goalProgress([task('DONE', { seriesId: 's' })])).toEqual({ done: 0, total: 0 });
  });
});

describe('subtaskProgress', () => {
  it('leaves cancelled subtasks out of 3/5', () => {
    expect(
      subtaskProgress([
        task('DONE'),
        task('DONE'),
        task('DONE'),
        task('TODO'),
        task('BLOCKED'),
        task('CANCELLED'),
      ]),
    ).toEqual({ done: 3, total: 5 });
  });
});

describe('seriesDoneRate', () => {
  const at = (iso: string, status: TaskStatus) => ({ status, occursAt: new Date(iso) });
  const since = new Date('2026-09-01T00:00:00Z');
  const now = new Date('2026-09-10T00:00:00Z');

  it('counts a missed occurrence against the rate and a cancelled one not at all', () => {
    expect(
      seriesDoneRate(
        [
          at('2026-09-02T07:00:00Z', 'DONE'),
          at('2026-09-04T07:00:00Z', 'TODO'), // missed
          at('2026-09-07T07:00:00Z', 'DONE'),
          at('2026-09-09T07:00:00Z', 'CANCELLED'),
        ],
        since,
        now,
      ),
    ).toEqual({ done: 2, total: 3 });
  });

  it('only counts occurrences over the goal’s lifetime so far', () => {
    expect(
      seriesDoneRate(
        [
          at('2026-08-30T07:00:00Z', 'DONE'), // before the goal started
          at('2026-09-02T07:00:00Z', 'DONE'),
          at('2026-09-11T07:00:00Z', 'TODO'), // not yet due
          { status: 'DONE' as const, occursAt: null }, // a one-off task
        ],
        since,
        now,
      ),
    ).toEqual({ done: 1, total: 1 });
  });
});

describe('Work columns on existing rows', () => {
  it('defaults Message.taskId/routineId and Routine.goalId for an older server', () => {
    const message = MessageSchema.parse({
      id: 'clx1a2b3c4d5e6f7g8h9i0j1',
      conversationId: 'clx9z8y7x6w5v4u3t2s1r0q9',
      author: 'USER',
      fromBotId: null,
      content: 'hi',
      parts: null,
      stopReason: null,
      chainId: null,
      hopCount: 0,
      createdAt: new Date(),
    });
    expect(message.taskId).toBeNull();
    expect(message.routineId).toBeNull();

    const routine = RoutineSchema.parse({
      id: 'clx1a2b3c4d5e6f7g8h9i0j1',
      botId: 'clx9z8y7x6w5v4u3t2s1r0q9',
      name: 'Weekly',
      cron: '0 20 * * 0',
      timezone: 'America/New_York',
      endsOn: null,
      prompt: 'How did my week go?',
      skillId: null,
      skillParams: null,
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
      origin: 'OPERATOR',
    });
    expect(routine.goalId).toBeNull();
  });
});
