import type { Bot } from '@crewaid/shared';
import { Dropdown, Popover, Separator } from '@heroui/react';
import {
  IconCheck,
  IconChecklist,
  IconCopy,
  IconDots,
  IconFileText,
  IconInfoCircle,
  IconTrash,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { t, useT } from '../../i18n/i18n';
import { BotAvatar } from '../BotAvatar';
import { copyText } from '../copyText';
import { StreamingMarkdown } from '../markdown/StreamingMarkdown';

export type MessageWorkAction = 'task' | 'deliverable';

/** All actions offered by a settled message's overflow menu. */
export type MessageAction = MessageWorkAction | 'delete';

export type PeerLabel = {
  name: string;
  color: string;
  avatarShape?: Bot['avatarShape'];
  avatarUrl?: Bot['avatarUrl'];
};

export type PeerSummary = {
  id: string;
  name: string;
  avatarColor: string;
  avatarShape?: Bot['avatarShape'];
  avatarUrl?: Bot['avatarUrl'];
};

const REMOVED_PEER: PeerLabel = {
  get name() {
    return t('transcript.removedBot');
  },
  color: 'var(--color-muted, #8a8a8a)',
};

/**
 * Resolve an originating peer from the live roster at render time so renames
 * and recolours stay consistent with the sidebar. Removed senders stay labelled
 * rather than dropped so the thread's context remains legible.
 */
export function peerLabel(fromBotId: string, peers: readonly PeerSummary[] | undefined): PeerLabel {
  const found = peers?.find((peer) => peer.id === fromBotId);
  return found === undefined
    ? REMOVED_PEER
    : {
        name: found.name,
        color: found.avatarColor,
        ...(found.avatarShape === undefined ? {} : { avatarShape: found.avatarShape }),
        ...(found.avatarUrl === undefined ? {} : { avatarUrl: found.avatarUrl }),
      };
}

export function InterBotAttribution({ peer }: { peer: PeerLabel }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold leading-none">
      <span data-interbot-mascot className="flex size-6 shrink-0 items-center justify-center">
        <BotAvatar
          bot={{
            name: peer.name,
            avatarColor: peer.color,
            ...(peer.avatarShape === undefined ? {} : { avatarShape: peer.avatarShape }),
            ...(peer.avatarUrl === undefined ? {} : { avatarUrl: peer.avatarUrl }),
          }}
          size="sm"
        />
      </span>
      <span style={{ color: peer.color }}>{peer.name}</span>
    </div>
  );
}

/**
 * Message overflow menu: task/deliverable creation and deletion all operate on
 * the whole message and open a confirmation/editor dialog before mutating.
 */
