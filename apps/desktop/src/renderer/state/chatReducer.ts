import { SeatControlRefusalCodeSchema } from '@crewaid/shared';
import type {
  ApprovalBinding,
  Bot,
  BotGroup,
  BotStatus,
  BotWithSandbox,
  Json,
  ProviderExplanation,
  RecordingState,
  RecordingStatusResponse,
  RecordingWarning,
  SandboxStatusResponse,
  ScreenControlStatePayload,
  ServerFrame,
  UsageNoticePayload,
} from '@crewaid/shared';
import type { ApiFailure } from '../api/apiError';
import { t } from '../i18n/i18n';

/** Refusals of a screen-seat action, which never mean the agent turn failed. */
const SEAT_REFUSAL_CODES: ReadonlySet<string> = new Set(SeatControlRefusalCodeSchema.options);

/**
 * The single place a WebSocket frame or a REST response becomes renderer state.
 *
 * This exhaustive switch is the point of the file. Ad-hoc
 * `if (frame.type === 'message.created')` handling scattered through components
 * is how a streaming UI rots: the same event gets three interpretations, and a
 * new event type added in M2–M8 silently does nothing. `ServerFrame` is a
 * discriminated union, so an unhandled type is a compile error here and
 * nowhere else.
 *
 * The transcript is NOT one of those pieces of state any more. A
 * thread's messages, the reply in flight, the page cursor and the approval
 * prompts belong to the TanStack chat client, which reads them from the run's
 * own delivery log and from the server's history. This reducer keeps
 * everything the transcript is not: the roster, the sandbox, the recording
 * flow, the Work counters, the unread badges, the plan notice, and the one
 * sentence a failure leaves the operator.
 *
 * So the `message.*` and `approval.*` arms below are nearly empty, and they
 * are still listed: the switch being exhaustive is what makes a WebSocket event
 * added later a compile error here rather than a silent no-op anywhere.
 */

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Operator-facing failure copy. Never a raw status line or vendor string. */
export interface ChatError {
  code: string;
  message: string;
  /**
   * The provider's own reason, already judged readable and cleaned by
   * the server. Shown beside `message`, attributed to `source`.
   */
  explanation?: ProviderExplanation;
}

/**
 * How a request for THIS bot's computer is going.
 *
 * Separate from `bot.sandbox.state`, which is the durable row, because the two
 * answer different questions and only one of them survives a restart. The row
 * says what the orchestrator believes about the container; this says whether
 * the operator's own click is still outstanding, was refused for capacity, or
 * failed in a way they can retry. A wake that is in flight has no row state of
 * its own for the first moments — `STOPPED` is still the truth — and rendering
 * that would answer a click with "not running".
 *
 * `capacity` is its own kind rather than a `failed` with different copy
 * because D-039 §16.1 requires the screen to show a full host separately from
 * a broken sandbox: one is "someone else's computer is using the slot", the
 * other is "this bot's computer is unwell", and they lead the operator to
 * different actions.
 */
export type WakeStatus =
  | { readonly kind: 'waking' }
  | { readonly kind: 'capacity'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/** WebSocket `recording.event` counts, kept as the frame carries them. */
export interface RecordingCounts {
  readonly x11: number;
  readonly cdp: number;
}

/**
 * The teaching flow for one bot, assembled from WebSocket frames and
 * the REST round trips around them.
 *
 * Separate from anything durable — there is no `Recording` row in this state —
 * because the interesting part is the operator's experience of a flow, not the
 * database's view of a row: a stop that is out, a compile that is running, and
 * an outcome that is still worth showing are all states the server moves
 * through in its own time, and the two clocks do not agree.
 *
 * `recordingId` is carried everywhere it exists so a frame about one
 * recording can never be mistaken for news about another — the tee emits for
 * whichever recording is active, and an old recording's queued frame must not
 * resurrect a counter next to its successor.
 */
export type RecordingView =
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'recording';
      readonly recordingId: string;
      readonly counts: RecordingCounts;
      /** The last captured kind, in the tee's vocabulary — display maps it. */
      readonly lastType: string | null;
      /** A stop that did not land, in operator copy; null when none. */
      readonly error: string | null;
    }
  | {
      readonly kind: 'stopping';
      readonly recordingId: string;
      readonly counts: RecordingCounts;
      readonly lastType: string | null;
    }
  | {
      readonly kind: 'compiling';
      readonly recordingId: string;
      readonly counts: RecordingCounts;
      /** A discard that did not land, in operator copy; null when none. */
      readonly error: string | null;
    }
  | {
      readonly kind: 'ready';
      readonly recordingId: string;
      readonly counts: RecordingCounts;
      readonly skillId: string | null;
      readonly skillName: string | null;
      /** Set only when a hard limit stopped it; the renderer picks the sentence. */
      readonly warning: RecordingWarning | null;
      /** A discard that did not land, in operator copy; null when none. */
      readonly error: string | null;
    }
  | { readonly kind: 'failed'; readonly recordingId: string | null; readonly message: string };

/**
 * What a FAILED recording says when nothing more specific is known.
 *
 * Only the WebSocket frame lands here. `recording.state` carries `{recordingId,
 * state}` and nothing else by the deliberate choice, so the frame alone
 * cannot say WHY — the read that follows it can, and `failedFrom` below uses
 * it. Keeping this as the fallback means the card is never empty in the gap
 * between the frame and that read.
 */
const recordingFailedMessage = (): string => t('recording.failed');

/**
 * The failed view for a recording that has been READ.
 *
 * The acceptance criterion is "a `FAILED` recording with a **readable
 * error**", and `Recording.error` is where D-044 put it — free text, already
 * normalized server-side so no vendor sentence reaches a user-visible surface.
 * Dropping it in favour of the constant would leave the operator with
 * the single word FAILED and no recourse but to re-record a task that will
 * fail the same way, which is the exact situation that decision exists to end.
 */
