import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { Routine } from '@crewaid/shared';

import { ApiClient } from '../src/renderer/api/apiClient';
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  runRoutineNow,
  updateRoutine,
} from '../src/renderer/api/routines';
import { RoutinesPanel, type RoutineActions } from '../src/renderer/routines/RoutinesPanel';
import {
  createBodyOf,
  describeSchedule,
  draftFromRoutine,
  draftProblem,
  emptyDraft,
  isInFlight,
  lastRunView,
  relativeTime,
  routineEnded,
  routinesForBot,
  scheduleText,
  updateBodyOf,
} from '../src/renderer/routines/routinesState';

/**
 * M8-FE-01 — the routine panel in the right rail: create, edit,
 * enable/disable, run-now, last-run status — and, since M8-BE-08, the
 * routines a bot scheduled for itself, marked (D-125).
 */

const BOT = 'cbot00000000000000000000a';
const OTHER_BOT = 'cbot00000000000000000000b';
const NOW = new Date('2026-09-22T15:00:00.000Z');

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'croutine000000000000000001',
    botId: BOT,
    name: 'Morning digest',
    cron: '0 9 * * 1-5',
    timezone: 'America/New_York',
    endsOn: null,
    prompt: 'Summarise the inbox.',
    skillId: null,
    skillParams: null,
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    origin: 'OPERATOR',
    goalId: null,
    ...over,
  };
}

describe('describeSchedule — a cron in words, never a guess', () => {
  it.each([
    ['*/5 * * * *', 'Every 5 minutes'],
    ['* * * * *', 'Every minute'],
    ['0 * * * *', 'Hourly'],
    ['15 * * * *', 'Hourly at :15'],
    ['0 9 * * *', 'Daily at 09:00'],
    ['30 7 * * 1-5', 'Weekdays at 07:30'],
    ['0 10 * * 0,6', 'Weekends at 10:00'],
    ['0 8 * * 1', 'Mondays at 08:00'],
    ['0 9 * * 1,3', 'Weekly on Mon, Wed at 09:00'],
    ['0 6 1 * *', 'Monthly on day 1 at 06:00'],
    ['30 8 24 9 *', 'Sep 24 at 08:30'],
    ['0 */2 * * *', 'Every 2 hours'],
    ['0 9 1 */2 *', 'Every 2 months on day 1 at 09:00'],
  ])('%s → %s', (cron, words) => {
    expect(describeSchedule(cron)).toBe(words);
  });

  it('shows anything it does not recognise exactly as written', () => {
    expect(describeSchedule('0 9-17/2 * * 1-5')).toBe('0 9-17/2 * * 1-5');
    expect(describeSchedule('not a cron')).toBe('not a cron');
  });

  it('lists an unrecognised schedule as "Custom schedule", not as cron', () => {
    expect(scheduleText('0 9-17/2 * * 1-5')).toBe('Custom schedule');
    expect(scheduleText('0 9 * * 1-5')).toBe('Weekdays at 09:00');
  });
});

describe('lastRunView — what happened last, at a glance', () => {
  it('reads "Never run" before the first firing', () => {
    expect(lastRunView(routine(), NOW)).toEqual({ label: 'Never run', tone: 'default' });
  });

  it('names the outcome and how long ago', () => {
    const at = '2026-09-22T12:00:00.000Z';
    expect(lastRunView(routine({ lastRunAt: at, lastStatus: 'SUCCEEDED' }), NOW)).toEqual({
      label: 'Succeeded · 3 h ago',
      tone: 'success',
    });
    expect(lastRunView(routine({ lastRunAt: at, lastStatus: 'FAILED' }), NOW).tone).toBe('danger');
    expect(lastRunView(routine({ lastRunAt: at, lastStatus: 'RUNNING' }), NOW).label).toBe(
      'Running',
    );
    expect(lastRunView(routine({ lastRunAt: at, lastStatus: 'PENDING' }), NOW).label).toBe(
      'Queued',
    );
  });

  it('keeps polling only while an outcome is still arriving', () => {
    expect(isInFlight(routine({ lastStatus: 'RUNNING' }))).toBe(true);
    expect(isInFlight(routine({ lastStatus: 'PENDING' }))).toBe(true);
    expect(isInFlight(routine({ lastStatus: 'SUCCEEDED' }))).toBe(false);
    expect(isInFlight(routine())).toBe(false);
  });

  it('coarsens time the way a glance needs', () => {
    expect(relativeTime(new Date(NOW.getTime() - 20_000), NOW)).toBe('just now');
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe('5 min ago');
    expect(relativeTime(new Date(NOW.getTime() - 3 * 86_400_000), NOW)).toBe('3 d ago');
  });
});

