import { useLocale } from '../i18n/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import { useAguiChat } from './useAguiChat';
import type { Message } from '@ag-ui/core';
import type { ChatInterrupt } from './crewaidChat';
import { TargetRunChangedError } from './crewaidChat';
import type { CodingTaskProgress } from './codingProgress';
import {
  ApprovalBindingSchema,
  ToolApprovalRequestSchema,
  type BotThread,
  type Json,
  type MessageWithAttachments,
  type ServerFrame,
  type TranscriptAttachment,
} from '@crewaid/shared';

import type { ChatError, PendingApproval } from '../state/chatReducer';
import { findExchangeMessageId } from '../state/transcriptRows';
import type { ExchangeFocus } from '../state/useShellNavigation';
import type { TranscriptMessage } from '../state/viewTypes';
import { createTranscriptProjection, crewaidMetadataIn } from './uiMessage';
import type { ThreadPreviewCache } from './threadPreviewCache';
import { crewaidChat, createRunAnnouncements } from './crewaidChat';
import type { ChatEndpoint } from './chatEndpoint';
import { t } from '../i18n/i18n';

/**
 * The one place the standalone AG-UI chat client lives.
 *
 * `App` mounts this with `key={thread.id}`, and that key is load-bearing: the
 * hook preserves its messages across a client rebuild on purpose, so re-keying
 * it in place is exactly how one bot's conversation would leak into another's.
 * A key change unmounts and remounts, and the fresh client hydrates from the
 * server — which is correct rather than merely safe, because the server is the
 * authority for a thread's transcript and a run that was
 * produced while nobody watched is replayed in full from its durable log.
 *
 * A render prop rather than a wrapper around `Transcript`, so that the
 * transcript's props still have exactly one call site (`App`) and this file
 * does not become a second place that knows what a transcript needs.
 */

export type QueuedSendResult =
  | { readonly kind: 'sent'; readonly messageId: string }
  | { readonly kind: 'target-changed'; readonly activeRunId: string | null }
  | { readonly kind: 'failed' };

export type ChatThreadView = {
  readonly startedAt: number | undefined;
  readonly activeRunId: string | null;
  /** Resolved focus message id from either direct focus or a peer exchange jump. */
  readonly resolvedFocusMessageId: string | null;
  readonly messages: TranscriptMessage[];
  /** The first hydrate has landed, so an empty transcript means empty. */
  readonly historyLoaded: boolean;
  readonly hasOlderMessages: boolean;
  readonly loadingOlder: boolean;
  readonly olderHistoryError: string | null;
  readonly loadOlder: () => void;
  /** The thread is producing a run — this window's, or anyone's. */
  readonly generating: boolean;
  readonly error: ChatError | null;
  readonly retrying: boolean;
  readonly retry?: (() => void) | undefined;
  readonly approvals: readonly PendingApproval[];
  readonly codingProgress: ReadonlyMap<string, CodingTaskProgress>;
  readonly respondToApproval: (toolCallId: string, approved: boolean, editedArgs?: Json) => void;
  /** The stored message's id once it is admitted; null when it was refused. */
  readonly send: (
    text: string,
    attachmentIds: readonly string[],
    attachments?: readonly TranscriptAttachment[],
  ) => Promise<string | null>;
  /** Idempotent send for queued messages, optionally targeting a run to stop and preempt. */
  readonly sendQueued: (input: {
    readonly text: string;
    readonly attachmentIds: readonly string[];
    readonly messageId?: string | undefined;
    readonly interruptRunId?: string | undefined;
  }) => Promise<QueuedSendResult>;
  readonly stop: () => void;
  /** Put the `/new` boundary this window just created in the transcript. */
  readonly appendStoredRow: (row: MessageWithAttachments) => void;
  /**
   * The reply whose voice note arrived live in this window. Only a
   * reply heard as it lands plays by itself; one read from history waits.
   */
  readonly spokenReplyId: string | null;
};

