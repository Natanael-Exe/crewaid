import { currentLocale } from '../i18n/i18n';
import {
  CrewaidMessageMetadataSchema,
  projectPublicSpeech,
  type CrewaidMessageMetadata,
} from '@crewaid/shared';
import type { PendingApproval } from '../state/chatReducer';
import type { Message } from '@ag-ui/core';
import type { AnyPart } from '../components/PartRenderer';
import { groupReasoning } from '../components/ReasoningPart';
import { foldToolParts, groupToolActivity } from '../components/tools/toolParts';
import {
  formatDateLabel,
  formatTimeLabel,
  toAttachmentViews,
  type TranscriptMessage,
} from '../state/viewTypes';

const EMPTY_METADATA: CrewaidMessageMetadata = {
  author: 'BOT',
  fromBotId: null,
  runId: null,
  sequence: 0,
  stopReason: null,
  taskId: null,
  routineId: null,
  chainId: null,
  hopCount: 0,
  startsTopic: false,
  attachments: [],
};
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function metadata(message: Message): Record<string, unknown> | undefined {
  const value: unknown = message.metadata;
  return object(value);
}
export function crewaidMetadataIn(message: Message): CrewaidMessageMetadata {
  const parsed = CrewaidMessageMetadataSchema.safeParse(metadata(message)?.['crewaid']);
  return parsed.success
    ? parsed.data
    : {
        ...EMPTY_METADATA,
        author: message.role === 'user' ? 'USER' : message.role === 'system' ? 'SYSTEM' : 'BOT',
      };
}
function content(message: Message): AnyPart[] {
  const body: unknown = message.content;
  if (typeof body === 'string') return body === '' ? [] : [{ type: 'text', text: body }];
  if (!Array.isArray(body)) return [];
  return body.flatMap((part: unknown) => {
    const value = object(part);
    if (value?.['type'] === 'text' && typeof value['text'] === 'string')
      return [{ type: 'text', text: value['text'] }];
    return [{ type: typeof value?.['type'] === 'string' ? value['type'] : 'unknown' }];
  });
}
function toolResult(message: Extract<Message, { role: 'tool' }>): AnyPart {
  const fields = object(metadata(message)?.['tanstack']);
  const outcome: unknown = fields?.['toolResultOutcome'];
  const original = object(fields?.['toolResult']);
  const rich = original?.['content'];
  const result: unknown = Array.isArray(rich)
    ? rich
        .map((part: unknown) => {
          const text = object(part)?.['content'];
          return typeof text === 'string' ? text : '';
        })
        .join('')
    : message.content;
  if (outcome !== undefined) return { type: 'tool-output-denied', toolCallId: message.toolCallId };
  const state = object(fields?.['toolResult']);
  if (message.error !== undefined || state?.['state'] === 'error')
    return {
      type: 'tool-error',
      toolCallId: message.toolCallId,
      error: message.error ?? state?.['error'] ?? result,
    };
  return { type: 'tool-result', toolCallId: message.toolCallId, output: result };
}
function parts(
  message: Message,
  related: readonly Message[],
  live: boolean,
  approvals: readonly PendingApproval[],
  demotePreTool: boolean,
): AnyPart[] {
  const result: AnyPart[] = [];
  for (const item of related) {
    if (item.role === 'reasoning')
      result.push({
        type: 'reasoning',
        text: typeof item.content === 'string' ? item.content : '',
        ...(live ? { state: 'streaming' } : {}),
      });
  }
  if (message.role === 'reasoning')
    result.push({
      type: 'reasoning',
      text: typeof message.content === 'string' ? message.content : '',
      ...(live ? { state: 'streaming' } : {}),
    });
  else if (message.role === 'tool') result.push(toolResult(message));
  else {
    const author = crewaidMetadataIn(message).author;
    const textParts =
      author === 'USER'
        ? content(message).map((part) =>
            part.type === 'text' ? { ...part, verbatim: true as const } : part,
          )
        : content(message);
    // Assistant text on a tool-calling step is pre-tool working narration, not
    // the settled reply. Keep it out of permanent speech bubbles (folded into
    // the work log when "Show thinking and actions" is enabled) — but only
    // when the run says something after it (see `preToolNarration`).
    const isPreToolStep =
      demotePreTool &&
      message.role === 'assistant' &&
      (message.toolCalls?.length ?? 0) > 0 &&
      author === 'BOT';
    if (isPreToolStep) {
      for (const part of textParts) {
        if (part.type === 'text' && typeof part.text === 'string') {
          result.push({ type: 'work-note', text: part.text });
        } else {
          result.push(part);
        }
      }
    } else {
      result.push(...textParts);
    }
  }
  if (message.role === 'assistant') {
    const calls = object(object(metadata(message)?.['tanstack'])?.['toolCallMetadata']);
    for (const call of message.toolCalls ?? []) {
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments) as unknown;
      } catch {
        input = undefined;
      }
      result.push({ type: 'tool-call', toolCallId: call.id, toolName: call.function.name, input });
      const pending = approvals.find((row) => row.toolCallId === call.id);
      const approval =
        pending === undefined
          ? object(object(calls?.[call.id])?.['approval'])
          : {
              needsApproval: true,
              ...(pending.answered === undefined
                ? {}
                : { approved: pending.answered === 'approved' }),
            };
      if (approval?.['needsApproval'] === true) {
        result.push({ type: 'tool-approval-request', toolCallId: call.id });
        if (typeof approval['approved'] === 'boolean')
          result.push({
            type: 'tool-approval-response',
            toolCallId: call.id,
            approved: approval['approved'],
          });
      }
    }
  }
  for (const item of related) if (item.role === 'tool') result.push(toolResult(item));
  const structured = object(object(metadata(message)?.['tanstack'])?.['structuredOutput']);
  if (structured !== undefined) result.push({ type: 'structured-output', ...structured });
  const resources = object(metadata(message)?.['tanstack'])?.['uiResources'];
  if (Array.isArray(resources))
    for (const resource of resources)
      result.push({
        type:
          typeof object(resource)?.['type'] === 'string'
            ? String(object(resource)?.['type'])
            : 'ui-resource',
      });
  return groupReasoning(groupToolActivity(foldToolParts(result)));
}
function row(
  message: Message,
  related: readonly Message[],
  botId: string,
  live: boolean,
  fallback: number,
  approvals: readonly PendingApproval[] = [],
  demotePreTool = false,
): TranscriptMessage {
  const crewaid = crewaidMetadataIn(message);
  const stamp = object(metadata(message)?.['tanstack'])?.['createdAt'];
  const createdAt = new Date(
    typeof stamp === 'string' || typeof stamp === 'number' ? stamp : fallback,
  );
  const attachments = toAttachmentViews(crewaid.attachments);
  return {
    id: message.id,
    author: crewaid.author === 'USER' ? 'USER' : crewaid.author === 'SYSTEM' ? 'SYSTEM' : 'BOT',
    parts: parts(message, related, live, approvals, demotePreTool),
    timeLabel: formatTimeLabel(createdAt),
    dateLabel: formatDateLabel(createdAt),
    createdAt: createdAt.getTime(),
    stopReason: crewaid.stopReason,
    ...(live ? { live: true as const } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(crewaid.taskId !== null ? { taskId: crewaid.taskId } : {}),
    ...(crewaid.chainId !== null ? { chainId: crewaid.chainId } : {}),
    ...(crewaid.startsTopic ? { startsTopic: true as const } : {}),
    ...(crewaid.author === 'BOT' && crewaid.fromBotId !== null && crewaid.fromBotId !== botId
      ? { fromBotId: crewaid.fromBotId }
      : {}),
  };
}
export function toTranscriptMessage(
  message: Message,
  botId: string,
  live = false,
): TranscriptMessage {
  return row(message, [], botId, live, Date.now());
}

/** Fold protocol reasoning/result fan-outs into the canonical assistant anchor. */
function groups(messages: readonly Message[]): Array<{ message: Message; related: Message[] }> {
  const rows: Array<{ message: Message; related: Message[] }> = [];
  const calls = new Map<string, { message: Message; related: Message[] }>();
  let reasoning: Message[] = [];
  const flushReasoning = () => {
    for (const message of reasoning) rows.push({ message, related: [] });
    reasoning = [];
  };
  for (const message of messages) {
    // Internal continuation notices add no action for the person. Suppress
    // stored notices as well as future ones, without hiding ordinary text.
    if (
      crewaidMetadataIn(message).author === 'SYSTEM' &&
      typeof message.content === 'string' &&
      /^Paused[^\n]*\. Still working — carrying on for (?:one more round|up to [\d,]+ more rounds)\.$/.test(
        message.content,
      )
    )
      continue;
    if (message.role === 'reasoning') {
      reasoning.push(message);
      continue;
    }
    if (message.role === 'tool') {
      const owner = calls.get(message.toolCallId);
      if (owner !== undefined) {
        owner.related.push(message);
        continue;
      }
    }
    if (message.role !== 'assistant') flushReasoning();
    const group = { message, related: message.role === 'assistant' ? reasoning : [] };
    reasoning = [];
    rows.push(group);
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? []) calls.set(call.id, group);
  }
  flushReasoning();
  return rows;
}
/** Whether an assistant step carries text a person would see as speech. */
function speaks(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    content(message).some(
      (part) => part.type === 'text' && projectPublicSpeech(String(part.text)).trim() !== '',
    )
  );
}

