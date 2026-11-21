import { Conversation, type Language } from '@elevenlabs/client';
import {
  speakable,
  type BotStatus,
  type RunSettledPayload,
  type StartCallResponse,
  type UpdateCallBody,
} from '@crewaid/shared';
import { t } from '../i18n/i18n';

/**
 * One call with a bot.
 *
 * The voice on the line is a shared ElevenLabs agent. What the person asks
 * for reaches the bot as an ordinary message, through the thread's own send,
 * and the bot's reply goes back to the voice to be read aloud. This file is
 * the only one that imports `@elevenlabs/client`; the session is written
 * against a narrow connection port so the state machine is tested without a
 * microphone or a network.
 *
 * A request is the message it was stored as. It is answered when the
 * server says, in `run.settled`, that a run was the last word on that
 * message: the server is the one that knows when a run hands its work to a
 * continuation, a retry or a newer message's run, and the desktop only sees
 * the runs it happens to be reading.
 *
 * While the bot works, what it is doing reaches the voice as contextual
 * updates, which ElevenLabs never answers aloud. A `user_message` is the only
 * way the platform documents to make the voice speak on the desktop's
 * initiative, so the session sends one for the answer and for a check-in
 * after a long quiet stretch, and for nothing else.
 *
 * The renderer holds no orchestration: it relays what was said in both
 * directions, and the bot's run, its tools and its approvals stay where they
 * always are.
 */

export type CallPhase = 'idle' | 'connecting' | 'live' | 'ending';

export type CallSnapshot = {
  readonly phase: CallPhase;
  /** When the line opened, for the timer; null until it does. */
  readonly connectedAt: number | null;
  /** The call's own budget, from what was left of the period when it started. */
  readonly maxDurationSeconds: number | null;
  /** The voice's most recent line, as a caption. Never stored. */
  readonly caption: string | null;
  readonly speaking: boolean;
  readonly muted: boolean;
  /** A request is with the bot and its answer has not come back yet. */
  readonly waitingOnBot: boolean;
  readonly error: string | null;
};

export const IDLE_CALL: CallSnapshot = {
  phase: 'idle',
  connectedAt: null,
  maxDurationSeconds: null,
  caption: null,
  speaking: false,
  muted: false,
  waitingOnBot: false,
  error: null,
};

/** The part of an ElevenLabs conversation the session uses. */
export type CallConnection = {
  sendUserMessage(text: string): void;
  sendContextualUpdate(text: string): void;
  sendUserActivity(): void;
  setMicMuted(muted: boolean): void;
  endSession(): Promise<void>;
};

export type CallEvents = {
  readonly connected: (conversationId: string) => void;
  readonly disconnected: () => void;
  readonly agentLine: (text: string) => void;
  /** The person finished saying something. */
  readonly userLine: () => void;
  /** Voice activity, when the agent sends it; nothing depends on it arriving. */
  readonly userSpeech: (speaking: boolean) => void;
  readonly mode: (speaking: boolean) => void;
  readonly failed: (message: string) => void;
};

export type CallDeps = {
  readonly start: (botId: string) => Promise<StartCallResponse>;
  readonly update: (callId: string, body: UpdateCallBody) => Promise<unknown>;
  readonly connect: (options: {
    readonly signedUrl: string;
    readonly overrides: StartCallResponse['overrides'];
    readonly askBot: (request: string) => string;
    readonly events: CallEvents;
    /** The chosen microphone while it is plugged in; absent is the system default. */
    readonly inputDeviceId?: string;
  }) => Promise<CallConnection>;
  /** Which microphone to open, asked as each call connects. */
  readonly microphone?: () => Promise<string | undefined>;
  /**
   * Posts the request to the bot's thread, exactly as if it were typed: the
   * stored message's id, or null when it was refused.
   */
  readonly sendToBot: (text: string) => Promise<string | null>;
  readonly now: () => number;
  readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn: (handle: unknown) => void;
  readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  readonly clearIntervalFn: (handle: unknown) => void;
};

/** How often a waiting call looks at the line. */
export const WAIT_TICK_MS = 1_000;
/**
 * How long the line has been quiet before the session tells ElevenLabs the
 * person is still there, and how often after that. Under the agent's
 * take-turn-after-silence timeout, so the voice does not fill a wait with
 * "anything else?"; long enough after speech that the activity's two seconds
 * of enforced silence never land on a reply the voice is about to give.
 */
