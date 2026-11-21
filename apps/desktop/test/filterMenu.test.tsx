import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectWithCounts } from '@crewaid/shared';

import {
  FilterMenu,
  activeFilterCount,
  filterDefaults,
  projectFilterField,
  type FilterField,
} from '../src/renderer/work/FilterMenu';
import { ALL_PROJECTS } from '../src/renderer/work/workState';

/**
 * The Work views' one filter menu: every filter as a draft, applied together
 * or reset together, with the count of what is narrowed on the button.
 */

const project = (over: Partial<ProjectWithCounts> = {}): ProjectWithCounts => ({
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'clx1a2b3c4d5e6f7g8h9i0j2',
  name: 'Acme SaaS',
  description: null,
  color: '#2563EB',
  status: 'ACTIVE',
  sortOrder: 0,
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  updatedAt: new Date('2026-09-01T12:00:00.000Z'),
  openTaskCount: 3,
  goalCount: 1,
  deliverableCount: 2,
  ...over,
});

const FIELDS: FilterField[] = [
  {
    kind: 'select',
    key: 'goal',
    label: 'Goal',
    noneLabel: 'Any goal',
    defaultValue: null,
    options: [],
  },
  {
    kind: 'select',
    key: 'status',
    label: 'Status',
    noneLabel: 'Any status',
    defaultValue: 'ACTIVE',
    options: [{ id: 'ACTIVE', label: 'Active' }],
  },
  { kind: 'toggle', key: 'unfiled', label: 'Unfiled only', defaultValue: false },
];

describe('the filter count', () => {
  it('is zero at the defaults, which are what Reset applies', () => {
    expect(filterDefaults(FIELDS)).toEqual({ goal: null, status: 'ACTIVE', unfiled: false });
    expect(activeFilterCount(FIELDS, filterDefaults(FIELDS))).toBe(0);
  });

  it('counts each field that differs, including choosing "any" over a default', () => {
    expect(activeFilterCount(FIELDS, { goal: 'g1', status: 'ACTIVE', unfiled: true })).toBe(2);
    // Goals default to Active; "Any status" is a narrowing undone, so it counts.
    expect(activeFilterCount(FIELDS, { goal: null, status: null, unfiled: false })).toBe(1);
    // A key that is absent is at its default.
    expect(activeFilterCount(FIELDS, {})).toBe(0);
  });
});

describe('the filter button', () => {
  it('says how many filters are on', () => {
    const idle = renderToStaticMarkup(
      <FilterMenu fields={FIELDS} values={filterDefaults(FIELDS)} onApply={() => {}} />,
    );
    expect(idle).toContain('aria-label="Filter"');
    expect(idle).toContain('data-filter-menu');
    const busy = renderToStaticMarkup(
      <FilterMenu
        fields={FIELDS}
        values={{ goal: 'g1', status: 'ACTIVE', unfiled: true }}
        onApply={() => {}}
      />,
    );
    expect(busy).toContain('aria-label="Filter, 2 active"');
  });
});

describe('the project field', () => {
  const field = projectFilterField({
    scope: ALL_PROJECTS,
    projects: [
      project(),
      project({ id: 'clx1a2b3c4d5e6f7g8h9i0j9', name: 'Old', status: 'ARCHIVED' }),
    ],
    onScopeChange: () => {},
    onNewProject: () => {},
    onManageProjects: () => {},
  });

  it('offers all projects, each active one and the Inbox, defaulting to all', () => {
    if (field.kind !== 'select') throw new Error('project is a select');
    expect(field.defaultValue).toBe('all');
    expect(field.options.map((option) => option.label)).toEqual([
      'All projects',
      'Acme SaaS',
      'Inbox (no project)',
    ]);
    expect(field.options.map((option) => option.id)).toEqual([
      'all',
      'project:clx1a2b3c4d5e6f7g8h9i0j1',
      'inbox',
    ]);
  });

  it('keeps making and managing projects beside it', () => {
    if (field.kind !== 'select' || field.footer === undefined) throw new Error('no footer');
    const html = renderToStaticMarkup(<>{field.footer(() => {})}</>);
    expect(html).toContain('New project…');
    expect(html).toContain('Manage projects…');
  });
});
