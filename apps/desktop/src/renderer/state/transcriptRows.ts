import { projectPublicSpeech } from '@crewaid/shared';
import { isPartOutput, partField, type AnyPart } from '../components/PartRenderer';
import { isFoldedToolPart, type FoldedToolPart } from '../components/tools/toolParts';
import { isBotWorkPart } from './transcriptPrefs';
import { incompleteReason, type TranscriptMessage } from './viewTypes';

/**
 * How one message's parts become rows on screen.
 *
 * The rule this file exists for: **a bubble is something the bot SAID.**
 * Everything else a turn produces — the thinking between two sentences, the
 * twenty actions it took, a part this build does not know about — is work, and
 * work sits outside the bubble as a quiet row.
 *
 * Before this, every part of a turn went inside one bubble, so a long agentic
 * turn rendered as a single grey slab holding four paragraphs, eleven thinking
 * blocks and an action log, with a timestamp at the bottom. The reference
 * (ref-01, and the Grok transcript it was drawn from) is the opposite: short
 * bubbles, one per thing said, with the machinery between them.
 *
 * A pure function over parts, tested on its own, because the alternative is
 * this logic living as nested ternaries inside JSX where nothing can reach it.
 */

export type TranscriptRow =
  /** Speech. Gets a bubble. */
  | { readonly kind: 'bubble'; readonly key: string; readonly part: AnyPart }
  /** Work. Gets a quiet row in the bot's lane, no bubble. */
  | { readonly kind: 'aside'; readonly key: string; readonly part: AnyPart };

/**
 * The part types that are speech. Deliberately a closed list rather than
 * "anything the registry can render": a part type added in a later milestone
 * is work until somebody decides otherwise, and the failure mode of guessing
 * wrong in this direction is a quiet row instead of a bubble — recoverable,
 * unlike a tool-call log rendered as something the bot told you.
 */
const SPEECH_TYPES: ReadonlySet<string> = new Set(['text']);

/** A part's text, or '' for a part that carries none. Also what Copy copies. */
export function textOfPart(part: AnyPart): string {
  const text = (part as { text?: unknown }).text;
  return typeof text === 'string' ? projectPublicSpeech(text) : '';
}

