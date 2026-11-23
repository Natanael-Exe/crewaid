import {
  Button,
  Chip,
  Header,
  Kbd,
  ListBox,
  ListBoxItem,
  ListLayout,
  SearchField,
  Virtualizer,
} from '@heroui/react';
import {
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconPin,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import type { BotGroup, UsageNoticePayload } from '@crewaid/shared';
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useMemo,
  useState,
} from 'react';
import { Collection } from 'react-aria-components';
import { BotRowMenu, type BotMenuPosition } from '../bots/BotRowMenu';
import { GroupMenu } from '../bots/GroupMenu';
import { useT } from '../i18n/i18n';
import type { LaunchSession } from '../launch/LaunchGate';
import type { SidebarSection } from '../state/sidebarSections';
import type { BotRowView } from '../state/viewTypes';
import { botAccentTokens } from '../styles/botAccent';
import { BotAvatar } from './BotAvatar';
import { RoleChip, StatusDot } from './Chips';
import { EmptyState, IconButtonTooltip } from './ui';
import { UsageNotice } from './UsageNotice';

/**
 * BotSidebar.
 *
 * Rows are BOTS (name, role chip, avatarColor, status, preview), NOT chat
 * threads. Composed from free primitives: ListBox + Button + Avatar
 * (+ the shared RoleChip/StatusDot/BotAvatar).
 *
 * Search filters by name and role (client-side until the orchestrator grows a
 * query param — REST has none, and a self-hosted operator's list is small
 * enough that a round trip per keystroke would be the slower design).
 * Keyboard: ⌘1..9 switch bots (registered in the shortcut system; the
 * Kbd hints render here).
 */

/**
 * Row pitch in CSS pixels, in one place because two things must agree on it:
 * the virtualizer positions rows from this number without measuring, and
 * BotRow is sized to it. Both text lines truncate, so the content is always
 * two lines regardless of name or preview length.
 */
const ROW_HEIGHT = 58;

/**
 * A group header's height, for the same reason as ROW_HEIGHT: the layout
 * places sections from this number and never measures the header.
 */
const HEADER_HEIGHT = 34;

/**
 * What a row's overflow menu can do. One object rather than five props so a
 * sixth action does not thread another parameter through two components.
 */
export type BotRowActions = {
  readonly editProfile: (botId: string) => void;
  readonly togglePin: (botId: string) => void;
  readonly hide: (botId: string) => void;
  readonly duplicate: (botId: string) => void;
  readonly remove: (botId: string) => void;
  /** Move into a group, or out of every group with null. */
  readonly moveToGroup: (botId: string, groupId: string | null) => void;
  /** Make a new group with this bot in it. */
  readonly newGroupFor: (botId: string) => void;
  readonly markUnread: (botId: string) => void;
  /** Ask, then remove every message in this bot's conversation. */
  readonly clearChat: (botId: string) => void;
};

/** What a group header can do. */
export type GroupActions = {
  readonly toggleCollapsed: (group: BotGroup) => void;
  readonly edit: (group: BotGroup) => void;
  /** One place up or down the sidebar's group order. */
  readonly move: (group: BotGroup, direction: -1 | 1) => void;
  readonly remove: (group: BotGroup) => void;
};

