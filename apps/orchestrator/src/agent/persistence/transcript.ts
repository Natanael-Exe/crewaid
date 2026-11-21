import { createHash, randomUUID } from 'node:crypto';
import type { AgentTurn, Message, MessageAuthor, Prisma, RunInterrupt } from '@prisma/client';
import type { ModelMessage, RunRecord } from '@tanstack/ai';
import { parseRunUsage } from './run-usage.js';
import type { InterruptRecord } from '@tanstack/ai-persistence';
import {
  JsonSchema,
  type CrewaidMessageMetadata,
  type Json,
  type TranscriptAttachment,
} from '@crewaid/shared';
import { z } from 'zod';

/**
 * The one validating mapper between Crewaid's rows and the library's
 * records.
 *
 * A thread's canonical transcript is the library's `ModelMessage[]`, one
 * `Message` row each. The row keeps what the product needs
 * (author, provenance, order, read state) in columns; `parts` keeps the one
 * message body the model saw. Everything that crosses between the two goes
 * through a `safeParse` here, and nothing is cast: a row that does not fit is
 * a contract violation reported to the caller, never a value assumed to fit.
 *
 * Runs and interrupts cross here too, so that the stores MOD-AI-04 and
 * MOD-AI-06 build share one reading of every column.
 */

const ToolCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1), arguments: z.string() }).strict(),
    encryptedValue: z.string().optional(),
    // Provider state a call must carry into the next request, such as a
    // thought signature. Opaque, but JSON.
    metadata: z.record(z.string(), JsonSchema).optional(),
  })
  .strict();

/**
 * The library's own metadata, and nothing else. `metadata.tanstack` carries
 * the run tag `withPersistence` puts on an assistant message (`run.id`, which
 * reload needs to match a message to its run) and a tool result's outcome.
 * Saves come from the server's run, never from a client, so this is the
 * library's state rather than anyone's claim.
 */
const LibraryMetadataSchema = z.object({ tanstack: z.record(z.string(), JsonSchema) }).strict();

const ThinkingSchema = z
  .object({
    content: z.string(),
    signature: z.string().optional(),
    redacted: z.boolean().optional(),
  })
  .strict();

/**
 * What `Message.parts` holds: a `ModelMessage` without its identity (the row
 * id) or its time (the row's).
 *
 * Strict, so a field the library adds later is refused loudly here rather
 * than dropped silently on the way to the database.
 *
 * - A user message is text. Attachments are rows that point at it, turned
 * into parts for the model at call time, so no bytes are
 * stored in the transcript.
 * - Only the library's `metadata.tanstack` is stored. Any other key is
 * dropped: a client's metadata is not trusted, and what the product knows
 * about a message lives in columns, projected on read (`crewaidMetadataOf`).
 */
export const TranscriptBodySchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('user'),
      content: z.string(),
      name: z.string().optional(),
      metadata: LibraryMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().nullable(),
      name: z.string().optional(),
      toolCalls: z.array(ToolCallSchema).min(1).optional(),
      thinking: z.array(ThinkingSchema).min(1).optional(),
      metadata: LibraryMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      content: z.string(),
      toolCallId: z.string().min(1),
      error: z.string().optional(),
      metadata: LibraryMetadataSchema.optional(),
    })
    .strict(),
]);
export type TranscriptBody = z.infer<typeof TranscriptBodySchema>;

/** Why a row or a message could not cross. Each is a contract violation, not a user error. */
export type TranscriptViolation =
  | { readonly kind: 'missing-id' }
  | { readonly kind: 'unreadable-body'; readonly detail: string }
  | { readonly kind: 'author-mismatch'; readonly author: MessageAuthor; readonly role: string }
  | { readonly kind: 'run-mismatch'; readonly tagged: string; readonly runId: string };

export type TranscriptResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violation: TranscriptViolation };

/** Who wrote a model message, which the body alone cannot say. */
export type TranscriptProvenance = {
  /** The bot whose thread this is. */
  readonly threadBotId: string;
  /** The run that wrote an assistant or tool message; null for a user message. */
  readonly runId: string | null;
  /**
   * Set for a user-role message another bot sent (the `send_message`).
   * Its row is BOT-authored, as today, and the model reads it as a user turn.
   */
  readonly senderBotId?: string | null | undefined;
};

