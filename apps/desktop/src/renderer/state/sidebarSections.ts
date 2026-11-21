import type { BotGroup } from '@crewaid/shared';
import type { BotRowView } from './viewTypes';

/**
 * One block of the sidebar list: a group's header and its bots, or the
 * Unassigned block after the groups.
 */
export interface SidebarSection {
  /**
   * The collection key. Prefixed so it can never equal a bot id: sections and
   * rows share one React Aria collection, and a duplicate key there throws.
   */
  readonly id: string;
  /** Null for Unassigned, which has no row of its own and cannot collapse. */
  readonly group: BotGroup | null;
  readonly rows: readonly BotRowView[];
  /** Unread messages across the section's bots, for the header's chip. */
  readonly unread: number;
  /** Whether any of its bots is waiting on the operator to approve something. */
  readonly needsApproval: boolean;
}

export const UNASSIGNED_SECTION_ID = 'section:unassigned';

/**
 * The sidebar's sections, or null when the list should stay flat.
 *
 * A group appears only while it has a bot to show — an empty header is a
 * promise of bots that are not there. And the whole arrangement appears only
 * once some group does: until then there is nothing for "Unassigned" to be
 * unassigned FROM, and the list stays the flat one it has always been.
 *
 * Rows keep their incoming order inside each section, so whatever ordered the
 * roster (sort order, then creation) orders each group the same way.
 */
export function sidebarSections(
  rows: readonly BotRowView[],
  groups: readonly BotGroup[],
  unreadByBot: Readonly<Record<string, number>>,
): readonly SidebarSection[] | null {
  const known = new Set(groups.map((group) => group.id));
  const byGroup = new Map<string, BotRowView[]>();
  const unassigned: BotRowView[] = [];
  for (const row of rows) {
    const groupId = row.bot.groupId;
    // A bot pointing at a group this window has not loaded (created a moment
    // ago elsewhere) waits in Unassigned rather than vanishing.
    if (groupId === null || !known.has(groupId)) {
      unassigned.push(row);
      continue;
    }
    const members = byGroup.get(groupId) ?? [];
    members.push(row);
    byGroup.set(groupId, members);
  }
  if (byGroup.size === 0) return null;

  const section = (id: string, group: BotGroup | null, members: readonly BotRowView[]) => ({
    id,
    group,
    rows: members,
    unread: members.reduce((sum, row) => sum + (unreadByBot[row.bot.id] ?? 0), 0),
    needsApproval: members.some((row) => row.bot.status === 'AWAITING_APPROVAL'),
  });

  const sections: SidebarSection[] = [];
  for (const group of groups) {
    const members = byGroup.get(group.id);
    if (members !== undefined) sections.push(section(`section:${group.id}`, group, members));
  }
  if (unassigned.length > 0) sections.push(section(UNASSIGNED_SECTION_ID, null, unassigned));
  return sections;
}

/** The rows in the order the sidebar shows them, for ⌘1–9. */
export function sectionOrder(
  rows: readonly BotRowView[],
  sections: readonly SidebarSection[] | null,
): readonly BotRowView[] {
  return sections === null ? rows : sections.flatMap((section) => section.rows);
}
