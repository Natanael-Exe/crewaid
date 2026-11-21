import type { RecordingWarning } from '@crewaid/shared';
import type { RecordingCounts, RecordingView } from '../state/chatReducer';
import { t } from '../i18n/i18n';

/**
 * What the full-screen viewer's recording cluster should show (M3-FE-01,
 * M3-FE-02).
 *
 * Pure, like `screenCardState`: the surface this draws on is a canvas noVNC
 * owns, and the suite renders with `renderToStaticMarkup` — so the decision
 * being a value is what makes it assertable at all. `RecordingControls` only
 * draws what this returns.
 */

/**
 * The sentences, picked by the RENDERER.
 *
 * The frame deliberately does not carry the reason (WebSocket `recording.state`
 * stays `{recordingId, state}`), so after a terminal transition the client
 * reads `GET /recordings/:id` and chooses the sentence here — one vocabulary,
 * chosen where it is rendered, rather than prose the API would have to keep
 * stable for every client.
 */
export const RECORDING_LIMIT_SENTENCE: Record<RecordingWarning, string> = {
  get TIME_LIMIT() {
    return t('screen.recordingCardState.stoppedAtTimeLimit');
  },
  get EVENT_LIMIT() {
    return t('screen.recordingCardState.stoppedAtEventLimit');
  },
};

/**
 * The tee's capture vocabulary, in words a person reads.
 *
 * Deliberately partial: `RecordingEvent.type` is open by design, so
 * an unfamiliar value contributes nothing rather than putting a wire token in
 * front of the operator.
 */
const CAPTURED_KIND: Readonly<Record<string, string>> = {
  get pointer() {
    return t('screen.recordingCardState.capturedPointer');
  },
  get key() {
    return t('screen.recordingCardState.capturedKey');
  },
  get type() {
    return t('screen.recordingCardState.capturedTyping');
  },
};

/** The live counter: the trace's length, plus what the newest event was. */
export function recordingCounterLabel(counts: RecordingCounts, lastType: string | null): string {
  const total = counts.x11 + counts.cdp;
  const kind = lastType === null ? undefined : CAPTURED_KIND[lastType];
  return kind === undefined
    ? t('screen.recordingCardState.events', { count: total })
    : t('screen.recordingCardState.eventsWithKind', { count: total, kind });
}

/** One thing the cluster can offer, when it can offer anything. */
export interface RecordingCardAction {
  readonly kind: 'teach' | 'stop' | 'discard' | 'review';
  readonly label: string;
  readonly disabled: boolean;
  /**
   * Three weights, so a state with two buttons cannot show two primaries:
   * the one blue action, a quiet companion, or the red-tinted stop.
   */
  readonly emphasis: 'primary' | 'quiet' | 'danger';
}

export interface RecordingCardPresentation {
  readonly phase: 'idle' | 'starting' | 'recording' | 'stopping' | 'compiling' | 'ready' | 'failed';
  /** The capture dot. */
  readonly indicator: boolean;
  /** The word beside the dot: what is happening right now. */
  readonly label: string | null;
  /** The live counter; null whenever capture is not (or no longer) live. */
  readonly counter: string | null;
  /** One sentence for everything that is not the counter. */
  readonly message: string | null;
  /** The cluster's buttons, in draw order. */
  readonly actions: readonly RecordingCardAction[];
}

const TEACH: RecordingCardAction = {
  kind: 'teach',
  get label() {
    return t('screen.recordingCardState.teachATask');
  },
  disabled: false,
  emphasis: 'primary',
};

/**
 * Teaching, once reviewing is on the table. A draft the operator has not
 * reviewed yet is the fresher obligation, so it takes the primary weight and
 * teaching steps back beside it — but it stays on offer, because recording
 * another take is a thing an operator may well want next.
 */
const TEACH_BESIDE_REVIEW: RecordingCardAction = { ...TEACH, emphasis: 'quiet' };

const STOP_LIVE: RecordingCardAction = {
  kind: 'stop',
  get label() {
    return t('screen.recordingCardState.stop');
  },
  disabled: false,
  emphasis: 'danger',
};
const STOP_BUSY: RecordingCardAction = { ...STOP_LIVE, disabled: true };

/**
 * Abandoning a take — `POST /recordings/:id/discard`, which settles
 * the recording `DISCARDED` and compiles nothing.
 *
 * Offered in every state where a capture or a compile could still be running,
 * because the person who cannot stop what they started has one recourse left
 * and it is to wait it out. Quiet beside the red Stop — the operator's default
 * is to finish, and this is the way out beside it — and red only once it
 * destroys something real (the draft in the ready state below).
 *
 * While COMPILING the reason is sharper: the press is the only action on
 * screen, and the server has supported it since M3-BE-06 (a discard that lands
 * mid-compile makes the job find no row to move and write nothing) — refusing
 * it in the UI would mean watching a wrong compile finish first.
 */