function failedFrom(status: RecordingStatusResponse): RecordingView {
  return {
    kind: 'failed',
    recordingId: status.id,
    message: status.error ?? recordingFailedMessage(),
  };
}

/**
 * A tool call this client has been asked to approve.
 *
 * Driven by the WebSocket `approval.requested` frame and NOT by the message's
 * `tool-approval-request` part, because the part does not exist yet: the
 * runner emits content parts when a turn FINALIZES, and a suspended turn has
 * not. The frame is the only thing that arrives while anyone is waiting.
 *
 * Keyed on `toolCallId`, which is what WebSocket `approval.respond` answers with —
 * the SDK's `approvalId` never leaves the orchestrator.
 */
export interface PendingApproval {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly args: Json;
  readonly binding: ApprovalBinding;
  /**
   * What this client answered, once it has. The prompt stays on screen and
   * disabled rather than disappearing: the turn resumes asynchronously, and a
   * row that vanished on click would leave the operator unsure whether it
   * landed. Cleared with the rest when the turn ends.
   */
  readonly answered?: 'approved' | 'declined';
}

/**
 * A turn in flight, as the transcript reports it.
 *
 * `startedAt` is the client's clock on purpose. It measures how long the
 * OPERATOR has been waiting, which is the question the indicator answers, and
 * it needs no round trip to establish — the point of this state is to appear
 * the instant a send lands, before the server has said anything at all.
 */
export interface TurnActivity {
  readonly startedAt: number;
  /**
   * The last status frame seen for this turn, or absent before the first one.
   *
   * Kept HERE rather than read off the roster, though `bots` carries a status
   * too: the roster is loaded by REST and a status frame for a bot that is not
   * in it yet updates nothing, so a turn in a window that has just opened
   * would have no status at all. This is also what tells a completion that is
   * the end of the work from one that another round follows.
   */
  readonly status?: BotStatus;
}

/**
 * A counter per kind of Work record, raised by each `*.changed` frame.
 *
 * The frames are invalidations, not state, so this slice holds no rows: a
 * Work view reads its own through the API and refetches when the counter it
 * depends on moves. Kept apart from `messagesByBot` so a board update never
 * changes the identity of a transcript slice.
 */
export interface WorkRevisions {
  readonly tasks: number;
  readonly projects: number;
  readonly goals: number;
  readonly deliverables: number;
}

type WorkKind = keyof WorkRevisions;

/**
 * Which views one change can stale. A task moving changes a goal's progress
 * and a project's open count; a deliverable changes a card's count and a
 * goal's list; a project or goal changes the names and filters every view
 * shows. The server computes all of those — this only says who must re-ask.
 */
const WORK_INVALIDATES: Readonly<
  Record<
    'task.changed' | 'project.changed' | 'goal.changed' | 'deliverable.changed',
    readonly WorkKind[]
  >
> = {
  'task.changed': ['tasks', 'goals', 'projects'],
  'project.changed': ['projects', 'tasks', 'goals', 'deliverables'],
  'goal.changed': ['goals', 'tasks', 'projects', 'deliverables'],
  'deliverable.changed': ['deliverables', 'tasks', 'goals'],
};

const ALL_WORK_KINDS: readonly WorkKind[] = ['tasks', 'projects', 'goals', 'deliverables'];

function bumpWork(state: ChatState, kinds: readonly WorkKind[]): ChatState {
  const work = { ...state.work };
  for (const kind of kinds) work[kind] += 1;
  return { ...state, work };
}

export interface ChatState {
  readonly seatControlByBot: Readonly<Record<string, ScreenControlStatePayload | undefined>>;
  readonly bots: readonly BotWithSandbox[];
  readonly botsStatus: LoadStatus;
  readonly botsError: ApiFailure | null;
  /**
   * The in-flight or last-refused wake per bot. Keyed by bot rather
   * than held for the selected one: a wake the operator started keeps running
   * when they switch away, and its answer has to land on the bot that asked.
   */
  readonly wakeByBot: Readonly<Record<string, WakeStatus | undefined>>;
  /**
   * The teaching flow per bot. Keyed by bot rather than held for
   * the selected one for the same reason as the wake: a recording the operator
   * walked away from stays live (the tee runs on the server), and its counter
   * and its stop button have to be waiting when they come back.
   */
  readonly recordingByBot: Readonly<Record<string, RecordingView | undefined>>;
  /**
   * The failure the operator needs to see for this bot: the WebSocket `error` frame
   * that ended its turn, or the reason a refused approval gave. Neutral copy
   * only — D-006 applies to the UI. Cleared when the bot's next run starts,
   * because from then on it describes a turn that is over. A send that never
   * landed is the chat client's own error, not this.
   */
  readonly errorByBot: Readonly<Record<string, ChatError | null>>;
  /**
   * When this bot's turn started, or absent when it is not working.
   *
   * The gap this fills was the whole of the operator's experience of a slow
   * turn: a message goes, the composer empties, and NOTHING appears until the
   * model produces its first token — which on a reasoning model, behind a
   * tool call, is tens of seconds. The transcript can only render what has
   * arrived, so "it is working" has to be its own state rather than something
   * derived from content.
   *
   * A timestamp rather than a boolean, because the useful form of this
   * indicator says how long it has been going: the difference between three
   * seconds and three minutes is the difference between waiting and checking
   * whether something is broken.
   */
  readonly activityByBot: Readonly<Record<string, TurnActivity | undefined>>;
  /**
   * A WebSocket `error` frame carrying no `botId` — the gateway's transport-level
   * replies (a malformed envelope, an unknown type) are not attributable to a
   * bot, so they have nowhere else to go.
   */
  readonly lastError: ChatError | null;
  /** The sidebar groups, in their order. Empty until loaded, or when there are none. */
  readonly groups: readonly BotGroup[];
  /**
   * How many of each bot's messages the operator has not read.
   *
   * Seeded from `GET /bots`, re-read when a bot the operator is not looking
   * at finishes a run, and raised by a teammate's message as it arrives. The
   * server's count is the durable one; this is what keeps the badge live
   * between two reads of it.
   */
  readonly unreadByBot: Readonly<Record<string, number>>;
  /**
   * The bot whose transcript is on screen, or null. The reducer needs it for
   * one thing only: a reply the operator is watching arrive is not unread.
   */
  readonly viewedBotId: string | null;
  /** What each Work view has to refetch for. */
  readonly work: WorkRevisions;
  /**
   * The latest plan-use notice this window saw, until dismissed. One
   * slot, not a list — a newer crossing (100% after 80%, or the other meter)
   * replaces an older one, and a window opened later reads the same numbers
   * from Plan & usage.
   */
  readonly usageNotice: UsageNoticePayload | null;
}

