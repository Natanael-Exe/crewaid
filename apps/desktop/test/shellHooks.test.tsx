import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotGroup, BotWithSandbox, TaskCard } from '@crewaid/shared';
import { ApiClient } from '../src/renderer/api/apiClient';
import { useBotActions } from '../src/renderer/state/useBotActions';
import { useShellModals } from '../src/renderer/state/useShellModals';
import { railStartsCollapsed, useShellNavigation } from '../src/renderer/state/useShellNavigation';
import type { BotRowView } from '../src/renderer/state/viewTypes';
import { TaskCardView } from '../src/renderer/work/TaskCardView';

/**
 * Unit tests for the extracted shell hooks and Kanban keyboard affordance.
 * Runs in Node via `renderToStaticMarkup` (matching the rest of the desktop
 * test suite) to capture hook return surfaces without a DOM environment.
 */

function makeBot(id: string, pinned = false): BotWithSandbox {
  return {
    id,
    name: `Bot ${id}`,
    role: 'Researcher',
    kind: 'CUSTOM',
    modelId: 'default',
    approvalMode: 'AUTO',
    status: 'IDLE',
    pinned,
    hiddenFromSidebar: false,
    groupId: null,
    avatarColor: '#4F46E5',
    avatarShape: null,
    voiceId: null,
    systemPrompt: '',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    sandbox: null,
  } as unknown as BotWithSandbox;
}

function makeGroup(id: string, sortOrder: number): BotGroup {
  return {
    id,
    name: `Group ${id}`,
    sortOrder,
    collapsed: false,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  } as unknown as BotGroup;
}

function captureHook<T>(useHook: () => T): T {
  let captured: T | undefined;
  function Probe() {
    captured = useHook();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (captured === undefined) throw new Error('Hook did not capture');
  return captured;
}

describe('useBotActions', () => {
  function setup(overrides?: {
    rows?: readonly BotRowView[];
    groups?: readonly BotGroup[];
    groupDialog?: Parameters<typeof useBotActions>[0]['groupDialog'];
    saveGroupResult?:
      | { ok: true; value: unknown }
      | { ok: false; failure: { kind: 'http'; status: number; message: string } };
    createGroupResult?:
      | { ok: true; value: BotGroup }
      | { ok: false; failure: { kind: 'http'; status: number; message: string } };
  }) {
    const saveBot = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const duplicateExistingBot = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const removeBot = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const markUnread = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const saveGroup = vi
      .fn()
      .mockResolvedValue(overrides?.saveGroupResult ?? { ok: true, value: undefined });
    const createNewGroup = vi
      .fn()
      .mockResolvedValue(
        overrides?.createGroupResult ?? { ok: true, value: makeGroup('g_new', 2) },
      );
    const onSelectBot = vi.fn();
    const onEditProfile = vi.fn();
    const onOpenGroupDialog = vi.fn();
    const onDeleteGroup = vi.fn();
    const onClearChat = vi.fn();

    const rows: BotRowView[] = overrides?.rows
      ? [...overrides.rows]
      : [
          { bot: makeBot('b1', false), preview: '' },
          { bot: makeBot('b2', true), preview: '' },
        ];
    const groups: BotGroup[] = overrides?.groups
      ? [...overrides.groups]
      : [makeGroup('g0', 0), makeGroup('g1', 1), makeGroup('g2', 2)];

    const result = captureHook(() =>
      useBotActions({
        rows,
        groups,
        chatController: {
          saveBot,
          duplicateExistingBot,
          removeBot,
          markUnread,
          saveGroup,
          createNewGroup,
        } as unknown as Parameters<typeof useBotActions>[0]['chatController'],
        groupDialog: overrides?.groupDialog ?? null,
        onSelectBot,
        onEditProfile,
        onOpenGroupDialog,
        onDeleteGroup,
        onClearChat,
      }),
    );

    return {
      result,
      mocks: {
        saveBot,
        duplicateExistingBot,
        removeBot,
        markUnread,
        saveGroup,
        createNewGroup,
        onSelectBot,
        onEditProfile,
        onOpenGroupDialog,
        onDeleteGroup,
        onClearChat,
      },
    };
  }

  it('routes bot row actions and toggles pin state from the current row', () => {
    const { result, mocks } = setup();

    result.rowActions.togglePin('b1');
    expect(mocks.saveBot).toHaveBeenCalledWith('b1', { pinned: true });

    result.rowActions.togglePin('b2');
    expect(mocks.saveBot).toHaveBeenCalledWith('b2', { pinned: false });

    result.rowActions.togglePin('missing');
    expect(mocks.saveBot).toHaveBeenCalledTimes(2);

    result.rowActions.editProfile('b2');
    expect(mocks.onSelectBot).toHaveBeenCalledWith('b2');
    expect(mocks.onEditProfile).toHaveBeenCalledWith('b2');

    result.rowActions.hide('b1');
    expect(mocks.saveBot).toHaveBeenCalledWith('b1', { hiddenFromSidebar: true });

    result.rowActions.moveToGroup('b1', 'g1');
    expect(mocks.saveBot).toHaveBeenCalledWith('b1', { groupId: 'g1' });

    result.rowActions.newGroupFor('b1');
    expect(mocks.onOpenGroupDialog).toHaveBeenCalledWith({ group: null, forBotId: 'b1' });

    result.rowActions.duplicate('b1');
    expect(mocks.duplicateExistingBot).toHaveBeenCalledWith('b1');

    result.rowActions.remove('b1');
    expect(mocks.removeBot).toHaveBeenCalledWith('b1');

    result.rowActions.markUnread('b1');
    expect(mocks.markUnread).toHaveBeenCalledWith('b1');

    result.rowActions.clearChat('b1');
    expect(mocks.onClearChat).toHaveBeenCalledWith('b1');
  });

  it('reorders groups contiguously and ignores out-of-bounds moves', async () => {
    const { result, mocks } = setup();

    // Already first: moving up does nothing.
    result.groupActions.move(makeGroup('g0', 0), -1);
    expect(mocks.saveGroup).not.toHaveBeenCalled();

    // Move g1 up to index 0 -> only g1 (0) and g0 (1) change; g2 (2) is skipped.
    result.groupActions.move(makeGroup('g1', 1), -1);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.saveGroup.mock.calls).toEqual([
      ['g1', { sortOrder: 0 }],
      ['g0', { sortOrder: 1 }],
    ]);
  });

  it('creates a new group and assigns the originating bot when forBotId is set', async () => {
    const { result, mocks } = setup({
      groupDialog: { group: null, forBotId: 'b1' },
    });
    const saved = await result.saveGroupDraft({ name: 'Ops' });
    expect(saved.ok).toBe(true);
    expect(mocks.createNewGroup).toHaveBeenCalledWith({ name: 'Ops' });
    expect(mocks.saveBot).toHaveBeenCalledWith('b1', { groupId: 'g_new' });
  });

  it('updates an existing group in place when editing', async () => {
    const existing = makeGroup('g1', 1);
    const { result, mocks } = setup({
      groupDialog: { group: existing },
    });
    await result.saveGroupDraft({ name: 'Renamed' });
    expect(mocks.saveGroup).toHaveBeenCalledWith('g1', { name: 'Renamed' });
    expect(mocks.createNewGroup).not.toHaveBeenCalled();
  });
});

