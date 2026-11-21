import { useLocale } from '../i18n/i18n';
import type {
  Bot,
  BotGroup,
  ClientFrame,
  CreateBotBody,
  CreateBotGroupBody,
  DeleteMessagesResponse,
  MessageWithAttachments,
  ScreenControlPayload,
  ServerFrame,
  UpdateBotBody,
  UpdateBotGroupBody,
} from '@crewaid/shared';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  clearMessages,
  createBot,
  createGroup,
  deleteBot,
  deleteGroup,
  deleteMessage as requestDeleteMessage,
  discardRecording as requestDiscardRecording,
  duplicateBot,
  failureOf,
  getRecordingStatus,
  listBots,
  listGroups,
  markBotRead,
  startRecording as requestStartRecording,
  startTopic as requestStartTopic,
  startSandbox,
  releaseIdentity as requestReleaseIdentity,
  stopRecording as requestStopRecording,
  updateBot,
  updateGroup,
  useApiClient,
  requestScreenGrant,
  type ApiFailure,
} from '../api';
import { credentialsProvider } from '../bridge';
import type { WsConnectionState } from '../connection/wsClient';
import { useWsConnection } from '../connection/useWsConnection';
import {
  openScreenStream as openScreenStreamClient,
  type ScreenStreamHandle,
  type ScreenStreamOptions,
} from '../screen/screenStreamClient';
import { chatReducer, initialChatState, type ChatState } from './chatReducer';
import { initialResyncMemory, stepResync } from './reconnectResync';
import { toBotRowView, type BotRowView } from './viewTypes';

/**
 * The shell's data layer: REST for history, WS for everything live.
 *
 * Deliberately a `useReducer` and not a store library. Every transition
 * already lives in one pure reducer, which is the property that actually
 * matters — a container swap (Zustand, or a split context if per-token
 * re-render ever shows up in a profile) is then mechanical, because nothing
 * outside `chatReducer.ts` knows how a frame becomes state. Adding a
 * dependency before that pressure exists would shape the abstraction around a
 * guess.
 *
 * Ordering rule: the WS subscription is established BEFORE history is
 * fetched. The reverse order has a hole — a reply that starts between the
 * fetch returning and the socket attaching is lost with no trace.
 */

/**
 * A write's outcome, as data.
 *
 * The four bot mutations are the first calls whose failure the operator must
 * see in place — a create dialog has to keep its draft and say why, where a
 * failed list refetch can simply leave the last good list on screen. Throwing
 * would make every call site a try/catch that has to remember `failureOf`;
 * returning the failure makes handling it the obvious path.
 */
export type BotMutation<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ApiFailure };

export type SeatControlRequest =
  { readonly action: 'take' } | { readonly action: 'renew' | 'release'; readonly epoch: number };

/** Opens one bot's screen stream at a quality, feeding the viewer's handlers. */
export type OpenScreenStream = (
  botId: string,
  quality: number,
  handlers: Pick<ScreenStreamOptions, 'onRfb' | 'onEnded'>,
) => ScreenStreamHandle;