export const initialChatState: ChatState = {
  seatControlByBot: {},
  bots: [],
  botsStatus: 'idle',
  botsError: null,
  wakeByBot: {},
  recordingByBot: {},
  errorByBot: {},
  activityByBot: {},
  lastError: null,
  groups: [],
  unreadByBot: {},
  viewedBotId: null,
  work: { tasks: 0, projects: 0, goals: 0, deliverables: 0 },
  usageNotice: null,
};

export type ChatAction =
  | { type: 'seat-control/reset' }
  | { type: 'bots/loading' }
  /** The operator closed the plan-use notice. */
  | { type: 'usage/dismissed' }
  | { type: 'bots/loaded'; bots: readonly BotWithSandbox[] }
  | { type: 'bots/failed'; error: ApiFailure }
  /**
   * A single bot re-read from a PATCH. The response is a `Bot`, so it is
   * merged rather than substituted — `sandbox` only ever comes from `GET /bots`
   * and substituting would drop it.
   */
  | { type: 'bot/patched'; bot: Bot }
  /** The operator asked for this bot's computer and the call is out. */
  | { type: 'sandbox/waking'; botId: string }
  /**
   * REST start answered. The response is a `SandboxStatusResponse`, so it is
   * merged into the existing row exactly as the WebSocket frame below is, never
   * substituted for it: `Sandbox` has columns this body does not carry.
   */
  | { type: 'sandbox/settled'; botId: string; status: SandboxStatusResponse }
  | { type: 'sandbox/wakeFailed'; botId: string; error: ApiFailure }
  /** The start round trip is out (or about to be). */
  | { type: 'recording/starting'; botId: string }
  | { type: 'recording/started'; botId: string; recordingId: string }
  | { type: 'recording/startFailed'; botId: string; error: ApiFailure }
  /** The stop round trip is out; the view keeps counting until it answers. */
  | { type: 'recording/stopping'; botId: string }
  /**
   * A `RecordingStatusResponse` — the stop response, or the read the renderer
   * makes after a terminal `recording.state` frame.
   */
  | { type: 'recording/settled'; botId: string; status: RecordingStatusResponse }
  /** The stop call itself failed; the view goes back to counting with the reason. */
  | { type: 'recording/stopFailed'; botId: string; error: ApiFailure }
  /**
   * The take is gone: the recording was discarded, or never existed
   * to discard (a start that failed carries no id). The view is removed
   * rather than settled into a state, because there is nothing left to show.
   */
  | { type: 'recording/discarded'; botId: string }
  /**
   * The discard call failed. Unlike a stop, there is no "still live" state to
   * fall back to for every phase: the view stays exactly as it was and gains
   * the reason, and the button stays on offer.
   */
  | { type: 'recording/discardFailed'; botId: string; error: ApiFailure }
  /**
   * The review surface adopted a newer version of the draft this
   * recording produced. A save creates a new row with a new id and approval
   * does not carry over to it, so the card must point at the row that is
   * current now — otherwise reopening the review would quietly load the
   * superseded script the recording originally compiled.
   */
  | { type: 'recording/skillVersion'; botId: string; skillId: string }
  /** `GET /groups` answered. */
  | { type: 'groups/loaded'; groups: readonly BotGroup[] }
  /** A group created or changed by this window. */
  | { type: 'group/saved'; group: BotGroup }
  /** A group deleted by this window. Its bots are re-read separately. */
  | { type: 'group/removed'; groupId: string }
  /** The transcript on screen changed; that bot's messages are read. */
  | { type: 'selection/changed'; botId: string | null }
  /** The server's count after a read or unread mark. */
  | { type: 'unread/set'; botId: string; count: number }
  /**
   * The socket came back. Any `*.changed` frame sent while it was down
   * is lost, so every Work view refetches rather than trusting it saw them all.
   */
  | { type: 'work/resync' }
  | { type: 'ws/frame'; frame: ServerFrame };

/**
 * Mark this bot as working, from now — unless it already is.
 *
 * Idempotent on purpose: a turn announces itself several times over (the send
 * lands, the draft is created, the status goes THINKING), and each of those
 * would otherwise restart the clock the operator is reading. The FIRST of
 * them is the one that matters, because it is the earliest moment the client
 * knows something is happening.
 */
