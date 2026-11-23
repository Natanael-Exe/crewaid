import type { Bot, Json, ProviderExplanation, ToolInfo } from '@crewaid/shared';
import { ScrollShadow } from '@heroui/react';
import { useMemo } from 'react';
import { ConnectionStatusBadge } from '../connection/ConnectionStatusBadge';
import type { WsConnectionState } from '../connection/wsClient';
import { useT } from '../i18n/i18n';
import type { PendingApproval, TurnActivity } from '../state/chatReducer';
import type { QueuedMessage } from '../state/messageQueue';
import { hasVisibleTranscriptContent } from '../state/transcriptRows';
import type { TranscriptMessage } from '../state/viewTypes';
import type { PendingVoiceNote } from '../voice/useVoiceOutbox';
import type { PendingAttachment } from './attachments/attachmentState';
import { PendingVoiceNoteRow } from './attachments/PendingVoiceNoteRow';
import { BotAvatar } from './BotAvatar';
import { Composer } from './composer/Composer';
import type { ComposerVoice } from './composer/useVoiceCapture';
import type { PartRenderContext } from './PartRenderer';
import { ApprovalPromptList } from './tools/ApprovalPrompt';
import { TranscriptRow, type TranscriptWork } from './transcript/MessageGroup';
import {
  ConversationLoading,
  EmptyConversation,
  ErrorBanner,
  JumpToLatestButton,
  OlderHistoryBanner,
} from './transcript/TranscriptStates';
import { useTranscriptScroll } from './transcript/useTranscriptScroll';
import { WorkingIndicator } from './WorkingIndicator';

export type { TranscriptMessage } from '../state/viewTypes';
export type { MessageAction, MessageWorkAction, PeerLabel } from './transcript/MessageBubble';
export type { TranscriptWork } from './transcript/MessageGroup';
export { ConversationLoading, JumpToLatestButton } from './transcript/TranscriptStates';

/**
 * Tail messages kept out of `content-visibility: auto` so a still-growing reply
 * cannot snap back to a stale cached height when scrolled off screen.
 */
const LIVE_TAIL_MESSAGES = 6;

export interface TranscriptProps {
  bot: Bot;
  pendingVoiceNotes?: readonly PendingVoiceNote[];
  onRetryVoiceNote?: (note: PendingVoiceNote) => void;
  onDiscardVoiceNote?: (id: string) => void;
  aboveComposer?: React.ReactNode;
  emptyState?: React.ReactNode;
  threadStart?: React.ReactNode;
  afterMessages?: React.ReactNode;
  composerSeed?: { readonly text: string; readonly nonce: number } | null | undefined;
  composerPlaceholder?: string | undefined;
  voice?: ComposerVoice | undefined;
  spokenReplyId?: string | null;
  /** Gates empty-state rendering so switching to a busy bot never flashes it before hydration. */
  historyLoaded?: boolean;
  hasOlderMessages?: boolean;
  loadingOlder?: boolean;
  olderHistoryError?: string | null;
  /** Narrow peer summary so transcript rows do not re-render on sandbox status churn. */
  peers?:
    | readonly {
        id: string;
        name: string;
        role: string;
        avatarColor: string;
        avatarShape?: Bot['avatarShape'];
        avatarUrl?: Bot['avatarUrl'];
      }[]
    | undefined;
  onBotMention?: ((botId: string) => void) | undefined;
  connection: WsConnectionState;
  messages: readonly TranscriptMessage[];
  pending: PendingAttachment[];
  onSend: (text: string, attachmentIds: string[]) => void;
  onModelChanged?: (() => void) | undefined;
  onStop: () => void;
  onNewTopic?: (() => void) | undefined;
  error?: { message: string; explanation?: ProviderExplanation | undefined } | null;
  approvals?: readonly PendingApproval[] | undefined;
  onApprovalRespond?:
    ((toolCallId: string, approved: boolean, editedArgs?: Json) => void) | undefined;
  onReachTop?: (() => void) | undefined;
  focusMessageId?: string | null | undefined;
  onFocused?: (() => void) | undefined;
  showBotWork?: boolean | undefined;
  /** Keep stable across renders because rows are memoised. */
  work?: TranscriptWork | undefined;
  onFiles: (files: File[]) => void;
  onRemovePending: (localId: string) => void;
  onRetryPending: (localId: string) => void;
  activity?: TurnActivity | undefined;
  queued?: readonly QueuedMessage[] | undefined;
  onQueue?: ((text: string, attachmentIds: string[]) => void) | undefined;
  onEditQueued?: ((localId: string, text: string) => void) | undefined;
  onRemoveQueued?: ((localId: string) => void) | undefined;
  onSendQueuedNow?: ((localId: string) => void) | undefined;
  onMoveQueued?: ((from: number, to: number) => void) | undefined;
  tools?: readonly ToolInfo[] | undefined;
  onViewComputer?: (() => void) | undefined;
  catalogVersion?: number | undefined;
}

