import { Button, Separator } from '@heroui/react';
import { memo } from 'react';
import { useT } from '../../i18n/i18n';
import { isRowVisible, textOfPart, toTranscriptRows } from '../../state/transcriptRows';
import { incompleteReason, type TranscriptMessage } from '../../state/viewTypes';
import { TaskBriefCard } from '../../work/TaskBriefCard';
import { AttachmentCardRow } from '../attachments/AttachmentCard';
import { VoiceNoteBubble } from '../attachments/VoiceNoteBubble';
import { renderPart, type PartRenderContext } from '../PartRenderer';
// Part renderers self-register at import time; load them beside the sole caller.
import '../ReasoningPart';
import '../tools/ToolCallPart';
import {
  Aside,
  Bubble,
  BubbleFooter,
  InterBotAttribution,
  peerLabel,
  type MessageAction,
  type PeerSummary,
} from './MessageBubble';
import { IncompleteNote } from './TranscriptStates';

/**
 * Callbacks bridging the transcript to Work items and message mutations.
 * Absent in shells without Work support.
 */
export type TranscriptWork = {
  readonly onOpenTask: (taskId: string) => void;
  readonly filedTask: (attachmentId: string) => { taskId: string; title: string } | undefined;
  readonly onMessageAction?: (
    action: MessageAction,
    message: { readonly id: string; readonly content: string },
  ) => void;
  readonly onRemoveTopic?: (messageId: string) => void;
};

export function DateSeparator({ label }: { label: string }) {
  return (
    <div className="py-2.5 text-center text-micro tabular-nums text-foreground-faint">{label}</div>
  );
}

export function SystemEvent({ text }: { text: string }) {
  return <div className="py-1.5 text-center text-micro text-muted">{text}</div>;
}

/** Visual boundary marking where a `/new` topic resets the bot's context window. */
export function TopicDivider({ onUndo }: { onUndo?: (() => void) | undefined }) {
  const t = useT();
  return (
    <div
      data-topic-boundary
      className="group/topic flex items-center gap-3 px-1 py-3 text-micro text-muted"
      title={t('transcript.topic.title')}
    >
      <Separator className="flex-1 opacity-40" />
      <span className="rounded-full border border-glass-border bg-glass px-2.5 py-1 font-medium shadow-surface">
        {t('transcript.topic.new')}
      </span>
      {onUndo === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          data-topic-undo
          onPress={onUndo}
          className="h-6 rounded-md px-1.5 text-micro text-muted opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/topic:opacity-100 motion-reduce:transition-none"
        >
          {t('transcript.topic.undo')}
        </Button>
      )}
      <Separator className="flex-1 opacity-40" />
    </div>
  );
}

/**
 * Renders one message into its ordered sequence of speech bubbles, quiet aside
 * rows, voice notes, file cards, and incomplete-turn notes.
 */
