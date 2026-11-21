import { Button } from '@heroui/react';
import { IconLayoutGrid } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BotGroup, DeliverableView, Skill, ToolInfo } from '@crewaid/shared';
import { welcomeCopy } from '@crewaid/shared';
import { listDeliverables, listTools, transcribe, useApiClient, voiceStatus } from './api';
import { writeFailureMessage, type BotDraft } from './bots/botProfileForm';
import { FirstBotWelcome } from './bots/FirstBotWelcome';
import type { GroupDraft } from './bots/GroupDialog';
import { menuBridge } from './bridge';
import { ChatThread, type ChatThreadView } from './chat/ChatThread';
import { ThreadPreviewCache } from './chat/threadPreviewCache';
import { useChatEndpoint } from './chat/useChatEndpoint';
import { AppModals, type GroupDialogState } from './components/AppModals';
import { BotSidebar, type BotRowActions, type GroupActions } from './components/BotSidebar';
import { CallBar, CallBridge } from './components/call/CallControls';
import type { ComposerVoice } from './components/composer/useVoiceCapture';
import {
  deleteFailureMessage,
  type DeleteMessagesRequest,
} from './components/DeleteMessagesDialog';
import { SIDEBAR_BOUNDS, TRANSCRIPT_MIN_WIDTH } from './components/layout/paneLayout';
import { ResizableSash } from './components/layout/ResizableSash';
import { RoomTopBar } from './components/layout/RoomTopBar';
import { useShellShortcuts } from './components/layout/shortcuts';
import { usePaneLayout } from './components/layout/usePaneLayout';
import { RightRail } from './components/RightRail';
import { ConversationLoading, Transcript, type TranscriptWork } from './components/Transcript';
import { ExperienceGate, useExperience } from './experience/ExperienceGate';
import {
  StartingPoints,
  WelcomeOpening,
  WelcomeReplies,
  welcomeOffer,
  type WelcomeReplyChoice,
} from './experience/Welcome';
import { useMessageQueue } from './hooks/useMessageQueue';
import { currentLocale, useT } from './i18n/i18n';
import { LaunchGate, type LaunchSession } from './launch/LaunchGate';
import { PlanGate } from './launch/PlanGate';
import { useSyncAccountSettings } from './settings/accountSettings';
import type { SettingsPaneId } from './settings/settingsPanes';
import type { LoadStatus } from './state/chatReducer';
import { sectionOrder, sidebarSections } from './state/sidebarSections';
import { useShowBotWork } from './state/transcriptPrefs';
import { useAppEdition } from './state/useAppEdition';
import { useChat, type BotMutation } from './state/useChat';
import { useBotAccent } from './styles/botAccent';
import { useAppTheme } from './styles/themePreference';
import { useBotCall } from './voice/useBotCall';
import { useVoiceOutbox } from './voice/useVoiceOutbox';
import { DeliverablesView } from './work/DeliverablesView';
import type { ProjectFilter } from './work/FilterMenu';
import { GoalsView } from './work/GoalsView';
import type { MessageWorkRequest } from './work/MessageWorkDialogs';
import type { SearchTarget } from './work/SearchPalette';
import { TasksView } from './work/TasksView';
import { useWorkShell } from './work/useWorkShell';
import { WorkPane } from './work/WorkPane';
import { ALL_PROJECTS, liveScope, type ProjectScope, type WorkView } from './work/workState';

export default function App() {
  useAppTheme();
  return (
    <LaunchGate>
      {(session) => (
        <PlanGate session={session}>
          <ExperienceGate>
            <AppShell session={session} />
          </ExperienceGate>
        </PlanGate>
      )}
    </LaunchGate>
  );
}

/**
 * Mounted only once an account exists so `useChat` never opens a WebSocket
 * before the orchestrator can authorize the upgrade.
 */