/** The columns one model message writes. The caller adds the thread and product columns. */
export type TranscriptRowWrite = {
  readonly id: string;
  readonly author: MessageAuthor;
  readonly fromBotId: string | null;
  readonly runId: string | null;
  /** Plain text, for search, excerpts and the unread count. */
  readonly content: string;
  readonly parts: Prisma.InputJsonObject;
};

/** A model message as rows store it. */
export function toTranscriptRow(
  message: ModelMessage,
  provenance: TranscriptProvenance,
): TranscriptResult<TranscriptRowWrite> {
  if (message.id === undefined || message.id === '') {
    return { ok: false, violation: { kind: 'missing-id' } };
  }
  const parsed = TranscriptBodySchema.safeParse(bodyOf(message));
  if (!parsed.success) {
    return { ok: false, violation: { kind: 'unreadable-body', detail: parsed.error.message } };
  }
  const body = parsed.data;
  const sender = provenance.senderBotId ?? null;
  if (sender !== null && body.role !== 'user') {
    return {
      ok: false,
      violation: { kind: 'author-mismatch', author: 'BOT', role: body.role },
    };
  }
  // The library tags an assistant message with the run that wrote it; the
  // column must say the same run, or reload would pair it with another.
  const tagged = runTagOf(body);
  if (tagged !== undefined && provenance.runId !== null && tagged !== provenance.runId) {
    return { ok: false, violation: { kind: 'run-mismatch', tagged, runId: provenance.runId } };
  }
  return {
    ok: true,
    value: {
      id: message.id,
      author: body.role === 'tool' ? 'TOOL' : body.role === 'assistant' || sender ? 'BOT' : 'USER',
      fromBotId: body.role === 'user' ? sender : provenance.threadBotId,
      runId: body.role === 'user' ? null : (tagged ?? provenance.runId),
      content: body.content ?? '',
      parts: toInputJsonObject(body),
    },
  };
}

/**
 * A stored row as the model reads it, or `null` for a product row (a SYSTEM
 * notice or a `/new` boundary), which the model never sees.
 */
export function fromTranscriptRow(
  row: Pick<Message, 'id' | 'author' | 'fromBotId' | 'runId' | 'parts' | 'createdAt'>,
  threadBotId: string,
): TranscriptResult<ModelMessage | null> {
  if (row.author === 'SYSTEM') return { ok: true, value: null };
  const parsed = TranscriptBodySchema.safeParse(row.parts);
  if (!parsed.success) {
    return { ok: false, violation: { kind: 'unreadable-body', detail: parsed.error.message } };
  }
  const body = parsed.data;
  if (!authorFits(row.author, row.fromBotId, threadBotId, body.role)) {
    return {
      ok: false,
      violation: { kind: 'author-mismatch', author: row.author, role: body.role },
    };
  }
  const tagged = runTagOf(body);
  if (tagged !== undefined && row.runId !== null && tagged !== row.runId)
    return { ok: false, violation: { kind: 'run-mismatch', tagged, runId: row.runId } };
  const message = modelMessageOf(body);
  if (body.role === 'assistant' && tagged === undefined && row.runId !== null) {
    message.metadata = {
      ...message.metadata,
      tanstack: { ...body.metadata?.tanstack, run: { id: row.runId } },
    };
  }
  return { ok: true, value: { ...message, id: row.id, createdAt: row.createdAt } };
}

/**
 * Which authors may carry which role. A BOT row is the thread's own bot
 * speaking, or another bot's message, which the model reads as a user turn.
 */
function authorFits(
  author: MessageAuthor,
  fromBotId: string | null,
  threadBotId: string,
  role: TranscriptBody['role'],
): boolean {
  switch (author) {
    case 'USER':
      return role === 'user';
    case 'TOOL':
      return role === 'tool';
    case 'BOT':
      return fromBotId === threadBotId ? role === 'assistant' : role === 'user';
    case 'SYSTEM':
      return false;
  }
}

/** The body fields of a `ModelMessage`, with absent fields left out rather than undefined. */
function bodyOf(message: ModelMessage): Record<string, unknown> {
  const body: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.name !== undefined) body['name'] = message.name;
  if (message.toolCalls !== undefined) body['toolCalls'] = message.toolCalls;
  if (message.toolCallId !== undefined) body['toolCallId'] = message.toolCallId;
  if (message.thinking !== undefined) body['thinking'] = message.thinking;
  if (message.error !== undefined) body['error'] = message.error;
  if (message.structuredOutput !== undefined) body['structuredOutput'] = message.structuredOutput;
  const tanstack: unknown = message.metadata?.['tanstack'];
  if (typeof tanstack === 'object' && tanstack !== null) body['metadata'] = { tanstack };
  return body;
}