export function MessageGroup({
  msg,
  peers,
  renderContext,
  work,
  settled = true,
  showWork = true,
  autoplayVoice = false,
}: {
  msg: TranscriptMessage;
  peers?: readonly PeerSummary[] | undefined;
  renderContext?: PartRenderContext | undefined;
  work?: TranscriptWork | undefined;
  /** False while streaming: unsaved content cannot be acted on yet. */
  settled?: boolean;
  /** False hides thinking and tool rows, leaving speech visible. */
  showWork?: boolean;
  /** Plays a newly arrived spoken reply once. */
  autoplayVoice?: boolean;
}) {
  if (msg.author === 'SYSTEM' && msg.startsTopic === true) {
    const onRemoveTopic = work?.onRemoveTopic;
    return (
      <TopicDivider
        onUndo={onRemoveTopic === undefined ? undefined : () => onRemoveTopic(msg.id)}
      />
    );
  }
  if (msg.author === 'SYSTEM') {
    return <SystemEvent text={msg.parts.map((p) => ('text' in p ? p.text : '')).join(' ')} />;
  }
  if (msg.author === 'USER' && msg.taskId !== undefined) {
    return (
      <div
        data-message={msg.id}
        className="rounded-card transition-colors duration-700 data-[focused=true]:bg-accent/10"
      >
        <TaskBriefCard
          text={msg.parts.map(textOfPart).join('\n')}
          taskId={msg.taskId}
          timeLabel={msg.timeLabel}
          onOpenTask={work?.onOpenTask}
        />
      </div>
    );
  }

  // Capture narrowed author before mapping callbacks where TS drops control-flow narrowing.
  const author: 'USER' | 'BOT' = msg.author;
  const incomplete = incompleteReason(msg.stopReason);
  const voiceNotes = (msg.attachments ?? []).filter((a) => a.kind === 'VOICE_NOTE');
  const files = (msg.attachments ?? []).filter((a) => a.kind !== 'VOICE_NOTE');
  const peer = msg.fromBotId === undefined ? undefined : peerLabel(msg.fromBotId, peers);
  const rows = toTranscriptRows(msg.parts).filter((row) => isRowVisible(row, showWork));
  const transcript = rows
    .filter((row) => row.kind === 'bubble')
    .map((row) => textOfPart(row.part))
    .join('\n\n');
  // Audio replaces speech bubbles only once audio exists; thinking/tool rows stay visible.
  const visibleRows = voiceNotes.length > 0 ? rows.filter((row) => row.kind !== 'bubble') : rows;
  const hoverTime =
    msg.dateLabel === undefined ? msg.timeLabel : `${msg.dateLabel} ${msg.timeLabel}`;
  const partContext: PartRenderContext = {
    ...renderContext,
    streaming: !settled,
    showWork,
    onViewComputer: peer === undefined ? renderContext?.onViewComputer : undefined,
  };
  const onMessageAction = work?.onMessageAction;
  const onAction =
    settled && onMessageAction !== undefined
      ? (action: MessageAction) =>
          onMessageAction(action, { id: msg.id, content: msg.parts.map(textOfPart).join('\n') })
      : undefined;

  return (
    <div
      data-message={msg.id}
      className="flex flex-col gap-1 rounded-card transition-colors duration-700 data-[focused=true]:bg-accent/10"
    >
      {/* Rendered once per message so multi-bubble replies read as one delivery. */}
      {peer === undefined ? null : (
        <div className="flex justify-start ps-2 pe-1">
          <InterBotAttribution peer={peer} onOpenPeer={renderContext?.onBotMention} />
        </div>
      )}
      {visibleRows.map((row) =>
        row.kind === 'bubble' ? (
          <Bubble
            key={row.key}
            author={author}
            title={hoverTime}
            timeLabel={msg.timeLabel}
            text={textOfPart(row.part)}
            onAction={onAction}
            {...(peer === undefined ? {} : { peer })}
          >
            {renderPart(row.part, partContext)}
          </Bubble>
        ) : (
          <Aside key={row.key}>{renderPart(row.part, partContext)}</Aside>
        ),
      )}
      {voiceNotes.length > 0 ? (
        <div
          data-message-voice={author === 'USER' ? 'user' : 'bot'}
          className="flex flex-col gap-1"
        >
          {voiceNotes.map((note) => (
            <div
              key={note.id}
              className={`mb-2 flex px-1 ${author === 'USER' ? 'justify-end' : 'justify-start'}`}
            >
              <div className="crewaid-bubble-wrap group/bubble relative">
                <VoiceNoteBubble
                  attachment={note}
                  align={author === 'USER' ? 'end' : 'start'}
                  autoplay={autoplayVoice && author !== 'USER'}
                />
                <BubbleFooter
                  timeLabel={msg.timeLabel}
                  text={transcript}
                  isUser={author === 'USER'}
                  onAction={onAction}
                  showTranscript
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div
          data-message-attachments={author === 'USER' ? 'user' : 'bot'}
          className={`flex ${author === 'USER' ? 'justify-end' : 'justify-start'} px-1`}
        >
          <AttachmentCardRow
            attachments={files}
            filedTask={work?.filedTask}
            onOpenTask={work?.onOpenTask}
          />
        </div>
      ) : null}
      {incomplete === null ? null : (
        <Aside>
          <IncompleteNote text={incomplete} />
        </Aside>
      )}
    </div>
  );
}

/**
 * Memoised transcript row with optional day separator.
 *
 * Settled messages preserve object identity across streamed tokens so memo
 * avoids re-rendering markdown/tool history on every token. Off-screen rows
 * outside the live tail use `content-visibility: auto` to skip layout/paint,
 * adding symmetric `pb-4`/`-mb-4` so out-of-flow bubble footers are not clipped.
 */
export const TranscriptRow = memo(function TranscriptRow({
  msg,
  dayLabel,
  spaced,
  skippable,
  peers,
  renderContext,
  work,
  settled,
  showWork,
  autoplayVoice,
}: {
  msg: TranscriptMessage;
  dayLabel: string | null;
  spaced: boolean;
  skippable: boolean;
  peers: readonly PeerSummary[] | undefined;
  renderContext: PartRenderContext | undefined;
  work: TranscriptWork | undefined;
  settled: boolean;
  showWork: boolean;
  autoplayVoice: boolean;
}) {
  return (
    <div
      data-motion-message={msg.id}
      className={`flex flex-col gap-1.5 ${
        skippable ? '-mb-4 pb-4 [contain-intrinsic-size:auto_6rem] [content-visibility:auto]' : ''
      }`}
    >
      {dayLabel === null ? null : <DateSeparator label={dayLabel} />}
      <div className={spaced ? 'mt-2' : undefined}>
        <MessageGroup
          msg={msg}
          peers={peers}
          renderContext={renderContext}
          work={work}
          settled={settled}
          showWork={showWork}
          autoplayVoice={autoplayVoice}
        />
      </div>
    </div>
  );
});
