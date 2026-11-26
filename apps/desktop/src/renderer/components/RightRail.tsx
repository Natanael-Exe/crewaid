import { IconChevronsRight, IconDeviceDesktop, IconSettings } from '@tabler/icons-react';
import { useMemo } from 'react';
import type {
  BotWithSandbox,
  DeliverableView,
  Edition,
  ProjectWithCounts,
  SandboxState,
} from '@crewaid/shared';
import { useApiClient } from '../api';
import { BotProfilePane } from '../bots/BotProfilePane';
import { useT } from '../i18n/i18n';
import { liveRoutineActions, RoutinesPanel } from '../routines/RoutinesPanel';
import { ScreenCard, type ScreenCardProps } from '../screen/ScreenCard';
import type { RecordingView, WakeStatus } from '../state/chatReducer';
import type { ChatController } from '../state/useChat';
import type { BotCall } from '../voice/useBotCall';
import { BotTasksSection } from '../work/BotTasksSection';
import { DeliverablePane } from '../work/DeliverablePane';
import { GoalDetailsPane } from '../work/GoalDetailsPane';
import { TaskDetailsPane } from '../work/TaskDetailsPane';
import type { WorkView } from '../work/workState';
import { CallButton } from './call/CallControls';
import { RIGHT_RAIL_BOUNDS } from './layout/paneLayout';
import { ResizableSash } from './layout/ResizableSash';
import { IconButtonTooltip } from './ui';
import type { HandoffActions, LatestHandoffSummary } from './visuals/HandoffBlock';
import { RightRailHandoffSection } from './visuals/RightRailHandoffSection';

export interface RightRailScreenProps {
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly seatControl: ScreenCardProps['seatControl'];
  readonly controlScreen: ChatController['controlScreen'];
  readonly watchScreen: ChatController['watchScreen'];
  readonly sendScreenInput: ChatController['sendScreenInput'];
  readonly openScreenStream: ChatController['openScreenStream'];
  readonly wake: WakeStatus | undefined;
  readonly onWake: ChatController['wakeComputer'];
  readonly onReleaseIdentity: ChatController['releaseIdentity'];
}

export interface RightRailRecordingProps {
  readonly view: RecordingView | undefined;
  readonly onTeachTask: () => void;
  readonly onStop: () => void;
  readonly onDiscard: () => void;
  readonly onReviewSkill: () => void;
}

export interface RightRailCallProps {
  readonly session: BotCall;
  readonly edition: Edition | null;
  readonly onOpenPlan: () => void;
}

export interface RightRailProfileProps {
  readonly botId: string | null;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onSave: ChatController['saveBot'];
}

export interface RightRailWorkProps {
  readonly workView: WorkView | null;
  readonly selectedTaskId: string | null;
  readonly selectedGoalId: string | null;
  readonly selectedDeliverable: DeliverableView | null;
  readonly tasksRevision: number;
  readonly goalsRevision: number;
  readonly bots: readonly BotWithSandbox[];
  readonly projects: readonly ProjectWithCounts[];
  readonly onSelectTask: (taskId: string | null) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onCloseDeliverable: () => void;
  readonly onCloseGoal: () => void;
  readonly onOpenConversation: (botId: string, messageId: string | null) => void;
  readonly onSeeAllBotTasks: (botId: string) => void;
  readonly onOpenDeliverableById?: ((deliverableId: string) => void) | undefined;
}

export interface RightRailHandoffProps {
  readonly latest: LatestHandoffSummary | null;
  readonly onJumpToHandoff: (messageId: string) => void;
  readonly actions: HandoffActions;
}

export interface RightRailProps {
  readonly bot: BotWithSandbox | null;
  readonly collapsed: boolean;
  readonly railWidth: number;
  readonly onResize: (width: number) => void;
  readonly onToggle: () => void;
  /** Brings the rail out to show the computer, without changing the saved toggle. */
  readonly onShowComputer: () => void;
  readonly screen: RightRailScreenProps;
  readonly recording: RightRailRecordingProps;
  readonly call: RightRailCallProps;
  readonly profile: RightRailProfileProps;
  readonly work: RightRailWorkProps;
  readonly handoff?: RightRailHandoffProps | undefined;
}

