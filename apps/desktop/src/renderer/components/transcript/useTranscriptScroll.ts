import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { TurnActivity } from '../../state/chatReducer';
import {
  distanceFromBottom,
  followsAfterScroll,
  nearOlderHistory,
  showsJumpButton,
} from '../../state/transcriptScroll';
import type { TranscriptMessage } from '../../state/viewTypes';
import {
  enteringMessageIds,
  rememberMessages,
  type EntranceHistory,
} from '../../styles/messageEntrance';
import type { PendingVoiceNote } from '../../voice/useVoiceOutbox';

/** How long a jumped-to message stays highlighted before fading. */
const FOCUS_MARK_MS = 2400;

export interface UseTranscriptScrollOptions {
  botId: string;
  messages: readonly TranscriptMessage[];
  historyLoaded: boolean;
  hasOlderMessages: boolean;
  loadingOlder: boolean;
  olderHistoryError: string | null;
  showBotWork: boolean;
  activity: TurnActivity | undefined;
  approvalCount: number;
  pendingVoiceNotes: readonly PendingVoiceNote[] | undefined;
  focusMessageId: string | null | undefined;
  onFocused: (() => void) | undefined;
  onReachTop: (() => void) | undefined;
}

export interface UseTranscriptScrollResult {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  showJumpButton: boolean;
  jumpToBottom: (behavior: ScrollBehavior) => void;
  requestOlder: () => void;
  handleScroll: (event: { currentTarget: HTMLDivElement }) => void;
  handleScrollEnd: (event: { currentTarget: HTMLDivElement }) => void;
}

/**
 * Manages transcript scroll anchoring, tail following, jump-to-latest state,
 * viewport backfilling for hidden-only pages, older-page anchor restoration,
 * unified resize observation, and jump-to-message focus highlighting.
 */
