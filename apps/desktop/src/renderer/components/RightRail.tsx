import { IconChevronsRight, IconSettings } from '@tabler/icons-react';
import { useMemo } from 'react';
import type { BotWithSandbox, DeliverableView, Edition, ProjectWithCounts } from '@crewaid/shared';
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
}

export interface RightRailProps {
  readonly bot: BotWithSandbox | null;
  readonly collapsed: boolean;
  readonly railWidth: number;
  readonly onResize: (width: number) => void;
  readonly onToggle: () => void;
  readonly screen: RightRailScreenProps;
  readonly recording: RightRailRecordingProps;
  readonly call: RightRailCallProps;
  readonly profile: RightRailProfileProps;
  readonly work: RightRailWorkProps;
}

export function RightRail({
  bot,
  collapsed,
  railWidth,
  onResize,
  onToggle,
  screen,
  recording,
  call,
  profile,
  work,
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
            className="window-no-drag size-8 rounded-[10px] bg-surface text-room-muted"
          >
            <IconChevronsRight className="size-4 rotate-180 rtl:-scale-x-100" stroke={1.8} />
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
        ) : work.workView === 'deliverables' && work.selectedDeliverable !== null ? (
          <DeliverablePane
            key={work.selectedDeliverable.id}
            client={client}
            deliverable={work.selectedDeliverable}
            bots={work.bots}
            projects={work.projects}
            onClose={work.onCloseDeliverable}
            onOpenConversation={work.onOpenConversation}
            onOpenTask={work.onOpenTask}
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
              <CallButton
                call={call.session}
                botName={bot?.name ?? null}
                edition={call.edition}
                onOpenPlan={call.onOpenPlan}
              />
              <span aria-hidden className="flex-1" />
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

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
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
