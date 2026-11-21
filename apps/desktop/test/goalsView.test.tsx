import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GoalWithProgress } from '@crewaid/shared';

import { GoalCard } from '../src/renderer/work/GoalsView';
import {
  orderGoals,
  percent,
  progressText,
  rateText,
  readyToClose,
} from '../src/renderer/work/goalsState';

/** M10-FE-05 — the Goals view (PRD-WORK §3.4, §7.5). */
const NOW = new Date('2026-09-23T12:00:00Z');
const goal = (over: Partial<GoalWithProgress> = {}): GoalWithProgress => ({
  id: 'g1',
  userId: 'u',
  projectId: null,
  title: 'Ship the MVP',
  outcome: null,
  targetOn: '2026-11-01',
  status: 'ACTIVE',
  closedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  progress: { done: 12, total: 20 },
  series: [],
  routineCount: 0,
  ...over,
});

describe('goal numbers', () => {
  it('reads progress as a count and a percentage, and says nothing with no tasks', () => {
    expect(progressText({ done: 12, total: 20 })).toBe('12/20 tasks');
    expect(percent({ done: 12, total: 20 })).toBe(60);
    expect(progressText({ done: 0, total: 0 })).toBeNull();
    expect(percent({ done: 0, total: 0 })).toBeNull();
    expect(rateText('Work out', { done: 11, total: 12 })).toBe('Work out 11/12');
  });

  it('is Ready to close only when open and every one-off task is done — never closing itself', () => {
    expect(readyToClose(goal({ progress: { done: 20, total: 20 } }))).toBe(true);
    expect(readyToClose(goal({ progress: { done: 19, total: 20 } }))).toBe(false);
    expect(readyToClose(goal({ progress: { done: 0, total: 0 } }))).toBe(false);
    expect(readyToClose(goal({ progress: { done: 20, total: 20 }, status: 'ACHIEVED' }))).toBe(
      false,
    );
  });

  it('orders open goals by target date, undated after, closed ones last', () => {
    const ordered = orderGoals([
      goal({ id: 'closed', status: 'ACHIEVED', targetOn: '2026-01-01' }),
      goal({ id: 'undated', targetOn: null }),
      goal({ id: 'later', targetOn: '2027-01-01' }),
      goal({ id: 'soon', targetOn: '2026-10-01' }),
    ]);
    expect(ordered.map((row) => row.id)).toEqual(['soon', 'later', 'undated', 'closed']);
  });
});

describe('GoalCard', () => {
  it('shows progress, recurring done rates and routines, and Ready to close at 100%', () => {
    const html = renderToStaticMarkup(
      <GoalCard
        goal={goal({
          title: 'Lose 8 kg by March',
          progress: { done: 3, total: 3 },
          series: [
            { seriesId: 's1', title: 'Work out', enabled: true, rate: { done: 11, total: 12 } },
            {
              seriesId: 's2',
              title: 'Log my weight',
              enabled: true,
              rate: { done: 25, total: 28 },
            },
          ],
          routineCount: 1,
        })}
        project={undefined}
        selected={false}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('Lose 8 kg by March');
    expect(html).toContain('3/3 tasks');
    expect(html).toContain('Work out 11/12');
    expect(html).toContain('Log my weight 25/28');
    expect(html).toContain('1 routine');
    expect(html).toContain('Ready to close');
  });

  it('shows only the done rates for a goal made of recurring tasks', () => {
    const html = renderToStaticMarkup(
      <GoalCard
        goal={goal({
          progress: { done: 0, total: 0 },
          series: [
            { seriesId: 's1', title: 'Work out', enabled: true, rate: { done: 2, total: 3 } },
          ],
        })}
        project={undefined}
        selected={false}
        onOpen={() => {}}
      />,
    );
    expect(html).not.toContain('tasks ·');
    expect(html).toContain('Work out 2/3');
    expect(html).not.toContain('Ready to close');
  });
});