function withActivityStarted(state: ChatState, botId: string, status?: BotStatus): ChatState {
  const current = state.activityByBot[botId];
  if (current !== undefined && (status === undefined || current.status === status)) return state;
  const next: TurnActivity = {
    startedAt: current?.startedAt ?? Date.now(),
    ...(status === undefined ? {} : { status }),
  };
  return { ...state, activityByBot: { ...state.activityByBot, [botId]: next } };
}

function withActivityCleared(state: ChatState, botId: string): ChatState {
  if (state.activityByBot[botId] === undefined) return state;
  const next = { ...state.activityByBot };
  delete next[botId];
  return { ...state, activityByBot: next };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'seat-control/reset':
      return Object.keys(state.seatControlByBot).length === 0
        ? state
        : { ...state, seatControlByBot: {} };
    case 'usage/dismissed':
      return state.usageNotice === null ? state : { ...state, usageNotice: null };
    case 'bots/loading':
      return { ...state, botsStatus: 'loading', botsError: null };

    case 'bots/loaded': {
      // The repair for a turn whose ending this client never saw.
      // Every server-side ending writes a status (IDLE on a clean stop or a
      // cancel, ERROR on a failure), but a socket that was down for the one
      // frame that said so would leave a spinner running forever. The roster
      // is the durable version of the same fact, so a bot the server says is
      // idle stops being "working" here — unless a reply is mid-stream, which
      // is what the roster itself reports.
      const settled: ChatState = {
        ...state,
        bots: action.bots,
        botsStatus: 'ready',
        botsError: null,
        // The server's count wins on every read of the roster. Keep the local
        // count for the bot on screen: its read mark may still be in flight,
        // or the operator may have explicitly marked it unread.
        unreadByBot: Object.fromEntries(
          action.bots.map((bot) => [
            bot.id,
            bot.id === state.viewedBotId ? (state.unreadByBot[bot.id] ?? 0) : bot.unreadCount,
          ]),
        ),
      };
      return action.bots.reduce(
        (current, bot) =>
          bot.status === 'THINKING' || bot.status === 'ACTING'
            ? current
            : withActivityCleared(current, bot.id),
        settled,
      );
    }

    case 'bots/failed':
      return { ...state, botsStatus: 'error', botsError: action.error };

    case 'bot/patched':
      return {
        ...state,
        bots: state.bots.map((bot) => (bot.id === action.bot.id ? { ...bot, ...action.bot } : bot)),
      };

    case 'sandbox/waking':
      return {
        ...state,
        wakeByBot: { ...state.wakeByBot, [action.botId]: { kind: 'waking' } },
      };

    case 'sandbox/settled':
      return {
        ...mergeSandbox(state, action.botId, {
          state: action.status.state,
          widthPx: action.status.widthPx,
          heightPx: action.status.heightPx,
          lastError: action.status.lastError,
        }),
        // The call answered, whatever it answered. A settled row is the honest
        // thing to render from now on, so the request's own status steps aside
        // rather than competing with it.
        wakeByBot: withoutWake(state.wakeByBot, action.botId),
      };

    case 'sandbox/wakeFailed':
      return {
        ...state,
        wakeByBot: {
          ...state.wakeByBot,
          [action.botId]:
            action.error.code === 'SANDBOX_CAPACITY'
              ? { kind: 'capacity', message: action.error.message }
              : { kind: 'failed', message: action.error.message },
        },
      };

    case 'recording/starting': {
      const current = state.recordingByBot[action.botId];
      // One start at a time, and a live capture is not replaceable — the
      // server would refuse the second call anyway (REST: 409 while recording).
      // A terminal view is what a second take replaces.
      if (current !== undefined && current.kind !== 'ready' && current.kind !== 'failed')
        return state;
      return withRecording(state, action.botId, { kind: 'starting' });
    }

    case 'recording/started': {
      const current = state.recordingByBot[action.botId];
      // The WebSocket RECORDING frame and this response race; whichever arrives
      // second must not reset the counter the first one started.
      if (
        current !== undefined &&
        'recordingId' in current &&
        current.recordingId === action.recordingId
      ) {
        return state;
      }
      return withRecording(state, action.botId, {
        kind: 'recording',
        recordingId: action.recordingId,
        counts: { x11: 0, cdp: 0 },
        lastType: null,
        error: null,
      });
    }

    case 'recording/startFailed': {
      const current = state.recordingByBot[action.botId];
      if (current === undefined || current.kind !== 'starting') return state;
      return withRecording(state, action.botId, {
        kind: 'failed',
        recordingId: null,
        message: action.error.message,
      });
    }

    case 'recording/stopping': {
      const current = state.recordingByBot[action.botId];
      if (current === undefined || current.kind !== 'recording') return state;
      return withRecording(state, action.botId, {
        kind: 'stopping',
        recordingId: current.recordingId,
        counts: current.counts,
        lastType: current.lastType,
      });
    }

    case 'recording/settled':
      return withRecording(
        state,
        action.botId,
        applySettledStatus(state.recordingByBot[action.botId], action.status),
      );

    case 'recording/stopFailed': {
      const current = state.recordingByBot[action.botId];
      if (current === undefined || current.kind !== 'stopping') return state;
      // The recording is still live server-side, so the counter comes back —
      // with the reason the press did not land beside it, and the button
      // offered again.
      return withRecording(state, action.botId, {
        kind: 'recording',
        recordingId: current.recordingId,
        counts: current.counts,
        lastType: current.lastType,
        error: t('recording.stopFailed', { reason: action.error.message }),
      });
    }

    case 'recording/discarded': {
      // A start that failed has no id, so there is no row to discard — the
      // card is cleared locally. Any other phase reaches here only through a
      // discard response, which already removed the view; re-removing is the
      // same answer.
      return withRecording(state, action.botId, undefined);
    }

    case 'recording/discardFailed':
      return withDiscardFailure(state, action.botId, action.error.message);

    case 'recording/skillVersion': {
      const current = state.recordingByBot[action.botId];
      // Only a settled card carries a skill id to update; every other kind
      // either has no draft yet or is already off screen.
      if (current === undefined || current.kind !== 'ready') return state;
      if (current.skillId === action.skillId) return state;
      return withRecording(state, action.botId, { ...current, skillId: action.skillId });
    }

    case 'groups/loaded':
      return { ...state, groups: action.groups };

    case 'group/saved': {
      const exists = state.groups.some((group) => group.id === action.group.id);
      const groups = exists
        ? state.groups.map((group) => (group.id === action.group.id ? action.group : group))
        : [...state.groups, action.group];
      // The server's order: sort order, then creation. A move changes
      // `sortOrder`, and the sidebar reads the order off this array.
      return {
        ...state,
        groups: [...groups].sort(
          (a, b) =>
            a.sortOrder - b.sortOrder ||
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
      };
    }

    case 'group/removed':
      return {
        ...state,
        groups: state.groups.filter((group) => group.id !== action.groupId),
        // The foreign key moved these bots to Unassigned on the server; saying
        // so here as well keeps them out of a header that no longer exists
        // until the roster is re-read.
        bots: state.bots.map((bot) =>
          bot.groupId === action.groupId ? { ...bot, groupId: null } : bot,
        ),
      };

    case 'selection/changed':
      return action.botId === null
        ? { ...state, viewedBotId: null }
        : {
            ...state,
            viewedBotId: action.botId,
            unreadByBot: { ...state.unreadByBot, [action.botId]: 0 },
          };

    case 'unread/set':
      return { ...state, unreadByBot: { ...state.unreadByBot, [action.botId]: action.count } };

    case 'work/resync':
      return bumpWork(state, ALL_WORK_KINDS);

    case 'ws/frame': {
      const next = applyFrame(state, action.frame);
      // A teammate's message is complete on `message.created`. Counted from
      // the frame alone: the settled transcript is the chat client's,
      // and a double count lasts only until `bots/loaded` takes the server's.
      if (action.frame.type === 'message.created') {
        const { payload, botId } = action.frame;
        if (
          botId !== undefined &&
          botId !== state.viewedBotId &&
          payload.author === 'BOT' &&
          payload.fromBotId !== null &&
          payload.fromBotId !== botId
        ) {
          return {
            ...next,
            unreadByBot: { ...next.unreadByBot, [botId]: (next.unreadByBot[botId] ?? 0) + 1 },
          };
        }
      }
      return next;
    }
  }
}