export function useTranscriptScroll({
  botId,
  messages,
  historyLoaded,
  hasOlderMessages,
  loadingOlder,
  olderHistoryError,
  showBotWork,
  activity,
  approvalCount,
  pendingVoiceNotes,
  focusMessageId,
  onFocused,
  onReachTop,
}: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [distance, setDistance] = useState(0);
  // Kept in a ref rather than state so layout-effect pins never lag behind a re-render.
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  // Suppresses user-scroll detection while a smooth programmatic jump animates.
  const jumping = useRef(false);

  // Highlight timers outlive the focus effect because `onFocused` clears `focusMessageId` immediately.
  const unmarkTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = unmarkTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (focusMessageId === null || focusMessageId === undefined) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-message="${CSS.escape(focusMessageId)}"]`,
    );
    if (el === null || el === undefined) return;
    following.current = false;
    el.scrollIntoView({ block: 'center' });
    el.dataset['focused'] = 'true';
    const timer = setTimeout(() => {
      delete el.dataset['focused'];
      unmarkTimers.current.delete(timer);
    }, FOCUS_MARK_MS);
    unmarkTimers.current.add(timer);
    onFocused?.();
  }, [focusMessageId, messages, onFocused]);

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
    setDistance(0);
  }, []);

  const jumpToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (el === null) return;
    following.current = true;
    if (behavior === 'smooth') jumping.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
    lastScrollTop.current = el.scrollTop;
    setDistance(0);
  }, []);

  // Layout effect so streamed tokens and new tail prompts paint already pinned.
  useLayoutEffect(() => {
    if (!following.current) return;
    pinToBottom();
  }, [pinToBottom, messages, activity, approvalCount, pendingVoiceNotes]);

  // Pages with only hidden thinking/tool rows produce no overflow to trigger a scroll
  // event; backfill one page per oldest boundary until the viewport has scrollable slack.
  const filledBoundary = useRef<string | null>(null);
  useEffect(() => {
    filledBoundary.current = null;
  }, [botId]);

  const fillViewportRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (
      !historyLoaded ||
      !hasOlderMessages ||
      loadingOlder ||
      olderHistoryError !== null ||
      scroller === null ||
      content === null ||
      onReachTop === undefined
    ) {
      fillViewportRef.current = () => undefined;
      return;
    }
    const boundary = `${botId}:${messages[0]?.id ?? ''}:${showBotWork}`;
    const fill = () => {
      if (
        filledBoundary.current === boundary ||
        scroller.clientHeight === 0 ||
        scroller.scrollHeight > scroller.clientHeight + 120
      )
        return;
      filledBoundary.current = boundary;
      onReachTop();
    };
    fillViewportRef.current = fill;
    fill();
    return () => {
      fillViewportRef.current = () => undefined;
    };
  }, [
    botId,
    historyLoaded,
    hasOlderMessages,
    loadingOlder,
    olderHistoryError,
    messages,
    showBotWork,
    onReachTop,
  ]);

  // Preserve the first visible row when prepending older pages; native scroll
  // anchoring alone drifts across `content-visibility: auto` rows.
  const olderAnchor = useRef<{ id: string; top: number; boundary: string | undefined } | null>(
    null,
  );
  const rememberOlderAnchor = () => {
    const scroller = scrollRef.current;
    if (scroller !== null && !following.current) {
      const top = scroller.getBoundingClientRect().top;
      const row = [...scroller.querySelectorAll<HTMLElement>('[data-motion-message]')].find(
        (node) => node.getBoundingClientRect().bottom > top,
      );
      const motionId = row?.dataset['motionMessage'];
      if (row !== undefined && motionId !== undefined) {
        olderAnchor.current = {
          id: motionId,
          top: row.getBoundingClientRect().top - top,
          boundary: messages[0]?.id,
        };
      }
    }
  };

  const requestOlder = () => {
    if (!hasOlderMessages || loadingOlder || onReachTop === undefined) return;
    rememberOlderAnchor();
    onReachTop();
  };

  useLayoutEffect(() => {
    const anchor = olderAnchor.current;
    if (anchor === null || anchor.boundary === messages[0]?.id) return;
    olderAnchor.current = null;
    const scroller = scrollRef.current;
    const row = contentRef.current?.querySelector<HTMLElement>(
      `[data-motion-message="${CSS.escape(anchor.id)}"]`,
    );
    if (scroller === null || row === undefined || row === null || following.current) return;
    scroller.scrollTop +=
      row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
    lastScrollTop.current = scroller.scrollTop;
  }, [messages]);

  // Single ResizeObserver handles both async content growth (media/reflow) and pane resizes.
  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (content === null || scroller === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      fillViewportRef.current();
      if (following.current && !jumping.current) pinToBottom();
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [pinToBottom]);

  // Land on the newest message whenever switching bots; re-land until history arrives.
  const landedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (landedFor.current === botId) return;
    const el = scrollRef.current;
    if (el === null) return;
    following.current = true;
    pinToBottom();
    if (messages.length > 0) landedFor.current = botId;
  }, [botId, messages, pinToBottom]);

  // Animate newly arriving rows once after initial hydration unless motion is reduced.
  const entranceHistory = useRef<EntranceHistory | null>(null);
  useLayoutEffect(() => {
    if (!historyLoaded) return;
    const entering = enteringMessageIds(entranceHistory.current, botId, messages, historyLoaded);
    entranceHistory.current = rememberMessages(botId, messages);
    if (
      entering.length === 0 ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.dataset['reduceMotion'] === 'true'
    )
      return;
    for (const id of entering) {
      const row = contentRef.current?.querySelector<HTMLElement>(
        `[data-motion-message="${CSS.escape(id)}"]`,
      );
      if (row === null || row === undefined) continue;
      row.dataset['messageEnter'] = 'true';
      const finish = (event: AnimationEvent) => {
        // Ignore child animations (mascots/spinners); only the row's entrance clears the flag.
        if (event.target !== row || event.animationName !== 'crewaid-message-in') return;
        delete row.dataset['messageEnter'];
        row.removeEventListener('animationend', finish);
        row.removeEventListener('animationcancel', finish);
      };
      row.addEventListener('animationend', finish);
      row.addEventListener('animationcancel', finish);
    }
  }, [botId, historyLoaded, messages]);

  const handleScroll = (event: { currentTarget: HTMLDivElement }) => {
    const el = event.currentTarget;
    if (jumping.current) {
      lastScrollTop.current = el.scrollTop;
      return;
    }
    const next = distanceFromBottom(el);
    setDistance((previous) =>
      showsJumpButton(previous) === showsJumpButton(next) ? previous : next,
    );
    following.current = followsAfterScroll({
      following: following.current,
      distance: next,
      scrollTop: el.scrollTop,
      lastScrollTop: lastScrollTop.current,
    });
    lastScrollTop.current = el.scrollTop;
    // Update the anchor while loading because trackpad momentum continues mid-request.
    if (loadingOlder) rememberOlderAnchor();
    if (olderHistoryError === null && nearOlderHistory(el)) requestOlder();
  };

  const handleScrollEnd = (event: { currentTarget: HTMLDivElement }) => {
    if (!jumping.current) return;
    jumping.current = false;
    const el = event.currentTarget;
    lastScrollTop.current = el.scrollTop;
    setDistance(distanceFromBottom(el));
  };

  return {
    scrollRef,
    contentRef,
    showJumpButton: showsJumpButton(distance),
    jumpToBottom,
    requestOlder,
    handleScroll,
    handleScrollEnd,
  };
}