export const QUIET_ACTIVITY_MS = 4_000;
/** A quiet stretch this long while the bot works earns one spoken check-in. */
export const CHECK_IN_QUIET_MS = 45_000;
/** The least time between two work-status updates about progress. */
export const PROGRESS_EVERY_MS = 10_000;
/** How long after the voice stops speaking an answer waits, for a reply in flight. */
export const ANSWER_PAUSE_MS = 1_200;
/**
 * How long the bot may sit idle with a request unanswered before the call
 * stops waiting. `run.settled` is the answer; this covers a run that ended
 * without one, such as a worker that died.
 */
export const IDLE_GIVE_UP_MS = 20_000;
/** How long the time limit waits for the voice to finish its sentence. */
const FINISH_SENTENCE_MS = 5_000;
/** Settled frames remembered for a send still resolving its id. */
const EARLY_SETTLED_KEPT = 20;

/** The framing the call's prompt teaches the voice to read verbatim. */
export function relayLine(botName: string, text: string): string {
  return `Read this answer to the user as ${botName}: ${text}`;
}

/** The framing the call's prompt teaches the voice to answer with one sentence. */
export function checkInLine(botName: string): string {
  return `Give the user a short update on how the work is going, as ${botName}.`;
}

/** How the work status names a settled request's ending. */
const ENDINGS: Readonly<Record<RunSettledPayload['outcome'], string>> = {
  completed: 'finished',
  failed: 'could not finish',
  stopped: 'stopped',
};

/** What the voice says when a run ended without an answer to read. */
export function settledLine(outcome: RunSettledPayload['outcome'], reply: string | null): string {
  if (outcome === 'stopped') return t('voice.callSession.iStoppedWorkingOnThat');
  if (outcome === 'failed') return t('voice.callSession.iCouldnTFinishThat');
  const said = reply === null ? '' : speakable(reply);
  return said === '' ? t('voice.callSession.iVeFinishedTheDetails') : said;
}

export class CallSession {
  private snapshot: CallSnapshot = IDLE_CALL;
  private connection: CallConnection | null = null;
  private callId: string | null = null;
  private limitTimer: unknown = null;
  private waitTimer: unknown = null;
  private answerTimer: unknown = null;
  private idleTimer: unknown = null;
  /** The call's requests the bot has, by stored message id. */
  private readonly requests = new Map<string, string>();
  /** Requests whose send has not resolved yet. */
  private readonly sending = new Set<string>();
  private readonly earlySettled = new Map<string, RunSettledPayload>();
  private readonly answers: string[] = [];
  private botStatus: BotStatus | null = null;
  private approvalPending = false;
  private userSpeaking = false;
  /** When anyone last spoke on the line, or the session last made the voice speak. */
  private lineAt = 0;
  private activityAt = Number.NEGATIVE_INFINITY;
  private checkInAt = 0;
  private progress: string | null = null;
  private progressSent: string | null = null;
  private progressAt = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(
    private readonly deps: CallDeps,
    private readonly bot: { readonly id: string; readonly name: string },
    private readonly onChange: (snapshot: CallSnapshot) => void,
  ) {}

  get state(): CallSnapshot {
    return this.snapshot;
  }

  async start(): Promise<void> {
    if (this.snapshot.phase !== 'idle') return;
    this.set({ ...IDLE_CALL, phase: 'connecting' });
    let call: StartCallResponse;
    try {
      call = await this.deps.start(this.bot.id);
    } catch (failure) {
      this.set({ ...IDLE_CALL, error: messageOf(failure) });
      return;
    }
    this.callId = call.callId;
    this.set({ maxDurationSeconds: call.overrides.maxDurationSeconds });
    try {
      const inputDeviceId = await this.deps.microphone?.();
      this.connection = await this.deps.connect({
        signedUrl: call.signedUrl,
        overrides: call.overrides,
        ...(inputDeviceId !== undefined && { inputDeviceId }),
        askBot: (request) => this.ask(request),
        events: {
          connected: (conversationId) => this.connected(conversationId),
          disconnected: () => void this.finish(false),
          agentLine: (text) => this.set({ caption: captionOf(text) }),
          userLine: () => {
            this.lineAt = this.deps.now();
          },
          userSpeech: (speaking) => {
            // Scores arrive many times a second: only an edge is speech.
            if (speaking === this.userSpeaking) return;
            this.userSpeaking = speaking;
            this.lineAt = this.deps.now();
            if (!speaking) this.scheduleAnswers();
          },
          mode: (speaking) => {
            this.lineAt = this.deps.now();
            this.set({ speaking });
            if (!speaking) this.scheduleAnswers();
          },
          failed: (message) => this.set({ error: message }),
        },
      });
    } catch {
      // The line never opened: the server settles this call to nothing.
      await this.report({ ended: true });
      this.set({ ...IDLE_CALL, error: t('voice.callSession.theCallCouldntConnect') });
      return;
    }
    // Hung up while the line was still opening.
    if (this.closed) await this.connection.endSession().catch(() => undefined);
  }