/**
 * A discard that did not land, folded onto the view it failed to remove.
 *
 * Every phase keeps its shape and gains the reason: a live capture goes on
 * counting, a compile goes on compiling, a ready card goes on offering its
 * draft — the press failed, it did not move the recording anywhere. A FAILED
 * view is the one that ignores it: its message is the compile's own reason,
 * which is more useful than this one, and the discard button stays on
 * offer either way.
 */
function withDiscardFailure(state: ChatState, botId: string, reason: string): ChatState {
  const current = state.recordingByBot[botId];
  if (current === undefined) return state;
  const error = t('recording.discardFailed', { reason });
  switch (current.kind) {
    case 'recording':
    case 'compiling':
    case 'ready':
      return withRecording(state, botId, { ...current, error });
    case 'starting':
    case 'stopping':
    case 'failed':
      return state;
  }
}

/**
 * Patch the columns a REST start body and a WebSocket `sandbox.state` frame have in
 * common, on the row that already exists.
 *
 * Never creates one. `Sandbox` carries `sessionId`, `containerId` and the port
 * fields, and inventing them would put a half-built row in front of a
 * component that reads them — the same reason `bot/patched` merges rather than
 * substitutes. A bot with no row yet is repaired by the `GET /bots` refetch
 * `useChat` issues when a frame arrives for one.
 */
function mergeSandbox(
  state: ChatState,
  botId: string,
  patch: Partial<NonNullable<BotWithSandbox['sandbox']>>,
): ChatState {
  const bots = state.bots.map((bot) =>
    bot.id === botId && bot.sandbox !== null
      ? { ...bot, sandbox: { ...bot.sandbox, ...patch } }
      : bot,
  );
  return bots.every((bot, index) => bot === state.bots[index]) ? state : { ...state, bots };
}

/** Drop one bot's wake entry, leaving the map untouched when it had none. */
function withoutWake(wakeByBot: ChatState['wakeByBot'], botId: string): ChatState['wakeByBot'] {
  if (wakeByBot[botId] === undefined) return wakeByBot;
  const next = { ...wakeByBot };
  delete next[botId];
  return next;
}

/**
 * Set (or clear) one bot's recording view, preserving state identity when the
 * view did not change — the same discipline `sandbox.state` keeps, because
 * frames arrive at up to ten a second and every no-op that copies the map
 * re-renders the sidebar.
 */
function withRecording(
  state: ChatState,
  botId: string,
  view: RecordingView | undefined,
): ChatState {
  const current = state.recordingByBot[botId];
  if (view === current) return state;
  if (view === undefined) {
    if (current === undefined) return state;
    const next = { ...state.recordingByBot };
    delete next[botId];
    return { ...state, recordingByBot: next };
  }
  return { ...state, recordingByBot: { ...state.recordingByBot, [botId]: view } };
}

/** A view that names a recording, under any of the kinds that do. */
function namesRecording(
  view: RecordingView,
): view is Extract<RecordingView, { recordingId: string | null }> {
  return 'recordingId' in view;
}

