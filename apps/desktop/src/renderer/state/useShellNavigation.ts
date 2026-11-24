import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DeliverableView, SandboxState } from '@crewaid/shared';
import { listDeliverables, type ApiClient } from '../api';
import type { SearchTarget } from '../work/SearchPalette';
import { ALL_PROJECTS, type ProjectScope, type WorkView } from '../work/workState';

export type MessageFocus = {
  readonly botId: string;
  readonly messageId: string;
  readonly pages: number;
};

/**
 * Where the right rail starts when the user has not chosen for themselves.
 *
 * The live computer is the one thing in the rail Hark-style calm must not
 * hide, so a bot whose computer is running or starting opens with the rail
 * out. A new account (the welcome conversation leads) and a bot with no
 * computer running open with it tucked away.
 */
export function railStartsCollapsed({
  welcoming,
  computer,
}: {
  readonly welcoming: boolean;
  /** The selected bot's computer; `null` when it has none. */
  readonly computer: SandboxState | null;
}): boolean {
  return welcoming || computer === null || computer === 'STOPPED';
}

function readRailPreference(key: string): boolean | null {
  try {
    const stored = localStorage.getItem(key);
    return stored === 'true' ? true : stored === 'false' ? false : null;
  } catch {
    return null;
  }
}

/**
 * Navigation, active bot/work selection, and right-rail state for the desktop shell.
 * Kept out of App.tsx so routing transitions stay cohesive and testable.
 */