export interface ChatController {
  readonly controlScreen: (botId: string, request: SeatControlRequest) => void;
  readonly state: ChatState;
  /** close the plan-use notice. */
  readonly dismissUsageNotice: () => void;
  readonly connection: WsConnectionState;
  /** Sidebar rows, derived from bots + their last settled message. */
  readonly rows: readonly BotRowView[];
  readonly cancel: (botId: string) => void;
  /**
   * this bot's WebSocket frames, for the chat client that is watching it.
   *
   * The transcript comes from the chat routes. Three frames are about the
   * thread rather than about a run's content and so have nowhere else to
   * arrive: `run.started` (how a window joins a run it did not start),
   * `message.deleted`, and a `message.created` for a row no run streams. The
   * returned function unsubscribes, exactly as the screen listeners do.
   */
  readonly onBotFrames: (botId: string, listener: (frame: ServerFrame) => void) => () => void;
  /**
   * WebSocket `screen.subscribe`; the returned function unsubscribes. It makes this
   * window a watcher of the bot's seat — what lets it take control and send
   * input — and carries no pixels.
   */
  readonly watchScreen: (botId: string) => () => void;
  readonly sendScreenInput: (botId: string, rfb: Uint8Array) => boolean;
  /**
   * The bot's desktop pixels, on a stream of their own: granted by the
   * orchestrator and served from wherever the grant says. Never through
   * `chatReducer` — they are RFB bytes for a decoder, with no state to derive.
   */
  readonly openScreenStream: OpenScreenStream;
  readonly reloadBots: () => Promise<void>;
  /**
   * Re-read the credentials everywhere at once.
   *
   * Called when the operator saves a new address or token: the REST client
   * reads the bag per request and so needs only a refetch, while the socket is
   * already open against the old one and has to be reopened.
   */
  readonly applyCredentialChange: () => void;
  /**
   * explicitly ask for this bot's computer.
   *
   * Fire-and-forget by design. The outcome is per-bot state the card reads
   * (`state.wakeByBot`), not a promise the caller awaits — the operator can
   * switch bots while a wake is out, and a component that had to hold the
   * promise would either cancel it on unmount or leak its result onto whatever
   * bot happens to be selected when it lands.
   */
  readonly wakeComputer: (botId: string) => void;
  readonly releaseIdentity: (botId: string) => Promise<BotMutation<void>>;
  /**
   * teach a task on this bot's computer.
   *
   * Fire-and-forget, like the wake: the flow is per-bot state the viewer
   * renders (`state.recordingByBot`), and the operator can switch bots while
   * a start or a stop is out. A start on a bot that is already recording is
   * ignored here and refused server-side (REST: 409) — the button only exists
   * on a terminal flow, so this is a fence, not the interaction.
   */
  readonly startRecording: (botId: string) => void;
  /** Stop the recording this window believes is live, and settle the outcome. */
  readonly stopRecording: (botId: string) => void;
  /**
   * throw the take away instead of keeping it.
   *
   * One gesture for every phase with something to abandon: a live capture, a
   * compile already running, a finished draft (which is deleted first — a
   * discarded card must not leave its skill behind, and a skill outlives the
   * card that would reach it), or a failed row.
   */
  readonly discardRecording: (botId: string) => void;
  /**
   * point the recording card at the version of its draft that is
   * current now. A save answers with a NEW row (new id) and approval does not
   * carry over to it, so without this a review reopened from the card would
   * load the superseded version the recording originally compiled.
   */
  readonly adoptSkillVersion: (botId: string, skillId: string) => void;
  /** writes. Each refreshes the list itself, so callers only route the result. */
  readonly createNewBot: (body: CreateBotBody) => Promise<BotMutation<Bot>>;
  readonly saveBot: (botId: string, body: UpdateBotBody) => Promise<BotMutation<Bot>>;
  readonly duplicateExistingBot: (botId: string) => Promise<BotMutation<Bot>>;
  readonly removeBot: (botId: string) => Promise<BotMutation<void>>;
  /** group writes. Each updates `state.groups` itself. */
  readonly createNewGroup: (body: CreateBotGroupBody) => Promise<BotMutation<BotGroup>>;
  readonly saveGroup: (groupId: string, body: UpdateBotGroupBody) => Promise<BotMutation<BotGroup>>;
  readonly removeGroup: (groupId: string) => Promise<BotMutation<void>>;
  /** put this bot's newest message back to unread. */
  readonly markUnread: (botId: string) => Promise<BotMutation<void>>;
  /**
   * `forget` is the confirmation's answer; the result says how many
   * messages and memories went, so the caller can report it.
   */
  readonly deleteMessage: (
    botId: string,
    messageId: string,
    forget: boolean,
  ) => Promise<BotMutation<DeleteMessagesResponse>>;
  readonly clearChat: (
    botId: string,
    forget: boolean,
  ) => Promise<BotMutation<DeleteMessagesResponse>>;
  /**
   * `/new`. No turn starts, so nothing else is coming for it — and no
   * frame either, so the caller hands the boundary row to the transcript.
   */
  readonly startTopic: (botId: string) => Promise<BotMutation<MessageWithAttachments>>;
}

