import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TranscriptAttachment } from '@crewaid/shared';
import { ApiRequestError, deleteAttachment, uploadAttachment, type ApiClient } from '../api';
import type { ChatThreadView } from '../chat/ChatThread';
import {
  normalizeAttachmentError,
  pendingAdded,
  pendingRemoved,
  pendingStatus,
  toAttachmentError,
  validateFile,
  type PendingAttachment,
  type PendingMap,
} from '../components/attachments/attachmentState';
import {
  editQueued,
  enqueue,
  moveQueued,
  nextDrain,
  nextLocalId,
  queueOf,
  readPersistedQueues,
  removeQueued,
  setQueuedNotice,
  writePersistedQueues,
  type MessageQueues,
  type QueuedMessage,
} from '../state/messageQueue';
import { t } from '../i18n/i18n';

const QUEUE_STORAGE_KEY = 'crewaid.queued-messages';

function queueStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Drop exactly the chips a send claimed. `attachmentIds` are remote ids while
 * the pending tray is keyed by client-local ids.
 */
function claimedRemoved(list: PendingMap, claimedIds: readonly string[]): PendingMap {
  if (claimedIds.length === 0) return list;
  const claimed = new Set(claimedIds);
  let next = list;
  for (const item of Object.values(list)) {
    if (item.remoteId !== undefined && claimed.has(item.remoteId)) {
      next = pendingRemoved(next, item.localId);
    }
  }
  return next;
}

export interface UseMessageQueueOptions {
  readonly client: ApiClient;
  readonly selectedId: string | null;
}

export interface MessageQueueController {
  readonly threadSend: RefObject<ChatThreadView['send'] | null>;
  readonly threadSendQueued: RefObject<ChatThreadView['sendQueued'] | null>;
  readonly threadGenerating: boolean;
  readonly threadStartedAt: number | null;
  readonly interruptingId: string | null;
  readonly noteGenerating: (generating: boolean) => void;
  readonly noteActiveRun: (runId: string | null) => void;
  readonly pending: PendingAttachment[];
  readonly stageFiles: (files: File[]) => void;
  readonly removePending: (localId: string) => void;
  readonly retryPending: (localId: string) => void;
  readonly claimPending: (attachmentIds: readonly string[]) => void;
  readonly queuedFor: (botId: string) => readonly QueuedMessage[];
  readonly postMessageId: (
    text: string,
    attachmentIds: readonly string[],
    attachments?: readonly TranscriptAttachment[],
  ) => Promise<string | null>;
  readonly postMessage: (
    text: string,
    attachmentIds: readonly string[],
    attachments?: readonly TranscriptAttachment[],
  ) => Promise<boolean>;
  readonly queueMessage: (botId: string, text: string, attachmentIds: readonly string[]) => void;
  readonly queueOrSend: (botId: string, text: string, attachmentIds: readonly string[]) => void;
  readonly editQueuedMessage: (botId: string, localId: string, text: string) => void;
  readonly removeQueuedMessage: (botId: string, localId: string) => void;
  readonly sendQueuedNow: (botId: string, localId: string) => void;
  readonly moveQueuedMessage: (botId: string, from: number, to: number) => void;
}

/**
 * Owns staged attachment uploads, per-bot client-side message queues, the
 * single-message drain loop, and thread send coordination.
 */