/**
 * Resolve which bot a recording frame belongs to. The envelope's `botId` is
 * optional in WebSocket, so a frame without one is matched by the recording id it
 * names — the same repair `botIdForMessage` performs for deltas.
 */
function botIdForRecording(
  state: ChatState,
  frameBotId: string | undefined,
  recordingId: string,
): string | undefined {
  if (frameBotId !== undefined) return frameBotId;
  for (const [botId, view] of Object.entries(state.recordingByBot)) {
    if (view !== undefined && namesRecording(view) && view.recordingId === recordingId)
      return botId;
  }
  return undefined;
}

function countsEqual(a: RecordingCounts, b: RecordingCounts): boolean {
  return a.x11 === b.x11 && a.cdp === b.cdp;
}

/**
 * WebSocket `recording.event` — cumulative counts, plus the kind of the event that
 * produced them.
 *
 * Three adoption rules, all of them about a client that is not the one that
 * started the capture:
 *
 * - No view, or an id that does not match one: the tee only emits while a
 * recording is live, so the frame is evidence a capture exists — adopt it.
 * Without this a window that reloaded mid-recording would show nothing
 * while its bot's desktop kept being recorded, and no way to stop it.
 * - A view already counting: the frame replaces the counts (they describe
 * the trace, not this window's observations).
 * - A settled view for the same recording: ignore. The throttled frame was
 * queued while capture was ending and must not put a counter back next to
 * a finished recording.
 */
function applyRecordingEvent(
  view: RecordingView | undefined,
  recordingId: string,
  counts: RecordingCounts,
  lastType: string,
): RecordingView | undefined {
  if (view !== undefined && namesRecording(view) && view.recordingId === recordingId) {
    if (view.kind === 'recording' || view.kind === 'stopping') {
      return countsEqual(view.counts, counts) && view.lastType === lastType
        ? view
        : { ...view, counts, lastType };
    }
    return view;
  }
  if (
    view === undefined ||
    view.kind === 'starting' ||
    view.kind === 'ready' ||
    view.kind === 'failed'
  ) {
    return { kind: 'recording', recordingId, counts, lastType, error: null };
  }
  return view;
}

/**
 * WebSocket `recording.state` — one transition of the row.
 *
 * Forward-only: the frames for a recording arrive in the order the server
 * settled it, but this window's own view can already be ahead (the stop
 * response landed first), so a transition that would move the view backwards
 * is stale news and dropped. `RECORDING` never rewrites a view that is
 * already stopping — the stop was a later decision than the frame.
 */
function applyRecordingState(
  view: RecordingView | undefined,
  recordingId: string,
  state: RecordingState,
): RecordingView | undefined {
  if (view !== undefined && namesRecording(view) && view.recordingId === recordingId) {
    switch (state) {
      case 'RECORDING':
        return view;
      case 'COMPILING':
        return view.kind === 'recording' || view.kind === 'stopping'
          ? { kind: 'compiling', recordingId, counts: view.counts, error: null }
          : view;
      case 'READY':
        return view.kind === 'recording' || view.kind === 'stopping' || view.kind === 'compiling'
          ? {
              kind: 'ready',
              recordingId,
              counts: view.counts,
              skillId: null,
              skillName: null,
              warning: null,
              error: null,
            }
          : view;
      case 'FAILED':
        return view.kind === 'recording' || view.kind === 'stopping' || view.kind === 'compiling'
          ? { kind: 'failed', recordingId, message: recordingFailedMessage() }
          : view;
      case 'DISCARDED':
        return undefined;
    }
  }
  // Nothing on screen — or a view whose id cannot be this frame's. A
  // transition into RECORDING still means a capture is live (this window just
  // has not seen one begin), so it is adopted; a terminal state for an
  // unknown recording is not news until a read gives it shape.
  if (
    state === 'RECORDING' &&
    (view === undefined ||
      view.kind === 'starting' ||
      view.kind === 'ready' ||
      view.kind === 'failed')
  ) {
    return {
      kind: 'recording',
      recordingId,
      counts: { x11: 0, cdp: 0 },
      lastType: null,
      error: null,
    };
  }
  return view;
}

/** WebSocket `skill.compiled` — the draft exists; name it. */
function applySkillCompiled(
  view: RecordingView | undefined,
  recordingId: string,
  skillId: string,
  skillName: string,
): RecordingView | undefined {
  if (view === undefined || !namesRecording(view) || view.recordingId !== recordingId) return view;
  switch (view.kind) {
    case 'ready':
      return view.skillId === skillId && view.skillName === skillName
        ? view
        : { ...view, skillId, skillName };
    case 'compiling':
      return {
        kind: 'ready',
        recordingId,
        counts: view.counts,
        skillId,
        skillName,
        warning: null,
        error: null,
      };
    case 'recording':
    case 'stopping':
      // The compile only runs after capture ended; a view still showing a
      // counter is simply behind, and the skill is the newer fact.
      return {
        kind: 'ready',
        recordingId,
        counts: view.counts,
        skillId,
        skillName,
        warning: null,
        error: null,
      };
    case 'failed':
      return view;
  }
}

/**
 * A `RecordingStatusResponse` folded onto the view — the stop response, or
 * the read after a terminal frame that the warning is fetched by.
 *
 * Forward-only like the frames, and adoption-tolerant like them too: a read
 * that arrives for an unknown id is what tells a reloaded window that the
 * recording it missed has finished — and whether a skill came out of it.
 */
