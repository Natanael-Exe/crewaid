import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ViewSearch } from '../src/renderer/work/ViewSearch';
import { WorkEmptyState, WorkNoMatch } from '../src/renderer/work/WorkPane';
import { matchesQuery } from '../src/renderer/work/workState';

/** Search within a Work view, and the states around it. */

describe('matchesQuery', () => {
  const task = ['API auth', 'Use JWT with refresh tokens'];

  it('finds a task by its name or its brief, in any case', () => {
    expect(matchesQuery('auth', task)).toBe(true);
    expect(matchesQuery('JWT', task)).toBe(true);
    expect(matchesQuery('REFRESH', task)).toBe(true);
  });

  it('needs every word, in any order and across fields', () => {
    expect(matchesQuery('jwt api', task)).toBe(true);
    expect(matchesQuery('jwt billing', task)).toBe(false);
  });

  it('matches everything when empty, and skips a missing brief', () => {
    expect(matchesQuery('  ', task)).toBe(true);
    expect(matchesQuery('auth', ['API auth', null])).toBe(true);
    expect(matchesQuery('jwt', ['API auth', null])).toBe(false);
  });
});

describe('ViewSearch', () => {
  it('is a quiet icon until it is wanted', () => {
    const html = renderToStaticMarkup(
      <ViewSearch label="Search tasks" placeholder="Search" value="" onChange={() => {}} />,
    );
    expect(html).toContain('aria-label="Search tasks"');
    expect(html).not.toContain('<input');
  });

  it('stays open, with a way to clear, while it holds a query', () => {
    const html = renderToStaticMarkup(
      <ViewSearch label="Search tasks" placeholder="Search" value="auth" onChange={() => {}} />,
    );
    expect(html).toMatch(/<input[^>]*aria-label="Search tasks"[^>]*value="auth"/);
    expect(html).toContain('aria-label="Clear search"');
  });
});

describe('empty and no-match states', () => {
  it('centres the empty state in the pane', () => {
    expect(renderToStaticMarkup(<WorkEmptyState view="deliverables" />)).toContain('m-auto');
  });

  it('says a search found nothing, apart from having nothing at all', () => {
    const searched = renderToStaticMarkup(<WorkNoMatch query="zzz" />);
    expect(searched).toContain('Nothing matches “zzz”');
    expect(searched).toContain('m-auto');
    expect(renderToStaticMarkup(<WorkNoMatch query="" />)).toContain(
      'Nothing matches these filters',
    );
  });
});