  /**
   * `run.settled` for this bot. Answers the call's requests among the
   * messages it names; a frame for someone else's message changes nothing.
   */
  runSettled(settled: RunSettledPayload): void {
    if (this.snapshot.phase !== 'live') return;
    const answered = settled.messageIds.filter((id) => this.requests.has(id));
    if (answered.length === 0) {
      // The send that stored one of these may not have resolved its id yet.
      for (const id of settled.messageIds) this.earlySettled.set(id, settled);
      while (this.earlySettled.size > EARLY_SETTLED_KEPT) {
        const oldest = this.earlySettled.keys().next().value;
        if (oldest === undefined) break;
        this.earlySettled.delete(oldest);
      }
      return;
    }
    this.answer(answered, ENDINGS[settled.outcome], settledLine(settled.outcome, settled.reply));
  }

  /** `bot.status` for this bot: an idle bot with a request unanswered is a run that ended unheard. */
  botStatusChanged(status: BotStatus): void {
    this.botStatus = status;
    if (status === 'IDLE' || status === 'ERROR') this.armIdleGiveUp();
    else this.clearIdleGiveUp();
  }

  /** What the bot is visibly doing, for the voice's work status. */
  runProgress(progress: string | null): void {
    if (this.requests.size > 0) this.progress = progress;
  }

  /** The bot is waiting on an approval: only the card on screen can answer it. */
  approvalWaiting(): void {
    if (this.connection === null || this.snapshot.phase !== 'live') return;
    this.approvalPending = true;
    this.connection.sendContextualUpdate(
      'Work status: waiting for the user to answer an approval on screen.',
    );
    this.say(t('voice.callSession.approveOnScreen'));
  }

  /** Every approval on screen has an answer. */
  approvalsAnswered(): void {
    if (!this.approvalPending) return;
    this.approvalPending = false;
    if (this.snapshot.phase !== 'live') return;
    this.connection?.sendContextualUpdate(
      'Work status: the approval was answered; work carries on.',
    );
  }

  setMuted(muted: boolean): void {
    this.connection?.setMicMuted(muted);
    this.set({ muted });
  }

  /** Hang up: on the button, a bot switch, the window closing, or the limit. */
  async hangUp(): Promise<void> {
    if (this.snapshot.phase === 'idle' || this.snapshot.phase === 'ending') return;
    this.closed = true;
    await this.finish(true);
  }

  private connected(conversationId: string): void {
    this.lineAt = this.deps.now();
    this.set({ phase: 'live', connectedAt: this.deps.now() });
    void this.report({ conversationId });
    const limit = this.snapshot.maxDurationSeconds;
    if (limit !== null) {
      this.limitTimer = this.deps.setTimeoutFn(() => this.atLimit(), limit * 1000);
    }
  }

  /** At the limit, let the voice finish its sentence rather than cut it. */
  private atLimit(): void {
    if (!this.snapshot.speaking) {
      void this.hangUp();
      return;
    }
    this.limitTimer = this.deps.setTimeoutFn(() => void this.hangUp(), FINISH_SENTENCE_MS);
  }

  private ask(request: string): string {
    this.lineAt = this.deps.now();
    if (this.snapshot.phase !== 'live') return 'The call has ended.';
    // The voice can call the tool twice for one sentence; the bot gets it once.
    if (this.sending.has(request) || [...this.requests.values()].includes(request))
      return 'Already in progress.';
    this.sending.add(request);
    this.waiting();
    void this.deliver(request);
    return 'Sent.';
  }

  private async deliver(request: string): Promise<void> {
    let id: string | null = null;
    try {
      id = await this.deps.sendToBot(request);
    } catch {
      // A transport rejection and a refused send need the same spoken retry.
    }
    this.sending.delete(request);
    if (this.snapshot.phase !== 'live' || this.connection === null) return;
    if (id === null) {
      this.connection.sendContextualUpdate(
        `Work status: ${JSON.stringify(request)} did not reach the work; ask the user to say it again.`,
      );
      this.say(t('voice.callSession.didntReachMe'));
      this.waiting();
      return;
    }
    this.requests.set(id, request);
    this.connection.sendContextualUpdate(`Work status: working on ${JSON.stringify(request)}.`);
    const early = this.earlySettled.get(id);
    if (early !== undefined) {
      this.earlySettled.delete(id);
      this.answer([id], ENDINGS[early.outcome], settledLine(early.outcome, early.reply));
      return;
    }
    if (this.botStatus === 'IDLE' || this.botStatus === 'ERROR') this.armIdleGiveUp();
  }