export function BotSidebar({
  rows,
  mainRow,
  pinned,
  selectedId,
  onSelect,
  onOpenSettings,
  onCreateBot,
  onRowAction,
  actionFailure,
  onDismissActionFailure,
  searchInputRef,
  sections,
  groups,
  unreadByBot,
  onGroupAction,
  footer,
  onSearchEverything,
  usageNotice = null,
  onOpenPlan,
  onDismissUsageNotice,
}: {
  rows: readonly BotRowView[];
  mainRow?: BotRowView | undefined;
  /** Empty until the bot list loads, or when no bot is pinned. */
  pinned: readonly BotRowView[];
  selectedId: string | null;
  onSelect: (botId: string) => void;
  onOpenSettings: () => void;
  /** The latest plan-use notice, and where its button goes. */
  usageNotice?: UsageNoticePayload | null;
  onOpenPlan?: () => void;
  onDismissUsageNotice?: () => void;
  onCreateBot: () => void;
  onRowAction: BotRowActions;
  actionFailure: string | null;
  onDismissActionFailure: () => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  session?: LaunchSession;
  /**
   * The list as group sections, or null for the flat list. Built from
   * the same `rows` by `sidebarSections`, so the two cannot disagree.
   */
  sections: readonly SidebarSection[] | null;
  /** Every group, for a row's "Move to" menu — including ones with no bots yet. */
  groups: readonly BotGroup[];
  unreadByBot: Readonly<Record<string, number>>;
  onGroupAction: GroupActions;
  /**
   * What sits above the account row — the Work rows, in the place
   * the Plugins placeholder held until plugins moved into Settings.
   */
  footer?: ReactNode;
  /**
   * The box keeps filtering bots as you type; this runs the query over
   * everything instead — offered below the box, and on Enter.
   */
  onSearchEverything?: (query: string) => void;
}) {
  const t = useT();
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [groupMenu, setGroupMenu] = useState<{
    readonly group: BotGroup;
    readonly position: BotMenuPosition;
  } | null>(null);
  const closeGroupMenu = useCallback(() => setGroupMenu(null), []);
  const [contextMenu, setContextMenu] = useState<{
    readonly bot: BotRowView['bot'];
    readonly position: BotMenuPosition | null;
  } | null>(null);

  const openContextMenu = useCallback((bot: BotRowView['bot'], event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      bot,
      position: { x: event.clientX, y: event.clientY },
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((current) => (current === null ? null : { ...current, position: null }));
  }, []);

  const pinnedRows = mainRow
    ? [mainRow, ...pinned.filter((row) => row.bot.id !== mainRow.bot.id)]
    : pinned;

  const searching = query.trim() !== '';
  const matches = useCallback(
    (v: BotRowView) => {
      const q = query.trim().toLowerCase();
      return v.bot.name.toLowerCase().includes(q) || v.bot.role.toLowerCase().includes(q);
    },
    [query],
  );
  const filtered = useMemo(
    () => (searching ? rows.filter(matches) : rows),
    [rows, matches, searching],
  );
  const shownSections = useMemo(
    () =>
      sections === null
        ? null
        : sections
            .map((section) =>
              searching ? { ...section, rows: section.rows.filter(matches) } : section,
            )
            .filter((section) => section.rows.length > 0),
    [sections, searching, matches],
  );

  const renderRow = (view: BotRowView) => (
    <BotRow
      view={view}
      unread={unreadByBot[view.bot.id] ?? 0}
      onSelect={() => onSelect(view.bot.id)}
      onContextMenu={(event) => openContextMenu(view.bot, event)}
    />
  );

  const visibleCount =
    shownSections === null
      ? filtered.length
      : shownSections.reduce(
          (count, section) =>
            count + (!searching && section.group?.collapsed === true ? 0 : section.rows.length),
          0,
        );
  const listHeight = Math.max(
    64,
    visibleCount * ROW_HEIGHT + (shownSections?.length ?? 0) * HEADER_HEIGHT,
  );

  // Width is owned by the pane layout in App; the aside fills the full column.
  return (
    <aside className="crewaid-crew-dock flex h-full w-full shrink-0 flex-col">
      <div className="crewaid-crew-heading flex shrink-0 items-center gap-1 px-2.5">
        <h2 className="me-auto whitespace-nowrap">
          <span className="crewaid-crew-title-full">{t('sidebar.crew')}</span>
          <span className="crewaid-crew-title-short">{t('sidebar.crewShort')}</span>
        </h2>
        <IconButtonTooltip
          label={t('sidebar.filter')}
          aria-expanded={filterOpen}
          onPress={() => setFilterOpen((open) => !open)}
          className="crewaid-roster-filter size-7 rounded-full"
        >
          <IconSearch className="size-3.5" stroke={1.8} />
        </IconButtonTooltip>
        <IconButtonTooltip
          label={t('sidebar.newBot')}
          onPress={onCreateBot}
          className="size-7 rounded-lg text-muted"
        >
          <IconPlus className="size-[18px]" stroke={1.8} />
        </IconButtonTooltip>
      </div>

      {/* Filter field */}
      <div className="crewaid-bot-filter px-3 pb-3" hidden={!filterOpen}>
        <SearchField
          aria-label={t('sidebar.search')}
          value={query}
          onChange={setQuery}
          variant="secondary"
        >
          <SearchField.Group className="h-9 rounded-[10px]">
            <SearchField.SearchIcon />
            <SearchField.Input
              ref={searchInputRef}
              aria-keyshortcuts="Meta+K"
              placeholder={t('sidebar.searchPlaceholder')}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  query.trim() !== '' &&
                  onSearchEverything !== undefined
                ) {
                  event.preventDefault();
                  onSearchEverything(query.trim());
                }
              }}
            />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      </div>

      {searching && onSearchEverything !== undefined ? (
        <div className="px-3 pb-2">
          <Button
            variant="ghost"
            size="sm"
            onPress={() => onSearchEverything(query.trim())}
            className="flex h-8 w-full items-center justify-start gap-2 rounded-[10px] px-2 text-start text-caption text-muted"
          >
            <IconSearch className="size-3.5 shrink-0" stroke={1.8} />
            <span className="min-w-0 flex-1 truncate">
              {t('sidebar.searchEverything', { query: query.trim() })}
            </span>
            <Kbd>
              <Kbd.Content>↵</Kbd.Content>
            </Kbd>
          </Button>
        </div>
      ) : null}

      {actionFailure === null ? null : (
        <div
          role="alert"
          className="mx-3 mb-3 flex items-start gap-2 rounded-lg bg-danger/10 px-2.5 py-2 text-micro leading-4 text-danger"
        >
          <span className="min-w-0 flex-1">{actionFailure}</span>
          <IconButtonTooltip
            label={t('sidebar.dismissError')}
            onPress={onDismissActionFailure}
            className="size-5 min-w-5 shrink-0 rounded text-danger"
          >
            <IconX className="size-3.5" stroke={1.8} />
          </IconButtonTooltip>
        </div>
      )}

      {/* Pinned profile is intentionally quieter than the scrolling bot list. */}
      {pinnedRows.length === 0 ? null : (
        <section aria-label={t('sidebar.pinned')} className="crewaid-pinned shrink-0 pb-3">
          <div data-pinned-slot="heading" className="mb-1 flex items-center justify-between px-3">
            <span className="flex items-center gap-1.5 text-micro font-medium tracking-[0.02em] text-muted">
              <IconPin className="size-3" stroke={1.6} aria-hidden />
              {t('sidebar.pinnedTitle')}
            </span>
          </div>
          <div
            data-pinned-slot="scroller"
            className="min-w-0 overflow-x-auto overscroll-x-contain px-3 pb-1"
          >
            <div
              data-pinned-slot="row"
              className={`flex w-full gap-2 ${pinnedRows.length > 1 ? 'justify-start' : 'justify-center'}`}
            >
              {pinnedRows.map((view) => (
                <div
                  key={view.bot.id}
                  data-pinned-slot="tile"
                  className="min-w-0 flex-[0_0_calc(50%-4px)]"
                >
                  <Button
                    variant="ghost"
                    aria-label={t('sidebar.open', { name: view.bot.name })}
                    aria-pressed={selectedId === view.bot.id}
                    style={{
                      ['--pinned-accent' as string]: view.bot.avatarColor,
                      ['--pinned-ink-light' as string]: botAccentTokens(view.bot.avatarColor)[
                        '--bot-accent-ink-light'
                      ],
                      ['--pinned-ink-dark' as string]: botAccentTokens(view.bot.avatarColor)[
                        '--bot-accent-ink-dark'
                      ],
                    }}
                    onPress={() => onSelect(view.bot.id)}
                    onContextMenu={(event) => openContextMenu(view.bot, event)}
                    className="crewaid-pinned-tile h-auto w-full min-w-0 flex-col gap-2 rounded-card px-2 py-3 text-surface-foreground"
                  >
                    <div className="crewaid-pinned-avatar relative size-16">
                      <BotAvatar bot={view.bot} size="md" status={view.bot.status} />
                      <span className="crewaid-bot-status-compact">
                        <StatusDot status={view.bot.status} />
                      </span>
                    </div>
                    <span className="crewaid-bot-row-copy min-w-0 max-w-full text-center">
                      <span className="flex min-w-0 items-center justify-center gap-1.5">
                        <span className="min-w-0 truncate text-callout font-medium">
                          {view.bot.name}
                        </span>
                        <StatusDot status={view.bot.status} />
                      </span>
                      <span className="crewaid-pinned-role mt-1 flex min-w-0 items-center justify-center gap-2">
                        <RoleChip role={view.bot.role} />
                      </span>
                    </span>
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Bot list — selection + action both route through onSelect */}
      {/* The empty state goes through renderEmptyState, never a child of the
          collection. ListBox builds its children inside React Aria's stand-in
          document, which knows how to make collection elements and nothing
          else — it has no createTextNode, so ANY plain text under a ListBox
          throws during render and takes the whole tree down with it. */}
      {/* Virtualizer renders no DOM of its own — it supplies the layout through
          context, so the ListBox stays the flex child and the scroll container.
          ROW_HEIGHT must match BotRow's fixed height: the layout positions rows
          from this number alone, so a row that renders taller overlaps its
          neighbour instead of pushing it down. */}
      <Virtualizer
        layout={ListLayout}
        layoutOptions={{ rowHeight: ROW_HEIGHT, rowSize: 60, headingHeight: HEADER_HEIGHT }}
      >
        <ListBox
          aria-label={t('sidebar.bots')}
          selectionMode="single"
          selectedKeys={selectedId === null ? new Set<string>() : new Set([selectedId])}
          onSelectionChange={(keys) => {
            const first = [...keys][0];
            if (typeof first === 'string') onSelect(first);
          }}
          renderEmptyState={() => (
            <EmptyState size="sm" className="crewaid-roster-empty px-3 py-6">
              <EmptyState.Description className="text-footnote">
                {query.trim() !== ''
                  ? t('sidebar.noMatch', { query })
                  : mainRow
                    ? t('sidebar.emptyWithMain')
                    : t('sidebar.empty')}
              </EmptyState.Description>
            </EmptyState>
          )}
          style={{ height: listHeight }}
          className="crewaid-roster min-h-0 flex-initial w-full min-w-0 overflow-x-hidden overflow-y-auto px-2.5 py-0 outline-none"
          items={shownSections ?? filtered}
        >
          {/* A render prop, not a mapped array: virtualization needs the
              collection to stay addressable by key so the layout can build
              only the rows the viewport asks for. With groups (D-131) each
              item is a section, and its bots are a nested collection. */}
          {(item: BotRowView | SidebarSection) =>
            'bot' in item ? (
              renderRow(item)
            ) : (
              <ListBox.Section id={item.id} className="min-w-0 p-0">
                <GroupHeader
                  section={item}
                  collapsed={!searching && item.group?.collapsed === true}
                  searching={searching}
                  actions={onGroupAction}
                  onOpenMenu={(group, position) => setGroupMenu({ group, position })}
                />
                <Collection items={!searching && item.group?.collapsed === true ? [] : item.rows}>
                  {renderRow}
                </Collection>
              </ListBox.Section>
            )
          }
        </ListBox>
      </Virtualizer>

      {/* Bottom pinned footer: usage notice + Templates action */}
      {footer !== undefined || usageNotice !== null ? (
        <div className="mt-auto shrink-0 px-3 pt-2 pb-1">
          {usageNotice === null ? null : (
            <UsageNotice
              notice={usageNotice}
              onOpenPlan={onOpenPlan ?? onOpenSettings}
              onDismiss={onDismissUsageNotice ?? (() => undefined)}
            />
          )}
          {footer}
        </div>
      ) : null}

      {groupMenu === null ? null : (
        <GroupMenu
          group={groupMenu.group}
          position={groupMenu.position}
          onClose={closeGroupMenu}
          canMoveUp={groups[0]?.id !== groupMenu.group.id}
          canMoveDown={groups[groups.length - 1]?.id !== groupMenu.group.id}
          onEdit={() => onGroupAction.edit(groupMenu.group)}
          onMove={(direction) => onGroupAction.move(groupMenu.group, direction)}
          onDelete={() => onGroupAction.remove(groupMenu.group)}
        />
      )}
      {contextMenu === null ? null : (
        <BotRowMenu
          bot={contextMenu.bot}
          position={contextMenu.position}
          onClose={closeContextMenu}
          onEditProfile={() => onRowAction.editProfile(contextMenu.bot.id)}
          onTogglePin={() => onRowAction.togglePin(contextMenu.bot.id)}
          onHide={() => onRowAction.hide(contextMenu.bot.id)}
          onDuplicate={() => onRowAction.duplicate(contextMenu.bot.id)}
          onClearChat={() => onRowAction.clearChat(contextMenu.bot.id)}
          onDelete={() => {
            setContextMenu(null);
            onRowAction.remove(contextMenu.bot.id);
          }}
          groups={groups}
          onMoveToGroup={(groupId) => onRowAction.moveToGroup(contextMenu.bot.id, groupId)}
          onNewGroup={() => onRowAction.newGroupFor(contextMenu.bot.id)}
          onMarkUnread={() => onRowAction.markUnread(contextMenu.bot.id)}
        />
      )}
    </aside>
  );
}

function BotRow({
  view,
  unread,
  onSelect,
  onContextMenu,
}: {
  view: BotRowView;
  /** This bot's unread messages; the row shows a dot, not the number. */
  unread: number;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const t = useT();
  const { bot, preview } = view;
  return (
    <ListBoxItem
      id={bot.id}
      textValue={bot.name}
      aria-label={t('sidebar.rowLabel', { name: bot.name, preview })}
      onAction={onSelect}
      // The virtualizer writes its own width onto the row, so the inset is set
      // inline too; the icon-wide roster narrows it through the variable.
      style={{ height: ROW_HEIGHT, width: 'var(--crewaid-row-width, calc(100% - 20px))' }}
      onContextMenu={onContextMenu}
      className="crewaid-bot-row group flex h-full min-w-0 max-w-full cursor-[var(--cursor-interactive)] items-center gap-3 overflow-hidden rounded-[16px] px-2.5 py-2 outline-none data-[focused]:outline-2 data-[focused]:outline-focus/60"
    >
      <div
        className="relative size-[42px] shrink-0"
        title={t('sidebar.rowTitle', { name: bot.name, preview })}
      >
        <BotAvatar bot={bot} size="row" status={bot.status} />
        <span className="crewaid-bot-status-compact">
          <StatusDot status={bot.status} />
        </span>
      </div>
      <div className="crewaid-bot-row-copy min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <span className="min-w-0 flex-1 truncate text-body font-semibold">{bot.name}</span>
          <span className="ms-auto flex shrink-0 items-center gap-1">
            <StatusDot status={bot.status} />
            {unread > 0 ? (
              <span
                role="img"
                aria-label={t('sidebar.unread', { count: unread })}
                className="size-2 shrink-0 rounded-full bg-accent"
              />
            ) : null}
          </span>
        </div>
        <div className="mt-0.5 truncate text-caption leading-[16px] text-room-muted">{preview}</div>
      </div>
    </ListBoxItem>
  );
}

/**
 * A group's header in the sidebar list: the name, which folds the
 * group, a chip when something in it wants the operator, and the bot count
 * while folded. Right-click opens the group's menu. Unassigned has only its label and count — it is not
 * a group, so there is nothing to fold, rename or delete.
 *
 * Every piece of text sits inside an element: this renders inside the
 * ListBox's collection, where a bare text node takes the whole tree down.
 */
function GroupHeader({
  section,
  collapsed,
  searching,
  actions,
  onOpenMenu,
}: {
  section: SidebarSection;
  collapsed: boolean;
  searching: boolean;
  actions: GroupActions;
  /** Opens the group's menu, which the sidebar renders outside the list. */
  onOpenMenu: (group: BotGroup, position: BotMenuPosition) => void;
}) {
  const t = useT();
  const { group } = section;
  const Chevron = collapsed ? IconChevronRight : IconChevronDown;
  return (
    <Header
      className="crewaid-group-heading flex min-w-0 items-center gap-1.5 px-2 pt-2.5 pb-1 text-micro font-medium tracking-[0.02em] text-muted"
      // The same inset as a row: the virtualizer places a header at the
      // list's full width and ignores its padding, which put the menu button
      // under the sash.
      style={{ height: HEADER_HEIGHT, width: 'calc(100% - 1.5rem)' }}
      // Right-click, like a bot row — the group's menu has no button of its
      // own. The keyboard's context-menu key lands here too, from the
      // focused name button.
      onContextMenu={(event) => {
        if (group === null) return;
        event.preventDefault();
        onOpenMenu(group, { x: event.clientX, y: event.clientY });
      }}
    >
      {group === null ? (
        <span className="truncate">{t('sidebar.unassigned')}</span>
      ) : (
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={group.name}
          title={group.name}
          // A search holds every group open, so folding one then would do
          // nothing visible; the header says so by not offering it.
          disabled={searching}
          onClick={() => actions.toggleCollapsed(group)}
          className="flex min-w-0 items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus/40"
        >
          <Chevron className="size-3 shrink-0 rtl:-scale-x-100" stroke={2} />
          <span className="truncate">{group.name}</span>
        </button>
      )}
      {section.unread > 0 ? (
        <Chip size="sm" variant="primary" color="accent" className="h-4 min-w-4 px-1">
          <Chip.Label className="text-micro tabular-nums">
            {section.unread > 99 ? '99+' : section.unread}
          </Chip.Label>
        </Chip>
      ) : null}
      {section.needsApproval ? (
        <Chip size="sm" variant="soft" color="warning" className="h-4 px-1.5">
          <Chip.Label className="text-micro">{t('sidebar.needsYou')}</Chip.Label>
        </Chip>
      ) : null}
      {/* The count only while folded: open, the bots are right there to count. */}
      {collapsed ? (
        <span className="ms-auto shrink-0 tabular-nums text-foreground-faint">
          {section.rows.length}
        </span>
      ) : null}
    </Header>
  );
}