export function useChat(selectedBotId: string | null): ChatController {
  const locale = useLocale();
  const client = useApiClient();
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  const dismissUsageNotice = useCallback(() => dispatch({ type: 'usage/dismissed' }), []);

  const reloadBots = useCallback(async () => {
    dispatch({ type: 'bots/loading' });
    // the groups ride along, and never decide whether the roster
    // loads. An orchestrator from before groups answers 404 here, and the
    // right sidebar for it is the flat one it always had.
    const groups = listGroups(client).catch(() => null);
    try {
      dispatch({ type: 'bots/loaded', bots: await listBots(client) });
    } catch (error: unknown) {
      dispatch({ type: 'bots/failed', error: failureOf(error) });
    }
    const loaded = await groups;
    if (loaded !== null) dispatch({ type: 'groups/loaded', groups: loaded });
  }, [client]);

  /**
   * the bot on screen, for the frame listener. A ref because the
   * listener must not be rebuilt on every selection, and a reply is read the
   * moment it lands on the transcript the operator is looking at.
   */
  const viewedRef = useRef<string | null>(null);
  useEffect(() => {
    viewedRef.current = selectedBotId;
    dispatch({ type: 'selection/changed', botId: selectedBotId });
    // A bot is read when opened and as messages arrive while it is visible.
    // Marking the one being left here would race a new off-screen message:
    // the server stamps the mark when it handles the request, after selection.
    if (selectedBotId !== null) markBotRead(client, selectedBotId).catch(() => undefined);
  }, [client, selectedBotId]);

  // The latest recording views, for callbacks that must read them
  // synchronously — a dispatched status is not visible to the next call in the
  // same tick, and both the start and the stop guard have to see the current
  // flow, not the one from the render their closure was built in.
  const recordingsRef = useRef(state.recordingByBot);
  useEffect(() => {
    recordingsRef.current = state.recordingByBot;
  }, [state.recordingByBot]);

  /**
   * Read a recording's status after a terminal transition told us it settled.
   *
   * the reason a hard limit stopped it (`warning`) is deliberately not
   * pushed in `recording.state`; it lives on `GET /recordings/:id`, and the
   * read happens at the one moment it can matter — after the transition — so
   * the client never polls a live recording. The same read fills the final
   * counts and, once compiles, the new skill's id.
   */
  const refreshRecordingStatus = useCallback(
    async (botId: string, recordingId: string) => {
      try {
        const status = await getRecordingStatus(client, recordingId);
        dispatch({ type: 'recording/settled', botId, status });
      } catch {
        // The frame already settled the view; this read only enriches it. A
        // failed read leaves the honest generic copy in place rather than
        // replacing a finished recording with a network error.
      }
    },
    [client],
  );

  /**
   * the chat clients watching a bot, by bot.
   *
   * A ref and not state, for the reason `screenListeners` is one: nothing
   * renders from it, and a subscribe during a render that React then discards
   * must not outlive that render.
   */
  const botFrameListeners = useRef(new Map<string, Set<(frame: ServerFrame) => void>>()).current;
  const onBotFrames = useCallback(
    (botId: string, listener: (frame: ServerFrame) => void): (() => void) => {
      const listeners = botFrameListeners.get(botId) ?? new Set();
      listeners.add(listener);
      botFrameListeners.set(botId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) botFrameListeners.delete(botId);
      };
    },
    [botFrameListeners],
  );

  // `state.bots` changes identity on every bot.status frame, so callbacks read
  // the current roster through a ref instead of rebuilding on every tick.
  const botsRef = useRef(state.bots);
  useEffect(() => {
    botsRef.current = state.bots;
  }, [state.bots]);

  const onFrame = useCallback(
    (frame: ServerFrame) => {
      dispatch({ type: 'ws/frame', frame });
      if (frame.botId !== undefined) {
        // After the dispatch, so a listener that reads this hook's state sees
        // the same frame the reducer has already taken.
        for (const listener of [...(botFrameListeners.get(frame.botId) ?? [])]) listener(frame);
      }
      // First startup creates the row server-side. The event only carries state
      // and geometry, so fetch the complete row rather than inventing columns.
      if (
        frame.type === 'sandbox.state' &&
        botsRef.current.some((bot) => bot.id === frame.payload.botId && bot.sandbox === null)
      ) {
        void reloadBots();
      }
      // The roster changed on the server; refetch the canonical list.
      if (frame.type === 'bots.changed') {
        void reloadBots();
      }
      // A run ends on `bot.status: IDLE`; off-screen bots refresh their unread count.
      const runEnded = frame.type === 'bot.status' && frame.payload.status === 'IDLE';
      if (runEnded && frame.payload.botId !== viewedRef.current) {
        void reloadBots();
      }
      // A teammate's message is settled on arrival, so it is read then.
      if (
        frame.botId !== undefined &&
        frame.botId === viewedRef.current &&
        (runEnded ||
          (frame.type === 'message.created' &&
            frame.payload.author === 'BOT' &&
            frame.payload.fromBotId !== null &&
            frame.payload.fromBotId !== frame.botId))
      ) {
        markBotRead(client, frame.botId).catch(() => undefined);
      }
      // A recording reaching a terminal state is settled at most once.
      if (
        frame.type === 'recording.state' &&
        frame.botId !== undefined &&
        (frame.payload.state === 'READY' || frame.payload.state === 'FAILED')
      ) {
        void refreshRecordingStatus(frame.botId, frame.payload.recordingId);
      }
    },
    [client, reloadBots, refreshRecordingStatus, botFrameListeners],
  );
  const {
    state: connection,
    send: sendWsFrame,
    sendScreenInput,
    reconnect,
  } = useWsConnection({ onFrame });

  const controlScreen = useCallback(
    (botId: string, request: SeatControlRequest) => {
      const payload: ScreenControlPayload = { botId, ...request };
      sendWsFrame({
        id: crypto.randomUUID(),
        type: 'screen.control',
        botId,
        ts: Date.now(),
        payload,
      });
    },
    [sendWsFrame],
  );

  useEffect(() => {
    if (connection.status !== 'connected') dispatch({ type: 'seat-control/reset' });
  }, [connection.status]);

  const applyCredentialChange = useCallback(() => {
    reconnect();
    void reloadBots();
  }, [reconnect, reloadBots]);

  useEffect(() => {
    void reloadBots();
  }, [reloadBots]);

  /**
   * Repair the gap a dropped socket leaves behind. `stepResync` owns the
   * decision; this effect owns the fetching. The transcript is re-hydrated by
   * the chat client directly; this repairs missed roster/shell events.
   */
  const resyncMemory = useRef(initialResyncMemory(connection.status));
  useEffect(() => {
    const { memory, refetch } = stepResync(resyncMemory.current, connection.status);
    resyncMemory.current = memory;
    if (!refetch) return;
    dispatch({ type: 'work/resync' });
    // A recording in flight needs the same repair, and needs it more.
    // `starting` and `stopping` are settled by their own REST response, but
    // `compiling` is settled ONLY by a `recording.state` / `skill.compiled`
    // frame — and the server emits those on transition, never on subscribe.
    // A socket that drops during a compile and reconnects after it finished
    // leaves a card reading "Compiling skill…" with no actions on it, and both
    // start guards refuse a new take until the view is terminal, so the bot
    // cannot be taught anything for the rest of the session. Unlike the
    // transcript above, this is not bounded to opened bots: the recording is
    // the operator's own work and it is cheap to ask about.
    for (const [botId, view] of Object.entries(recordingsRef.current)) {
      if (view === undefined) continue;
      // `starting` has no id to ask about yet, and its own response settles it.
      if (view.kind === 'starting' || view.kind === 'ready' || view.kind === 'failed') continue;
      void refreshRecordingStatus(botId, view.recordingId);
    }
  }, [connection.status, recordingsRef, refreshRecordingStatus]);

  const watchScreen = useCallback(
    (botId: string): (() => void) => {
      // A disconnected send is not queued. Changing this callback when the
      // connection changes recreates the viewer and subscribes on the new socket.
      if (connection.status !== 'connected') return () => undefined;
      sendWsFrame({
        id: crypto.randomUUID(),
        type: 'screen.subscribe',
        botId,
        ts: Date.now(),
        payload: { botId },
      });
      return () => {
        sendWsFrame({
          id: crypto.randomUUID(),
          type: 'screen.unsubscribe',
          botId,
          ts: Date.now(),
          payload: { botId },
        });
      };
    },
    [connection.status, sendWsFrame],
  );

  const openScreenStream = useCallback<OpenScreenStream>(
    (botId, quality, handlers) =>
      openScreenStreamClient({
        botId,
        quality,
        grant: (id) => requestScreenGrant(client, id),
        orchestratorBaseUrl: async () => (await credentialsProvider()).orchestratorBaseUrl,
        ...handlers,
      }),
    [client],
  );

  const cancel = useCallback(
    (botId: string) => {
      const frame: ClientFrame = {
        id: crypto.randomUUID(),
        type: 'bot.cancel',
        botId,
        ts: Date.now(),
        payload: { botId },
      };
      // The partial reply STAYS: the run's own terminal event
      // settles it, and clearing it locally would drop text the server kept.
      sendWsFrame(frame);
    },
    [sendWsFrame],
  );

  /**
   * The four REST bot writes.
   *
   * Create, duplicate and delete refetch the list rather than splicing the
   * response into state: the row the sidebar renders is a `BotWithSandbox`,
   * and these endpoints answer a bare `Bot`. Splicing would mean inventing
   * the missing `sandbox` half — which is exactly the cast this repo bans at
   * the Prisma → wire boundary, in the other direction. A rename does patch
   * in place, because `bot/patched` merges fields into the row that already
   * has its sandbox.
   */
  const runMutation = useCallback(async <T>(work: () => Promise<T>): Promise<BotMutation<T>> => {
    try {
      return { ok: true, value: await work() };
    } catch (error: unknown) {
      return { ok: false, failure: failureOf(error) };
    }
  }, []);

  const createNewBot = useCallback(
    (body: CreateBotBody): Promise<BotMutation<Bot>> =>
      runMutation(async () => {
        const bot = await createBot(client, body);
        await reloadBots();
        return bot;
      }),
    [client, reloadBots, runMutation],
  );

  const saveBot = useCallback(
    (botId: string, body: UpdateBotBody): Promise<BotMutation<Bot>> =>
      runMutation(async () => {
        const bot = await updateBot(client, botId, body);
        dispatch({ type: 'bot/patched', bot });
        return bot;
      }),
    [client, runMutation],
  );

  const duplicateExistingBot = useCallback(
    (botId: string): Promise<BotMutation<Bot>> =>
      runMutation(async () => {
        const bot = await duplicateBot(client, botId);
        await reloadBots();
        return bot;
      }),
    [client, reloadBots, runMutation],
  );

  const removeBot = useCallback(
    (botId: string): Promise<BotMutation<void>> =>
      runMutation(async () => {
        await deleteBot(client, botId);
        await reloadBots();
      }),
    [client, reloadBots, runMutation],
  );

  const createNewGroup = useCallback(
    (body: CreateBotGroupBody): Promise<BotMutation<BotGroup>> =>
      runMutation(async () => {
        const group = await createGroup(client, body);
        dispatch({ type: 'group/saved', group });
        return group;
      }),
    [client, runMutation],
  );

  const saveGroup = useCallback(
    (groupId: string, body: UpdateBotGroupBody): Promise<BotMutation<BotGroup>> =>
      runMutation(async () => {
        const group = await updateGroup(client, groupId, body);
        dispatch({ type: 'group/saved', group });
        return group;
      }),
    [client, runMutation],
  );

  const removeGroup = useCallback(
    (groupId: string): Promise<BotMutation<void>> =>
      runMutation(async () => {
        await deleteGroup(client, groupId);
        dispatch({ type: 'group/removed', groupId });
      }),
    [client, runMutation],
  );

  const markUnread = useCallback(
    (botId: string): Promise<BotMutation<void>> =>
      runMutation(async () => {
        const { unreadCount } = await markBotRead(client, botId, true);
        dispatch({ type: 'unread/set', botId, count: unreadCount });
      }),
    [client, runMutation],
  );

  const deleteMessage = useCallback(
    (
      botId: string,
      messageId: string,
      forget: boolean,
    ): Promise<BotMutation<DeleteMessagesResponse>> =>
      runMutation(() => requestDeleteMessage(client, botId, messageId, forget)),
    [client, runMutation],
  );

  const clearChat = useCallback(
    (botId: string, forget: boolean): Promise<BotMutation<DeleteMessagesResponse>> =>
      runMutation(async () => {
        const result = await clearMessages(client, botId, forget);
        dispatch({ type: 'unread/set', botId, count: 0 });
        return result;
      }),
    [client, runMutation],
  );

  const startTopic = useCallback(
    (botId: string): Promise<BotMutation<MessageWithAttachments>> =>
      runMutation(() => requestStartTopic(client, botId)),
    [client, runMutation],
  );

  /**
   * one wake per bot at a time.
   *
   * A ref rather than reading `state.wakeByBot`: a dispatched status is not
   * visible to the next call in the same tick, so two clicks landing together
   * would both pass the guard. `loadOlder` uses the same pattern for the same
   * reason.
   *
   * The orchestrator would answer both identically — REST start is idempotent
   * and serializes concurrent wakes onto one runtime — so this is
   * about not asking twice, not about correctness on the server.
   */
  const wakingRef = useRef(new Set<string>()).current;
  const wakeComputer = useCallback(
    (botId: string) => {
      if (wakingRef.has(botId)) return;
      wakingRef.add(botId);
      dispatch({ type: 'sandbox/waking', botId });
      startSandbox(client, botId)
        .then((status) => dispatch({ type: 'sandbox/settled', botId, status }))
        .catch((error: unknown) =>
          dispatch({ type: 'sandbox/wakeFailed', botId, error: failureOf(error) }),
        )
        // Not `signal`-cancelled when the operator switches away: the wake is
        // already happening on the host, and abandoning the response would
        // leave the card unable to say whether it worked ( — switching
        // bots detaches the viewer, it does not cancel work).
        .finally(() => wakingRef.delete(botId));
    },
    [client, wakingRef],
  );

  const releaseIdentity = useCallback(
    (botId: string): Promise<BotMutation<void>> =>
      runMutation(() => requestReleaseIdentity(client, botId)),
    [client, runMutation],
  );

  // One start per bot at a time, for the same reason `wakingRef` exists: a
  // dispatched status is not visible to the next call in the same tick, so
  // two clicks landing together would both pass a state-only guard.
  const startingRef = useRef(new Set<string>()).current;
  const startRecording = useCallback(
    (botId: string) => {
      if (startingRef.has(botId)) return;
      const current = recordingsRef.current[botId];
      // A live capture is not replaceable — REST refuses a second start with
      // 409 — and a request already out is the same question again. A
      // terminal view (ready/failed) is what a new take replaces.
      if (current !== undefined && current.kind !== 'ready' && current.kind !== 'failed') return;
      startingRef.add(botId);
      dispatch({ type: 'recording/starting', botId });
      requestStartRecording(client, botId, {})
        .then(({ recordingId }) => dispatch({ type: 'recording/started', botId, recordingId }))
        .catch((error: unknown) =>
          dispatch({ type: 'recording/startFailed', botId, error: failureOf(error) }),
        )
        .finally(() => startingRef.delete(botId));
    },
    [client, recordingsRef, startingRef],
  );

  const stoppingRef = useRef(new Set<string>()).current;
  const stopRecording = useCallback(
    (botId: string) => {
      const current = recordingsRef.current[botId];
      if (current === undefined || current.kind !== 'recording') return;
      if (stoppingRef.has(botId)) return;
      stoppingRef.add(botId);
      const recordingId = current.recordingId;
      dispatch({ type: 'recording/stopping', botId });
      requestStopRecording(client, recordingId)
        .then((status) => dispatch({ type: 'recording/settled', botId, status }))
        .catch((error: unknown) => {
          const failure = failureOf(error);
          // The stop can lose a race to the recording settling itself —
          // auto-stop fires on the input path while this call is in
          // flight, and a 409 means exactly that the row is no longer
          // RECORDING. Re-read rather than guess which side won: only a read
          // that still says RECORDING is a stop that genuinely did not land.
          void getRecordingStatus(client, recordingId)
            .then((status) =>
              status.state === 'RECORDING'
                ? dispatch({ type: 'recording/stopFailed', botId, error: failure })
                : dispatch({ type: 'recording/settled', botId, status }),
            )
            .catch(() => dispatch({ type: 'recording/stopFailed', botId, error: failure }));
        })
        .finally(() => stoppingRef.delete(botId));
    },
    [client, recordingsRef, stoppingRef],
  );

  const adoptSkillVersion = useCallback((botId: string, skillId: string) => {
    dispatch({ type: 'recording/skillVersion', botId, skillId });
  }, []);

  /**
   * abandon the take.
   *
   * Guarded like the other recording calls (a ref, not the dispatched state,
   * because a second click lands before the first dispatch is visible). The
   * one phase with no server call at all is a start that FAILED: it carries
   * no recording id, so clearing the card is the entire job.
   *
   * The server owns draft cleanup so it can serialize deletion with a compile
   * that may finish while this request is in flight.
   */
  const discardingRef = useRef(new Set<string>()).current;
  const discardRecording = useCallback(
    (botId: string) => {
      const current = recordingsRef.current[botId];
      if (current === undefined || current.kind === 'starting' || current.kind === 'stopping') {
        return;
      }
      if (discardingRef.has(botId)) return;

      // `starting` and `stopping` returned above, so every view here names a
      // recording except a FAILED start — and clearing that card is the whole
      // job, because there is no row to discard.
      const recordingId: string | null = 'recordingId' in current ? current.recordingId : null;
      if (recordingId === null) {
        dispatch({ type: 'recording/discarded', botId });
        return;
      }
      discardingRef.add(botId);
      requestDiscardRecording(client, recordingId)
        .then((status) => dispatch({ type: 'recording/settled', botId, status }))
        .catch((error: unknown) =>
          dispatch({ type: 'recording/discardFailed', botId, error: failureOf(error) }),
        )
        .finally(() => discardingRef.delete(botId));
    },
    [client, discardingRef, recordingsRef],
  );

  const rows = useMemo(
    // the preview rides on the roster row, so this no longer depends
    // on a transcript — which is also what gives a bot nobody has opened a
    // real preview line.
    () => state.bots.filter((bot) => !bot.hiddenFromSidebar).map((bot) => toBotRowView(bot)),
    [state.bots, locale],
  );

  return {
    state,
    connection,
    rows,
    cancel,
    onBotFrames,
    watchScreen,
    controlScreen,
    sendScreenInput,
    openScreenStream,
    reloadBots,
    applyCredentialChange,
    wakeComputer,
    releaseIdentity,
    startRecording,
    stopRecording,
    discardRecording,
    adoptSkillVersion,
    createNewBot,
    saveBot,
    duplicateExistingBot,
    removeBot,
    createNewGroup,
    saveGroup,
    removeGroup,
    markUnread,
    deleteMessage,
    clearChat,
    startTopic,
    dismissUsageNotice,
  };
}
