import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { BotGroup } from '@crewaid/shared';
import { BotSidebar, type GroupActions } from '../src/renderer/components/BotSidebar';
import { sidebarSections, type SidebarSection } from '../src/renderer/state/sidebarSections';
import type { BotRowView } from '../src/renderer/state/viewTypes';

/**
 * The sidebar's empty state is reachable on every cold start — bots arrive
 * over REST, so the first render always has none. It must go through
 * `renderEmptyState`: a ListBox builds its children inside React Aria's
 * stand-in document, which can make collection elements and nothing else. It
 * has no `createTextNode`, so plain text placed under the ListBox throws in
 * the reconciler and blanks the entire window rather than the one component.
 */
const NO_GROUP_ACTIONS: GroupActions = {
  toggleCollapsed: () => undefined,
  edit: () => undefined,
  remove: () => undefined,
};

function render(
  rows: readonly BotRowView[],
  pinned: readonly BotRowView[] = [],
  grouping: {
    sections?: readonly SidebarSection[] | null;
    groups?: readonly BotGroup[];
    unreadByBot?: Readonly<Record<string, number>>;
  } = {},
) {
  return renderToStaticMarkup(
    <I18nProvider>
      <BotSidebar
        rows={rows}
        pinned={pinned}
        selectedId={null}
        onSelect={() => undefined}
        onCreateBot={() => undefined}
        onRowAction={{
          editProfile: () => undefined,
          togglePin: () => undefined,
          hide: () => undefined,
          duplicate: () => undefined,
          remove: () => undefined,
          moveToGroup: () => undefined,
          newGroupFor: () => undefined,
          markUnread: () => undefined,
        }}
        actionFailure={null}
        onDismissActionFailure={() => undefined}
        onOpenSettings={() => undefined}
        searchInputRef={{ current: null }}
        session={{
          user: { id: 'usr_1', email: 'ada@example.com', name: 'Ada Lovelace' },
          signOut: () => undefined,
        }}
        sections={grouping.sections ?? null}
        groups={grouping.groups ?? []}
        unreadByBot={grouping.unreadByBot ?? {}}
        onGroupAction={NO_GROUP_ACTIONS}
      />
    </I18nProvider>,
  );
}

describe('BotSidebar', () => {
  it('renders with no bots — the state every cold start begins in', () => {
    const html = render([]);
    expect(html).toContain('No bots yet.');
  });

  it('puts no bare text inside the ListBox collection', () => {
    const html = render([]);
    // React Aria builds collection children into a <template>; any text there
    // is what kills the reconciler.
    const template = /<template[^>]*>([\s\S]*?)<\/template>/.exec(html)?.[1] ?? '';
    expect(template.replace(/<[^>]*>/g, '').trim()).toBe('');
  });

  it('renders every pinned bot in the horizontal pinned strip', () => {
    const pinned = [
      {
        id: 'bot_pinned_01',
        bot: {
          id: 'bot_pinned_01',
          userId: 'usr_crewaid_singleton_v1',
          name: 'Quill',
          role: 'Writer',
          avatarColor: '#4c6ef5',
          systemPrompt: 'Write.',
          modelId: 'default',
          status: 'IDLE',
          sortOrder: 0,
          pinned: true,
          hiddenFromSidebar: false,
          autoReviewRules: [],
          createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
          updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
          sandbox: null,
          groupId: null,
          unreadCount: 0,
        },
        preview: 'Writer',
        timeLabel: '',
      } satisfies BotRowView,
      {
        id: 'bot_pinned_02',
        bot: {
          id: 'bot_pinned_02',
          userId: 'usr_crewaid_singleton_v1',
          name: 'Warden',
          role: 'Researcher',
          avatarColor: '#f06595',
          systemPrompt: 'Research.',
          modelId: 'default',
          status: 'IDLE',
          sortOrder: 1,
          pinned: true,
          hiddenFromSidebar: false,
          autoReviewRules: [],
          createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
          updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
          sandbox: null,
          groupId: null,
          unreadCount: 0,
        },
        preview: 'Researcher',
        timeLabel: '',
      } satisfies BotRowView,
    ];

    const html = render([], pinned);
    expect(html).toContain('Pinned');
    expect(html).toContain('Open Quill');
    expect(html).toContain('Open Warden');
  });

  /**
   * D-131. With groups, the list is sections: a header per group, then
   * Unassigned. Headers carry text and buttons, so the collection rule above
   * matters more here, not less.
   */
  it('renders group sections without putting bare text in the collection', () => {
    const quill = groupedRow('bot_q', 'grp_sales', 'Quill');
    const scout = groupedRow('bot_s', null, 'Scout');
    const sales = {
      id: 'grp_sales',
      userId: 'usr_1',
      name: 'Sales team',
      instructions: '',
      sortOrder: 0,
      collapsed: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const sections = sidebarSections([quill, scout], [sales], { bot_q: 2 });
    expect(sections).not.toBeNull();
    const html = render([quill, scout], [], {
      sections,
      groups: [sales],
      unreadByBot: { bot_q: 2 },
    });
    for (const [, contents] of html.matchAll(/<template[^>]*>([\s\S]*?)<\/template>/g)) {
      expect((contents ?? '').replace(/<[^>]*>/g, '').trim()).toBe('');
    }
  });

  it('merges bot status and unread state into a single indicator dot per row', () => {
    const errored = groupedRow('bot_err', null, 'Kira');
    const rowWithError: BotRowView = {
      ...errored,
      bot: { ...errored.bot, status: 'ERROR' },
    };
    const html = render([rowWithError], [], { unreadByBot: { bot_err: 2 } });
    // One compact dot on the avatar + one dot in the row copy (never two side-by-side in the copy).
    const copyIndex = html.indexOf('crewaid-bot-row-copy');
    const copyHtml = html.slice(copyIndex, html.indexOf('</template>', copyIndex));
    expect(copyHtml.match(/role="img"/g)).toHaveLength(1);
    expect(copyHtml).toContain('aria-label="Error · 2 unread"');
  });

  it('fills available vertical space inside a HeroUI ScrollShadow instead of hard-clipping rows to an inline height', () => {
    const quill = groupedRow('bot_q', 'grp_sales', 'Quill');
    const scout = groupedRow('bot_s', null, 'Scout');
    const sales = {
      id: 'grp_sales',
      userId: 'usr_1',
      name: 'Sales team',
      instructions: '',
      sortOrder: 0,
      collapsed: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const sections = sidebarSections([quill, scout], [sales], {});
    const html = render([quill, scout], [], { sections, groups: [sales] });

    expect(html).toContain('data-roster-scroll');
    expect(html).toContain('scroll-shadow');
    expect(html).not.toMatch(/crewaid-roster[^>]*style="height:/);
  });
});

function groupedRow(id: string, groupId: string | null, name: string): BotRowView {
  return {
    id,
    bot: {
      id,
      userId: 'usr_1',
      name,
      role: 'Writer',
      avatarColor: '#4c6ef5',
      avatarShape: null,
      avatarUrl: null,
      systemPrompt: '',
      modelId: 'default',
      status: 'IDLE',
      sortOrder: 0,
      pinned: false,
      hiddenFromSidebar: false,
      autoReviewRules: [],
      sandboxId: null,
      groupId,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      sandbox: null,
      unreadCount: 0,
    },
    preview: '',
    timeLabel: '',
  };
}