export function toTranscriptRows(parts: readonly AnyPart[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  parts.forEach((part, index) => {
    // An empty text part is not a silence the operator should see — the SDK
    // emits one for a step that only called a tool, and a bubble with nothing
    // in it reads as a message that failed to load.
    if (SPEECH_TYPES.has(part.type)) {
      if (textOfPart(part).trim() === '') return;
      rows.push({ kind: 'bubble', key: `p${index}`, part });
      return;
    }
    rows.push({ kind: 'aside', key: `p${index}`, part });
  });
  return rows;
}

/** Whether anything in this message is spoken, for the callers that care. */
export function hasBubble(rows: readonly TranscriptRow[]): boolean {
  return rows.some((row) => row.kind === 'bubble');
}

export function isRowVisible(row: TranscriptRow, showWork: boolean): boolean {
  return (
    showWork || row.kind === 'bubble' || !isBotWorkPart(row.part.type) || isPartOutput(row.part)
  );
}

/** Hidden work must not leave an empty message box or a virtual height behind. */
export function hasVisibleTranscriptContent(
  message: TranscriptMessage,
  showWork: boolean,
): boolean {
  if (message.startsTopic === true || (message.author === 'USER' && message.taskId !== undefined))
    return true;
  if ((message.attachments?.length ?? 0) > 0 || incompleteReason(message.stopReason) !== null)
    return true;
  return toTranscriptRows(message.parts).some((row) => isRowVisible(row, showWork));
}

function routineCallsOnly(message: TranscriptMessage): FoldedToolPart[] | null {
  if (
    message.author !== 'BOT' ||
    message.live === true ||
    message.startsTopic === true ||
    message.taskId !== undefined ||
    (message.attachments?.length ?? 0) > 0 ||
    incompleteReason(message.stopReason) !== null
  ) {
    return null;
  }
  const rows = toTranscriptRows(message.parts);
  if (rows.length === 0) return null;
  const collected: FoldedToolPart[] = [];
  for (const row of rows) {
    if (row.kind !== 'aside') return null;
    if (isPartOutput(row.part)) return null;
    if (row.part.type === 'tool-activity') {
      const calls = partField(row.part, 'calls');
      if (!Array.isArray(calls)) return null;
      const valid = calls.filter(isFoldedToolPart);
      if (valid.length === 0) return null;
      collected.push(...valid);
    } else if (isFoldedToolPart(row.part)) {
      collected.push(row.part);
    } else {
      return null;
    }
  }
  return collected.length > 0 ? collected : null;
}

export interface DeliveryReceiptEntry {
  readonly id: string;
  readonly recipient: string;
  readonly timeLabel: string;
}

export interface DeliveryReceiptsPart {
  readonly type: 'delivery-receipts';
  readonly receipts: readonly DeliveryReceiptEntry[];
  readonly [key: string]: unknown;
}

const DELIVERY_RECEIPT_RE = /^Your message to (.+?) was delivered to their conversation\.$/;

/**
 * Extracts recipient metadata when a SYSTEM row is a routine successful
 * delivery receipt. Delivery failures and chain-limit notices return `null` so
 * they stay prominently visible in the transcript.
 */
export function parseDeliveryReceipt(message: TranscriptMessage): DeliveryReceiptEntry | null {
  if (message.author !== 'SYSTEM' || message.startsTopic === true) return null;
  const text = message.parts.map(textOfPart).join(' ').trim();
  const match = DELIVERY_RECEIPT_RE.exec(text);
  const recipient = match?.[1]?.trim();
  if (recipient === undefined || recipient === '') return null;
  return { id: message.id, recipient, timeLabel: message.timeLabel };
}

/**
 * Folds consecutive successful inter-bot delivery receipts into one compact
 * expandable activity row while keeping delivery failures and limit notices
 * ungrouped and visible.
 */
export function coalesceDeliveryReceipts(
  messages: readonly TranscriptMessage[],
  focusMessageId?: string | null,
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let pending: { anchor: TranscriptMessage; receipts: DeliveryReceiptEntry[] } | null = null;

  const flush = () => {
    if (pending === null) return;
    const part: DeliveryReceiptsPart = {
      type: 'delivery-receipts',
      receipts: pending.receipts,
    };
    out.push({
      ...pending.anchor,
      parts: [part],
    });
    pending = null;
  };

  for (const message of messages) {
    const receipt =
      focusMessageId != null && message.id === focusMessageId
        ? null
        : parseDeliveryReceipt(message);
    if (receipt === null) {
      flush();
      out.push(message);
      continue;
    }
    if (pending !== null && pending.anchor.dateLabel === message.dateLabel) {
      pending.receipts.push(receipt);
    } else {
      flush();
      pending = { anchor: message, receipts: [receipt] };
    }
  }
  flush();
  return out;
}

export interface ExchangeMatchTarget {
  readonly chainId: string | null;
  readonly timestamp: number;
  readonly excerpt: string;
}

/**
 * Locates the exact originating message in a peer bot's thread for an incoming
 * handoff: matches a `send_message` tool call carrying the excerpt first, then
 * falls back to the closest message in the same chain or within ±2 minutes.
 */
export function findExchangeMessageId(
  messages: readonly TranscriptMessage[],
  target: ExchangeMatchTarget,
): string | null {
  const normalizedExcerpt = target.excerpt
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 64);

  if (normalizedExcerpt.length >= 12) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg === undefined || msg.author !== 'BOT') continue;
      for (const part of msg.parts) {
        const calls: FoldedToolPart[] = [];
        if (part.type === 'tool-activity') {
          const inner = partField(part, 'calls');
          if (Array.isArray(inner)) calls.push(...inner.filter(isFoldedToolPart));
        } else if (isFoldedToolPart(part)) {
          calls.push(part);
        }
        for (const call of calls) {
          if (call.toolName !== 'send_message') continue;
          const input = call.input;
          if (typeof input !== 'object' || input === null || Array.isArray(input)) continue;
          const rawBody =
            (input as Record<string, unknown>)['message'] ??
            (input as Record<string, unknown>)['content'];
          if (
            typeof rawBody === 'string' &&
            rawBody.replace(/\s+/g, ' ').trim().toLowerCase().includes(normalizedExcerpt)
          ) {
            return msg.id;
          }
        }
      }
    }
  }

  let bestId: string | null = null;
  let bestDelta = Infinity;
  for (const msg of messages) {
    if (msg.author === 'SYSTEM') continue;
    const sameChain = target.chainId !== null && msg.chainId === target.chainId;
    const delta = Math.abs(msg.createdAt - target.timestamp);
    if (sameChain && delta < bestDelta) {
      bestDelta = delta;
      bestId = msg.id;
    }
  }
  if (bestId !== null) return bestId;

  for (const msg of messages) {
    if (msg.author === 'SYSTEM') continue;
    const delta = Math.abs(msg.createdAt - target.timestamp);
    if (delta <= 120_000 && delta < bestDelta) {
      bestDelta = delta;
      bestId = msg.id;
    }
  }
  return bestId;
}

/**
 * When "Show thinking and actions" is enabled, merge adjacent purely-routine-tool
 * bot messages between speech bubbles into one collapsed `tool-activity` row so a
 * multi-step tool stretch renders as one "N actions" line rather than N stacked rows.
 */
export function coalesceRoutineMessages(
  messages: readonly TranscriptMessage[],
  focusMessageId?: string | null,
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let pending: { message: TranscriptMessage; calls: FoldedToolPart[] } | null = null;

  const flush = () => {
    if (pending === null) return;
    out.push({
      ...pending.message,
      parts: [{ type: 'tool-activity', calls: pending.calls }],
    });
    pending = null;
  };

  for (const message of messages) {
    const routine =
      focusMessageId != null && message.id === focusMessageId ? null : routineCallsOnly(message);
    if (routine === null) {
      flush();
      out.push(message);
      continue;
    }
    if (
      pending !== null &&
      pending.message.fromBotId === message.fromBotId &&
      pending.message.dateLabel === message.dateLabel
    ) {
      pending.calls.push(...routine);
    } else {
      flush();
      pending = { message, calls: [...routine] };
    }
  }
  flush();
  return out;
}