describe('useShellNavigation', () => {
  const originalLocalStorage = globalThis.localStorage;

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
  });

  it('restores selected bot from localStorage and starts with work detail closed', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => (key === 'crewaid.selected-bot.u1' ? 'bot_saved' : null),
        setItem: () => undefined,
      },
      configurable: true,
      writable: true,
    });
    const client = new ApiClient({
      credentials: () => Promise.resolve({ baseUrl: 'http://localhost', token: 't' }),
    });
    const nav = captureHook(() => useShellNavigation({ userId: 'u1', client, welcoming: true }));
    expect(nav.selectedId).toBe('bot_saved');
    expect(nav.railCollapsed).toBe(true);
    expect(nav.workView).toBeNull();
    expect(nav.workDetailOpen).toBe(false);
  });

  it('falls back to null selectedId when storage throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => {
          throw new Error('storage disabled');
        },
        setItem: () => undefined,
      },
      configurable: true,
      writable: true,
    });
    const client = new ApiClient({
      credentials: () => Promise.resolve({ baseUrl: 'http://localhost', token: 't' }),
    });
    const nav = captureHook(() => useShellNavigation({ userId: 'u1', client, welcoming: false }));
    expect(nav.selectedId).toBeNull();
    expect(nav.railCollapsed).toBe(false);
  });

  it('lets a saved toggle win over the per-bot default', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => (key === 'crewaid.rail-collapsed.u1' ? 'false' : null),
        setItem: () => undefined,
      },
      configurable: true,
      writable: true,
    });
    const client = new ApiClient({
      credentials: () => Promise.resolve({ baseUrl: 'http://localhost', token: 't' }),
    });
    const nav = captureHook(() => useShellNavigation({ userId: 'u1', client, welcoming: true }));
    expect(nav.railCollapsed).toBe(false);
  });
});

describe('railStartsCollapsed', () => {
  // The live computer is what the rail is for, so a bot whose computer is up
  // opens with it showing; nothing to show, or a welcome to read, tucks it away.
  it('opens the rail for a running or starting computer', () => {
    expect(railStartsCollapsed({ welcoming: false, computer: 'RUNNING' })).toBe(false);
    expect(railStartsCollapsed({ welcoming: false, computer: 'STARTING' })).toBe(false);
    expect(railStartsCollapsed({ welcoming: false, computer: 'ERROR' })).toBe(false);
  });

  it('tucks the rail away with no computer running, or while welcoming', () => {
    expect(railStartsCollapsed({ welcoming: false, computer: 'STOPPED' })).toBe(true);
    expect(railStartsCollapsed({ welcoming: false, computer: null })).toBe(true);
    expect(railStartsCollapsed({ welcoming: true, computer: 'RUNNING' })).toBe(true);
  });
});

describe('useShellModals', () => {
  it('initializes all overlays closed with clean catalog version', () => {
    const modals = captureHook(() => useShellModals());
    expect(modals.settingsOpen).toBe(false);
    expect(modals.pluginsOpen).toBe(false);
    expect(modals.createOpen).toBe(false);
    expect(modals.catalogVersion).toBe(0);
    expect(modals.searchQuery).toBeNull();
  });
});

describe('TaskCardView keyboard affordance', () => {
  const card: TaskCard = {
    id: 't1',
    title: 'Ship PR #10',
    brief: '',
    status: 'TODO',
    rank: 'a',
    projectId: null,
    goalId: null,
    assigneeBotId: null,
    dueOn: null,
    occursOn: null,
    blockedReason: null,
    subtasks: { done: 0, total: 0 },
    deliverableCount: 0,
    series: null,
  } as unknown as TaskCard;

  it('exposes Alt+Arrow keyboard shortcuts when column movement is wired', () => {
    const html = renderToStaticMarkup(
      <TaskCardView
        card={card}
        assignee={undefined}
        project={undefined}
        today="2026-11-23"
        selected={false}
        onOpen={() => undefined}
        onMoveColumn={() => undefined}
      />,
    );
    expect(html).toContain('aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"');
  });
});