export function useShellNavigation({
  userId,
  client,
  welcoming,
}: {
  readonly userId: string;
  readonly client: ApiClient;
  /** A new account's welcome conversation is showing. */
  readonly welcoming: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`crewaid.selected-bot.${userId}`);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!selectedId) return;
    try {
      localStorage.setItem(`crewaid.selected-bot.${userId}`, selectedId);
    } catch {
      /* Session selection remains usable without storage. */
    }
  }, [selectedId, userId]);

  // The rail's state, in order of precedence:
  //  1. `opened` — the user just opened something that lives in the rail (a
  //     task, a goal, a deliverable, a bot's profile, its computer);
  //  2. `preference` — the user's own toggle, kept across launches;
  //  3. `quiet` — `railStartsCollapsed` for the selected bot, decided once per
  //     bot. A computer that starts mid-conversation does not re-decide it:
  //     the panel jumping open under the pointer is worse than a status dot.
  const railKey = `crewaid.rail-collapsed.${userId}`;
  const [preference, setPreference] = useState<boolean | null>(() => readRailPreference(railKey));
  const [opened, setOpened] = useState(false);
  const [quiet, setQuiet] = useState(welcoming);
  const decidedFor = useRef<string | null | undefined>(undefined);
  /**
   * Called by the shell with the selected bot's computer once the bot list can
   * answer (`undefined` until then; `null` for a bot with none).
   */
  const settleRail = useCallback(
    (botId: string | null, computer: SandboxState | null | undefined) => {
      if (computer === undefined || decidedFor.current === botId) return;
      decidedFor.current = botId;
      setQuiet(railStartsCollapsed({ welcoming, computer }));
    },
    [welcoming],
  );
  const railCollapsed = opened ? false : (preference ?? quiet);
  const setRailCollapsed = useCallback((collapsed: boolean) => {
    if (!collapsed) setOpened(true);
  }, []);

  const [screenExpanded, setScreenExpanded] = useState(false);
  const [profileBotId, setProfileBotIdState] = useState<string | null>(null);
  // Opening a profile brings the rail out. Clearing it does not put the rail
  // away: it is cleared on every bot switch and conversation jump, including
  // the jump from an open task, whose details must stay in the rail.
  const setProfileBotId = useCallback((botId: string | null) => {
    setProfileBotIdState(botId);
    if (botId !== null) setOpened(true);
  }, []);
  const [workView, setWorkView] = useState<WorkView | null>(null);
  const [workScope, setWorkScope] = useState<ProjectScope>(ALL_PROJECTS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [selectedDeliverable, setSelectedDeliverable] = useState<DeliverableView | null>(null);
  const [workActions, setWorkActions] = useState<ReactNode>(null);
  const [tasksBotFilter, setTasksBotFilter] = useState<string | null>(null);
  const [focus, setFocus] = useState<MessageFocus | null>(null);

  const viewComputer = useCallback(() => {
    setOpened(true);
    setScreenExpanded(true);
  }, []);
  const toggleRail = useCallback(() => {
    const next = !railCollapsed;
    setPreference(next);
    setOpened(false);
    setScreenExpanded(false);
    try {
      localStorage.setItem(railKey, String(next));
    } catch {
      /* The toggle still applies for this session without storage. */
    }
  }, [railCollapsed, railKey]);

  const selectBot = useCallback(
    (botId: string) => {
      setSelectedId(botId);
      setProfileBotId(null);
      setWorkView(null);
    },
    [setProfileBotId],
  );

  const openTask = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      setRailCollapsed(false);
    },
    [setRailCollapsed],
  );

  const openGoal = useCallback(
    (goalId: string) => {
      setSelectedTaskId(null);
      setSelectedGoalId(goalId);
      setRailCollapsed(false);
    },
    [setRailCollapsed],
  );

  const openDeliverable = useCallback(
    (deliverable: DeliverableView, switchView = false) => {
      setSelectedTaskId(null);
      setRailCollapsed(false);
      if (switchView) setWorkView('deliverables');
      setSelectedDeliverable(deliverable);
    },
    [setRailCollapsed],
  );

  const openConversation = useCallback(
    (botId: string, messageId: string | null) => {
      selectBot(botId);
      setFocus(messageId === null ? null : { botId, messageId, pages: 0 });
    },
    [selectBot],
  );

  const clearFocus = useCallback(() => setFocus(null), []);

  const closeWorkDetail = useCallback(() => {
    setSelectedTaskId(null);
    setSelectedDeliverable(null);
    setSelectedGoalId(null);
    setOpened(false);
  }, []);

  const openWorkView = useCallback(
    (view: WorkView | null) => {
      closeWorkDetail();
      setTasksBotFilter(null);
      setWorkView(view);
    },
    [closeWorkDetail],
  );

  const seeAllBotTasks = useCallback((botId: string) => {
    setTasksBotFilter(botId);
    setWorkView('tasks');
  }, []);

  const goTo = useCallback(
    (target: SearchTarget) => {
      setSelectedTaskId(null);
      setRailCollapsed(false);
      switch (target.kind) {
        case 'message':
          openConversation(target.botId, target.id);
          return;
        case 'task':
          setWorkView('tasks');
          setSelectedTaskId(target.id);
          return;
        case 'goal':
          setWorkView('goals');
          setSelectedGoalId(target.id);
          return;
        case 'project':
          setWorkView('tasks');
          setWorkScope({ kind: 'project', projectId: target.id });
          return;
        case 'deliverable':
          setWorkView('deliverables');
          void listDeliverables(client, {
            ...(target.taskId !== null
              ? { taskId: target.taskId }
              : target.goalId !== null
                ? { goalId: target.goalId }
                : target.botId !== null
                  ? { botId: target.botId }
                  : {}),
            limit: 100,
          })
            .then((page) => {
              const found = page.items.find((item) => item.id === target.id);
              if (found !== undefined) setSelectedDeliverable(found);
            })
            .catch(() => undefined);
          return;
      }
    },
    [client, openConversation, setRailCollapsed],
  );

  // In a Work view the rail only appears while a Work record is open.
  const workDetailOpen =
    selectedTaskId !== null ||
    (workView === 'deliverables' && selectedDeliverable !== null) ||
    (workView === 'goals' && selectedGoalId !== null);

  useEffect(() => {
    if (!workDetailOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      closeWorkDetail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workDetailOpen, closeWorkDetail]);

  return {
    selectedId,
    setSelectedId,
    railCollapsed,
    settleRail,
    openRail: () => setRailCollapsed(false),
    screenExpanded,
    setScreenExpanded,
    viewComputer,
    toggleRail,
    profileBotId,
    setProfileBotId,
    workView,
    workScope,
    setWorkScope,
    selectedTaskId,
    setSelectedTaskId,
    selectedGoalId,
    setSelectedGoalId,
    selectedDeliverable,
    setSelectedDeliverable,
    workActions,
    setWorkActions,
    tasksBotFilter,
    focus,
    clearFocus,
    selectBot,
    openTask,
    openGoal,
    openDeliverable,
    openConversation,
    closeWorkDetail,
    openWorkView,
    seeAllBotTasks,
    goTo,
    workDetailOpen,
  };
}
