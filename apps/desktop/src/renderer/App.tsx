import { Button } from '@heroui/react';
import { IconLayoutGrid } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Skill, ToolInfo } from '@crewaid/shared';
import { welcomeCopy } from '@crewaid/shared';
import { listDeliverables, listTools, transcribe, useApiClient, voiceStatus } from './api';
import { writeFailureMessage } from './bots/botProfileForm';
import { FirstBotWelcome } from './bots/FirstBotWelcome';
import { ChatThread, type ChatThreadView } from './chat/ChatThread';
import { ThreadPreviewCache } from './chat/threadPreviewCache';
import { useChatEndpoint } from './chat/useChatEndpoint';
import { AppModals } from './components/AppModals';
import { BotSidebar } from './components/BotSidebar';
import { CallBar, CallBridge } from './components/call/CallControls';
import type { ComposerVoice } from './components/composer/useVoiceCapture';
import { deleteFailureMessage } from './components/DeleteMessagesDialog';
import { SIDEBAR_BOUNDS, TRANSCRIPT_MIN_WIDTH } from './components/layout/paneLayout';
import { ResizableSash } from './components/layout/ResizableSash';
import { RoomTopBar } from './components/layout/RoomTopBar';
import { useShellShortcuts } from './components/layout/shortcuts';
import { usePaneLayout } from './components/layout/usePaneLayout';
import { RightRail } from './components/RightRail';
import { ConversationLoading, Transcript, type TranscriptWork } from './components/Transcript';
import { IconButtonTooltip } from './components/ui';
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
import { accountLabel } from './launch/launchState';
import { useSyncAccountSettings } from './settings/accountSettings';
import type { LoadStatus } from './state/chatReducer';
import { sectionOrder, sidebarSections } from './state/sidebarSections';
import { useShowBotWork } from './state/transcriptPrefs';
import { useAppEdition } from './state/useAppEdition';
import { useBotActions } from './state/useBotActions';
import { useChat } from './state/useChat';
import { useShellModals } from './state/useShellModals';
import { useShellNavigation } from './state/useShellNavigation';
import { useBotAccent } from './styles/botAccent';
import { useAppTheme } from './styles/themePreference';
import { useBotCall } from './voice/useBotCall';
import { useVoiceOutbox } from './voice/useVoiceOutbox';
import { DeliverablesView } from './work/DeliverablesView';
import type { ProjectFilter } from './work/FilterMenu';
import { GoalsView } from './work/GoalsView';
import { TasksView } from './work/TasksView';
import { useWorkShell } from './work/useWorkShell';
import { WorkPane } from './work/WorkPane';
import { liveScope } from './work/workState';

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

  const nav = useShellNavigation({
    userId: session.user.id,
    client,
    // New accounts open with the rail collapsed so the conversation leads.
    welcoming,
  });
  const modals = useShellModals();

  const chatController = useChat(nav.selectedId);
  const { state: chat, connection, rows, onBotFrames } = chatController;

  const [composerSeed, setComposerSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [tools, setTools] = useState<readonly ToolInfo[]>([]);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [threadEpoch, setThreadEpoch] = useState(0);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [filedByAttachment, setFiledByAttachment] = useState<
    ReadonlyMap<string, { taskId: string; title: string }>
  >(new Map());

  const showBotWork = useShowBotWork();
  const work = useWorkShell(client, chat.work);
  const scope = liveScope(nav.workScope, work.projects);
  const projectFilter = useMemo<ProjectFilter>(
    () => ({
      scope,
      projects: work.projects,
      onScopeChange: nav.setWorkScope,
      onNewProject: () => modals.setProjectDialog('new'),
      onManageProjects: () => modals.setProjectDialog('manage'),
    }),
    [scope, work.projects, nav.setWorkScope, modals.setProjectDialog],
  );

  useEffect(() => {
    const controller = new AbortController();
    listTools(client, controller.signal)
      .then((directory) => setTools(directory))
      .catch(() => undefined);
    return () => controller.abort();
  }, [client]);

  const remountThread = useCallback(() => setThreadEpoch((epoch) => epoch + 1), []);

  useEffect(() => {
    if (nav.selectedId === null) return;
    let live = true;
    listDeliverables(client, { botId: nav.selectedId, kind: 'FILE', limit: 100 })
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
  }, [client, nav.selectedId, chat.work.deliverables]);

  const {
    botActionFailure,
    setBotActionFailure,
    reportBotMutation,
    rowActions,
    groupActions,
    saveGroupDraft,
  } = useBotActions({
    rows,
    groups: chat.groups,
    chatController,
    groupDialog: modals.groupDialog,
    onSelectBot: nav.setSelectedId,
    onEditProfile: nav.setProfileBotId,
    onOpenGroupDialog: modals.setGroupDialog,
    onDeleteGroup: modals.setDeletingGroup,
    onClearChat: (botId) => modals.setDeleteRequest({ kind: 'clear', botId }),
  });

  const transcriptWork = useMemo<TranscriptWork>(
    () => ({
      onOpenTask: nav.openTask,
      filedTask: (id) => filedByAttachment.get(id),
      onMessageAction: (action, message) => {
        if (action !== 'delete') {
          modals.setMessageWork({ action, message });
          return;
        }
        if (nav.selectedId !== null) {
          modals.setDeleteRequest({
            kind: 'message',
            botId: nav.selectedId,
            messageId: message.id,
          });
        }
      },
      // Topic dividers carry no learned memories, so removal needs no confirmation.
      onRemoveTopic: (messageId) => {
        if (nav.selectedId === null) return;
        const name =
          chat.bots.find((bot) => bot.id === nav.selectedId)?.name ?? t('app.shell.theBot');
        setBotActionFailure(null);
        void chatController.deleteMessage(nav.selectedId, messageId, false).then((result) => {
          if (!result.ok) setBotActionFailure(deleteFailureMessage(result.failure, name));
        });
      },
    }),
    [
      nav.openTask,
      filedByAttachment,
      nav.selectedId,
      chat.bots,
      chatController.deleteMessage,
      modals.setMessageWork,
      modals.setDeleteRequest,
      setBotActionFailure,
      t,
    ],
  );

  const railHidden = nav.workView !== null ? !nav.workDetailOpen : chat.bots.length === 0;

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
    if (nav.selectedId !== null && rows.some((row) => row.bot.id === nav.selectedId)) return;
    nav.setProfileBotId(null);
    const initial = assistant?.isNewAccount
      ? rows.find((row) => row.bot.kind === 'MAIN')
      : rows.find((row) => row.bot.kind !== 'MAIN');
    nav.setSelectedId((initial ?? pinned[0] ?? rows[0])?.bot.id ?? null);
  }, [
    rows,
    pinned,
    nav.selectedId,
    nav.setProfileBotId,
    nav.setSelectedId,
    assistant?.isNewAccount,
  ]);

  const selected =
    nav.selectedId === null ? null : (chat.bots.find((b) => b.id === nav.selectedId) ?? null);
  const wake = nav.selectedId === null ? undefined : chat.wakeByBot[nav.selectedId];
  const selectedComputer = selected === null ? undefined : (selected.sandbox?.state ?? null);
  const { settleRail } = nav;
  useEffect(() => {
    settleRail(nav.selectedId, selectedComputer);
  }, [settleRail, nav.selectedId, selectedComputer]);
  const recording = nav.selectedId === null ? undefined : chat.recordingByBot[nav.selectedId];

  const teachTask = useCallback(() => {
    if (nav.selectedId !== null) chatController.startRecording(nav.selectedId);
  }, [nav.selectedId, chatController.startRecording]);
  const stopRecordingForSelected = useCallback(() => {
    if (nav.selectedId !== null) chatController.stopRecording(nav.selectedId);
  }, [nav.selectedId, chatController.stopRecording]);
  const discardRecordingForSelected = useCallback(() => {
    if (nav.selectedId !== null) chatController.discardRecording(nav.selectedId);
  }, [nav.selectedId, chatController.discardRecording]);
  const reviewDraftSkill = useCallback(() => {
    if (nav.selectedId === null) return;
    const view = chat.recordingByBot[nav.selectedId];
    if (view === undefined || view.kind !== 'ready' || view.skillId === null) return;
    // Close the full-screen viewer first so its Escape handling does not race the modal.
    nav.setScreenExpanded(false);
    modals.setReviewSkillId(view.skillId);
  }, [nav.selectedId, nav.setScreenExpanded, modals.setReviewSkillId, chat.recordingByBot]);
  const adoptReviewedSkill = useCallback(
    (skill: Skill) => {
      if (nav.selectedId !== null) chatController.adoptSkillVersion(nav.selectedId, skill.id);
    },
    [chatController.adoptSkillVersion, nav.selectedId],
  );

  const thread = selected?.thread ?? null;
  const endpoint = useChatEndpoint(nav.selectedId ?? '', undefined, credentialRevision);
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

  const shellError = nav.selectedId === null ? null : (chat.errorByBot[nav.selectedId] ?? null);
  const queue = useMessageQueue({ client, selectedId: nav.selectedId });

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
      if (nav.selectedId === botId && send !== null) deliverStarter(botId, send);
      else nav.selectBot(botId);
    },
    [nav.selectedId, nav.selectBot, deliverStarter, queue.threadSend],
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
  }, [client, credentialRevision, modals.catalogVersion]);

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
    onSelectBot: nav.selectBot,
    onFocusSearch: modals.focusSearch,
  });
  useBotAccent(selected?.avatarColor);

  return (
    <div
      className="crewaid-room"
      data-room-view={nav.workView === null ? 'crew' : 'work'}
      data-room-empty={selected === null}
    >
      <RoomTopBar
        session={session}
        view={nav.workView}
        attention={work.attention}
        onView={nav.openWorkView}
        onSearch={modals.focusSearch}
        onPlugins={() => modals.setPluginsOpen(true)}
        onSettings={modals.openSettings}
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
            selectedId={nav.workView === null ? nav.selectedId : null}
            onSelect={(botId) => {
              nav.closeWorkDetail();
              nav.selectBot(botId);
            }}
            onOpenSettings={modals.openSettings}
            usageNotice={chat.usageNotice}
            onOpenPlan={modals.openPlan}
            onDismissUsageNotice={chatController.dismissUsageNotice}
            onCreateBot={() => modals.openCreateBot()}
            onRowAction={rowActions}
            actionFailure={botActionFailure}
            onDismissActionFailure={() => setBotActionFailure(null)}
            searchInputRef={searchInputRef}
            session={session}
            sections={sections}
            groups={chat.groups}
            unreadByBot={chat.unreadByBot}
            onGroupAction={groupActions}
            onSearchEverything={modals.setSearchQuery}
            footer={
              dimensions.sidebarWidth < 140 ? (
                <div className="flex justify-center">
                  <IconButtonTooltip
                    variant="ghost"
                    label={t('app.shell.templates')}
                    placement="right"
                    onPress={() => experience?.openTemplates()}
                    className="crewaid-templates-trigger"
                    data-compact="true"
                  >
                    <IconLayoutGrid className="size-4" aria-hidden />
                  </IconButtonTooltip>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  fullWidth
                  className="crewaid-templates-trigger justify-start"
                  data-compact="false"
                  onPress={() => experience?.openTemplates()}
                >
                  <IconLayoutGrid className="size-4" aria-hidden />
                  {t('app.shell.templates')}
                </Button>
              )
            }
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
          {nav.workView !== null ? (
            <WorkPane
              view={nav.workView}
              scope={scope}
              projects={work.projects}
              actions={nav.workActions}
            >
              {nav.workView === 'tasks' ? (
                <TasksView
                  key={nav.tasksBotFilter ?? 'all'}
                  client={client}
                  projectFilter={projectFilter}
                  revision={chat.work.tasks}
                  bots={chat.bots}
                  selectedTaskId={nav.selectedTaskId}
                  onOpenTask={nav.openTask}
                  onHeaderActions={nav.setWorkActions}
                  initialBotId={nav.tasksBotFilter}
                />
              ) : nav.workView === 'goals' ? (
                <GoalsView
                  client={client}
                  projectFilter={projectFilter}
                  revision={chat.work.goals}
                  selectedGoalId={nav.selectedGoalId}
                  onOpenGoal={nav.openGoal}
                  onHeaderActions={nav.setWorkActions}
                />
              ) : (
                <DeliverablesView
                  client={client}
                  projectFilter={projectFilter}
                  revision={chat.work.deliverables}
                  bots={chat.bots}
                  selectedId={nav.selectedDeliverable?.id ?? null}
                  onOpen={(deliverable) => nav.openDeliverable(deliverable)}
                  onHeaderActions={nav.setWorkActions}
                />
              )}
            </WorkPane>
          ) : selected === null ? (
            <EmptyTranscript
              status={chat.botsStatus}
              message={chat.botsError?.message}
              onCreateBot={() => modals.openCreateBot()}
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
                nav.focus !== null && nav.focus.botId === selected.id ? nav.focus.messageId : null
              }
              onFocusUnreachable={nav.clearFocus}
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
                    onBotMention={nav.selectBot}
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
                    onViewComputer={nav.viewComputer}
                    catalogVersion={modals.catalogVersion}
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
                      nav.focus !== null && nav.focus.botId === selected.id
                        ? nav.focus.messageId
                        : null
                    }
                    work={transcriptWork}
                    showBotWork={showBotWork}
                    onFocused={nav.clearFocus}
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
            collapsed={nav.railCollapsed}
            railWidth={dimensions.railWidth}
            onResize={resizeRail}
            onToggle={nav.toggleRail}
            onShowComputer={nav.openRail}
            screen={{
              expanded: nav.screenExpanded,
              onExpandedChange: nav.setScreenExpanded,
              seatControl:
                nav.selectedId === null ? undefined : chat.seatControlByBot[nav.selectedId],
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
            call={{ session: call, edition, onOpenPlan: modals.openPlan }}
            profile={{
              botId: nav.profileBotId,
              onOpen: () => nav.setProfileBotId(nav.selectedId),
              onClose: () => nav.setProfileBotId(null),
              onSave: chatController.saveBot,
            }}
            work={{
              workView: nav.workView,
              selectedTaskId: nav.selectedTaskId,
              selectedGoalId: nav.selectedGoalId,
              selectedDeliverable: nav.selectedDeliverable,
              tasksRevision: chat.work.tasks,
              goalsRevision: chat.work.goals,
              bots: chat.bots,
              projects: work.projects,
              onSelectTask: nav.setSelectedTaskId,
              onOpenTask: nav.openTask,
              onCloseDeliverable: () => nav.setSelectedDeliverable(null),
              onCloseGoal: () => nav.setSelectedGoalId(null),
              onOpenConversation: nav.openConversation,
              onSeeAllBotTasks: nav.seeAllBotTasks,
            }}
          />
        )}
      </div>
      <AppModals
        client={client}
        bots={chat.bots}
        projects={work.projects}
        selectedBot={selected}
        groups={{
          dialog: modals.groupDialog,
          onCloseDialog: () => modals.setGroupDialog(null),
          onSaveGroup: saveGroupDraft,
          deleting: modals.deletingGroup,
          onCloseDeleting: () => modals.setDeletingGroup(null),
          onConfirmDelete: (group) =>
            void reportBotMutation(() => chatController.removeGroup(group.id)),
        }}
        deleteMessages={{
          request: modals.deleteRequest,
          onClose: () => modals.setDeleteRequest(null),
          onClearChat: chatController.clearChat,
          onDeleteMessage: chatController.deleteMessage,
        }}
        work={{
          messageWork: modals.messageWork,
          onCloseMessageWork: () => modals.setMessageWork(null),
          onTaskCreated: nav.openTask,
          onOpenDeliverable: (deliverable) => nav.openDeliverable(deliverable, true),
          projectDialog: modals.projectDialog,
          onProjectDialogChange: modals.setProjectDialog,
          onProjectCreated: (projectId) => {
            work.reloadProjects();
            nav.setWorkScope({ kind: 'project', projectId });
          },
          onProjectsChanged: work.reloadProjects,
        }}
        search={{
          query: modals.searchQuery,
          onClose: () => modals.setSearchQuery(null),
          onChoose: nav.goTo,
        }}
        templates={{
          experience,
          assistant,
          onAddBot: (draft) => modals.openCreateBot(draft),
          onInstalled: async () => {
            await chatController.reloadBots();
          },
          onOpenCrew: nav.selectBot,
          onStartTask: sendAs,
        }}
        createBot={{
          isOpen: modals.createOpen,
          draft: modals.createDraft,
          onOpenChange: modals.onCreateOpenChange,
          onCreate: chatController.createNewBot,
          onCreated: nav.selectBot,
        }}
        settings={{
          isOpen: modals.settingsOpen,
          initialPane: modals.settingsPane,
          onOpenChange: modals.onSettingsOpenChange,
          account: {
            ...accountLabel(session.user),
            email: session.user.email,
            image: session.user.image,
          },
          onSignOut: session.signOut,
          onCredentialsSaved: () => {
            previewCache.clear();
            setCredentialRevision((revision) => revision + 1);
            remountThread();
            chatController.applyCredentialChange();
          },
        }}
        plugins={{ isOpen: modals.pluginsOpen, onOpenChange: modals.setPluginsOpen }}
        skillReview={{
          skillId: modals.reviewSkillId,
          onClose: () => modals.setReviewSkillId(null),
          onSkillSaved: adoptReviewedSkill,
        }}
      />
    </div>
  );
}

function ThreadNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-body text-ink">{title}</p>
      {body === '' ? null : <p className="max-w-[46ch] text-footnote text-muted">{body}</p>}
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
      <p className="text-footnote text-muted">
        {status === 'error'
          ? (message ?? t('app.shell.couldNotReachTheOrchestrator'))
          : t('app.shell.connectingToTheOrchestrator')}
      </p>
    </div>
  );
}