/** `metadata.tanstack.run.id`, the run `withPersistence` tagged a message with. */
function runTagOf(body: TranscriptBody): string | undefined {
  const run = body.metadata?.tanstack['run'];
  if (typeof run !== 'object' || run === null || Array.isArray(run)) return undefined;
  const id = run['id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Give every message of a save a stable id, so a later save of the same run
 * updates its rows rather than adding new ones.
 *
 * The engine names an assistant message after its stream, but a tool result
 * has no id, and neither has the text it records at an interrupt. Those get
 * an id derived from what they are, so the same message saved twice is named
 * the same way twice:
 *
 * - a tool result, from its thread, call's originating run and call id. Within a run a call id
 * is unique; across runs it need not be, because some providers number
 * their calls from zero every time.
 * - an assistant message, from its thread, run and body, plus how many
 * identical bodies came before it in the same save.
 *
 * A user message always has an id: the route that admits it assigns one.
 */
export function assignTranscriptIds(
  messages: readonly ModelMessage[],
  scope: { readonly threadId: string; readonly runId: string | null },
): TranscriptResult<ModelMessage[]> {
  const seen = new Map<string, number>();
  const named: ModelMessage[] = [];
  for (const message of messages) {
    if (message.id !== undefined && message.id !== '') {
      named.push(message);
      continue;
    }
    if (message.role === 'user' || scope.runId === null) {
      return { ok: false, violation: { kind: 'missing-id' } };
    }
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || message.toolCallId === '') {
        return { ok: false, violation: { kind: 'missing-id' } };
      }
      const caller = named.findLast(
        (prior) =>
          prior.role === 'assistant' &&
          prior.toolCalls?.some((call) => call.id === message.toolCallId),
      );
      const body =
        caller === undefined ? undefined : TranscriptBodySchema.safeParse(bodyOf(caller));
      const originatingRun = body?.success ? runTagOf(body.data) : undefined;
      named.push({
        ...message,
        id: toolResultMessageId(scope.threadId, originatingRun ?? scope.runId, message.toolCallId),
      });
      continue;
    }
    const key = digest(scope.threadId, scope.runId, JSON.stringify(bodyOf(message)));
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    named.push({ ...message, id: `ta_${digest(key, String(occurrence))}` });
  }
  return { ok: true, value: named };
}

/**
 * The canonical id of one tool result row: its thread, the run whose assistant
 * message made the call, and the call id, which is unique within a run.
 *
 * Exported because an attachment a tool produces claims this row, and
 * two derivations of the same id would be two rows the first time they
 * disagreed.
 */
export function toolResultMessageId(threadId: string, runId: string, toolCallId: string): string {
  return `tr_${digest(threadId, runId, toolCallId)}`;
}

/**
 * The columns one out-of-request trigger writes.
 *
 * The row is a model message, so it carries the validated body and an id
 * minted here — the mapper needs one, and Prisma's default would only arrive
 * after the body had to be built.
 *
 * One function for all three triggers (a routine's prompt, a teammate's
 * delivery, a Work brief), so there is one answer to what a trigger row looks
 * like rather than three. The product columns — `routineId`, `taskId`, the
 * chain — are the caller's.
 */
export function triggerRowColumns(
  threadBotId: string,
  content: string,
  senderBotId?: string,
): Prisma.MessageUncheckedCreateWithoutConversationInput {
  const row = toTranscriptRow(
    { id: newTranscriptMessageId(), role: 'user', content },
    { threadBotId, runId: null, ...(senderBotId !== undefined && { senderBotId }) },
  );
  // Unreachable: a `user` body is any string, and the id is minted above.
  if (!row.ok) throw new Error(`A trigger row could not be built: ${row.violation.kind}`);
  return { ...row.value };
}

/**
 * An id for a trigger row the server is about to write.
 *
 * The mapper needs an id before the row exists, so Prisma's default cannot
 * supply it. Random rather than derived: two identical briefs for the same
 * task, minutes apart, are two messages, and a digest of what they say would
 * make the second one a collision.
 */
export function newTranscriptMessageId(): string {
  return `tm_${randomUUID().replaceAll('-', '')}`;
}

/** 40 hex characters of sha256 over the parts, so a prefixed id fits `CuidSchema`. */
function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);
}