export function useMessageQueue({
  client,
  selectedId,
}: UseMessageQueueOptions): MessageQueueController {
  const [pending, setPending] = useState<PendingMap>({});
  // Held outside the chat reducer and persisted in sessionStorage so queued
  // messages and their target run survive bot switches and reconnects.
  const [queues, setQueues] = useState<MessageQueues>(() =>
    readPersistedQueues(queueStorage(), QUEUE_STORAGE_KEY),
  );
  useEffect(() => {
    writePersistedQueues(queueStorage(), QUEUE_STORAGE_KEY, queues);
  }, [queues]);
  // Ref keeps one stable map across renders so abort and upload always agree.
  const aborters = useRef(new Map<string, AbortController>()).current;
  const held = useRef(new Set<string>()).current;

  const threadSend = useRef<ChatThreadView['send'] | null>(null);
  const threadSendQueued = useRef<ChatThreadView['sendQueued'] | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const [threadGenerating, setThreadGenerating] = useState(false);
  // Local timestamp when the user clicked Send, before server status frames arrive.
  const [threadStartedAt, setThreadStartedAt] = useState<number | null>(null);
  const [interruptingId, setInterruptingId] = useState<string | null>(null);

  const noteGenerating = useCallback((generating: boolean) => {
    setThreadGenerating(generating);
    setThreadStartedAt((current) => (generating ? (current ?? Date.now()) : null));
  }, []);

  const noteActiveRun = useCallback((runId: string | null) => {
    activeRunIdRef.current = runId;
  }, []);

  const postMessageId = useCallback(
    (
      text: string,
      attachmentIds: readonly string[],
      attachments?: readonly TranscriptAttachment[],
    ): Promise<string | null> => {
      const send = threadSend.current;
      // Only the mounted thread on screen has a live chat client.
      if (send === null) return Promise.resolve(null);
      return send(text, attachmentIds, attachments).then((id) => {
        // Remove only the claimed remote ids so chips still uploading stay visible.
        if (id !== null) setPending((list) => claimedRemoved(list, [...attachmentIds]));
        return id;
      });
    },
    [],
  );

  const postMessage = useCallback(
    (
      text: string,
      attachmentIds: readonly string[],
      attachments?: readonly TranscriptAttachment[],
    ): Promise<boolean> =>
      postMessageId(text, attachmentIds, attachments).then((id) => id !== null),
    [postMessageId],
  );

  // Drain one queued message at a time once the visible bot stops generating.
  // `held` prevents duplicate POSTs across renders and stops retry storms on failure
  // until the operator edits, reorders, or re-sends the queue.
  useEffect(() => {
    const next = nextDrain(queues, (botId) => botId !== selectedId || threadGenerating, held);
    if (next === undefined) return;
    const { botId, message } = next;
    held.add(botId);
    const sendQueued = threadSendQueued.current;
    const attempt =
      sendQueued !== null
        ? sendQueued({
            text: message.text,
            attachmentIds: message.attachmentIds,
            messageId: message.messageId,
          }).then((result) => {
            if (result.kind === 'sent') {
              setPending((list) => claimedRemoved(list, [...message.attachmentIds]));
              return true;
            }
            return false;
          })
        : postMessage(message.text, message.attachmentIds);
    void attempt.then((sent) => {
      if (!sent) return;
      held.delete(botId);
      setQueues((current) => removeQueued(current, botId, message.localId));
    });
  }, [queues, selectedId, threadGenerating, postMessage, held]);

  // Any operator edit to a bot's queue lifts a prior failure hold.
  const updateQueues = useCallback(
    (botId: string, change: (current: MessageQueues) => MessageQueues) => {
      held.delete(botId);
      setQueues(change);
    },
    [held],
  );

  const queueMessage = useCallback(
    (botId: string, text: string, attachmentIds: readonly string[]) => {
      updateQueues(botId, (current) =>
        enqueue(current, botId, {
          localId: nextLocalId(),
          messageId: crypto.randomUUID(),
          targetRunId: botId === selectedId ? activeRunIdRef.current : null,
          text,
          attachmentIds,
        }),
      );
    },
    [selectedId, updateQueues],
  );

  const queueOrSend = useCallback(
    (botId: string, text: string, attachmentIds: readonly string[]) => {
      if (botId !== selectedId || threadGenerating) {
        queueMessage(botId, text, attachmentIds);
      } else {
        void postMessage(text, attachmentIds);
      }
    },
    [selectedId, threadGenerating, queueMessage, postMessage],
  );

  const editQueuedMessage = useCallback(
    (botId: string, localId: string, text: string) => {
      updateQueues(botId, (current) => editQueued(current, botId, localId, text));
    },
    [updateQueues],
  );

  const removeQueuedMessage = useCallback(
    (botId: string, localId: string) => {
      updateQueues(botId, (current) => removeQueued(current, botId, localId));
    },
    [updateQueues],
  );

  const sendQueuedNow = useCallback(
    (botId: string, localId: string) => {
      const item = queueOf(queues, botId).find((row) => row.localId === localId);
      if (item === undefined || interruptingId !== null) return;
      const sendQueued = threadSendQueued.current;
      if (sendQueued === null) {
        updateQueues(botId, (current) => removeQueued(current, botId, localId));
        void postMessage(item.text, item.attachmentIds);
        return;
      }
      const targetRunId =
        threadGenerating
          ? (item.targetRunId ?? activeRunIdRef.current ?? undefined)
          : undefined;
      setInterruptingId(localId);
      held.add(botId);
      void sendQueued({
        text: item.text,
        attachmentIds: item.attachmentIds,
        messageId: item.messageId,
        ...(targetRunId === undefined ? {} : { interruptRunId: targetRunId }),
      })
        .then((result) => {
          if (result.kind === 'sent') {
            setPending((list) => claimedRemoved(list, [...item.attachmentIds]));
            held.delete(botId);
            setQueues((current) => removeQueued(current, botId, localId));
            return;
          }
          if (result.kind === 'target-changed') {
            // Preserve the message, refresh its target run, and ask the user to retry.
            const nextRun = result.activeRunId ?? activeRunIdRef.current;
            setQueues((current) =>
              setQueuedNotice(
                current,
                botId,
                localId,
                t('composer.queue.targetChanged'),
                nextRun,
              ),
            );
            return;
          }
          setQueues((current) =>
            setQueuedNotice(current, botId, localId, t('composer.queue.interruptFailed')),
          );
        })
        .finally(() => {
          setInterruptingId(null);
        });
    },
    [queues, interruptingId, threadGenerating, held, updateQueues, postMessage],
  );

  const moveQueuedMessage = useCallback(
    (botId: string, from: number, to: number) => {
      updateQueues(botId, (current) => moveQueued(current, botId, from, to));
    },
    [updateQueues],
  );

  const queuedFor = useCallback((botId: string) => queueOf(queues, botId), [queues]);

  const stageFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const localId = crypto.randomUUID();
        const item: PendingAttachment = { localId, file, status: 'queued' };
        const invalid = validateFile({ size: file.size, type: file.type });
        setPending((list) => pendingAdded(list, item));
        if (invalid) {
          setPending((list) => pendingStatus(list, localId, 'error', { error: invalid }));
          continue;
        }
        const controller = new AbortController();
        aborters.set(localId, controller);
        setPending((list) => pendingStatus(list, localId, 'uploading'));
        uploadAttachment(client, file, controller.signal)
          .then((result) => {
            setPending((list) => pendingStatus(list, localId, 'ready', { remoteId: result.id }));
          })
          .catch((error: unknown) => {
            const normalized =
              error instanceof ApiRequestError
                ? toAttachmentError(error.failure)
                : normalizeAttachmentError(undefined);
            // Ignore errors for chips already removed (including aborts).
            setPending((list) => {
              if (!list[localId]) return list;
              return pendingStatus(list, localId, 'error', { error: normalized });
            });
          })
          .finally(() => aborters.delete(localId));
      }
    },
    [aborters, client],
  );

  const removePending = useCallback(
    (localId: string) => {
      aborters.get(localId)?.abort();
      // Read before setState so StrictMode double-invocations cannot issue two DELETEs.
      const item = pending[localId];
      if (item?.status === 'ready' && item.remoteId !== undefined) {
        void deleteAttachment(client, item.remoteId).catch(() => undefined);
      }
      setPending((list) => pendingRemoved(list, localId));
    },
    [aborters, client, pending],
  );

  const retryPending = useCallback(
    (localId: string) => {
      // Read before setState so StrictMode double-invocations cannot upload twice.
      const item = pending[localId];
      if (!item) return;
      setPending((list) => pendingRemoved(list, localId));
      stageFiles([item.file]);
    },
    [pending, stageFiles],
  );

  const claimPending = useCallback((attachmentIds: readonly string[]) => {
    setPending((list) => claimedRemoved(list, attachmentIds));
  }, []);

  const pendingList = useMemo(() => Object.values(pending), [pending]);

  return {
    threadSend,
    threadSendQueued,
    threadGenerating,
    threadStartedAt,
    interruptingId,
    noteGenerating,
    noteActiveRun,
    pending: pendingList,
    stageFiles,
    removePending,
    retryPending,
    claimPending,
    queuedFor,
    postMessageId,
    postMessage,
    queueMessage,
    queueOrSend,
    editQueuedMessage,
    removeQueuedMessage,
    sendQueuedNow,
    moveQueuedMessage,
  };
}
