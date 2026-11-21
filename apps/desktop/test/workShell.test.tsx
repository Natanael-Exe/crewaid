import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectWithCounts } from '@crewaid/shared';

import { ApiClient } from '../src/renderer/api/apiClient';
import { listTasks, startTask } from '../src/renderer/api/work';
import { WorkNav } from '../src/renderer/work/WorkNav';
import { WorkEmptyState, WorkPane } from '../src/renderer/work/WorkPane';
import { workErrorCode, workFailureText } from '../src/renderer/work/workErrors';
import {
  ALL_PROJECTS,
  attentionCount,
  liveScope,
  nextProjectColor,
  PROJECT_COLORS,
  scopeFromKey,
  scopeKey,
  scopeLabel,
  scopeTaskFilter,
} from '../src/renderer/work/workState';

/**
 * M10-FE-01 — the sidebar's Work rows and the centre-pane shell (D-140).
 *
 * The rule they exist to keep: someone who never uses Work sees three plain
 * rows and nothing else — no badge, no counts, no nudges.
 */

const project = (over: Partial<ProjectWithCounts> = {}): ProjectWithCounts => ({
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'clx9z8y7x6w5v4u3t2s1r0q9',
  name: 'Acme SaaS',
  description: null,
  color: '#4F46E5',
  status: 'ACTIVE',
  sortOrder: 0,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  openTaskCount: 3,
  goalCount: 1,
  ...over,
});

describe('WorkNav', () => {
  it('shows three quiet rows, and no badge when nothing needs anyone', () => {
    const html = renderToStaticMarkup(
      <WorkNav active={null} attention={0} onSelect={() => {}} onCrew={() => {}} />,
    );
    expect(html).toContain('Tasks');
    expect(html).toContain('Goals');
    expect(html).toContain('Deliverables');
    expect(html).not.toContain('waiting on review');
    expect(html).toContain('Crew');
  });

  it('badges Tasks with the cards in Review or Blocked, and marks the open view', () => {
    const html = renderToStaticMarkup(
      <WorkNav active="goals" attention={3} onSelect={() => {}} onCrew={() => {}} />,
    );
    expect(html).toContain('3 waiting on review or unblocking');
    expect(html).toMatch(/aria-selected="true"[^>]*>Goals/s);
  });
});

describe('WorkPane', () => {
  it('names the view and the project it is scoped to, with an empty state that says what it is for', () => {
    const html = renderToStaticMarkup(
      <WorkPane
        view="deliverables"
        scope={{ kind: 'project', projectId: project().id }}
        projects={[project()]}
      >
        <WorkEmptyState view="deliverables" />
      </WorkPane>,
    );
    expect(html).toContain('Deliverables');
    expect(html).toContain('Acme SaaS');
    expect(html).toContain('Every file a bot attaches is kept here');
    expect(html).toContain('data-work-scope');
  });

  it('names the All projects scope in the Paper header', () => {
    const html = renderToStaticMarkup(
      <WorkPane view="tasks" scope={ALL_PROJECTS} projects={[project()]}>
        <WorkEmptyState view="tasks" />
      </WorkPane>,
    );
    expect(html).toContain('Tasks');
    expect(html).toContain('data-work-scope');
    expect(html).toContain('All projects');
  });
});

describe('project scope', () => {
  it('round-trips through its menu key and names itself', () => {
    for (const scope of [
      ALL_PROJECTS,
      { kind: 'inbox' as const },
      { kind: 'project' as const, projectId: 'p1' },
    ]) {
      expect(scopeFromKey(scopeKey(scope))).toEqual(scope);
    }
    expect(scopeLabel(ALL_PROJECTS, [])).toBe('All projects');
    expect(scopeLabel({ kind: 'inbox' }, [])).toBe('Inbox');
    expect(scopeLabel({ kind: 'project', projectId: project().id }, [project()])).toBe('Acme SaaS');
  });

  it('falls back to all projects when the chosen one is archived or gone', () => {
    const scope = { kind: 'project' as const, projectId: project().id };
    expect(liveScope(scope, [project()])).toEqual(scope);
    expect(liveScope(scope, [project({ status: 'ARCHIVED' })])).toEqual(ALL_PROJECTS);
    expect(liveScope(scope, [])).toEqual(ALL_PROJECTS);
  });

  it('turns into the task query it stands for', () => {
    expect(scopeTaskFilter(ALL_PROJECTS)).toEqual({});
    expect(scopeTaskFilter({ kind: 'inbox' })).toEqual({ inbox: true });
    expect(scopeTaskFilter({ kind: 'project', projectId: 'p1' })).toEqual({ projectId: 'p1' });
  });
});

describe('small derivations', () => {
  it('counts only Review and Blocked for the badge', () => {
    expect(
      attentionCount([
        { status: 'IN_REVIEW' },
        { status: 'BLOCKED' },
        { status: 'TODO' },
        { status: 'DONE' },
      ]),
    ).toBe(2);
  });

  it('gives a new project the first colour nobody has', () => {
    expect(nextProjectColor([])).toBe(PROJECT_COLORS[0]);
    expect(nextProjectColor([{ color: PROJECT_COLORS[0] }])).toBe(PROJECT_COLORS[1]);
  });

  it('shows the server’s own refusal sentence, and a Work code as a fixed one', () => {
    const conflict = {
      code: 'CONFLICT' as const,
      message: 'That conflicts with the current state.',
      detail: JSON.stringify({ statusCode: 409, code: 'PROJECT_NOT_EMPTY', message: 'x' }),
    };
    expect(workErrorCode(conflict)).toBe('PROJECT_NOT_EMPTY');
    expect(workFailureText(conflict)).toMatch(/still holds goals or tasks/);
    const invalid = {
      code: 'INVALID_REQUEST' as const,
      message: 'The server rejected that request.',
      detail: JSON.stringify({ statusCode: 400, message: 'Subtasks are one level deep.' }),
    };
    expect(workFailureText(invalid)).toBe('Subtasks are one level deep.');
    expect(workFailureText({ code: 'NETWORK', message: 'Unreachable.' })).toBe('Unreachable.');
  });
});

describe('the Work API module', () => {
  function client(fetchFn: ReturnType<typeof vi.fn>) {
    return new ApiClient({
      credentialsProvider: () =>
        Promise.resolve({
          orchestratorToken: 'secret-token',
          orchestratorBaseUrl: 'https://o.example',
        }),
      fetchFn: fetchFn as unknown as ConstructorParameters<typeof ApiClient>[0]['fetchFn'],
    });
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends the Start key as Idempotency-Key, and the board filters as a query', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ messageId: 'clx1a2b3c4d5e6f7g8h9i0j1' }, 202))
      .mockResolvedValueOnce(json([]));
    const api = client(fetchFn);
    await startTask(api, 'task1', '3f1a5c2e-9b47-4d81-a6f2-0e5c7b8d1234');
    await listTasks(api, { status: ['IN_REVIEW', 'BLOCKED'], inbox: true });

    const [startUrl, startInit] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(startUrl).toBe('https://o.example/api/v1/tasks/task1/start');
    expect((startInit.headers as Record<string, string>)['Idempotency-Key']).toBe(
      '3f1a5c2e-9b47-4d81-a6f2-0e5c7b8d1234',
    );
    const [listUrl] = fetchFn.mock.calls[1] as [string];
    expect(decodeURIComponent(listUrl)).toContain('status=IN_REVIEW,BLOCKED');
    expect(listUrl).toContain('inbox=true');
  });
});