function computerLabel(state: SandboxState, t: ReturnType<typeof useT>): string {
  switch (state) {
    case 'RUNNING':
      return t('app.shell.computer.running');
    case 'STARTING':
      return t('app.shell.computer.starting');
    case 'STOPPED':
      return t('app.shell.computer.stopped');
    case 'UNHEALTHY':
    case 'ERROR':
      return t('app.shell.computer.trouble');
  }
}

export function RightRail({
  bot,
  collapsed,
  railWidth,
  onResize,
  onToggle,
  onShowComputer,
  screen,
  recording,
  call,
  profile,
  work,
  handoff,
}: RightRailProps) {
  const t = useT();
  // Keep hook order stable across collapsed/expanded toggles.
  const client = useApiClient();
  const routineActions = useMemo(() => liveRoutineActions(client), [client]);

  if (collapsed) {
    return (
      <div data-pane="rail-collapsed" className="self-start shrink-0" style={{ width: '48px' }}>
        <aside
          aria-label={t('app.shell.details')}
          data-pane-rail-state="collapsed"
          className="crewaid-rail crewaid-rail-collapsed flex w-full flex-col items-center"
        >
          <IconButtonTooltip
            label={t('app.shell.expandPanel')}
            aria-expanded={false}
            onPress={onToggle}
            className="window-no-drag size-8 rounded-full bg-surface text-room-muted"
          >
            <IconChevronsRight className="size-4 rotate-180 rtl:-scale-x-100" stroke={1.8} />
          </IconButtonTooltip>
          {/* The computer stays one glance away while the rail is tucked in:
              its dot turns live when it starts, without the panel jumping
              open under the pointer. */}
          {bot?.sandbox == null ? null : (
            <IconButtonTooltip
              label={t('app.shell.showComputer', { state: computerLabel(bot.sandbox.state, t) })}
              tooltip={t('app.shell.showComputer', {
                state: computerLabel(bot.sandbox.state, t),
              })}
              placement="left"
              onPress={onShowComputer}
              className="window-no-drag relative size-8 rounded-full text-room-muted"
            >
              <IconDeviceDesktop className="size-4" stroke={1.8} />
              <span
                aria-hidden
                data-computer-state={bot.sandbox.state}
                className={`absolute end-1 top-1 size-2 rounded-full ring-2 ring-[var(--glass)] ${
                  bot.sandbox.state === 'RUNNING'
                    ? 'bg-success'
                    : bot.sandbox.state === 'STARTING'
                      ? 'bg-warning motion-safe:animate-pulse'
                      : bot.sandbox.state === 'STOPPED'
                        ? 'bg-foreground-faint'
                        : 'bg-danger'
                }`}
              />
            </IconButtonTooltip>
          )}
          <IconButtonTooltip
            label={t('app.shell.botSettings')}
            placement="left"
            isDisabled={bot === null}
            onPress={profile.onOpen}
            className="window-no-drag size-8 rounded-full text-room-muted"
          >
            <IconSettings className="size-4" stroke={1.8} />
          </IconButtonTooltip>
          <CallButton
            call={call.session}
            botName={bot?.name ?? null}
            edition={call.edition}
            onOpenPlan={call.onOpenPlan}
            iconOnly
          />
        </aside>
      </div>
    );
  }

  return (
    <>
      <ResizableSash
        side="end"
        value={railWidth}
        min={RIGHT_RAIL_BOUNDS.min}
        max={RIGHT_RAIL_BOUNDS.max}
        onResize={onResize}
        label={t('app.shell.resizeDetailsRail')}
      />
      <div data-pane="rail" className="h-full shrink-0" style={{ width: `${railWidth}px` }}>
        {work.selectedTaskId !== null ? (
          <TaskDetailsPane
            key={work.selectedTaskId}
            client={client}
            taskId={work.selectedTaskId}
            revision={work.tasksRevision}
            bots={work.bots}
            projects={work.projects}
            onClose={() => work.onSelectTask(null)}
            onOpenTask={work.onSelectTask}
            onOpenConversation={work.onOpenConversation}
          />
        ) : work.selectedDeliverable !== null ? (
          <DeliverablePane
            key={work.selectedDeliverable.id}
            client={client}
            deliverable={work.selectedDeliverable}
            bots={work.bots}
            projects={work.projects}
            onClose={work.onCloseDeliverable}
            onOpenConversation={work.onOpenConversation}
            onOpenTask={work.onOpenTask}
            onOpenDeliverableById={work.onOpenDeliverableById}
          />
        ) : work.workView === 'goals' && work.selectedGoalId !== null ? (
          <GoalDetailsPane
            key={work.selectedGoalId}
            client={client}
            goalId={work.selectedGoalId}
            revision={work.goalsRevision}
            bots={work.bots}
            projects={work.projects}
            onClose={work.onCloseGoal}
            onOpenTask={work.onOpenTask}
          />
        ) : bot !== null && profile.botId === bot.id ? (
          <BotProfilePane
            bot={bot}
            onBack={profile.onClose}
            onCollapse={onToggle}
            onSave={profile.onSave}
          />
        ) : (
          <aside
            aria-label={t('app.shell.details')}
            data-pane-rail-state="expanded"
            className="crewaid-rail flex h-full w-full flex-col"
          >
            <div className="crewaid-rail-header flex shrink-0 items-center gap-0.5">
              <h2 className="crewaid-rail-section-title flex-1 truncate ps-1">
                {t('screen.railTitle')}
              </h2>
              <CallButton
                call={call.session}
                botName={bot?.name ?? null}
                edition={call.edition}
                onOpenPlan={call.onOpenPlan}
              />
              <IconButtonTooltip
                // Scoped to the selected bot's profile; app settings live behind the account menu.
                label={t('app.shell.botSettings')}
                isDisabled={bot === null}
                onPress={profile.onOpen}
                className="window-no-drag size-7 rounded-lg text-muted"
              >
                <IconSettings className="size-4" stroke={1.8} />
              </IconButtonTooltip>
              <IconButtonTooltip
                label={t('app.shell.collapsePanel')}
                aria-expanded={true}
                onPress={onToggle}
                className="window-no-drag size-7 rounded-lg text-muted"
              >
                <IconChevronsRight className="size-4 rtl:-scale-x-100" stroke={1.8} />
              </IconButtonTooltip>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
              <ScreenCard
                seatControl={screen.seatControl}
                controlScreen={screen.controlScreen}
                bot={bot}
                expanded={screen.expanded}
                onExpandedChange={screen.onExpandedChange}
                watchScreen={screen.watchScreen}
                sendScreenInput={screen.sendScreenInput}
                openScreenStream={screen.openScreenStream}
                wake={screen.wake}
                onWake={screen.onWake}
                onReleaseIdentity={screen.onReleaseIdentity}
                recording={recording.view}
                onTeachTask={recording.onTeachTask}
                onStopRecording={recording.onStop}
                onDiscardRecording={recording.onDiscard}
                onReviewSkill={recording.onReviewSkill}
              />

              {handoff?.latest == null ? null : (
                <RightRailHandoffSection
                  handoff={handoff.latest}
                  onJumpToHandoff={handoff.onJumpToHandoff}
                  actions={handoff.actions}
                />
              )}

              {bot === null ? null : (
                <BotTasksSection
                  client={client}
                  botId={bot.id}
                  revision={work.tasksRevision}
                  onOpenTask={work.onOpenTask}
                  onSeeAll={() => work.onSeeAllBotTasks(bot.id)}
                />
              )}

              <RoutinesPanel botId={bot?.id ?? null} actions={routineActions} />
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
