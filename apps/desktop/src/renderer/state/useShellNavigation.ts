import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DeliverableView } from '@crewaid/shared';
import { listDeliverables, type ApiClient } from '../api';
import type { SearchTarget } from '../work/SearchPalette';
import { ALL_PROJECTS, type ProjectScope, type WorkView } from '../work/workState';

export type MessageFocus = {
  readonly botId: string;
  readonly messageId: string;
  readonly pages: number;
};

/**
 * Navigation, active bot/work selection, and right-rail state for the desktop shell.
 * Kept out of App.tsx so routing transitions stay cohesive and testable.
 */
export function useShellNavigation({
  userId,
  client,
  initialRailCollapsed,
}: {
  readonly userId: string;
  readonly client: ApiClient;
  readonly initialRailCollapsed: boolean;
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

  const [railCollapsed, setRailCollapsed] = useState(initialRailCollapsed);
  const [screenExpanded, setScreenExpanded] = useState(false);
  const [profileBotId, setProfileBotId] = useState<string | null>(null);
  const [workView, setWorkView] = useState<WorkView | null>(null);
  const [workScope, setWorkScope] = useState<ProjectScope>(ALL_PROJECTS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [selectedDeliverable, setSelectedDeliverable] = useState<DeliverableView | null>(null);
  const [workActions, setWorkActions] = useState<ReactNode>(null);
  const [tasksBotFilter, setTasksBotFilter] = useState<string | null>(null);
  const [focus, setFocus] = useState<MessageFocus | null>(null);

  const viewComputer = useCallback(() => setScreenExpanded(true), []);
  const toggleRail = useCallback(() => {
    setRailCollapsed((collapsed) => !collapsed);
    setScreenExpanded(false);
  }, []);

  const selectBot = useCallback((botId: string) => {
    setSelectedId(botId);
    setProfileBotId(null);
    setWorkView(null);
  }, []);

  const openTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setRailCollapsed(false);
  }, []);

  const openGoal = useCallback((goalId: string) => {
    setSelectedTaskId(null);
    setSelectedGoalId(goalId);
    setRailCollapsed(false);
  }, []);

  const openDeliverable = useCallback((deliverable: DeliverableView, switchView = false) => {
    setSelectedTaskId(null);
    setRailCollapsed(false);
    if (switchView) setWorkView('deliverables');
    setSelectedDeliverable(deliverable);
  }, []);

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
    [client, openConversation],
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