  /** Ends the wait for these requests, and queues `line` to be read aloud. */
  private answer(ids: readonly string[], ending: string, line: string): void {
    const asked = ids.flatMap((id) => {
      const request = this.requests.get(id);
      this.requests.delete(id);
      return request === undefined ? [] : [request];
    });
    if (asked.length === 0) return;
    const named = asked.map((text) => JSON.stringify(text)).join(', ');
    this.connection?.sendContextualUpdate(`Work status: ${ending} ${named}. The answer follows.`);
    this.answers.push(line);
    this.waiting();
    this.flushAnswers();
  }

  /** Starts or stops the wait loop to match what is outstanding. */
  private waiting(): void {
    const outstanding = this.requests.size > 0 || this.sending.size > 0;
    if (outstanding !== this.snapshot.waitingOnBot) this.set({ waitingOnBot: outstanding });
    if (!outstanding) {
      this.progress = null;
      this.progressSent = null;
      this.clearIdleGiveUp();
    }
    if (outstanding && this.waitTimer === null) {
      this.checkInAt = this.deps.now();
      this.waitTimer = this.deps.setIntervalFn(() => this.tick(), WAIT_TICK_MS);
    } else if (!outstanding && this.waitTimer !== null) {
      this.deps.clearIntervalFn(this.waitTimer);
      this.waitTimer = null;
    }
  }

  private tick(): void {
    const connection = this.connection;
    if (connection === null || this.snapshot.phase !== 'live') return;
    const now = this.deps.now();
    if (
      this.progress !== null &&
      this.progress !== this.progressSent &&
      now - this.progressAt >= PROGRESS_EVERY_MS
    ) {
      this.progressSent = this.progress;
      this.progressAt = now;
      connection.sendContextualUpdate(`Work status: in progress. ${this.progress}`);
    }
    if (this.snapshot.speaking || this.userSpeaking || this.answers.length > 0) return;
    const quiet = now - this.lineAt;
    if (
      this.requests.size > 0 &&
      !this.approvalPending &&
      quiet >= CHECK_IN_QUIET_MS &&
      now - this.checkInAt >= CHECK_IN_QUIET_MS
    ) {
      this.checkInAt = now;
      this.lineAt = now;
      connection.sendUserMessage(checkInLine(this.bot.name));
      return;
    }
    if (quiet >= QUIET_ACTIVITY_MS && now - this.activityAt >= QUIET_ACTIVITY_MS) {
      this.activityAt = now;
      connection.sendUserActivity();
    }
  }

  private say(text: string): void {
    this.lineAt = this.deps.now();
    this.connection?.sendUserMessage(relayLine(this.bot.name, text));
  }

  private scheduleAnswers(): void {
    if (this.answers.length === 0) return;
    if (this.answerTimer !== null) this.deps.clearTimeoutFn(this.answerTimer);
    // The person may be answering the voice: give their reply time to start.
    this.answerTimer = this.deps.setTimeoutFn(() => {
      this.answerTimer = null;
      this.flushAnswers();
    }, ANSWER_PAUSE_MS);
  }

  private flushAnswers(): void {
    if (this.snapshot.phase !== 'live' || this.snapshot.speaking || this.userSpeaking) return;
    if (this.answers.length > 0) this.say(this.answers.splice(0).join('\n'));
  }

  private armIdleGiveUp(): void {
    if (this.requests.size === 0 || this.idleTimer !== null) return;
    this.idleTimer = this.deps.setTimeoutFn(() => {
      this.idleTimer = null;
      if (this.botStatus !== 'IDLE' && this.botStatus !== 'ERROR') return;
      this.answer(
        [...this.requests.keys()],
        'stopped',
        t('voice.callSession.iveStoppedDetailsOnScreen'),
      );
    }, IDLE_GIVE_UP_MS);
  }

  private clearIdleGiveUp(): void {
    if (this.idleTimer !== null) this.deps.clearTimeoutFn(this.idleTimer);
    this.idleTimer = null;
  }