function modelMessageOf(body: TranscriptBody): ModelMessage {
  switch (body.role) {
    case 'user':
      return {
        role: 'user',
        content: body.content,
        ...optional('name', body.name),
        ...optional('metadata', body.metadata),
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: body.content,
        ...optional('name', body.name),
        ...optional('toolCalls', body.toolCalls?.map(toolCallOf)),
        ...optional('thinking', body.thinking?.map(thinkingOf)),
        ...optional('metadata', body.metadata),
      };
    case 'tool':
      return {
        role: 'tool',
        content: body.content,
        toolCallId: body.toolCallId,
        ...optional('error', body.error),
        ...optional('metadata', body.metadata),
      };
  }
}

type StoredToolCall = z.infer<typeof ToolCallSchema>;
type ModelToolCall = NonNullable<ModelMessage['toolCalls']>[number];

function toolCallOf(call: StoredToolCall): ModelToolCall {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.function.name, arguments: call.function.arguments },
    ...optional('encryptedValue', call.encryptedValue),
    ...optional('metadata', call.metadata),
  };
}

function thinkingOf(
  block: z.infer<typeof ThinkingSchema>,
): NonNullable<ModelMessage['thinking']>[number] {
  return {
    content: block.content,
    ...optional('signature', block.signature),
    ...optional('redacted', block.redacted),
  };
}

/** `{ [key]: value }` when the value is present, `{}` when not: exactOptionalPropertyTypes. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) return {};
  const out: { [P in K]?: V } = {};
  out[key] = value;
  return out;
}

/**
 * A validated body as Prisma's write type. Rebuilt rather than cast: the
 * shared `Json` union and Prisma's input type disagree about a top-level null,
 * and a body is never null.
 */
function toInputJsonObject(body: TranscriptBody): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) out[key] = toInputJson(JsonSchema.parse(value));
  }
  return out;
}

function toInputJson(value: Json): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(toInputJson);
  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toInputJson(entry);
    return out;
  }
  return value;
}

// Product facts, projected on read

/**
 * What a client is told about a message beyond the model's view of it, under
 * `metadata.crewaid`. Read from columns; never written from a
 * client's metadata. The wire shape itself is
 * `CrewaidMessageMetadataSchema` in `packages/shared`, which both ends parse.
 *
 * The attachments are projected whole, not as ids. A card needs a name,
 * a type and a size, there is no route that reads one attachment, and the read
 * that builds this already holds the rows.
 */
export function crewaidMetadataOf(
  row: Pick<
    Message,
    | 'author'
    | 'fromBotId'
    | 'runId'
    | 'sequence'
    | 'stopReason'
    | 'taskId'
    | 'routineId'
    | 'chainId'
    | 'hopCount'
    | 'startsTopic'
  >,
  attachments: readonly TranscriptAttachment[],
): CrewaidMessageMetadata {
  return {
    author: row.author,
    fromBotId: row.fromBotId,
    runId: row.runId,
    sequence: row.sequence,
    stopReason: row.stopReason,
    taskId: row.taskId,
    routineId: row.routineId,
    chainId: row.chainId,
    hopCount: row.hopCount,
    startsTopic: row.startsTopic,
    attachments: [...attachments],
  };
}

/** The columns `fromTranscriptRowForOperator` reads. */
export type OperatorRow = Pick<
  Message,
  | 'id'
  | 'author'
  | 'fromBotId'
  | 'runId'
  | 'content'
  | 'parts'
  | 'createdAt'
  | 'sequence'
  | 'stopReason'
  | 'taskId'
  | 'routineId'
  | 'chainId'
  | 'hopCount'
  | 'startsTopic'
>;

/**
 * A stored row as the OPERATOR reads it.
 *
 * `fromTranscriptRow` reads a thread for the model, which is a different
 * conversation from the one a person sees: it drops the SYSTEM notices and
 * `/new` boundaries the model must not be told about, reads a teammate's
 * message as a plain `user` turn, and carries none of the product facts a
 * transcript renders. A hydrate goes through the same store, so without this
 * the renderer would be handed the model's view and would be missing its
 * notices, its dividers, its teammate attribution, its unfinished-reply
 * reasons and its attachments.
 *
 * Two things make a row readable by a person rather than by a provider:
 *
 *   - every message carries `metadata.crewaid`, the §3.4 projection, which is
 *     the renderer's ONLY source for a message's author;
 *   - a product row is kept rather than dropped.
 *
 * A product row is carried as `role: 'assistant'` because `ModelMessage` has no
 * system role to put it in, and the library only reconstructs here — the write
 * authorities are refused on this store. `metadata.crewaid.author` is what the
 * renderer reads, and it says `SYSTEM`, so the role never reaches a reader's
 * eye. A row with any other author still goes through the model's reader, so a
 * body that cannot be read is still a contract violation rather than a notice.
 */
