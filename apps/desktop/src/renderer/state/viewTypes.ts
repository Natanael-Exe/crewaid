import type { BotWithSandbox } from '@crewaid/shared';
import type { MessageAttachment } from '../components/attachments/AttachmentCard';
import type { AnyPart } from '../components/PartRenderer';
import { currentLocale, t } from '../i18n/i18n';

/**
 * The shapes the shell renders, and the only place a §3/REST row is turned
 * into one.
 *
 * These are deliberately NOT the contract types. A `Message` carries
 * `conversationId`, `hopCount`, `runId` and a nullable `parts` blob; a
 * transcript row needs an author, some parts and a time label. Keeping the
 * translation in one function means the components never learn the wire shape,
 * which is what let the seed module stand in for the server for all of M1.
 */

/** A bot as the sidebar shows it: the contract row plus its last-message view. */
export interface BotRowView {
  /**
   * The row's collection key, equal to `bot.id`.
   *
   * A React Aria dynamic collection reads `id` off the item OBJECT. Without
   * it the collection keys by position, so any change that shifts rows —
   * deleting one above others, pinning, hiding — hands a live item node a
   * different `id` prop and React Aria throws "Cannot change the id of an
   * item" mid-render, unmounting the whole tree rather than the list. It is
   * duplicated from `bot.id` because the collection cannot be told where to
   * look for a key.
   */
  id: string;
  bot: BotWithSandbox;
  /** One-line ellipsized preview under the name ("Sent 1 Markdown file"). */
  preview: string;
  /** Right-aligned timestamp label ("10:26 AM"). */
  timeLabel: string;
}

export interface TranscriptMessage {
  id: string;
  author: 'USER' | 'BOT' | 'SYSTEM';
  /** Persisted message parts, rendered via the part registry. */
  parts: AnyPart[];
  timeLabel: string;
  /** The day this message falls on, for the transcript's date separator. */
  dateLabel?: string;
  /**
   * The row's instant, in epoch ms — what the transcript is ORDERED by.
   *
   * See `messageOrder.ts`: position in the array is not the whole model, because
   * the in-flight reply lives outside it and a message sent during that reply is
   * stored after it. The instant is the server's, so the render order and the
   * database order cannot disagree about which of two messages came first.
   */
  createdAt: number;
  /**
   * The reply the stream is still writing into. It has no saved content to
   * act on yet, so it carries no message menu, and its thinking stays open.
   */
  live?: true;
  /** Claimed attachments ride the message (WebSocket include). */
  attachments?: MessageAttachment[];
  /**
   * How the reply ended, verbatim from the server. Read only through
   * `incompleteReason` — the raw value is not display text.
   */
  stopReason?: string | null;
  /**
   * Set only when this message came from ANOTHER bot.
   *
   * §6/M7 stores an inter-bot message with `author: BOT` and the SENDER's
   * `fromBotId`, which is the same shape a bot's own reply has — so the
   * author alone renders a teammate's message as this bot speaking, in this
   * bot's lane, with no sign that anyone else was involved.
   *
   * The id rather than the name and colour, because those belong to a row
   * that can be renamed or recoloured after the message was sent, and a
   * transcript that disagrees with the sidebar about what a bot is called is
   * worse than one that has to look it up.
   */
  fromBotId?: string;
  /**
   * The task this message is about. A USER message with one is a
   * Start brief, and renders as the task's card rather than a bubble.
   */
  taskId?: string;
  /** A `/new` boundary, drawn as a divider rather than a note. */
  startsTopic?: true;
}

/**
 * The operator-facing note for a reply that did not finish normally, or null
 * when it did.
 *
 * PRD M1 requires an interrupted reply to READ as interrupted. Without this
 * the three endings the server can persist — finished, interrupted, failed —
 * all render as the same silent stop, and a truncated answer is
 * indistinguishable from a short one.
 *
 * The server writes three families into `stopReason`: the model's finish reason
 * on the happy path; the literal `interrupted` for both an orchestrator restart
 * and an operator cancel; and a
 * D-006 error code when the turn failed. Only the first family contains
 * values meaning "finished", so anything unrecognised is reported as
 * incomplete rather than passed off as a whole reply. The raw value is never
 * rendered: a D-006 code is written for logs, not for the transcript.
 */
export function incompleteReason(stopReason: string | null | undefined): string | null {
  // Absent means still streaming, or a USER message — neither is an ending.
  if (stopReason === null || stopReason === undefined || stopReason === '') return null;
  switch (stopReason) {
    case 'stop':
    case 'tool-calls':
      return null;
    case 'interrupted':
      return t('stop.interrupted');
    case 'length':
      return t('stop.length');
    case 'content-filter':
      return t('stop.contentFilter');
    default:
      return t('stop.unfinished');
  }
}

export function formatTimeLabel(iso: string | Date): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(currentLocale(), { hour: 'numeric', minute: '2-digit' });
}

/**
 * Today and yesterday are named rather than dated — an absolute date on a
 * message five minutes old reads as stale history.
 */
export function formatDateLabel(iso: string | Date, now: Date = new Date()): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return t('date.today');
  if (days === 1) return t('date.yesterday');
  return date.toLocaleDateString(currentLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The card view of a wire attachment row — the fields the card renders,
 * mapped identically wherever a WebSocket payload or a REST response carries
 * attachments. The wire row also carries `messageId` and `storageKey`, which
 * are the server's plumbing and stay behind.
 */
export function toAttachmentViews(
  attachments: ReadonlyArray<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    kind?: 'FILE' | 'VOICE_NOTE';
    durationMs?: number | null;
  }>,
): MessageAttachment[] {
  return attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    kind: a.kind ?? 'FILE',
    durationMs: a.durationMs ?? null,
  }));
}

/**
 * Sidebar row: the bot, the last thing said in its thread, and when.
 *
 * D-192 reads both off the `GET /bots` row rather than out of a transcript
 * this window happens to be holding. The server flattens the text and picks
 * the message (the newest spoken USER or BOT row), which is what makes the
 * line right for a bot nobody has opened — the old reading fell back to the
 * bot's role for every row but the one on screen.
 */
export function toBotRowView(bot: BotWithSandbox): BotRowView {
  const preview = bot.thread?.preview ?? null;
  return {
    id: bot.id,
    bot,
    // An empty thread says what the bot is FOR instead, which is the more
    // useful line for a bot the operator has not talked to yet.
    preview: preview === null || preview.text === '' ? bot.role : preview.text,
    timeLabel: preview === null ? '' : formatTimeLabel(preview.createdAt),
  };
}
