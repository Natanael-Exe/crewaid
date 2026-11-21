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
  removeQueued,
  type MessageQueues,
  type QueuedMessage,
} from '../state/messageQueue';

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
  readonly threadGenerating: boolean;
  readonly threadStartedAt: number | null;
  readonly noteGenerating: (generating: boolean) => void;
  readonly pending: PendingAttachment[];
  readonly stageFiles: (files: File[]) => void;
  readonly removePending: (localId: string) => void;
  readonly retryPending: (localId: string) => void;
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
  // Held outside the chat reducer because queued drafts never originate from
  // server frames and must survive bot switches.
  const [queues, setQueues] = useState<MessageQueues>({});
  // Ref keeps one stable map across renders so abort and upload always agree.
  const aborters = useRef(new Map<string, AbortController>()).current;
  const held = useRef(new Set<string>()).current;

  const threadSend = useRef<ChatThreadView['send'] | null>(null);
  const [threadGenerating, setThreadGenerating] = useState(false);
  // Local timestamp when the user clicked Send, before server status frames arrive.
  const [threadStartedAt, setThreadStartedAt] = useState<number | null>(null);

  const noteGenerating = useCallback((generating: boolean) => {
    setThreadGenerating(generating);
    setThreadStartedAt((current) => (generating ? (current ?? Date.now()) : null));
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
    void postMessage(message.text, message.attachmentIds).then((sent) => {
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
          text,
          attachmentIds,
        }),
      );
    },
    [updateQueues],
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
      if (item === undefined) return;
      updateQueues(botId, (current) => removeQueued(current, botId, localId));
      void postMessage(item.text, item.attachmentIds);
    },
    [queues, updateQueues, postMessage],
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

  const pendingList = useMemo(() => Object.values(pending), [pending]);

  return {
    threadSend,
    threadGenerating,
    threadStartedAt,
    noteGenerating,
    pending: pendingList,
    stageFiles,
    removePending,
    retryPending,
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