describe('routineEnded — after the last day, in the routine’s own zone', () => {
  it('is over only once its end date has passed there', () => {
    // 15:00 UTC on the 22nd: the 22nd in New York, the 23rd in Kiritimati.
    expect(routineEnded(routine({ endsOn: '2026-09-22' }), NOW)).toBe(false);
    expect(routineEnded(routine({ endsOn: '2026-09-21' }), NOW)).toBe(true);
    expect(
      routineEnded(routine({ endsOn: '2026-09-22', timezone: 'Pacific/Kiritimati' }), NOW),
    ).toBe(true);
    expect(routineEnded(routine({ endsOn: null }), NOW)).toBe(false);
  });
});

describe('routinesForBot', () => {
  it('shows one bot’s routines, the operator’s before the bot’s own, each by name', () => {
    const rows = routinesForBot(
      [
        routine({ id: 'c1', name: 'Zeta', origin: 'OPERATOR' }),
        routine({ id: 'c2', name: 'Alpha', origin: 'BOT' }),
        routine({ id: 'c3', name: 'Beta', origin: 'OPERATOR' }),
        routine({ id: 'c4', name: 'Other', botId: OTHER_BOT }),
      ],
      BOT,
    );
    expect(rows.map((r) => r.name)).toEqual(['Beta', 'Zeta', 'Alpha']);
  });
});

describe('the form', () => {
  it('stops Save on what is plainly missing, with a sentence', () => {
    // A new routine starts with no schedule: the operator picks one.
    expect(emptyDraft('America/New_York').cron).toBe('');
    expect(
      draftProblem({ ...emptyDraft('America/New_York'), name: 'D', prompt: 'S.' }, false),
    ).toMatch(/repeat/);
    const ok = {
      ...emptyDraft('America/New_York'),
      name: 'Digest',
      cron: '0 9 * * 1-5',
      prompt: 'Summarise.',
    };
    expect(draftProblem(ok, false)).toBeNull();
    expect(draftProblem({ ...ok, name: ' ' }, false)).toMatch(/name/);
    expect(draftProblem({ ...ok, cron: '* * * * * *' }, false)).toMatch(/repeat/);
    expect(draftProblem({ ...ok, timezone: 'Mars/Olympus' }, false)).toMatch(/timezone/);
    expect(draftProblem({ ...ok, endsOn: '2026-02-30' }, false)).toMatch(/end date/);
    expect(draftProblem({ ...ok, endsOn: '2020-01-01' }, false)).toMatch(/today or later/);
    // An ended routine keeps its end date through an edit that does not move it.
    expect(draftProblem({ ...ok, endsOn: '2020-01-01' }, false, '2020-01-01')).toBeNull();
    expect(draftProblem({ ...ok, prompt: '' }, false)).toMatch(/should do/);
    // A skill routine has no prompt to fill in.
    expect(draftProblem({ ...ok, prompt: '' }, true)).toBeNull();
  });

  it('creates on the selected bot, trimmed', () => {
    expect(
      createBodyOf(
        {
          name: ' Digest ',
          cron: ' 0 9 * * * ',
          timezone: 'Europe/Paris',
          endsOn: null,
          prompt: ' Go. ',
        },
        BOT,
      ),
    ).toEqual({
      botId: BOT,
      name: 'Digest',
      cron: '0 9 * * *',
      timezone: 'Europe/Paris',
      endsOn: null,
      prompt: 'Go.',
    });
  });

  it('edits send only what changed, and never a prompt for a skill routine', () => {
    const current = routine();
    expect(updateBodyOf(draftFromRoutine(current), current)).toBeNull();
    expect(updateBodyOf({ ...draftFromRoutine(current), cron: '0 10 * * *' }, current)).toEqual({
      cron: '0 10 * * *',
    });
    expect(updateBodyOf({ ...draftFromRoutine(current), endsOn: '2099-09-22' }, current)).toEqual({
      endsOn: '2099-09-22',
    });
    const skill = routine({ prompt: null, skillId: 'cskill00000000000000000001' });
    expect(updateBodyOf({ ...draftFromRoutine(skill), prompt: 'x', name: 'New' }, skill)).toEqual({
      name: 'New',
    });
  });
});