export type ChatThreadProps = {
  readonly botId: string;
  readonly thread: BotThread;
  readonly endpoint: ChatEndpoint;
  readonly previewCache: ThreadPreviewCache;
  /** Subscribes to this bot's WebSocket frames, for the two the client is told about. */
  readonly onFrames: (botId: string, listener: (frame: ServerFrame) => void) => () => void;
  /** Ends the thread's run on the server. Closing a stream is not a cancel. */
  readonly onCancel: () => void;
  /**
   * A message the shell wants brought into view, from Work or search.
   *
   * Paging back to it belongs here because only this component knows what is
   * loaded. `onFocusUnreachable` says the search gave up — a message in a
   * deleted part of the history must not page the whole transcript in.
   */
  readonly focusMessageId?: string | null;
  readonly focusExchange?: ExchangeFocus | null;
  readonly onFocusUnreachable?: () => void;
  /**
   * Filled with this thread's send, for the shell's queue drain.
   *
   * The queue is the operator's drafts and is held per bot by the shell, which
   * outlives any one thread's client; a ref is how the shell reaches the
   * client that can actually send. Only the thread on screen has one, so a
   * queue is drained when its bot is being looked at.
   */
  readonly sendRef?: MutableRefObject<ChatThreadView['send'] | null>;
  readonly sendQueuedRef?: MutableRefObject<ChatThreadView['sendQueued'] | null>;
  /** Called once the thread can send — how the shell delivers a message it queued for this bot. */
  readonly onSendReady?: (send: ChatThreadView['send']) => void;
  /** Told when the thread starts and stops producing, for that same drain. */
  readonly onGeneratingChange?: (generating: boolean) => void;
  /** Told whenever the thread's active run id changes, for target-run-scoped interrupts. */
  readonly onActiveRunChange?: (runId: string | null) => void;
  /**
   * This window's client can no longer follow the thread, and must be
   * mounted again to read it from the server. The shell re-keys it.
   */
  readonly onStale?: () => void;
  /** Clears staged pending attachment chips when a failed send succeeds on retry. */
  readonly onRetryClaimedAttachments?: (attachmentIds: readonly string[]) => void;
  readonly children: (view: ChatThreadView) => ReactNode;
};

/** How far back a jump-to-message will page before it gives up. */
const MAX_FOCUS_PAGES = 20;

/**
 * One of this thread's pending interrupts, if it is the tool approval.
 *
 * Narrowed on the DEFINITION id rather than on `kind`: an AG-UI interrupt with
 * no binding this client registered is also `kind: 'generic'`, and resolving
 * one of those would send an answer nobody is waiting for.
 */
type ToolApprovalInterrupt = ChatInterrupt;

type MessageAttachmentsPayload = Extract<ServerFrame, { type: 'message.attachments' }>['payload'];

/**
 * The rows with a `message.attachments` frame's files on their message, or
 * null when this window does not hold that message (a page it never loaded)
 * or already shows every file.
 */
export function withAttachments(
  messages: readonly Message[],
  payload: MessageAttachmentsPayload,
): Message[] | null {
  const index = messages.findIndex((message) => message.id === payload.messageId);
  const target = messages[index];
  if (target === undefined) return null;
  // From the parsed metadata, not the raw object: a reply streamed in this
  // window carries none until a hydrate, and a partial `crewaid` would fail
  // the schema on the way back out and take the attachment with it.
  const crewaid = crewaidMetadataIn(target);
  const ids = new Set(crewaid.attachments.map((a) => a.id));
  const added = payload.attachments
    .filter((a) => !ids.has(a.id))
    .map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      kind: a.kind,
      durationMs: a.durationMs,
    }));
  if (added.length === 0) return null;
  const meta = (target as { metadata?: unknown }).metadata;
  const fields = typeof meta === 'object' && meta !== null ? meta : {};
  const next = [...messages];
  next[index] = {
    ...target,
    metadata: {
      ...fields,
      crewaid: { ...crewaid, attachments: [...crewaid.attachments, ...added] },
    },
  };
  return next;
}

/** A BOT row by this bot itself, rather than a teammate's delivered message. */
function isOwnReply(row: MessageWithAttachments, botId: string): boolean {
  return row.author === 'BOT' && (row.fromBotId === null || row.fromBotId === botId);
}