function applySettledStatus(
  view: RecordingView | undefined,
  status: RecordingStatusResponse,
): RecordingView | undefined {
  const counts: RecordingCounts = { x11: status.counts.x11, cdp: status.counts.cdp };

  if (view === undefined || !namesRecording(view) || view.recordingId !== status.id) {
    switch (status.state) {
      case 'RECORDING':
        return { kind: 'recording', recordingId: status.id, counts, lastType: null, error: null };
      case 'COMPILING':
        return { kind: 'compiling', recordingId: status.id, counts, error: null };
      case 'READY':
        return {
          kind: 'ready',
          recordingId: status.id,
          counts,
          skillId: status.skillId,
          skillName: null,
          warning: status.warning,
          error: null,
        };
      case 'FAILED':
        return failedFrom(status);
      case 'DISCARDED':
        return undefined;
    }
  }

  switch (view.kind) {
    case 'recording':
    case 'stopping':
      switch (status.state) {
        case 'RECORDING':
          return countsEqual(view.counts, counts) ? view : { ...view, counts };
        case 'COMPILING':
          return { kind: 'compiling', recordingId: status.id, counts, error: null };
        case 'READY':
          return {
            kind: 'ready',
            recordingId: status.id,
            counts,
            skillId: status.skillId,
            skillName: null,
            warning: status.warning,
            error: null,
          };
        case 'FAILED':
          return failedFrom(status);
        case 'DISCARDED':
          return undefined;
      }
      break;
    case 'compiling':
      switch (status.state) {
        case 'READY':
          return {
            kind: 'ready',
            recordingId: status.id,
            counts,
            skillId: status.skillId,
            skillName: null,
            warning: status.warning,
            error: null,
          };
        case 'FAILED':
          return failedFrom(status);
        case 'COMPILING':
          return countsEqual(view.counts, counts) ? view : { ...view, counts };
        case 'RECORDING':
          return view;
        case 'DISCARDED':
          return undefined;
      }
      break;
    case 'ready':
      switch (status.state) {
        case 'READY': {
          // Keep a name and skill id that a `skill.compiled` frame already
          // delivered; the read may predate the compiler's write.
          const skillId = status.skillId ?? view.skillId;
          return countsEqual(view.counts, counts) &&
            skillId === view.skillId &&
            status.warning === view.warning
            ? view
            : { ...view, counts, skillId, warning: status.warning };
        }
        case 'RECORDING':
        case 'COMPILING':
        case 'FAILED':
          return view;
        case 'DISCARDED':
          return undefined;
      }
      break;
    case 'failed':
      return status.state === 'DISCARDED' ? undefined : view;
  }
  return view;
}

/**
 * What a deletion leaves this reducer to do.
 *
 * The transcript itself is the chat client's, which takes the same
 * frame. What is left here is the badge: a cleared conversation has nothing
 * unread in it, and the server's own count arrives with the next `GET /bots`.
 */
function withMessagesCleared(state: ChatState, botId: string): ChatState {
  if (state.unreadByBot[botId] === 0) return state;
  return { ...state, unreadByBot: { ...state.unreadByBot, [botId]: 0 } };
}