export function Transcript({
  bot,
  peers,
  connection,
  messages,
  pending,
  onSend,
  onModelChanged,
  onStop,
  onNewTopic,
  error,
  approvals,
  onApprovalRespond,
  onReachTop,
  focusMessageId,
  onFocused,
  work,
  showBotWork = true,
  onFiles,
  onRemovePending,
  onRetryPending,
  activity,
  queued,
  onQueue,
  onEditQueued,
  onRemoveQueued,
  onSendQueuedNow,
  onMoveQueued,
  tools,
  onViewComputer,
  catalogVersion,
  onBotMention,
  historyLoaded = false,
  hasOlderMessages = false,
  loadingOlder = false,
  olderHistoryError = null,
  voice,
  spokenReplyId = null,
  aboveComposer,
  emptyState,
  threadStart,
  afterMessages,
  composerSeed,
  composerPlaceholder,
  pendingVoiceNotes,
  onRetryVoiceNote,
  onDiscardVoiceNote,
}: TranscriptProps) {
  const t = useT();

  const renderContext = useMemo<PartRenderContext | undefined>(() => {
    const toolLabels =
      tools === undefined || tools.length === 0
        ? undefined
        : new Map(tools.map((tool) => [tool.name, tool.label]));
    const mentionBots = peers?.map((peer) => ({ ...peer }));
    if (
      toolLabels === undefined &&
      mentionBots === undefined &&
      onViewComputer === undefined &&
      approvals === undefined
    )
      return undefined;
    return {
      ...(toolLabels === undefined ? {} : { toolLabels }),
      pendingToolCalls: new Set(
        approvals
          ?.filter((approval) => approval.answered === undefined)
          .map((approval) => approval.toolCallId),
      ),
      ...(tools === undefined ? {} : { tools: new Map(tools.map((tool) => [tool.name, tool])) }),
      ...(onViewComputer === undefined ? {} : { onViewComputer }),
      ...(mentionBots === undefined ? {} : { mentionBots }),
      ...(onBotMention === undefined ? {} : { onBotMention }),
    };
  }, [onBotMention, peers, tools, onViewComputer, approvals]);

  const {
    scrollRef,
    contentRef,
    showJumpButton,
    jumpToBottom,
    requestOlder,
    handleScroll,
    handleScrollEnd,
  } = useTranscriptScroll({
    botId: bot.id,
    messages,
    historyLoaded,
    hasOlderMessages,
    loadingOlder,
    olderHistoryError,
    showBotWork,
    activity,
    approvalCount: approvals?.length ?? 0,
    pendingVoiceNotes,
    focusMessageId,
    onFocused,
    onReachTop,
  });

  const tail = useMemo(
    () => messages.filter((message) => hasVisibleTranscriptContent(message, showBotWork)),
    [messages, showBotWork],
  );
  const writing = messages.at(-1)?.live === true;
  const hasApprovals = approvals !== undefined && approvals.length > 0;

  return (
    <section
      aria-label={t('transcript.label')}
      data-connection-status={connection.status}
      aria-busy={(!historyLoaded && error == null) || loadingOlder}
      className="crewaid-bot-context flex h-full min-w-0 flex-1 flex-col"
    >
      <header className="crewaid-transcript-header flex shrink-0 items-center gap-4 px-6">
        <BotAvatar bot={bot} size="header" status={bot.status} />
        <div className="min-w-0">
          <h1>{bot.name}</h1>
          <p className="truncate text-footnote text-room-muted">{bot.role}</p>
        </div>
        <div className="ms-auto flex items-center gap-2">
          {activity === undefined ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-glass px-3 py-1.5 text-footnote leading-none text-room-muted backdrop-blur-md">
              <span className="size-1.5 rounded-full bg-muted" />
              {t('transcript.idle')}
            </span>
          ) : (
            <span className="crewaid-working-pill">{t('transcript.working')}</span>
          )}
          <ConnectionStatusBadge state={connection} />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {loadingOlder || olderHistoryError !== null ? (
          <OlderHistoryBanner
            loading={loadingOlder}
            error={olderHistoryError}
            onRetry={requestOlder}
          />
        ) : null}

        <ScrollShadow
          ref={scrollRef}
          data-transcript-scroll
          className="min-h-0 flex-1"
          onScroll={handleScroll}
          onScrollEnd={handleScrollEnd}
        >
          <div
            ref={contentRef}
            data-transcript-content
            className="mx-auto flex min-h-full w-full max-w-[900px] flex-col gap-2 px-6 py-4 [overflow-anchor:auto]"
          >
            {!historyLoaded && error == null ? <ConversationLoading /> : null}
            {historyLoaded &&
            messages.length === 0 &&
            (pendingVoiceNotes?.length ?? 0) === 0 &&
            activity === undefined &&
            !hasApprovals
              ? (emptyState ?? <EmptyConversation bot={bot} />)
              : null}
            {historyLoaded && !hasOlderMessages && messages.length > 0 ? threadStart : null}

            {tail.map((msg, i) => {
              const prev = i > 0 ? tail[i - 1] : undefined;
              // Group by speaker (author + originating peer), not author alone.
              const startsStack =
                !prev ||
                prev.author !== msg.author ||
                prev.fromBotId !== msg.fromBotId ||
                msg.author === 'SYSTEM';
              const startsDay = msg.dateLabel !== undefined && msg.dateLabel !== prev?.dateLabel;
              return (
                <TranscriptRow
                  key={msg.id}
                  msg={msg}
                  dayLabel={
                    startsDay && msg.dateLabel !== undefined
                      ? `${msg.dateLabel} ${msg.timeLabel}`
                      : null
                  }
                  spaced={!startsDay && startsStack}
                  skippable={i < tail.length - LIVE_TAIL_MESSAGES}
                  peers={peers}
                  renderContext={renderContext}
                  work={work}
                  settled={msg.live !== true}
                  showWork={showBotWork}
                  autoplayVoice={msg.id === spokenReplyId}
                />
              );
            })}

            {pendingVoiceNotes
              ?.filter(
                (note) =>
                  note.attachmentId === null ||
                  !messages.some((message) =>
                    message.attachments?.some((attachment) => attachment.id === note.attachmentId),
                  ),
              )
              .map((note) => (
                <PendingVoiceNoteRow
                  key={note.id}
                  note={note}
                  onRetry={() => onRetryVoiceNote?.(note)}
                  onDiscard={() => onDiscardVoiceNote?.(note.id)}
                />
              ))}

            {!writing && activity === undefined && !hasApprovals ? afterMessages : null}

            {/* Hidden while an approval prompt is open so the UI never claims the bot is still running. */}
            {activity !== undefined && !hasApprovals ? (
              <WorkingIndicator
                bot={bot}
                startedAt={activity.startedAt}
                status={activity.status ?? bot.status}
              />
            ) : null}

            {hasApprovals && onApprovalRespond !== undefined ? (
              <ApprovalPromptList
                approvals={approvals}
                botName={bot.name}
                onRespond={onApprovalRespond}
              />
            ) : null}
          </div>
        </ScrollShadow>

        {showJumpButton ? <JumpToLatestButton onClick={() => jumpToBottom('smooth')} /> : null}
      </div>

      <footer className="crewaid-transcript-footer shrink-0 pb-4">
        {error ? (
          <div className="mx-auto w-full max-w-[900px] px-(--transcript-gutter)">
            <ErrorBanner message={error.message} explanation={error.explanation} />
          </div>
        ) : null}
        {aboveComposer}
        <div className="px-(--transcript-gutter)">
          <Composer
            seed={composerSeed}
            placeholder={composerPlaceholder}
            botId={bot.id}
            botModelId={bot.modelId}
            botApprovalMode={bot.approvalMode}
            onApprovalModeChanged={onModelChanged}
            botName={bot.name}
            // Queue whenever a turn is active, even during quiet tool stretches with no streaming text.
            streaming={writing || activity !== undefined}
            queued={queued}
            onQueue={onQueue}
            onEditQueued={onEditQueued}
            onRemoveQueued={onRemoveQueued}
            onSendQueuedNow={onSendQueuedNow}
            onMoveQueued={onMoveQueued}
            pending={pending}
            onSend={onSend}
            onModelChanged={onModelChanged}
            onStop={onStop}
            onNewTopic={onNewTopic}
            onFiles={onFiles}
            onRemovePending={onRemovePending}
            onRetryPending={onRetryPending}
            tools={tools}
            bots={peers?.filter((peer) => peer.id !== bot.id)}
            catalogVersion={catalogVersion}
            voice={voice}
          />
        </div>
      </footer>
    </section>
  );
}