  private async finish(endLine: boolean): Promise<void> {
    if (this.snapshot.phase === 'idle' || this.snapshot.phase === 'ending') return;
    this.set({ phase: 'ending' });
    for (const timer of [this.limitTimer, this.answerTimer, this.idleTimer]) {
      if (timer !== null) this.deps.clearTimeoutFn(timer);
    }
    if (this.waitTimer !== null) this.deps.clearIntervalFn(this.waitTimer);
    this.limitTimer = null;
    this.answerTimer = null;
    this.idleTimer = null;
    this.waitTimer = null;
    this.requests.clear();
    this.sending.clear();
    this.earlySettled.clear();
    this.answers.length = 0;
    this.progress = null;
    this.progressSent = null;
    this.approvalPending = false;
    this.userSpeaking = false;
    const connection = this.connection;
    this.connection = null;
    if (endLine && connection !== null) await connection.endSession().catch(() => undefined);
    await this.report({ ended: true });
    this.set({ ...IDLE_CALL, error: this.snapshot.error });
  }

  /** Tell the server; a failure here costs nothing the settlement cannot fix. */
  private async report(body: UpdateCallBody): Promise<void> {
    if (this.callId === null) return;
    await this.deps.update(this.callId, body).catch(() => undefined);
  }

  private set(patch: Partial<CallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onChange(this.snapshot);
  }
}

/**
 * The voice's line as a caption. Expressive voice models mark delivery with
 * bracketed tags (`[thinking]`, `[happy]`) that are performed, not said.
 */
export function captionOf(line: string): string {
  return line
    .replace(/\[[a-z][a-z ]{0,30}\]\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function messageOf(failure: unknown): string {
  if (typeof failure === 'object' && failure !== null && 'failure' in failure) {
    const inner = (failure as { failure?: { message?: unknown } }).failure;
    if (typeof inner?.message === 'string') return inner.message;
  }
  return t('voice.callSession.theCallCouldnTStart');
}

/**
 * Every agent language the server sends for a call in the person's language,
 * typed against the SDK's own list so a code it would refuse does
 * not compile. English is absent: the agent's default needs no override.
 */
const CALL_LANGUAGES: readonly Language[] = [
  'af',
  'ar',
  'bn',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'fi',
  'fr',
  'ha',
  'he',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'mr',
  'nl',
  'no',
  'pl',
  'pt-br',
  'ru',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh',
];

/** The real line, for the app. Tests pass their own `connect`. */
export const connectElevenLabs: CallDeps['connect'] = async ({
  signedUrl,
  overrides,
  askBot,
  events,
  inputDeviceId,
}) => {
  const language = CALL_LANGUAGES.find((code) => code === overrides.language);
  const conversation = await Conversation.startSession({
    signedUrl,
    connectionType: 'websocket',
    ...(inputDeviceId !== undefined && { inputDeviceId }),
    overrides: {
      agent: {
        prompt: { prompt: overrides.prompt },
        firstMessage: overrides.firstMessage,
        ...(language !== undefined && { language }),
      },
      tts: { voiceId: overrides.voiceId },
    },
    clientTools: {
      ask_bot: (parameters: unknown) => {
        const request =
          typeof parameters === 'object' && parameters !== null && 'request' in parameters
            ? String(parameters.request)
            : '';
        return request === '' ? 'Nothing was asked.' : askBot(request);
      },
    },
    onConnect: ({ conversationId }) => events.connected(conversationId),
    onDisconnect: () => events.disconnected(),
    onMessage: ({ message, role }) => {
      if (role === 'agent') events.agentLine(message);
      else if (role === 'user') events.userLine();
    },
    onModeChange: ({ mode }) => events.mode(mode === 'speaking'),
    onVadScore: ({ vadScore }) => events.userSpeech(vadScore > 0.5),
    onError: () => events.failed(t('voice.callSession.connectionProblem')),
  });
  return {
    sendUserMessage: (text) => conversation.sendUserMessage(text),
    sendContextualUpdate: (text) => conversation.sendContextualUpdate(text),
    sendUserActivity: () => conversation.sendUserActivity(),
    setMicMuted: (muted) => conversation.setMicMuted(muted),
    endSession: () => conversation.endSession(),
  };
};

/** The browser's clock and timers, for the app. */
export const browserCallTimers = {
  now: () => Date.now(),
  setTimeoutFn: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  clearTimeoutFn: (handle: unknown) => window.clearTimeout(handle as number),
  setIntervalFn: (fn: () => void, ms: number) => window.setInterval(fn, ms),
  clearIntervalFn: (handle: unknown) => window.clearInterval(handle as number),
} satisfies Pick<
  CallDeps,
  'now' | 'setTimeoutFn' | 'clearTimeoutFn' | 'setIntervalFn' | 'clearIntervalFn'
>;