function applyFrame(state: ChatState, frame: ServerFrame): ChatState {
  switch (frame.type) {
    /**
     * The transcript is the chat client's, so these frames leave the
     * reducer with one thing each, or nothing at all.
     *
     * Every one of them is a fact about the run, and a run reaches the window
     * through its own delivery log: the client reads the same news
     * there, in order, with a replay for the part it missed. Writing it twice
     * is how the reply would be painted twice. They stay listed rather than
     * folded into a default so a WebSocket event added later is still a compile
     * error here.
     */
    case 'message.created': {
      const botId = frame.botId ?? frame.payload.fromBotId;
      if (botId === null || botId === undefined) return state;
      // The one thing left. A BOT draft means a turn is under way, and
      // a turn this client did not start — a routine, a teammate's
      // delegation — is still a turn the operator should see working. A
      // foreign BOT row is a delivered message, complete on arrival, so it
      // says nothing about anyone working.
      const foreign =
        frame.payload.author === 'BOT' &&
        frame.payload.fromBotId !== null &&
        frame.payload.fromBotId !== botId;
      return frame.payload.author === 'BOT' && !foreign ? withActivityStarted(state, botId) : state;
    }

    case 'message.attachments':
      return state;

    case 'message.deleted': {
      const { botId, cleared } = frame.payload;
      // Only a cleared conversation changes anything here, and only
      // the badge. Deleting some of a conversation's messages leaves the
      // count to the server's own answer on the next `GET /bots`.
      return cleared === true ? withMessagesCleared(state, botId) : state;
    }

    case 'bot.status': {
      const withStatus: ChatState = {
        ...state,
        bots: state.bots.map((bot) =>
          bot.id === frame.payload.botId ? { ...bot, status: frame.payload.status } : bot,
        ),
      };
      // CC-44. CC-25 makes this the authoritative pair of edges: a turn opens
      // THINKING and ends IDLE, and the IDLE lands after the reply completed.
      // AWAITING_APPROVAL ends the indicator too — the bot is not working, it
      // is waiting on the operator, and the prompt below is what they should
      // be reading instead of a spinner.
      const status = frame.payload.status;
      return status === 'THINKING' || status === 'ACTING'
        ? withActivityStarted(withStatus, frame.payload.botId, status)
        : withActivityCleared(withStatus, frame.payload.botId);
    }

    case 'error': {
      // `detail` is for logs. Only the neutral message reaches state.
      const error: ChatError = { code: frame.payload.code, message: frame.payload.message };
      // A seat-control refusal is the screen pane's own news. The control
      // state frames already say who holds the seat, and a refused renew,
      // release or takeover changed nothing — in the failure banner it only
      // reads as a reply that failed, which it is not.
      if (SEAT_REFUSAL_CODES.has(error.code)) return state;
      const botId = frame.botId;
      if (botId === undefined) return { ...state, lastError: error };
      // A display outage says nothing about the agent turn or its approvals.
      if (error.code === 'SCREEN_STREAM_LOST') {
        return { ...state, errorByBot: { ...state.errorByBot, [botId]: error } };
      }
      // A failed turn is an ended turn, whatever the status frames do
      // or do not arrive afterwards.
      // The chat client reads the run's own terminal event for the
      // partial reply the server persisted, so what is left is the operator's
      // sentence.
      return {
        ...withActivityCleared(state, botId),
        errorByBot: { ...state.errorByBot, [botId]: error },
      };
    }

    case 'screen.control.state': {
      const next = frame.payload;
      const previous = state.seatControlByBot[next.botId];
      if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return state;
      return { ...state, seatControlByBot: { ...state.seatControlByBot, [next.botId]: next } };
    }
    case 'sandbox.state': {
      // The screen card decides everything from this: whether to subscribe at
      // all, and the geometry its synthetic ServerInit declares. Without it the
      // sandbox row only ever reflects the `GET /bots` fetch, so a desktop that
      // came up after the app did would never be watchable until a reload.
      // A row is patched, never created: `Sandbox` has columns this payload
      // does not carry, and inventing them would put a half-built row in front
      // of a component that reads `containerId` and the port fields.
      const { botId, state: sandboxState, widthPx, heightPx } = frame.payload;
      const merged = mergeSandbox(state, botId, { state: sandboxState, widthPx, heightPx });
      // A computer that is up ends any outstanding request for it, including
      // one this window never made — a skill or a recording wakes the same
      // desktop, and a stale "the host is full" left over from an
      // earlier refusal must not reappear the next time it stops.
      // Only RUNNING clears it. Any other state would let a STOPPED frame
      // still in flight from the moment before the click answer the click.
      const wakeByBot =
        sandboxState === 'RUNNING' ? withoutWake(state.wakeByBot, botId) : state.wakeByBot;
      // Identity is load-bearing here: a frame that changed nothing must return
      // the SAME state, or every memoized consumer re-renders on a poll.
      return merged === state && wakeByBot === state.wakeByBot ? state : { ...merged, wakeByBot };
    }

    // the teaching flow, wired from the frames emits

    case 'recording.event': {
      // One frame per ~100 ms carries the trace's cumulative length — the
      // count the acceptance means by "a live event counter".
      const { recordingId, counts, type } = frame.payload;
      const botId = botIdForRecording(state, frame.botId, recordingId);
      if (botId === undefined) return state;
      return withRecording(
        state,
        botId,
        applyRecordingEvent(
          state.recordingByBot[botId],
          recordingId,
          { x11: counts.x11, cdp: counts.cdp },
          type,
        ),
      );
    }

    case 'recording.state': {
      const { recordingId, state: recordingState } = frame.payload;
      const botId = botIdForRecording(state, frame.botId, recordingId);
      if (botId === undefined) return state;
      return withRecording(
        state,
        botId,
        applyRecordingState(state.recordingByBot[botId], recordingId, recordingState),
      );
    }

    case 'skill.compiled': {
      // The compiler's answer. The id and the name ride the frame; the read
      // useChat makes after a READY transition fills in what this one cannot
      // (the warning the renderer's sentence needs, D-042).
      const { recordingId, skillId, name } = frame.payload;
      const botId = botIdForRecording(state, frame.botId, recordingId);
      if (botId === undefined) return state;
      return withRecording(
        state,
        botId,
        applySkillCompiled(state.recordingByBot[botId], recordingId, skillId, name),
      );
    }

    case 'approval.resolved': {
      // The prompt itself is a client interrupt, resolved where it was
      // raised. What this frame still carries that the interrupt does not is
      // the reason a refusal gives — a policy said no, or the turn ended
      // under the question — and that is the operator's sentence.
      const { botId, reason, approved } = frame.payload;
      return approved || reason === undefined
        ? state
        : {
            ...state,
            errorByBot: {
              ...state.errorByBot,
              [botId]: { code: 'APPROVAL_REFUSED', message: reason },
            },
          };
    }

    // M5-FE-02, now D-192: the question reaches the operator as the run's own
    // interrupt, which the chat client raises and the prompt answers. This
    // frame is the same news on the other channel.
    case 'approval.requested':
      return state;

    // The roster moved (created, updated, deleted) — possibly by something
    // this window cannot see, like a bot tool acting on its operator's
    // behalf. The repair is `GET /bots`, which `useChat` issues on this
    // frame; there is nothing to derive here from an id and a verb.
    case 'bots.changed':
      return state;

    // Frames the M1 shell has no surface for yet. They are listed rather than
    // caught by a default so that a WebSocket event added later cannot be silently
    // ignored — the discriminated union makes an omission a compile error.
    case 'turn.step':
    case 'mcp.status':
      return state;
    // D-159 §3.8. The run's events arrive on its own delivery log, which the
    // TanStack chat client joins; this reducer holds no run state. What it
    // does hold is the last failure's sentence, and a new run is the moment it
    // stops being news — whoever started the run, the operator or a routine.
    case 'run.started': {
      const { botId } = frame.payload;
      if ((state.errorByBot[botId] ?? null) === null) return state;
      return { ...state, errorByBot: { ...state.errorByBot, [botId]: null } };
    }
    // A call listens for it on the bot's frames. A transcript has the
    // run's own stream, and this reducer holds no run state.
    case 'run.settled':
      return state;
    case 'usage.notice':
      return { ...state, usageNotice: frame.payload };
    case 'task.changed':
    case 'project.changed':
    case 'goal.changed':
    case 'deliverable.changed':
      return bumpWork(state, WORK_INVALIDATES[frame.type]);
  }
}