function AppShell({ session }: { session: LaunchSession }) {
  const t = useT();
  const experience = useExperience();
  const assistant = experience?.assistant ?? null;
  const welcoming = assistant?.onboarding.welcomeSeen === false;
  const shellRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { dimensions, resizeSidebar, resizeRail } = usePaneLayout(shellRef);
  const client = useApiClient();
  useSyncAccountSettings(client);

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`crewaid.selected-bot.${session.user.id}`);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!selectedId) return;
    try {
      localStorage.setItem(`crewaid.selected-bot.${session.user.id}`, selectedId);
    } catch {
      /* Session selection remains usable without storage. */
    }
  }, [selectedId, session.user.id]);

  // New accounts open with the rail collapsed so the conversation leads.
  const [railCollapsed, setRailCollapsed] = useState(welcoming);
  // Owned here because the full-screen viewer spans the shell and collapsing
  // the rail unmounts ScreenCard.
  const [screenExpanded, setScreenExpanded] = useState(false);
  const viewComputer = useCallback(() => setScreenExpanded(true), []);
  const toggleRail = useCallback(() => {
    setRailCollapsed((collapsed) => !collapsed);
    setScreenExpanded(false);
  }, []);

  const chatController = useChat(selectedId);
  const { state: chat, connection, rows, onBotFrames } = chatController;

  const [composerSeed, setComposerSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [createDraft, setCreateDraft] = useState<BotDraft | null>(null);
  const [workView, setWorkView] = useState<WorkView | null>(null);
  const [workScope, setWorkScope] = useState<ProjectScope>(ALL_PROJECTS);
  const [projectDialog, setProjectDialog] = useState<'new' | 'manage' | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [selectedDeliverable, setSelectedDeliverable] = useState<DeliverableView | null>(null);
  const [messageWork, setMessageWork] = useState<MessageWorkRequest | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteMessagesRequest | null>(null);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [workActions, setWorkActions] = useState<ReactNode>(null);
  const [tasksBotFilter, setTasksBotFilter] = useState<string | null>(null);
  const [focus, setFocus] = useState<{
    readonly botId: string;
    readonly messageId: string;
    readonly pages: number;
  } | null>(null);
  const [tools, setTools] = useState<readonly ToolInfo[]>([]);
  // Bumped when Settings closes so the composer's model picker refetches edits.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPaneId | undefined>(undefined);
  // Tracking the edited bot by id keeps select-and-edit atomic without a mode race.
  const [profileBotId, setProfileBotId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [botActionFailure, setBotActionFailure] = useState<string | null>(null);
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<BotGroup | null>(null);
  const [reviewSkillId, setReviewSkillId] = useState<string | null>(null);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [threadEpoch, setThreadEpoch] = useState(0);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [filedByAttachment, setFiledByAttachment] = useState<
    ReadonlyMap<string, { taskId: string; title: string }>
  >(new Map());

  const showBotWork = useShowBotWork();
  const work = useWorkShell(client, chat.work);
  const scope = liveScope(workScope, work.projects);
  const projectFilter = useMemo<ProjectFilter>(
    () => ({
      scope,
      projects: work.projects,
      onScopeChange: setWorkScope,
      onNewProject: () => setProjectDialog('new'),
      onManageProjects: () => setProjectDialog('manage'),
    }),
    [scope, work.projects],
  );

  useEffect(() => {
    const controller = new AbortController();
    listTools(client, controller.signal)
      .then((directory) => setTools(directory))
      .catch(() => undefined);
    return () => controller.abort();
  }, [client]);

  useEffect(() => menuBridge.onNewBot(() => setCreateOpen(true)), []);

  const openSettings = useCallback(() => {
    setSettingsPane(undefined);
    setSettingsOpen(true);
  }, []);
  const openPlan = useCallback(() => {
    setSettingsPane('plan');
    setSettingsOpen(true);
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
  const remountThread = useCallback(() => setThreadEpoch((epoch) => epoch + 1), []);
  const focusSearch = useCallback(() => setSearchQuery(''), []);

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

  useEffect(() => {
    if (selectedId === null) return;
    let live = true;
    listDeliverables(client, { botId: selectedId, kind: 'FILE', limit: 100 })
      .then((page) => {
        if (!live) return;
        const map = new Map<string, { taskId: string; title: string }>();
        for (const item of page.items) {
          if (item.attachmentId !== null && item.task !== null) {
            map.set(item.attachmentId, { taskId: item.task.id, title: item.task.title });
          }
        }
        setFiledByAttachment(map);
      })
      .catch(() => {
        if (live) setFiledByAttachment(new Map());
      });
    return () => {
      live = false;
    };
  }, [client, selectedId, chat.work.deliverables]);

  const transcriptWork = useMemo<TranscriptWork>(
    () => ({
      onOpenTask: openTask,
      filedTask: (id) => filedByAttachment.get(id),
      onMessageAction: (action, message) => {
        if (action !== 'delete') {
          setMessageWork({ action, message });
          return;
        }
        if (selectedId !== null) {
          setDeleteRequest({ kind: 'message', botId: selectedId, messageId: message.id });
        }
      },
      // Topic dividers carry no learned memories, so removal needs no confirmation.
      onRemoveTopic: (messageId) => {
        if (selectedId === null) return;
        const name = chat.bots.find((bot) => bot.id === selectedId)?.name ?? t('app.shell.theBot');
        setBotActionFailure(null);
        void chatController.deleteMessage(selectedId, messageId, false).then((result) => {
          if (!result.ok) setBotActionFailure(deleteFailureMessage(result.failure, name));
        });
      },
    }),
    [openTask, filedByAttachment, selectedId, chat.bots, chatController.deleteMessage, t],
  );

  // In a Work view the rail only appears while a Work record is open.
  const workDetailOpen =
    selectedTaskId !== null ||
    (workView === 'deliverables' && selectedDeliverable !== null) ||
    (workView === 'goals' && selectedGoalId !== null);
  const railHidden = workView !== null ? !workDetailOpen : chat.bots.length === 0;

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

  const reportBotMutation = useCallback(
    async (operation: () => Promise<BotMutation<unknown>>): Promise<void> => {
      setBotActionFailure(null);
      const result = await operation();
      if (!result.ok) setBotActionFailure(writeFailureMessage(result.failure));
    },
    [],
  );

  const rowActions = useMemo<BotRowActions>(
    () => ({
      editProfile: (botId) => {
        setBotActionFailure(null);
        setSelectedId(botId);
        setProfileBotId(botId);
      },
      togglePin: (botId) => {
        const current = rows.find((row) => row.bot.id === botId);
        if (current === undefined) return;
        void reportBotMutation(() =>
          chatController.saveBot(botId, { pinned: !current.bot.pinned }),
        );
      },
      hide: (botId) =>
        void reportBotMutation(() => chatController.saveBot(botId, { hiddenFromSidebar: true })),
      duplicate: (botId) =>
        void reportBotMutation(() => chatController.duplicateExistingBot(botId)),
      remove: (botId) => void reportBotMutation(() => chatController.removeBot(botId)),
      moveToGroup: (botId, groupId) =>
        void reportBotMutation(() => chatController.saveBot(botId, { groupId })),
      newGroupFor: (botId) => setGroupDialog({ group: null, forBotId: botId }),
      markUnread: (botId) => void reportBotMutation(() => chatController.markUnread(botId)),
      clearChat: (botId) => setDeleteRequest({ kind: 'clear', botId }),
    }),
    [
      chatController.duplicateExistingBot,
      chatController.markUnread,
      chatController.removeBot,
      chatController.saveBot,
      reportBotMutation,
      rows,
    ],
  );

  const groupActions = useMemo<GroupActions>(
    () => ({
      toggleCollapsed: (group) =>
        void reportBotMutation(() =>
          chatController.saveGroup(group.id, { collapsed: !group.collapsed }),
        ),
      edit: (group) => setGroupDialog({ group }),
      // Rewrite contiguous 0..n-1 positions so previously equal orders still move.
      move: (group, direction) => {
        const order = chat.groups.map((g) => g.id);
        const from = order.indexOf(group.id);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= order.length) return;
        [order[from], order[to]] = [order[to] ?? group.id, group.id];
        void reportBotMutation(async () => {
          for (const [index, id] of order.entries()) {
            if (chat.groups.find((g) => g.id === id)?.sortOrder === index) continue;
            const saved = await chatController.saveGroup(id, { sortOrder: index });
            if (!saved.ok) return saved;
          }
          return { ok: true, value: undefined };
        });
      },
      remove: (group) => setDeletingGroup(group),
    }),
    [chat.groups, chatController.saveGroup, reportBotMutation],
  );

  const saveGroupDraft = useCallback(
    async (draft: GroupDraft): Promise<BotMutation<unknown>> => {
      if (groupDialog?.group != null) return chatController.saveGroup(groupDialog.group.id, draft);
      const created = await chatController.createNewGroup(draft);
      if (!created.ok || groupDialog?.forBotId === undefined) return created;
      return chatController.saveBot(groupDialog.forBotId, { groupId: created.value.id });
    },
    [chatController.createNewGroup, chatController.saveBot, chatController.saveGroup, groupDialog],
  );

  const pinned = useMemo(
    () => rows.filter((row) => row.bot.pinned && row.bot.kind !== 'MAIN'),
    [rows],
  );
  const sidebarRows = useMemo(
    () => rows.filter((row) => !row.bot.pinned && row.bot.kind !== 'MAIN'),
    [rows],
  );
  const sections = useMemo(
    () => sidebarSections(sidebarRows, chat.groups, chat.unreadByBot),
    [sidebarRows, chat.groups, chat.unreadByBot],
  );
  const shortcutBotIds = useMemo(
    () =>
      [
        ...rows.filter((row) => row.bot.kind === 'MAIN'),
        ...pinned,
        ...sectionOrder(sidebarRows, sections),
      ].map((row) => row.bot.id),
    [rows, pinned, sidebarRows, sections],
  );

  useEffect(() => {
    if (rows.length === 0) return;
    if (selectedId !== null && rows.some((row) => row.bot.id === selectedId)) return;
    setProfileBotId(null);
    const initial = assistant?.isNewAccount
      ? rows.find((row) => row.bot.kind === 'MAIN')
      : rows.find((row) => row.bot.kind !== 'MAIN');
    setSelectedId((initial ?? pinned[0] ?? rows[0])?.bot.id ?? null);
  }, [rows, pinned, selectedId, assistant?.isNewAccount]);

  const selected =
    selectedId === null ? null : (chat.bots.find((b) => b.id === selectedId) ?? null);
  const wake = selectedId === null ? undefined : chat.wakeByBot[selectedId];
  const recording = selectedId === null ? undefined : chat.recordingByBot[selectedId];

  const teachTask = useCallback(() => {
    if (selectedId !== null) chatController.startRecording(selectedId);
  }, [selectedId, chatController.startRecording]);
  const stopRecordingForSelected = useCallback(() => {
    if (selectedId !== null) chatController.stopRecording(selectedId);
  }, [selectedId, chatController.stopRecording]);
  const discardRecordingForSelected = useCallback(() => {
    if (selectedId !== null) chatController.discardRecording(selectedId);
  }, [selectedId, chatController.discardRecording]);
  const reviewDraftSkill = useCallback(() => {
    if (selectedId === null) return;
    const view = chat.recordingByBot[selectedId];
    if (view === undefined || view.kind !== 'ready' || view.skillId === null) return;
    // Close the full-screen viewer first so its Escape handling does not race the modal.
    setScreenExpanded(false);
    setReviewSkillId(view.skillId);
  }, [selectedId, chat.recordingByBot]);
  const adoptReviewedSkill = useCallback(
    (skill: Skill) => {
      if (selectedId !== null) chatController.adoptSkillVersion(selectedId, skill.id);
    },
    [chatController.adoptSkillVersion, selectedId],
  );

  const thread = selected?.thread ?? null;
  const endpoint = useChatEndpoint(selectedId ?? '', undefined, credentialRevision);
  const previewCache = useMemo(() => new ThreadPreviewCache(), []);
  useEffect(() => {
    if (connection.status !== 'connected') previewCache.clear();
  }, [connection.status, previewCache]);
  const previewBotIds = chat.bots.map((bot) => bot.id).join('\0');
  useEffect(() => {
    const stops =
      previewBotIds === ''
        ? []
        : previewBotIds.split('\0').map((botId) =>
            onBotFrames(botId, (frame) => {
              if (
                frame.type === 'run.started' ||
                frame.type === 'message.created' ||
                frame.type === 'message.deleted'
              ) {
                previewCache.invalidate(botId);
              }
            }),
          );
    return () => stops.forEach((stop) => stop());
  }, [previewBotIds, onBotFrames, previewCache]);

  const shellError = selectedId === null ? null : (chat.errorByBot[selectedId] ?? null);
  const queue = useMessageQueue({ client, selectedId });

  // Stash a starter message until the target bot's thread mounts and hands back `send`.
  const pendingStarter = useRef<{ botId: string; text: string } | null>(null);
  const deliverStarter = useCallback((botId: string, send: ChatThreadView['send']) => {
    const starter = pendingStarter.current;
    if (starter?.botId !== botId) return;
    pendingStarter.current = null;
    void send(starter.text, []);
  }, []);
  const sendAs = useCallback(
    (botId: string, text: string) => {
      pendingStarter.current = { botId, text };
      const send = queue.threadSend.current;
      if (selectedId === botId && send !== null) deliverStarter(botId, send);
      else selectBot(botId);
    },
    [selectedId, selectBot, deliverStarter, queue.threadSend],
  );

  const answerWelcome = useCallback(
    async (botId: string, reply: WelcomeReplyChoice) => {
      if (experience === null) return;
      if (reply === 'CREW') {
        await experience.progress({ welcomeSeen: true, discovery: 'LEARNING' });
        sendAs(botId, welcomeCopy(currentLocale()).replies.CREW);
        return;
      }
      await experience.progress({ reply });
      remountThread();
      if (reply === 'TASK') setComposerSeed({ text: '', nonce: Date.now() });
    },
    [experience, remountThread, sendAs],
  );

  useEffect(() => {
    let live = true;
    voiceStatus(client).then(
      (status) => live && setVoiceConfigured(status.configured),
      () => live && setVoiceConfigured(false),
    );
    return () => {
      live = false;
    };
  }, [client, credentialRevision, catalogVersion]);

  const voiceOutbox = useVoiceOutbox(client);
  const composerVoice = useMemo<ComposerVoice>(
    () => ({
      configured: voiceConfigured,
      transcribe: async (clip) => (await transcribe(client, clip)).text,
      sendVoiceNote: async (clip, durationMs) => {
        if (thread === null) throw new Error('The conversation is not open.');
        await voiceOutbox.send(thread.id, clip, durationMs, queue.threadSend.current);
      },
    }),
    [client, voiceConfigured, thread?.id, voiceOutbox.send, queue.threadSend],
  );

  const callBot = useMemo(
    () => (selected === null ? null : { id: selected.id, name: selected.name }),
    [selected?.id, selected?.name],
  );
  const call = useBotCall(callBot, (text) => queue.postMessageId(text, []), onBotFrames);
  const edition = useAppEdition();

  useShellShortcuts({
    botIds: shortcutBotIds,
    onSelectBot: selectBot,
    onFocusSearch: focusSearch,
  });
  useBotAccent(selected?.avatarColor);

  return (
    <div
      className="crewaid-room"
      data-room-view={workView === null ? 'crew' : 'work'}
      data-room-empty={selected === null}
    >
      <RoomTopBar
        session={session}
        view={workView}
        attention={work.attention}
        onView={(view) => {
          closeWorkDetail();
          setTasksBotFilter(null);
          setWorkView(view);
        }}
        onSearch={focusSearch}
        onPlugins={() => setPluginsOpen(true)}
        onSettings={openSettings}
        onOpenPlan={openPlan}
      />
      <div ref={shellRef} data-pane-shell className="crewaid-room-panels">
        <div
          data-pane="sidebar"
          className="h-full shrink-0"
          style={{ width: `${dimensions.sidebarWidth}px` }}
        >
          <BotSidebar
            mainRow={rows.find((row) => row.bot.kind === 'MAIN')}
            rows={sidebarRows}
            pinned={pinned}
            selectedId={workView === null ? selectedId : null}
            onSelect={(botId) => {
              closeWorkDetail();
              selectBot(botId);
            }}
            onOpenSettings={openSettings}
            usageNotice={chat.usageNotice}
            onOpenPlan={openPlan}
            onDismissUsageNotice={chatController.dismissUsageNotice}
            onCreateBot={() => setCreateOpen(true)}
            onRowAction={rowActions}
            actionFailure={botActionFailure}
            onDismissActionFailure={() => setBotActionFailure(null)}
            searchInputRef={searchInputRef}
            session={session}
            sections={sections}
            groups={chat.groups}
            unreadByBot={chat.unreadByBot}
            onGroupAction={groupActions}
            onSearchEverything={setSearchQuery}
          />
        </div>
        <ResizableSash
          side="start"
          value={dimensions.sidebarWidth}
          min={SIDEBAR_BOUNDS.min}
          max={SIDEBAR_BOUNDS.max}
          onResize={resizeSidebar}
          label={t('app.shell.resizeSidebar')}
        />
        <main
          className="flex h-full min-w-0 flex-1 flex-col"
          style={{ minWidth: `${TRANSCRIPT_MIN_WIDTH}px` }}
        >
          {workView !== null ? (
            <WorkPane view={workView} scope={scope} projects={work.projects} actions={workActions}>
              {workView === 'tasks' ? (
                <TasksView
                  key={tasksBotFilter ?? 'all'}
                  client={client}
                  projectFilter={projectFilter}
                  revision={chat.work.tasks}
                  bots={chat.bots}
                  selectedTaskId={selectedTaskId}
                  onOpenTask={openTask}
                  onHeaderActions={setWorkActions}
                  initialBotId={tasksBotFilter}
                />
              ) : workView === 'goals' ? (
                <GoalsView
                  client={client}
                  projectFilter={projectFilter}
                  revision={chat.work.goals}
                  selectedGoalId={selectedGoalId}
                  onOpenGoal={(goalId) => {
                    setSelectedTaskId(null);
                    setSelectedGoalId(goalId);
                    setRailCollapsed(false);
                  }}
                  onHeaderActions={setWorkActions}
                />
              ) : (
                <DeliverablesView
                  client={client}
                  projectFilter={projectFilter}
                  revision={chat.work.deliverables}
                  bots={chat.bots}
                  selectedId={selectedDeliverable?.id ?? null}
                  onOpen={(deliverable) => {
                    setSelectedTaskId(null);
                    setSelectedDeliverable(deliverable);
                    setRailCollapsed(false);
                  }}
                  onHeaderActions={setWorkActions}
                />
              )}
            </WorkPane>
          ) : selected === null ? (
            <EmptyTranscript
              status={chat.botsStatus}
              message={chat.botsError?.message}
              onCreateBot={() => setCreateOpen(true)}
            />
          ) : thread === null ? (
            <ThreadNotice
              title={t('app.shell.thisConversationCannotBeOpened')}
              body={t('app.shell.thisBotHasNoConversation')}
            />
          ) : endpoint.status === 'loading' ? (
            <div className="flex h-full items-center justify-center" aria-busy="true">
              <ConversationLoading />
            </div>
          ) : endpoint.status !== 'ready' ? (
            <ThreadNotice title={t('app.shell.notConfigured')} body={endpoint.message} />
          ) : (
            <ChatThread
              key={`${thread.id}:${threadEpoch}`}
              botId={selected.id}
              thread={thread}
              endpoint={endpoint.endpoint}
              previewCache={previewCache}
              onFrames={onBotFrames}
              onCancel={() => chatController.cancel(selected.id)}
              focusMessageId={
                focus !== null && focus.botId === selected.id ? focus.messageId : null
              }
              onFocusUnreachable={clearFocus}
              sendRef={queue.threadSend}
              onSendReady={(send) => deliverStarter(selected.id, send)}
              onGeneratingChange={queue.noteGenerating}
              onStale={remountThread}
            >
              {(view) => {
                const main = selected.kind === 'MAIN' && experience !== null;
                const offer = main ? welcomeOffer(welcoming, view.messages) : null;
                return (
                  <Transcript
                    bot={selected}
                    emptyState={
                      main && welcoming ? <WelcomeOpening bot={selected} greeting /> : undefined
                    }
                    threadStart={
                      main && welcoming ? <WelcomeOpening bot={selected} greeting /> : undefined
                    }
                    afterMessages={
                      offer?.kind === 'replies' ? (
                        <WelcomeReplies
                          replies={offer.replies}
                          onReply={(reply) => answerWelcome(selected.id, reply)}
                        />
                      ) : offer?.kind === 'starting-points' ? (
                        <StartingPoints
                          onCompose={(text) => setComposerSeed({ text, nonce: Date.now() })}
                        />
                      ) : undefined
                    }
                    composerSeed={composerSeed}
                    composerPlaceholder={
                      main && welcoming
                        ? t('app.shell.tellCrewaidWhatYouD')
                        : offer?.kind === 'starting-points'
                          ? t('app.shell.describeTheTask')
                          : undefined
                    }
                    peers={chat.bots}
                    onBotMention={selectBot}
                    historyLoaded={view.historyLoaded}
                    hasOlderMessages={view.hasOlderMessages}
                    loadingOlder={view.loadingOlder}
                    olderHistoryError={view.olderHistoryError}
                    connection={connection}
                    messages={view.messages}
                    pendingVoiceNotes={voiceOutbox.notes.filter(
                      (note) => note.threadId === thread.id,
                    )}
                    onRetryVoiceNote={(note) =>
                      void voiceOutbox.retry(note, queue.threadSend.current)
                    }
                    onDiscardVoiceNote={voiceOutbox.discard}
                    pending={queue.pending}
                    error={shellError ?? view.error}
                    onModelChanged={() => void chatController.reloadBots()}
                    tools={tools}
                    onViewComputer={viewComputer}
                    catalogVersion={catalogVersion}
                    onSend={(text, attachmentIds) => {
                      if (selected.kind === 'MAIN' && welcoming) {
                        void experience
                          ?.progress({ welcomeSeen: true, discovery: 'LEARNING' })
                          .catch(() => undefined);
                      }
                      void queue.postMessage(text, attachmentIds);
                    }}
                    activity={
                      view.generating && view.startedAt !== undefined
                        ? { ...chat.activityByBot[selected.id], startedAt: view.startedAt }
                        : (chat.activityByBot[selected.id] ??
                          (queue.threadStartedAt === null
                            ? undefined
                            : { startedAt: queue.threadStartedAt }))
                    }
                    queued={queue.queuedFor(selected.id)}
                    onQueue={(text, attachmentIds) =>
                      queue.queueMessage(selected.id, text, attachmentIds)
                    }
                    onEditQueued={(localId, text) =>
                      queue.editQueuedMessage(selected.id, localId, text)
                    }
                    onRemoveQueued={(localId) => queue.removeQueuedMessage(selected.id, localId)}
                    onSendQueuedNow={(localId) => queue.sendQueuedNow(selected.id, localId)}
                    onMoveQueued={(from, to) => queue.moveQueuedMessage(selected.id, from, to)}
                    onStop={view.stop}
                    onNewTopic={() => {
                      setBotActionFailure(null);
                      void chatController.startTopic(selected.id).then((result) => {
                        if (result.ok) view.appendStoredRow(result.value);
                        else setBotActionFailure(writeFailureMessage(result.failure));
                      });
                    }}
                    approvals={view.approvals}
                    onApprovalRespond={view.respondToApproval}
                    onReachTop={view.loadOlder}
                    focusMessageId={
                      focus !== null && focus.botId === selected.id ? focus.messageId : null
                    }
                    work={transcriptWork}
                    showBotWork={showBotWork}
                    onFocused={clearFocus}
                    onFiles={queue.stageFiles}
                    onRemovePending={queue.removePending}
                    onRetryPending={queue.retryPending}
                    voice={composerVoice}
                    spokenReplyId={view.spokenReplyId}
                    aboveComposer={
                      <>
                        <CallBridge
                          call={call}
                          generating={view.generating}
                          messages={view.messages}
                          approvals={view.approvals}
                        />
                        <CallBar call={call} botName={selected.name} />
                      </>
                    }
                  />
                );
              }}
            </ChatThread>
          )}
        </main>
        {railHidden ? null : (
          <RightRail
            bot={selected}
            collapsed={railCollapsed}
            railWidth={dimensions.railWidth}
            onResize={resizeRail}
            onToggle={toggleRail}
            screen={{
              expanded: screenExpanded,
              onExpandedChange: setScreenExpanded,
              seatControl: selectedId === null ? undefined : chat.seatControlByBot[selectedId],
              controlScreen: chatController.controlScreen,
              watchScreen: chatController.watchScreen,
              sendScreenInput: chatController.sendScreenInput,
              openScreenStream: chatController.openScreenStream,
              wake,
              onWake: chatController.wakeComputer,
              onReleaseIdentity: chatController.releaseIdentity,
            }}
            recording={{
              view: recording,
              onTeachTask: teachTask,
              onStop: stopRecordingForSelected,
              onDiscard: discardRecordingForSelected,
              onReviewSkill: reviewDraftSkill,
            }}
            call={{ session: call, edition, onOpenPlan: openPlan }}
            profile={{
              botId: profileBotId,
              onOpen: () => setProfileBotId(selectedId),
              onClose: () => setProfileBotId(null),
              onSave: chatController.saveBot,
            }}
            work={{
              workView,
              selectedTaskId,
              selectedGoalId,
              selectedDeliverable,
              tasksRevision: chat.work.tasks,
              goalsRevision: chat.work.goals,
              bots: chat.bots,
              projects: work.projects,
              onSelectTask: setSelectedTaskId,
              onOpenTask: openTask,
              onCloseDeliverable: () => setSelectedDeliverable(null),
              onCloseGoal: () => setSelectedGoalId(null),
              onOpenConversation: openConversation,
              onSeeAllBotTasks: (botId) => {
                setTasksBotFilter(botId);
                setWorkView('tasks');
              },
            }}
          />
        )}
      </div>
      {workView === null ? (
        <Button
          variant="secondary"
          className="crewaid-templates-trigger"
          data-compact={dimensions.sidebarWidth < 140}
          aria-label={t('app.shell.templates')}
          onPress={() => experience?.openTemplates()}
        >
          <IconLayoutGrid className="size-4" aria-hidden />
          {dimensions.sidebarWidth < 140 ? null : t('app.shell.templates')}
        </Button>
      ) : null}
      <AppModals
        client={client}
        bots={chat.bots}
        projects={work.projects}
        selectedBot={selected}
        groups={{
          dialog: groupDialog,
          onCloseDialog: () => setGroupDialog(null),
          onSaveGroup: saveGroupDraft,
          deleting: deletingGroup,
          onCloseDeleting: () => setDeletingGroup(null),
          onConfirmDelete: (group) =>
            void reportBotMutation(() => chatController.removeGroup(group.id)),
        }}
        deleteMessages={{
          request: deleteRequest,
          onClose: () => setDeleteRequest(null),
          onClearChat: chatController.clearChat,
          onDeleteMessage: chatController.deleteMessage,
        }}
        work={{
          messageWork,
          onCloseMessageWork: () => setMessageWork(null),
          onTaskCreated: openTask,
          onOpenDeliverable: (deliverable) => {
            setSelectedTaskId(null);
            setRailCollapsed(false);
            setWorkView('deliverables');
            setSelectedDeliverable(deliverable);
          },
          projectDialog,
          onProjectDialogChange: setProjectDialog,
          onProjectCreated: (projectId) => {
            work.reloadProjects();
            setWorkScope({ kind: 'project', projectId });
          },
          onProjectsChanged: work.reloadProjects,
        }}
        search={{
          query: searchQuery,
          onClose: () => setSearchQuery(null),
          onChoose: goTo,
        }}
        templates={{
          experience,
          assistant,
          onAddBot: (draft) => {
            setCreateDraft(draft);
            setCreateOpen(true);
          },
          onInstalled: async () => {
            await chatController.reloadBots();
          },
          onOpenCrew: selectBot,
          onStartTask: sendAs,
        }}
        createBot={{
          isOpen: createOpen,
          draft: createDraft,
          onOpenChange: (open) => {
            setCreateOpen(open);
            if (!open) setCreateDraft(null);
          },
          onCreate: chatController.createNewBot,
          onCreated: selectBot,
        }}
        settings={{
          isOpen: settingsOpen,
          initialPane: settingsPane,
          onOpenChange: (open) => {
            setSettingsOpen(open);
            // Refetch the model catalog once settings edits are closed.
            if (!open) setCatalogVersion((version) => version + 1);
          },
          onCredentialsSaved: () => {
            previewCache.clear();
            setCredentialRevision((revision) => revision + 1);
            remountThread();
            chatController.applyCredentialChange();
          },
        }}
        plugins={{ isOpen: pluginsOpen, onOpenChange: setPluginsOpen }}
        skillReview={{
          skillId: reviewSkillId,
          onClose: () => setReviewSkillId(null),
          onSkillSaved: adoptReviewedSkill,
        }}
      />
    </div>
  );
}

function ThreadNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-[15px] text-ink">{title}</p>
      {body === '' ? null : <p className="max-w-[46ch] text-[13px] text-muted">{body}</p>}
    </div>
  );
}

function EmptyTranscript({
  status,
  message,
  onCreateBot,
}: {
  status: LoadStatus;
  message?: string | undefined;
  onCreateBot: () => void;
}) {
  const t = useT();
  if (status === 'ready') return <FirstBotWelcome onCreateBot={onCreateBot} />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-[13px] text-muted">
        {status === 'error'
          ? (message ?? t('app.shell.couldNotReachTheOrchestrator'))
          : t('app.shell.connectingToTheOrchestrator')}
      </p>
    </div>
  );
}