function isToolApproval(interrupt: { readonly kind: string }): interrupt is ToolApprovalInterrupt {
  return (
    interrupt.kind === 'generic' &&
    (interrupt as { definitionId?: unknown }).definitionId === 'crewaid.tool-approval'
  );
}

export function ChatThread(props: ChatThreadProps): ReactNode {
  const locale = useLocale();
  const { botId, thread, endpoint, previewCache, onFrames, onCancel, children } = props;
  const {
    focusMessageId,
    focusExchange,
    onFocusUnreachable,
    sendRef,
    sendQueuedRef,
    onGeneratingChange,
    onActiveRunChange,
    onStale,
  } = props;
  const onRetryClaimedAttachments = props.onRetryClaimedAttachments;
  // Latest callback, read when the thread becomes ready rather than on every render.
  const onSendReady = useRef(props.onSendReady);
  onSendReady.current = props.onSendReady;
  const [hydrated, setHydrated] = useState(false);
  const [preview] = useState(() => previewCache.read(endpoint, thread.id));

  // One per mounted thread, so the adapter and the frame reader agree about
  // which runs belong to it without either knowing the other.
  const announcements = useMemo(() => createRunAnnouncements(), []);
  const connection = useMemo(
    () =>
      crewaidChat({
        endpoint,
        threadId: thread.id,
        runs: announcements,
        onHydrated: () => setHydrated(true),
      }),
    [endpoint, thread.id, announcements],
  );

  const chat = useAguiChat(connection);
  const { setMessages, appendStored, sendMessage, retry: retryChat, stop: stopChat } = chat;

  /**
   * The WebSocket frames the chat client is told about.
   *
   * Everything else about this thread's transcript comes from the chat routes.
   * These are about the thread and belong to no run's log, so a frame is
   * the only live signal there is:
   *
   * - `run.started` is how a window joins a run it did not start —
   * a routine, a teammate, or a message answered after the turn that was
   * running when it was sent;
   * - `message.deleted` removes a canonical row or clears the chat;
   * - `message.created` is a stored row no run's log carries: a person's
   * message sent from Telegram or another window, a teammate's, a
   * routine's prompt, or the limit notice MOD-AI-17 posts between runs.
   * The bot's own reply is the one row its run streams, so it is left out;
   * - `message.attachments` is a spoken reply, synthesised after
   * its run ended, so it arrives after the run's log closed.
   */
  const appended = useRef(new Set<string>()).current;
  // The rows as last rendered. A frame lands between renders, so an append
  // reads the client's list back for the next frame in the same tick.
  const rendered = useRef(chat.messages);
  rendered.current = chat.messages;
  // Whether a question on screen is still this window's to answer.
  const asking = useRef(false);
  // The spoken reply that arrived while this thread was on screen, to play once.
  const [spokenReplyId, setSpokenReplyId] = useState<string | null>(null);
  const appendStoredRow = useCallback(
    (row: MessageWithAttachments) => {
      if (appended.has(row.id)) return;
      appended.add(row.id);
      if (rendered.current.some((message) => message.id === row.id)) return;
      // Set, never `append`: the client's `append` is a send, and streams a
      // run for whatever it was given. This row is already stored, and the
      // run it would start is refused (`/new` sends nothing, D-147).
      const message: Message = {
        id: row.id,
        // `ModelMessage` has no system role to carry a product row in, which
        // is the same reason the server's operator view reads one as an
        // assistant message: `metadata.crewaid.author` is what the transcript
        // reads, and it says SYSTEM.
        role: row.author === 'USER' ? 'user' : 'assistant',
        content: row.content,
        metadata: {
          tanstack: { createdAt: row.createdAt },
          crewaid: {
            author: row.author,
            fromBotId: row.fromBotId,
            runId: null,
            sequence: 0,
            stopReason: row.stopReason,
            taskId: row.taskId,
            routineId: row.routineId,
            chainId: row.chainId,
            hopCount: row.hopCount,
            startsTopic: row.startsTopic,
            attachments: row.attachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              kind: a.kind,
              durationMs: a.durationMs,
            })),
          },
        },
      };
      appendStored(message);
      rendered.current = connection.agent.messages;
    },
    [appended, appendStored, connection],
  );

  useEffect(
    () =>
      onFrames(botId, (frame) => {
        if (frame.type === 'run.started') {
          // A run starting while this window still shows a question it never
          // answered means it was answered somewhere else: the client only
          // clears an interrupt it resolved itself, so it would keep asking.
          // The server's hydrate is the record, so read it again. When the
          // question is in fact still open, the hydrate brings it back.
          if (asking.current && onStale !== undefined) {
            onStale();
            return;
          }
          announcements.announce(frame.payload.runId);
          return;
        }
        if (frame.type === 'message.deleted') {
          const removed = new Set(frame.payload.messageIds);
          rendered.current =
            frame.payload.cleared === true
              ? []
              : rendered.current.filter((message) => !removed.has(message.id));
          setMessages(rendered.current);
          return;
        }
        if (frame.type === 'message.attachments') {
          const merged = withAttachments(rendered.current, frame.payload);
          if (merged === null) return;
          rendered.current = merged;
          setMessages(rendered.current);
          if (frame.payload.attachments.some((a) => a.kind === 'VOICE_NOTE'))
            setSpokenReplyId(frame.payload.messageId);
          return;
        }
        if (frame.type === 'message.created' && !isOwnReply(frame.payload, botId))
          appendStoredRow(frame.payload);
      }),
    [botId, onFrames, announcements, setMessages, appendStoredRow, onStale],
  );

  /** What this window answered, until the thread's interrupts clear. */
  const [answered, setAnswered] = useState<Readonly<Record<string, 'approved' | 'declined'>>>({});

  const [submitted, setSubmitted] = useState<Readonly<Record<string, PendingApproval>>>({});

  const approvals = useMemo<readonly PendingApproval[]>(() => {
    const rows: PendingApproval[] = [];
    for (const interrupt of chat.interrupts) {
      if (!isToolApproval(interrupt)) continue;
      const parsed = ToolApprovalRequestSchema.safeParse(interrupt.payload);
      if (!parsed.success) continue;
      const binding = ApprovalBindingSchema.safeParse(parsed.data.binding);
      if (!binding.success) continue;
      const answer = interrupt.status === 'error' ? undefined : answered[parsed.data.toolCallId];
      rows.push({
        toolCallId: parsed.data.toolCallId,
        turnId: parsed.data.runId,
        toolName: parsed.data.toolName,
        args: parsed.data.args,
        binding: binding.data,
        ...(answer === undefined ? {} : { answered: answer }),
      });
    }
    // Submitting interrupts are temporarily omitted by the client. Keep their
    // cards mounted so a failed request preserves the operator's argument edits.
    if (chat.resuming) {
      for (const approval of Object.values(submitted))
        if (!rows.some((row) => row.toolCallId === approval.toolCallId)) rows.push(approval);
    }
    return rows;
  }, [chat.interrupts, chat.resuming, answered, submitted]);
  asking.current = approvals.some((approval) => approval.answered === undefined);

  const respondToApproval = useCallback(
    (toolCallId: string, approved: boolean, editedArgs?: Json) => {
      const match = chat.interrupts.find((interrupt) => {
        if (!isToolApproval(interrupt)) return false;
        const parsed = ToolApprovalRequestSchema.safeParse(interrupt.payload);
        return parsed.success && parsed.data.toolCallId === toolCallId;
      });
      if (match === undefined || !isToolApproval(match)) return;
      const approval = approvals.find((row) => row.toolCallId === toolCallId);
      if (approval !== undefined)
        setSubmitted((current) => ({
          ...Object.fromEntries(
            Object.entries(current).filter(([, row]) => row.turnId === approval.turnId),
          ),
          [toolCallId]: { ...approval, answered: approved ? 'approved' : 'declined' },
        }));
      setAnswered((current) => ({
        ...current,
        [toolCallId]: approved ? 'approved' : 'declined',
      }));
      match.resolveInterrupt({ approved, ...(editedArgs === undefined ? {} : { editedArgs }) });
    },
    [chat.interrupts, approvals],
  );

  const send = useCallback(
    async (
      text: string,
      attachmentIds: readonly string[],
      attachments?: readonly TranscriptAttachment[],
    ): Promise<string | null> => {
      try {
        return await sendMessage(text, {
          // The one key this server takes through `forwardedProps`.
          body: { attachmentIds: [...attachmentIds] },
          ...(attachments === undefined ? {} : { attachments }),
        });
      } catch {
        // The failure is on screen through `error`; the composer keeps its
        // chips, which is what the null is for.
        return null;
      }
    },
    [sendMessage],
  );

  const sendQueued = useCallback<ChatThreadView['sendQueued']>(
    async ({ text, attachmentIds, messageId, interruptRunId }) => {
      try {
        const id = await sendMessage(text, {
          body: {
            attachmentIds: [...attachmentIds],
            ...(interruptRunId === undefined ? {} : { interruptRunId }),
          },
          ...(messageId === undefined ? {} : { messageId }),
          ...(interruptRunId === undefined ? {} : { quietConflict: true }),
        });
        return { kind: 'sent', messageId: id };
      } catch (error) {
        if (error instanceof TargetRunChangedError) {
          return { kind: 'target-changed', activeRunId: error.activeRunId };
        }
        return { kind: 'failed' };
      }
    },
    [sendMessage],
  );

  const stop = useCallback(() => {
    // The frame is the authority: closing a stream is a disconnect, not
    // a cancel. `stop` then ends this window's read of a run that is ending.
    onCancel();
    stopChat();
  }, [onCancel, stopChat]);

  const project = useMemo(() => createTranscriptProjection(botId), [botId]);
  const messages = useMemo(
    () => project(chat.messages, chat.sessionGenerating || chat.isLoading, approvals),
    [chat.messages, project, chat.sessionGenerating, chat.isLoading, approvals, locale],
  );
  useEffect(() => {
    if (!hydrated || chat.sessionGenerating || chat.isLoading || chat.error !== undefined) return;
    previewCache.write(endpoint, thread.id, botId, messages);
  }, [
    hydrated,
    chat.sessionGenerating,
    chat.isLoading,
    chat.error,
    previewCache,
    endpoint,
    thread.id,
    botId,
    messages,
  ]);

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderHistoryError, setOlderHistoryError] = useState<string | null>(null);
  const olderInFlight = useRef(false);
  const loadOlder = useCallback(() => {
    if (!hydrated || !chat.hasOlderMessages || olderInFlight.current) return;
    olderInFlight.current = true;
    setLoadingOlder(true);
    setOlderHistoryError(null);
    void chat
      .loadOlderMessages()
      .catch(() => {
        setOlderHistoryError(t('chat.chatThread.earlierMessagesCouldNotLoad'));
      })
      .finally(() => {
        olderInFlight.current = false;
        setLoadingOlder(false);
      });
  }, [hydrated, chat.hasOlderMessages, chat.loadOlderMessages]);

  /**
   * Jump to a message older than the window that is painted: read one older
   * page at a time until it arrives, or give up after a bound. The transcript
   * brings it into view and clears the request once it is there.
   */
  const pagedFor = useRef<{ messageId: string; pages: number } | null>(null);
  useEffect(() => {
    if (focusMessageId === null || focusMessageId === undefined) {
      pagedFor.current = null;
      return;
    }
    if (!hydrated) return;
    if (loadingOlder || olderHistoryError !== null) return;
    if (chat.messages.some((message) => message.id === focusMessageId)) return;
    const paged =
      pagedFor.current?.messageId === focusMessageId
        ? pagedFor.current
        : { messageId: focusMessageId, pages: 0 };
    if (!chat.hasOlderMessages || paged.pages >= MAX_FOCUS_PAGES) {
      pagedFor.current = null;
      onFocusUnreachable?.();
      return;
    }
    pagedFor.current = { messageId: focusMessageId, pages: paged.pages + 1 };
    loadOlder();
  }, [
    focusMessageId,
    hydrated,
    chat,
    onFocusUnreachable,
    loadOlder,
    loadingOlder,
    olderHistoryError,
  ]);

  const resolvedExchangeId = useMemo(
    () => (focusExchange == null ? null : findExchangeMessageId(messages, focusExchange)),
    [focusExchange, messages],
  );
  const resolvedFocusMessageId = focusMessageId ?? resolvedExchangeId;

  const pagedForExchange = useRef<{ key: string; pages: number } | null>(null);
  useEffect(() => {
    if (focusExchange == null || focusMessageId != null) {
      pagedForExchange.current = null;
      return;
    }
    if (!hydrated || loadingOlder || olderHistoryError !== null) return;
    if (resolvedExchangeId !== null) return;
    const key = `${focusExchange.botId}:${focusExchange.timestamp}:${focusExchange.excerpt.slice(0, 24)}`;
    const paged =
      pagedForExchange.current?.key === key ? pagedForExchange.current : { key, pages: 0 };
    if (!chat.hasOlderMessages || paged.pages >= MAX_FOCUS_PAGES) {
      pagedForExchange.current = null;
      onFocusUnreachable?.();
      return;
    }
    pagedForExchange.current = { key, pages: paged.pages + 1 };
    loadOlder();
  }, [
    focusExchange,
    focusMessageId,
    hydrated,
    loadingOlder,
    olderHistoryError,
    resolvedExchangeId,
    chat.hasOlderMessages,
    onFocusUnreachable,
    loadOlder,
  ]);

  // The shell's queue drain reaches this thread's send through the ref it
  // owns. Cleared on unmount, so a drain can never reach a dead client.
  useEffect(() => {
    if (hydrated) onSendReady.current?.(send);
  }, [hydrated, send]);
  useEffect(() => {
    if (sendRef === undefined) return;
    sendRef.current = send;
    return () => {
      sendRef.current = null;
    };
  }, [sendRef, send]);
  useEffect(() => {
    if (sendQueuedRef === undefined) return;
    sendQueuedRef.current = sendQueued;
    return () => {
      sendQueuedRef.current = null;
    };
  }, [sendQueuedRef, sendQueued]);

  const generating = chat.sessionGenerating || chat.isLoading;
  useEffect(() => {
    onGeneratingChange?.(generating);
    // A thread that unmounts while producing must not leave the shell holding
    // "it is working" for a client that no longer exists.
    return () => onGeneratingChange?.(false);
  }, [generating, onGeneratingChange]);
  useEffect(() => {
    onActiveRunChange?.(chat.activeRunId);
    return () => onActiveRunChange?.(null);
  }, [chat.activeRunId, onActiveRunChange]);

  // The client's error is already the person's sentence — the server's
  // for a run, `chatFailure.ts`'s for this window's own round trips. Replacing
  // it here is how "your key was rejected" used to reach them as "something
  // went wrong".
  const error: ChatError | null = chat.error ?? null;
  const retry = useCallback(() => {
    void retryChat().then((claimed) => {
      if (claimed !== null && claimed.length > 0) onRetryClaimedAttachments?.(claimed);
    });
  }, [retryChat, onRetryClaimedAttachments]);

  return children({
    startedAt: chat.startedAt,
    activeRunId: chat.activeRunId,
    resolvedFocusMessageId,
    messages: hydrated || chat.messages.length > 0 ? messages : (preview ?? messages),
    historyLoaded: hydrated || preview !== null,
    // A preview may paint before hydration's callback enables paging. Do not
    // let its viewport spend the one automatic fill on a disabled request.
    hasOlderMessages: hydrated && chat.hasOlderMessages,
    loadingOlder,
    olderHistoryError,
    loadOlder,
    generating,
    error,
    retrying: chat.retrying,
    ...(chat.canRetry ? { retry } : {}),
    approvals,
    codingProgress: chat.codingProgress,
    respondToApproval,
    send,
    sendQueued,
    stop,
    appendStoredRow,
    spokenReplyId,
  });
}