export function fromTranscriptRowForOperator(
  row: OperatorRow,
  threadBotId: string,
  attachments: readonly TranscriptAttachment[],
): TranscriptResult<ModelMessage> {
  const crewaid = crewaidMetadataOf(row, attachments);
  if (row.author === 'SYSTEM') {
    return {
      ok: true,
      value: {
        id: row.id,
        role: 'assistant',
        content: row.content,
        createdAt: row.createdAt,
        metadata: { crewaid },
      },
    };
  }
  const read = fromTranscriptRow(row, threadBotId);
  if (!read.ok) return read;
  // Unreachable: `fromTranscriptRow` answers null for SYSTEM rows alone, and
  // this one is not one. Reported rather than assumed away.
  if (read.value === null)
    return { ok: false, violation: { kind: 'unreadable-body', detail: 'no model message' } };
  return { ok: true, value: { ...read.value, metadata: { ...read.value.metadata, crewaid } } };
}

// Runs

/**
 * An `AgentTurn` row as the library's run record. "Never set" stays absent,
 * distinct from `false` and `0`.
 *
 * A failed run's error carries its code and a sentence built from the code,
 * never a vendor's text.
 */
export function toRunRecord(row: AgentTurn): RunRecord {
  const usage =
    row.usage !== null
      ? parseRunUsage(row.usage)
      : row.inputTokens + row.outputTokens + row.cachedInputTokens + row.cacheCreationTokens > 0
        ? {
            promptTokens: row.inputTokens,
            completionTokens: row.outputTokens,
            totalTokens: row.inputTokens + row.outputTokens,
            promptTokensDetails: {
              cachedTokens: row.cachedInputTokens,
              cacheWriteTokens: row.cacheCreationTokens,
            },
          }
        : undefined;
  return {
    runId: row.id,
    threadId: row.conversationId,
    status: row.status,
    startedAt: row.startedAt.getTime(),
    ...optional('finishedAt', row.endedAt?.getTime()),
    ...optional(
      'error',
      row.errorCode === null && row.errorMessage === null
        ? undefined
        : {
            ...optional('code', row.errorCode ?? undefined),
            message: row.errorMessage ?? `the run failed: ${row.errorCode}`,
          },
    ),
    ...optional('usage', usage),
    ...optional('sandboxKey', row.sandboxKey ?? undefined),
    ...optional('detachedSince', row.detachedSince?.getTime()),
    ...optional('cancelRequested', row.cancelRequested ?? undefined),
    ...optional('driverEpoch', row.driverEpoch ?? undefined),
  };
}

// Interrupts

const InterruptPayloadSchema = z.record(z.string(), JsonSchema);

/** A `RunInterrupt` row as the library's interrupt record. */
export function toInterruptRecord(row: RunInterrupt): TranscriptResult<InterruptRecord> {
  if (
    !row.nativeInterruptId ||
    row.nativeStatus === null ||
    row.nativeRequestedAt === null ||
    (row.nativeStatus === 'pending') !== (row.nativeResolvedAt === null)
  )
    return {
      ok: false,
      violation: { kind: 'unreadable-body', detail: 'Incomplete native interrupt.' },
    };
  const payload = InterruptPayloadSchema.safeParse(row.nativePayload);
  if (!payload.success) {
    return { ok: false, violation: { kind: 'unreadable-body', detail: payload.error.message } };
  }
  const response =
    row.nativeResponse === null
      ? undefined
      : z.object({ value: JsonSchema }).strict().safeParse(row.nativeResponse);
  if (response !== undefined && !response.success)
    return {
      ok: false,
      violation: { kind: 'unreadable-body', detail: 'Unreadable native response.' },
    };
  return {
    ok: true,
    value: {
      interruptId: row.nativeInterruptId,
      runId: row.runId,
      threadId: row.conversationId,
      status: row.nativeStatus,
      requestedAt: row.nativeRequestedAt.getTime(),
      ...optional('resolvedAt', row.nativeResolvedAt?.getTime()),
      payload: payload.data,
      ...(response?.success ? { response: response.data.value } : {}),
    },
  };
}
