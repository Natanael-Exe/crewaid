import { describe, expect, it } from 'vitest';
import type { BotGroup, BotStatus } from '@crewaid/shared';
import {
  sectionOrder,
  sidebarSections,
  UNASSIGNED_SECTION_ID,
} from '../src/renderer/state/sidebarSections';
import type { BotRowView } from '../src/renderer/state/viewTypes';

/**
 * D-131 — how the sidebar splits into groups.
 *
 * The two rules the user asked for are the ones worth pinning: a group shows
 * only while it has a bot, and "Unassigned" appears only once some group
 * does, to set the ungrouped bots apart from it.
 */
function row(id: string, groupId: string | null, status: BotStatus = 'IDLE'): BotRowView {
  return {
    id,
    bot: { id, name: id, role: 'Tester', groupId, status },
    preview: '',
    timeLabel: '',
  } as unknown as BotRowView;
}

function group(id: string, name: string, extra: Partial<BotGroup> = {}): BotGroup {
  return {
    id,
    userId: 'usr_1',
    name,
    instructions: '',
    sortOrder: 0,
    collapsed: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  };
}

const SALES = group('grp_sales', 'Sales team');
const SUPPORT = group('grp_support', 'Support');

describe('sidebarSections', () => {
  it('stays flat while no group has a bot', () => {
    expect(sidebarSections([row('a', null), row('b', null)], [], {})).toBeNull();
    // A group that exists but holds nobody is not a reason to add headers.
    expect(sidebarSections([row('a', null)], [SALES], {})).toBeNull();
  });

  it('lists groups in their order, then Unassigned last', () => {
    const sections = sidebarSections(
      [row('a', null), row('b', SUPPORT.id), row('c', SALES.id), row('d', SALES.id)],
      [SALES, SUPPORT],
      {},
    );
    expect(sections?.map((s) => s.id)).toEqual([
      `section:${SALES.id}`,
      `section:${SUPPORT.id}`,
      UNASSIGNED_SECTION_ID,
    ]);
    expect(sections?.[0]?.rows.map((r) => r.id)).toEqual(['c', 'd']);
    expect(sections?.[2]?.group).toBeNull();
  });

  it('leaves out a group with no bots, and Unassigned when everyone is grouped', () => {
    const sections = sidebarSections([row('a', SALES.id)], [SALES, SUPPORT], {});
    expect(sections?.map((s) => s.id)).toEqual([`section:${SALES.id}`]);
  });

  it('keeps a bot whose group this window has not loaded, under Unassigned', () => {
    const sections = sidebarSections([row('a', SALES.id), row('b', 'grp_new')], [SALES], {});
    expect(sections?.find((s) => s.id === UNASSIGNED_SECTION_ID)?.rows.map((r) => r.id)).toEqual([
      'b',
    ]);
  });

  it('adds up unread messages and notices a bot waiting for approval', () => {
    const sections = sidebarSections(
      [row('a', SALES.id), row('b', SALES.id, 'AWAITING_APPROVAL'), row('c', null)],
      [SALES],
      { a: 2, b: 1, c: 5 },
    );
    expect(sections?.[0]).toMatchObject({ unread: 3, needsApproval: true });
    expect(sections?.[1]).toMatchObject({ unread: 5, needsApproval: false });
  });

  it('never gives a section the key of a bot', () => {
    const sections = sidebarSections([row(SALES.id, SALES.id)], [SALES], {});
    expect(sections?.[0]?.id).not.toBe(SALES.id);
  });

  it('orders ⌘1–9 the way the sections show the bots', () => {
    const rows = [row('a', null), row('b', SALES.id)];
    expect(sectionOrder(rows, sidebarSections(rows, [SALES], {})).map((r) => r.id)).toEqual([
      'b',
      'a',
    ]);
    expect(sectionOrder(rows, null)).toBe(rows);
  });
});
