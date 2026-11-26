import { Button, Disclosure, Separator } from '@heroui/react';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { memo, useEffect, useState } from 'react';
import { useT } from '../../i18n/i18n';
import {
  isRowVisible,
  textOfPart,
  toTranscriptRows,
  type DeliveryReceiptEntry,
} from '../../state/transcriptRows';
import { incompleteReason, type TranscriptMessage } from '../../state/viewTypes';
import { TaskBriefCard } from '../../work/TaskBriefCard';
import { AttachmentCardRow } from '../attachments/AttachmentCard';
import { VoiceNoteBubble } from '../attachments/VoiceNoteBubble';
import { formatPreviewInternalPaths } from '../markdown/internalPaths';
import { partField, renderPart, type PartRenderContext } from '../PartRenderer';
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

const PEER_COLLAPSE_CHARS = 220;
const PEER_COLLAPSE_LINES = 3;

function isLongPeerMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > PEER_COLLAPSE_CHARS) return true;
  return trimmed.split('\n').filter((line) => line.trim() !== '').length > PEER_COLLAPSE_LINES;
}

function plainPeerPreview(text: string, pathFallback: string): string {
  const masked = formatPreviewInternalPaths(text, pathFallback);
  return masked
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function DeliveryReceiptsRow({ receipts }: { receipts: readonly DeliveryReceiptEntry[] }) {
  const t = useT();
  const first = receipts[0];
  if (first === undefined) return null;
  const summary =
    receipts.length === 1
      ? t('transcript.receipts.one', { name: first.recipient })
      : t('transcript.receipts.many', { count: receipts.length });
  return (
    <div data-delivery-receipts={receipts.length} className="flex justify-start px-1 py-0.5">
      <Disclosure defaultExpanded={false} className="min-w-0">
        <Disclosure.Heading>
          <Disclosure.Trigger className="crewaid-tool-disclosure inline-flex items-center gap-1 rounded-md py-0.5 text-micro text-muted outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus">
            <span>{summary}</span>
            {receipts.length === 1 && first.timeLabel !== '' ? (
              <span className="tabular-nums opacity-75">· {first.timeLabel}</span>
            ) : null}
            <Disclosure.Indicator className="size-3 shrink-0 text-muted" />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body>
            <ul
              aria-label={t('transcript.receipts.label')}
              className="mt-1 flex flex-col gap-0.5 border-s-2 border-separator ps-2.5 text-micro text-muted"
            >
              {receipts.map((entry) => (
                <li key={entry.id} className="flex items-center gap-1.5">
                  <span>{t('transcript.receipts.one', { name: entry.recipient })}</span>
                  {entry.timeLabel === '' ? null : (
                    <span className="tabular-nums opacity-75">· {entry.timeLabel}</span>
                  )}
                </li>
              ))}
            </ul>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </div>
  );
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
  focused = false,
  onOpenPeerExchange,
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
  /** True when the operator explicitly jumped to this message. */
  focused?: boolean;
  /** Opens the originating peer's thread at this exact exchange. */
  onOpenPeerExchange?: ((peerBotId: string, msg: TranscriptMessage) => void) | undefined;
}) {
  const t = useT();
  const [peerExpanded, setPeerExpanded] = useState(focused);
  useEffect(() => {
    if (focused) setPeerExpanded(true);
  }, [focused]);

  if (msg.author === 'SYSTEM' && msg.startsTopic === true) {
    const onRemoveTopic = work?.onRemoveTopic;
    return (
      <TopicDivider
        onUndo={onRemoveTopic === undefined ? undefined : () => onRemoveTopic(msg.id)}
      />
    );
  }
  if (msg.author === 'SYSTEM') {
    const receiptPart = msg.parts.find((p) => p.type === 'delivery-receipts');
    const receipts =
      receiptPart === undefined ? undefined : partField(receiptPart, 'receipts');
    if (Array.isArray(receipts) && receipts.length > 0) {
      return <DeliveryReceiptsRow receipts={receipts as readonly DeliveryReceiptEntry[]} />;
    }
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
  const collapsiblePeer =
    peer !== undefined && settled && voiceNotes.length === 0 && isLongPeerMessage(transcript);
  const openPeer =
    onOpenPeerExchange !== undefined
      ? (peerId: string) => onOpenPeerExchange(peerId, msg)
      : renderContext?.onBotMention;

  return (
    <div
      data-message={msg.id}
      className="flex flex-col gap-1 rounded-card transition-colors duration-700 data-[focused=true]:bg-accent/10"
    >
      {/* Rendered once per message so multi-bubble replies read as one delivery. */}
      {peer === undefined ? null : (
        <div className="flex justify-start ps-2 pe-1">
          <InterBotAttribution
            peer={peer}
            timeLabel={collapsiblePeer ? msg.timeLabel : undefined}
            onOpenPeer={openPeer}
          />
        </div>
      )}
      {collapsiblePeer ? (
        <>
          <Bubble
            author={author}
            title={hoverTime}
            timeLabel={msg.timeLabel}
            text={transcript}
            onAction={onAction}
            peer={peer}
          >
            {peerExpanded ? (
              <div className="flex flex-col gap-2">
                {visibleRows
                  .filter((row) => row.kind === 'bubble')
                  .map((row) => (
                    <div key={row.key}>{renderPart(row.part, partContext)}</div>
                  ))}
              </div>
            ) : (
              <p
                data-peer-preview
                className="m-0 line-clamp-2 text-callout leading-[21px] text-foreground/85"
              >
                {plainPeerPreview(transcript, t('tools.path'))}
              </p>
            )}
            <div className="mt-2 flex items-center">
              <Button
                variant="ghost"
                size="sm"
                data-peer-toggle={peerExpanded ? 'collapse' : 'expand'}
                onPress={() => setPeerExpanded((open) => !open)}
                className="-ms-1.5 h-6 min-h-0 gap-1 rounded-full px-2 text-caption font-medium text-muted hover:text-foreground"
              >
                <span>
                  {peerExpanded
                    ? t('transcript.peer.hideFull')
                    : t('transcript.peer.showFull')}
                </span>
                {peerExpanded ? (
                  <IconChevronUp aria-hidden className="size-3.5" stroke={1.8} />
                ) : (
                  <IconChevronDown aria-hidden className="size-3.5" stroke={1.8} />
                )}
              </Button>
            </div>
          </Bubble>
          {visibleRows
            .filter((row) => row.kind !== 'bubble')
            .map((row) => (
              <Aside key={row.key}>{renderPart(row.part, partContext)}</Aside>
            ))}
        </>
      ) : (
        visibleRows.map((row) =>
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
        )
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
  focused = false,
  onOpenPeerExchange,
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
  focused?: boolean;
  onOpenPeerExchange?: ((peerBotId: string, msg: TranscriptMessage) => void) | undefined;
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
          focused={focused}
          onOpenPeerExchange={onOpenPeerExchange}
        />
      </div>
    </div>
  );
});
