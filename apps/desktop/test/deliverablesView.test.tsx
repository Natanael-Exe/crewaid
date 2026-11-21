import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeliverableView } from '@crewaid/shared';

import { DeliverableRow } from '../src/renderer/work/DeliverablesView';
import { byteSize, parseCsv } from '../src/renderer/work/deliverablesState';

/** M10-FE-06 — the Deliverables view and preview (PRD-WORK §7.5). */

describe('the CSV preview', () => {
  it('reads quoted fields, doubled quotes and both line endings', () => {
    const { rows, truncated } = parseCsv('name,notes\r\n"Acme, Inc","said ""yes"""\nBeta,\n');
    expect(rows).toEqual([
      ['name', 'notes'],
      ['Acme, Inc', 'said "yes"'],
      ['Beta', ''],
    ]);
    expect(truncated).toBe(false);
  });

  it('stops at its row bound and says so', () => {
    const text = Array.from({ length: 10 }, (_, i) => `r${i}`).join('\n');
    const { rows, truncated } = parseCsv(text, 3);
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it('sizes a file in words', () => {
    expect(byteSize(512)).toBe('512 B');
    expect(byteSize(2048)).toBe('2 KB');
    expect(byteSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('a deliverable row', () => {
  const item: DeliverableView = {
    id: 'd1',
    userId: 'u',
    kind: 'FILE',
    title: 'PRD.md',
    summary: null,
    botId: null,
    attachmentId: 'a1',
    messageId: null,
    url: null,
    sourcePath: '/home/bot/shared/PRD.md',
    taskId: 't1',
    goalId: 'g1',
    projectId: null,
    createdAt: new Date('2026-09-23T12:00:00Z'),
    attachment: {
      id: 'a1',
      messageId: 'm1',
      filename: 'PRD.md',
      mimeType: 'text/markdown',
      sizeBytes: 2048,
      storageKey: 'k',
    },
    task: { id: 't1', title: 'Write the PRD' },
    goal: { id: 'g1', title: 'Ship the MVP' },
  };

  it('names what it is filed under, and says Unfiled when it is not', () => {
    const filed = renderToStaticMarkup(
      <DeliverableRow
        item={item}
        bot={undefined}
        project={undefined}
        selected={false}
        onOpen={() => {}}
      />,
    );
    expect(filed).toContain('PRD.md');
    expect(filed).toContain('Write the PRD');
    expect(filed).toContain('Ship the MVP');
    expect(filed).toContain('2 KB');
    expect(filed).not.toContain('Unfiled');

    const loose = renderToStaticMarkup(
      <DeliverableRow
        item={{ ...item, taskId: null, goalId: null, task: null, goal: null }}
        bot={undefined}
        project={undefined}
        selected={false}
        onOpen={() => {}}
      />,
    );
    expect(loose).toContain('Unfiled');
  });
});