const CANCEL_LIVE: RecordingCardAction = {
  kind: 'discard',
  get label() {
    return t('screen.screenCard.cancel');
  },
  disabled: false,
  emphasis: 'quiet',
};

/** The lone action a compile in flight offers; the label is the same press. */
const CANCEL_COMPILING: RecordingCardAction = { ...CANCEL_LIVE };

/** Throwing the finished draft away — the one destructive move on this card. */
const DISCARD_DRAFT: RecordingCardAction = {
  kind: 'discard',
  get label() {
    return t('screen.recordingCardState.discardDraft');
  },
  disabled: false,
  emphasis: 'danger',
};

/** A READY recording with no draft yet, or a FAILED one: clearing the row. */
const DISCARD_QUIET: RecordingCardAction = {
  kind: 'discard',
  get label() {
    return t('screen.recordingCardState.discard');
  },
  disabled: false,
  emphasis: 'quiet',
};

/**
 * The draft a finished recording compiled into, opening the review surface.
 * Not gated on the desktop being alive: the skill exists
 * independently of the computer it was recorded on, and reviewing it — unlike
 * demonstrating one — needs nowhere to type.
 */
const REVIEW: RecordingCardAction = {
  kind: 'review',
  get label() {
    return t('screen.recordingCardState.reviewDraft');
  },
  disabled: false,
  emphasis: 'primary',
};

/**
 * The cluster's whole state, from the view `chatReducer` assembled and
 * whether a live desktop is under it.
 *
 * `live` gates the Teach action and nothing else: a recording that is already
 * running can be stopped even if the desktop under it has since died, and its
 * outcome stays readable — but a task cannot be DEMONSTRATED on a desktop
 * that is asleep, so offering to teach one would be offering a recording of
 * nothing.
 */
export function recordingCardPresentation(
  view: RecordingView | undefined,
  live: boolean,
): RecordingCardPresentation {
  const teach: RecordingCardAction | null = live ? TEACH : null;

  if (view === undefined) {
    return {
      phase: 'idle',
      indicator: false,
      label: null,
      counter: null,
      message: null,
      actions: teach === null ? [] : [teach],
    };
  }

  switch (view.kind) {
    case 'starting':
      return {
        phase: 'starting',
        indicator: false,
        label: null,
        counter: null,
        message: t('screen.recordingCardState.startingRecording'),
        actions: [],
      };
    case 'recording':
      return {
        phase: 'recording',
        indicator: true,
        label: t('screen.recordingCardState.recording'),
        counter: recordingCounterLabel(view.counts, view.lastType),
        message: view.error,
        actions: [STOP_LIVE, CANCEL_LIVE],
      };
    case 'stopping':
      return {
        phase: 'stopping',
        indicator: true,
        label: t('screen.recordingCardState.stopping'),
        counter: recordingCounterLabel(view.counts, view.lastType),
        message: null,
        // No discard here: the stop is already out, and a second terminal call
        // racing first would decide the outcome by which landed last.
        actions: [STOP_BUSY],
      };
    case 'compiling':
      return {
        phase: 'compiling',
        indicator: false,
        label: null,
        counter: null,
        message: view.error ?? t('screen.recordingCardState.compilingSkill'),
        actions: view.error === null ? [CANCEL_COMPILING] : [],
      };
    case 'ready':
      // A draft that exists can be reviewed regardless of the desktop; a
      // fresh take needs one. Both, when both are true.
      return {
        phase: 'ready',
        indicator: false,
        label: null,
        counter: null,
        // A failed discard is the newer fact than the draft announcement, and
        // the reason the draft is still on screen.
        message: view.error ?? readyMessage(view),
        actions: [
          ...(teach === null ? [] : [view.skillId === null ? teach : TEACH_BESIDE_REVIEW]),
          ...(view.skillId === null ? [] : [REVIEW]),
          view.skillId === null ? DISCARD_QUIET : DISCARD_DRAFT,
        ],
      };
    case 'failed':
      return {
        phase: 'failed',
        indicator: false,
        label: null,
        counter: null,
        message: view.message,
        actions: teach === null ? [DISCARD_QUIET] : [teach, DISCARD_QUIET],
      };
  }
}

/**
 * The outcome of a finished recording: the truncation reason when a hard
 * limit stopped it, the draft when one exists, and neither claim when neither
 * fact holds — "Recording finished." is the honest sentence before M3-BE-06
 * can settle a skill.
 */
function readyMessage(view: Extract<RecordingView, { kind: 'ready' }>): string {
  const parts: string[] = [];
  if (view.warning !== null) parts.push(RECORDING_LIMIT_SENTENCE[view.warning]);
  if (view.skillId !== null) {
    parts.push(
      view.skillName === null
        ? t('screen.recordingCardState.draftSkillIsReady')
        : t('screen.recordingCardState.draftSkillNamedIsReady', { name: view.skillName }),
    );
  }
  return parts.length === 0 ? t('screen.recordingCardState.recordingFinished') : parts.join(' ');
}