export function MessageWorkMenu({ onAction }: { onAction: (action: MessageAction) => void }) {
  const t = useT();
  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={t('transcript.more')}
        data-message-menu
        className="rounded p-0.5 text-muted outline-none data-[hovered]:text-foreground data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus/60"
      >
        <IconDots aria-hidden className="size-3.5" stroke={1.8} />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start" className="min-w-[200px] rounded-xl">
        <Dropdown.Menu
          aria-label={t('transcript.more')}
          onAction={(key) => {
            if (key === 'task' || key === 'deliverable' || key === 'delete') onAction(key);
          }}
        >
          <Dropdown.Item id="task" textValue={t('transcript.createTask')} className="rounded-lg">
            <IconChecklist className="size-4 shrink-0" stroke={1.8} />
            <span>{t('transcript.createTask')}</span>
          </Dropdown.Item>
          <Dropdown.Item
            id="deliverable"
            textValue={t('transcript.saveDeliverable')}
            className="rounded-lg"
          >
            <IconFileText className="size-4 shrink-0" stroke={1.8} />
            <span>{t('transcript.saveDeliverable')}</span>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item
            id="delete"
            textValue={t('transcript.deleteMessage')}
            variant="danger"
            className="rounded-lg text-danger data-[hovered]:text-danger"
          >
            <IconTrash className="size-4 shrink-0" stroke={1.8} />
            <span>{t('transcript.deleteMessage')}</span>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/**
 * Hover/focus-revealed bubble footer holding the timestamp, copy button,
 * optional voice transcript disclosure, and overflow menu. Positioned out of
 * flow with opacity transitions so hovering never shifts layout.
 */
export function BubbleFooter({
  timeLabel,
  text,
  isUser,
  onAction,
  showTranscript = false,
}: {
  timeLabel: string;
  text: string;
  isUser: boolean;
  onAction?: ((action: MessageAction) => void) | undefined;
  /** Voice messages keep their words in a disclosure instead of a text bubble. */
  showTranscript?: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1400);
    });
  };

  return (
    <div
      data-transcript-open={transcriptOpen || undefined}
      className={`crewaid-bubble-footer pointer-events-none absolute top-full z-10 flex h-5 items-center gap-1.5 px-2 opacity-0 group-hover/bubble:pointer-events-auto group-hover/bubble:opacity-100 group-focus-within/bubble:pointer-events-auto group-focus-within/bubble:opacity-100 data-[transcript-open=true]:pointer-events-auto data-[transcript-open=true]:opacity-100 ${
        isUser ? 'end-0 justify-end' : 'start-0 justify-start'
      }`}
    >
      <span className="text-[10px] leading-none text-muted">{timeLabel}</span>
      {showTranscript && text.trim() !== '' ? (
        <Popover isOpen={transcriptOpen} onOpenChange={setTranscriptOpen}>
          <Popover.Trigger
            data-voice-transcript-trigger
            aria-label={t('transcript.voice.show')}
            title={t('transcript.voice.show')}
            className="rounded p-0.5 text-muted outline-none data-[hovered]:text-foreground data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus/60"
          >
            <IconInfoCircle aria-hidden className="size-3.5" stroke={1.8} />
          </Popover.Trigger>
          <Popover.Content
            placement={isUser ? 'top end' : 'top start'}
            className="w-[360px] max-w-[calc(100vw-32px)] rounded-xl"
          >
            <Popover.Dialog aria-label={t('transcript.voice.dialog')} className="p-3">
              <Popover.Heading className="mb-2 text-[12px] font-medium text-muted">
                {t('transcript.voice.heading')}
              </Popover.Heading>
              <div
                data-voice-transcript
                className="max-h-[min(50vh,360px)] overflow-y-auto overscroll-contain text-[14px] leading-[21px]"
              >
                {isUser ? (
                  <p className="crewaid-user-prose whitespace-pre-wrap break-words">{text}</p>
                ) : (
                  <StreamingMarkdown source={text} />
                )}
              </div>
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
      ) : null}
      <button
        type="button"
        data-copy-message
        aria-label={copied ? t('transcript.copied') : t('transcript.copy')}
        className="rounded p-0.5 text-muted outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus/60"
        onClick={handleCopy}
      >
        {copied ? (
          <IconCheck aria-hidden className="size-3.5" stroke={2} />
        ) : (
          <IconCopy aria-hidden className="size-3.5" stroke={1.8} />
        )}
      </button>
      {onAction === undefined ? null : <MessageWorkMenu onAction={onAction} />}
    </div>
  );
}

export function Bubble({
  author,
  children,
  title,
  timeLabel,
  peer,
  text,
  onAction,
}: {
  author: 'USER' | 'BOT';
  children: React.ReactNode;
  /** Exact timestamp surfaced on hover so stacked bubbles stay uncluttered. */
  title: string;
  /** Compact clock text for the revealed footer. */
  timeLabel: string;
  /** Set only for a message delivered from another bot. */
  peer?: PeerLabel | undefined;
  /** Spoken text of this bubble; copy stays scoped to the hovered bubble. */
  text: string;
  /** Absent while the message is still streaming. */
  onAction?: ((action: MessageAction) => void) | undefined;
}) {
  const isUser = author === 'USER';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2 px-1`}>
      <div className="crewaid-bubble-wrap group/bubble relative">
        <div
          data-message-bubble={isUser ? 'user' : 'bot'}
          data-from-bot={peer === undefined ? undefined : 'true'}
          title={title}
          className={`whitespace-pre-wrap break-words rounded-message px-[18px] py-3 text-[15px] leading-[23px] ${
            isUser
              ? 'bg-message-user text-message-user-foreground'
              : 'bg-message-bot text-message-bot-foreground'
          }`}
          // Inline-start accent separates a teammate's message without repainting the bubble.
          style={peer === undefined ? undefined : { borderInlineStart: `3px solid ${peer.color}` }}
        >
          {children}
        </div>
        <BubbleFooter timeLabel={timeLabel} text={text} isUser={isUser} onAction={onAction} />
      </div>
    </div>
  );
}

/** Quiet row in the bot's lane for thinking, actions, and non-speech metadata. */
export function Aside({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-start px-1">{children}</div>;
}