describe('the API module — every route from the shared registry, every answer parsed', () => {
  function client(fetchFn: ReturnType<typeof vi.fn>) {
    return new ApiClient({
      credentialsProvider: () =>
        Promise.resolve({
          orchestratorToken: 'secret-token',
          orchestratorBaseUrl: 'https://orchestrator.example',
        }),
      fetchFn: fetchFn as unknown as ConstructorParameters<typeof ApiClient>[0]['fetchFn'],
    });
  }
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('lists, creates, updates, runs now and deletes on the §4.1 paths', async () => {
    const one = routine();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json([one]))
      .mockResolvedValueOnce(json(one, 201))
      .mockResolvedValueOnce(json({ ...one, enabled: false }))
      .mockResolvedValueOnce(json(one, 202))
      .mockResolvedValueOnce(json(null, 204));
    const api = client(fetchFn);

    expect(await listRoutines(api)).toEqual([one]);
    await createRoutine(api, createBodyOf(draftFromRoutine(one), BOT));
    expect((await updateRoutine(api, one.id, { enabled: false })).enabled).toBe(false);
    await runRoutineNow(api, one.id);
    await deleteRoutine(api, one.id);

    const calls = fetchFn.mock.calls.map(([url, init]) => [
      (init as { method: string }).method,
      String(url).replace('https://orchestrator.example/api/v1', ''),
    ]);
    expect(calls).toEqual([
      ['GET', '/routines'],
      ['POST', '/routines'],
      ['PATCH', `/routines/${one.id}`],
      ['POST', `/routines/${one.id}/run-now`],
      ['DELETE', `/routines/${one.id}`],
    ]);
  });

  it('rejects an answer that is not the §4.1 shape as a contract failure', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ routines: [] }));
    await expect(listRoutines(client(fetchFn))).rejects.toMatchObject({
      failure: { code: 'CONTRACT' },
    });
  });
});

describe('<RoutinesPanel> as it renders', () => {
  const idle: RoutineActions = {
    list: () => new Promise(() => undefined),
    create: () => Promise.resolve(),
    update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    runNow: () => Promise.resolve(),
  };
  const render = (initial?: readonly Routine[]) =>
    renderToStaticMarkup(
      <I18nProvider locale="en-US">
        <RoutinesPanel botId={BOT} actions={idle} now={() => NOW} {...(initial && { initial })} />
      </I18nProvider>,
    );

  it('shows a spinner until the first read lands', () => {
    expect(render()).toContain('Loading routines');
  });

  it('offers to create one when the bot has none', () => {
    const html = render([routine({ botId: OTHER_BOT })]);
    expect(html).toContain('Set a schedule and a prompt. This bot will take it from there.');
    expect(html).toContain('Create routine');
  });

  it('lists each routine with its schedule in words, its zone and its last run', () => {
    const html = render([
      routine({ lastRunAt: '2026-09-22T12:00:00.000Z', lastStatus: 'SUCCEEDED' }),
    ]);
    expect(html).toContain('Morning digest');
    expect(html).toContain('Weekdays at 09:00 · America/New York');
    expect(html).toContain('Succeeded · 3 h ago');
    expect(html).toContain('aria-label="Morning digest enabled"');
    expect(html).toContain('aria-label="Run Morning digest now"');
    expect(html).toContain('aria-label="Edit Morning digest"');
    expect(html).toContain('aria-label="Delete Morning digest"');
  });

  it('marks a routine the bot scheduled for itself, and not the operator’s', () => {
    const html = render([
      routine({ id: 'c1', name: 'Digest', origin: 'OPERATOR' }),
      routine({ id: 'c2', name: 'Invoice check', origin: 'BOT' }),
    ]);
    expect(html.match(/Set by bot/g)).toHaveLength(1);
    expect(html.indexOf('Set by bot')).toBeGreaterThan(html.indexOf('Invoice check'));
  });

  it('says when a routine ends, and that an ended one will not run', () => {
    const html = render([
      routine({ id: 'c1', name: 'Soon', endsOn: '2026-10-01' }),
      routine({ id: 'c2', name: 'Over', endsOn: '2026-09-01' }),
    ]);
    expect(html).toContain('Until Oct 1, 2026');
    expect(html).toContain('Ended Sep 1, 2026');
    const run = (name: string) =>
      new RegExp(`<button[^>]*aria-label="Run ${name} now"[^>]*>`).exec(html)?.[0] ?? '';
    expect(run('Over')).toMatch(/disabled/);
    expect(run('Soon')).not.toMatch(/disabled/);
  });

  it('keeps an unrecognised cron one hover away rather than in the headline', () => {
    const html = render([routine({ cron: '0 9-17/2 * * 1-5' })]);
    expect(html).toContain('title="0 9-17/2 * * 1-5"');
    expect(html).toContain('Custom schedule · America/New York');
  });

  it('does not offer run-now on a disabled routine, which the server would refuse', () => {
    const html = render([routine({ enabled: false })]);
    const runNow = /<button[^>]*aria-label="Run Morning digest now"[^>]*>/.exec(html)?.[0] ?? '';
    expect(runNow).toMatch(/disabled/);
  });

  it('shows nothing without a selected bot', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en-US">
        <RoutinesPanel botId={null} actions={idle} initial={[routine()]} />
      </I18nProvider>,
    );
    expect(html).toBe('');
  });
});