/**
 * Which tool-calling steps' text is working narration rather than the reply.
 *
 * Text written beside a tool call reads as "let me check…" only when the run
 * goes on to say something after it. When it does not — the run parked on an
 * approval, stopped at a limit, or the model ended on an empty step — that
 * text IS the reply, and hiding it would leave the person nothing to read.
 * While the exchange is still being produced, its steps count as narration;
 * a run that then ends without a later reply shows them again.
 */
function preToolNarration(
  grouped: ReadonlyArray<{ message: Message }>,
  generating: boolean,
): boolean[] {
  const demote = new Array<boolean>(grouped.length).fill(false);
  let saysLater = false;
  let openExchange = true;
  for (let index = grouped.length - 1; index >= 0; index -= 1) {
    const message = grouped[index]!.message;
    if (message.role === 'user') {
      saysLater = false;
      openExchange = false;
      continue;
    }
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      demote[index] = saysLater || (generating && openExchange);
    }
    if (speaks(message)) saysLater = true;
  }
  return demote;
}

export function createTranscriptProjection(botId: string) {
  const cached = new Map<string, { signature: string; row: TranscriptMessage }>();
  return (
    messages: readonly Message[],
    generating: boolean,
    approvals: readonly PendingApproval[] = [],
  ): TranscriptMessage[] => {
    const grouped = groups(messages);
    const narration = preToolNarration(grouped, generating);
    const ids = new Set(grouped.map(({ message }) => message.id));
    for (const id of cached.keys()) if (!ids.has(id)) cached.delete(id);
    return grouped.map(({ message, related }, index) => {
      const live =
        generating &&
        index === grouped.length - 1 &&
        (message.role === 'assistant' || message.role === 'reasoning');
      const demotePreTool = narration[index] === true;
      const signature = JSON.stringify([
        currentLocale(),
        message,
        related,
        live,
        demotePreTool,
        message.role === 'assistant'
          ? approvals.filter((approval) =>
              message.toolCalls?.some((call) => call.id === approval.toolCallId),
            )
          : [],
      ]);
      const previous = cached.get(message.id);
      if (previous?.signature === signature) return previous.row;
      const projected = row(
        message,
        related,
        botId,
        live,
        previous?.row.createdAt ?? Date.now(),
        approvals,
        demotePreTool,
      );
      cached.set(message.id, { signature, row: projected });
      return projected;
    });
  };
}
export function toTranscript(
  messages: readonly Message[],
  botId: string,
  generating: boolean,
): TranscriptMessage[] {
  return createTranscriptProjection(botId)(messages, generating);
}
