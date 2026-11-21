import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SearchResponse } from '@crewaid/shared';

import { SearchResults } from '../src/renderer/work/SearchPalette';
import { excerptParts, hitCount, typesOf } from '../src/renderer/work/searchState';

/** M10-FE-07 — search everything (PRD-WORK §7.6, D-139). */

describe('excerpts', () => {
  it('split on D-077’s markers into plain and matched runs', () => {
    expect(excerptParts('the <<PRD>> covers <<auth>>, billing')).toEqual([
      { text: 'the ', match: false },
      { text: 'PRD', match: true },
      { text: ' covers ', match: false },
      { text: 'auth', match: true },
      { text: ', billing', match: false },
    ]);
  });

  it('never treat the text as markup, and survive an unclosed marker', () => {
    expect(excerptParts('<script>x</script> <<hit')).toEqual([
      { text: '<script>x</script> <<hit', match: false },
    ]);
    const html = renderToStaticMarkup(
      <SearchResults
        results={{
          tasks: [
            {
              id: 't1',
              title: 'PRD',
              status: 'DONE',
              assigneeBotId: null,
              projectId: null,
              excerpt: '<b>x</b> <<PRD>>',
            },
          ],
          goals: [],
          projects: [],
          deliverables: [],
          messages: [],
        }}
        botById={new Map()}
        projectById={new Map()}
        onChoose={() => {}}
      />,
    );
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toMatch(/<mark[^>]*>PRD<\/mark>/);
  });
});

describe('tabs and groups', () => {
  it('map each tab to the record types it searches', () => {
    expect(typesOf('all')).toBeUndefined();
    expect(typesOf('tasks')).toEqual(['task', 'goal', 'project']);
    expect(typesOf('files')).toEqual(['deliverable']);
    expect(typesOf('chat')).toEqual(['message']);
  });

  it('group hits by type in the palette’s order, and drop empty groups', () => {
    const results: SearchResponse = {
      tasks: [
        {
          id: 't1',
          title: 'Split the PRD',
          status: 'DONE',
          assigneeBotId: null,
          projectId: null,
          excerpt: null,
        },
      ],
      goals: [],
      projects: [],
      deliverables: [
        {
          id: 'd1',
          kind: 'FILE',
          title: 'PRD.md',
          botId: null,
          taskId: null,
          goalId: null,
          projectId: null,
          createdAt: new Date('2026-09-23T12:00:00Z'),
          excerpt: null,
        },
      ],
      messages: [
        {
          id: 'm1',
          botId: 'b1',
          author: 'BOT',
          createdAt: new Date('2026-09-23T12:00:00Z'),
          excerpt: 'the <<PRD>>',
        },
      ],
    };
    expect(hitCount(results)).toBe(3);
    const html = renderToStaticMarkup(
      <SearchResults
        results={results}
        botById={new Map()}
        projectById={new Map()}
        onChoose={() => {}}
      />,
    );
    const order = ['Deliverables', 'Tasks', 'Conversations'].map((title) =>
      html.indexOf(`aria-label="${title}"`),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('aria-label="Goals"');
  });
});
