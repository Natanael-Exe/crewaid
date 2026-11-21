import { describe, expect, it } from 'vitest';
import type { RecordingView } from '../src/renderer/state/chatReducer';
import { t } from '../src/renderer/i18n/i18n';
import {
  RECORDING_LIMIT_SENTENCE,
  recordingCardPresentation,
  recordingCounterLabel,
  type RecordingCardAction,
} from '../src/renderer/screen/recordingCardState';

/**
 * What the full-screen viewer's recording cluster shows (M3-FE-01, M3-FE-02,
 * D-098's way out).
 *
 * Pure, like `screenCardState`: the component around it is a bar inside a
 * canvas noVNC owns, and a suite with no DOM can only assert the decision.
 */

const counts = (x11: number, cdp = 0) => ({ x11, cdp });

const TEACH: RecordingCardAction = {
  kind: 'teach',
  label: 'Teach a task',
  disabled: false,
  emphasis: 'primary',
};
/** Teaching when a review is also on offer takes the quiet weight. */
const TEACH_QUIET: RecordingCardAction = { ...TEACH, emphasis: 'quiet' };
const REVIEW: RecordingCardAction = {
  kind: 'review',
  label: 'Review draft',
  disabled: false,
  emphasis: 'primary',
};
const STOP: RecordingCardAction = {
  kind: 'stop',
  label: 'Stop',
  disabled: false,
  emphasis: 'danger',
};
/** D-098: abandoning a take that has not produced a draft. */
const CANCEL: RecordingCardAction = {
  kind: 'discard',
  label: 'Cancel',
  disabled: false,
  emphasis: 'quiet',
};
/** D-098: abandoning the finished draft — the card's one destructive press. */
const DISCARD_DRAFT: RecordingCardAction = {
  kind: 'discard',
  label: 'Discard draft',
  disabled: false,
  emphasis: 'danger',
};
/** Clearing a row that holds no draft: a failed recording, or a READY one
 *  whose compile has not named a skill yet. */
const DISCARD: RecordingCardAction = { ...DISCARD_DRAFT, label: 'Discard', emphasis: 'quiet' };

describe('recordingCounterLabel (M3-FE-01)', () => {
  it('counts every layer and pluralizes', () => {
    expect(recordingCounterLabel(counts(1), null)).toBe('1 event');
    expect(recordingCounterLabel(counts(41), null)).toBe('41 events');
    // The counter is the trace's length, not this layer's — M4 writes rows in
    // the same trace and §4.2's `counts` carries both.
    expect(recordingCounterLabel(counts(40, 2), null)).toBe('42 events');
  });

  it('names the newest captured kind, and drops one it does not know', () => {
    expect(recordingCounterLabel(counts(3), 'type')).toBe('3 events · typing');
    expect(recordingCounterLabel(counts(3), 'pointer')).toBe('3 events · pointer');
    expect(recordingCounterLabel(counts(3), 'key')).toBe('3 events · key');
    // §3's `type` is open by design — an unfamiliar token contributes nothing
    // rather than leaking a wire value into the UI.
    expect(recordingCounterLabel(counts(3), 'navigate')).toBe('3 events');
  });
});

describe('recordingCardPresentation (M3-FE-01)', () => {
  it('offers "Teach a task" on an idle live desktop, and nothing without one', () => {
    // D-038: a recording starts from the full-screen view, and only a live
    // desktop under it has anywhere to demonstrate a task.
    expect(recordingCardPresentation(undefined, true)).toEqual({
      phase: 'idle',
      indicator: false,
      label: null,
      counter: null,
      message: null,
      actions: [TEACH],
    });
    expect(recordingCardPresentation(undefined, false).actions).toEqual([]);
  });

  it('shows the dot, the live counter and the way out while capturing', () => {
    const view: RecordingView = {
      kind: 'recording',
      recordingId: 'r1',
      counts: counts(42),
      lastType: 'type',
      error: null,
    };
    const presentation = recordingCardPresentation(view, true);
    expect(presentation.phase).toBe('recording');
    expect(presentation.indicator).toBe(true);
    expect(presentation.label).toBe('Recording');
    expect(presentation.counter).toBe('42 events · typing');
    // D-098: Stop finishes and compiles, Cancel throws the take away. Both are
    // on offer from the moment capture starts — the operator who changes their
    // mind mid-recording has nowhere else to go.
    expect(presentation.actions).toEqual([STOP, CANCEL]);
  });

  it('keeps the counter but locks the button while the stop is out', () => {
    const presentation = recordingCardPresentation(
      { kind: 'stopping', recordingId: 'r1', counts: counts(42), lastType: null },
      true,
    );
    expect(presentation.indicator).toBe(true);
    expect(presentation.label).toBe('Stopping');
    expect(presentation.counter).toBe('42 events');
    // No discard beside a stop already in flight: two terminal calls racing
    // would decide the outcome by which landed last.
    expect(presentation.actions).toEqual([{ ...STOP, disabled: true }]);
  });

  it('says what it is doing while starting, and offers the way out while compiling', () => {
    // Against the catalog, not a regex over it: a copy change should fail
    // here rather than pass because the new wording happens to still match.
    expect(recordingCardPresentation({ kind: 'starting' }, true).message).toBe(
      t('screen.recordingCardState.startingRecording'),
    );
    const compiling = recordingCardPresentation(
      { kind: 'compiling', recordingId: 'r1', counts: counts(5), error: null },
      true,
    );
    expect(compiling.message).toBe(t('screen.recordingCardState.compilingSkill'));
    // D-098: the server has discarded a COMPILING recording since M3-BE-06,
    // so a wrong take must not have to finish compiling before it can go.
    expect(compiling.actions).toEqual([CANCEL]);
    expect(recordingCardPresentation({ kind: 'starting' }, true).actions).toEqual([]);
  });

  it('reads the D-042 limit sentence for a truncated recording', () => {
    // The sentence is chosen HERE, not pushed in the frame — D-042 keeps
    // §4.2's `recording.state` payload at `{recordingId, state}`.
    const truncated = recordingCardPresentation(
      {
        kind: 'ready',
        recordingId: 'r1',
        counts: counts(5000),
        skillId: null,
        skillName: null,
        warning: 'EVENT_LIMIT',
        error: null,
      },
      true,
    );
    expect(truncated.message).toBe(RECORDING_LIMIT_SENTENCE.EVENT_LIMIT);
    expect(RECORDING_LIMIT_SENTENCE.TIME_LIMIT).toMatch(/20-minute/);
    expect(RECORDING_LIMIT_SENTENCE.EVENT_LIMIT).toMatch(/5,000-event/);
  });

  it('names the draft once one exists, and never claims one before', () => {
    const named = recordingCardPresentation(
      {
        kind: 'ready',
        recordingId: 'r1',
        counts: counts(9),
        skillId: 's1',
        skillName: 'open_chrome',
        warning: null,
        error: null,
      },
      true,
    );
    expect(named.message).toBe('Draft skill “open_chrome” is ready.');
    const unnamed = recordingCardPresentation(
      {
        kind: 'ready',
        recordingId: 'r1',
        counts: counts(9),
        skillId: 's1',
        skillName: null,
        warning: null,
        error: null,
      },
      true,
    );
    expect(unnamed.message).toBe('Draft skill is ready.');
    // Before M3-BE-06 settles a skill there is no draft to promise.
    const bare = recordingCardPresentation(
      {
        kind: 'ready',
        recordingId: 'r1',
        counts: counts(9),
        skillId: null,
        skillName: null,
        warning: null,
        error: null,
      },
      true,
    );
    expect(bare.message).toBe('Recording finished.');
    expect(bare.actions).toEqual([TEACH, DISCARD]);
  });

  it('carries the failure copy the reducer normalized — never a raw body', () => {
    const presentation = recordingCardPresentation(
      { kind: 'failed', recordingId: null, message: 'Could not reach the server.' },
      true,
    );
    expect(presentation.message).toBe('Could not reach the server.');
    expect(presentation.actions).toEqual([TEACH, DISCARD]);
    // Nothing to demonstrate — but the failed row can still be cleared.
    expect(
      recordingCardPresentation({ kind: 'failed', recordingId: null, message: 'x' }, false).actions,
    ).toEqual([DISCARD]);
  });

  it('keeps a failed stop next to the live counter, with the button offered again', () => {
    const presentation = recordingCardPresentation(
      {
        kind: 'recording',
        recordingId: 'r1',
        counts: counts(3),
        lastType: null,
        error: 'Could not stop the recording. Could not reach the server.',
      },
      true,
    );
    expect(presentation.counter).toBe('3 events');
    expect(presentation.message).toBe('Could not stop the recording. Could not reach the server.');
    expect(presentation.actions).toEqual([STOP, CANCEL]);
  });
});

describe('recordingCardPresentation — the review offer (M3-FE-02)', () => {
  const readyWithDraft = (skillName: string | null): RecordingView => ({
    kind: 'ready',
    recordingId: 'r1',
    counts: counts(9),
    skillId: 's1',
    skillName,
    warning: null,
    error: null,
  });

  it('offers Review draft as the primary, with teaching beside it on a live desktop', () => {
    const presentation = recordingCardPresentation(readyWithDraft('open_chrome'), true);
    // D-098: throwing the draft away is offered right beside reading it —
    // a draft the operator already knows is junk should not need approving or
    // leaving the card to get rid of.
    expect(presentation.actions).toEqual([TEACH_QUIET, REVIEW, DISCARD_DRAFT]);
    // The message still names the draft — the button opens it.
    expect(presentation.message).toContain('Draft skill “open_chrome” is ready.');
  });

  it('offers Review draft even when the desktop has since died', () => {
    // The skill exists independently of the computer it was recorded on;
    // reviewing it needs nowhere to type, so `live` must not gate it.
    const presentation = recordingCardPresentation(readyWithDraft('open_chrome'), false);
    expect(presentation.actions).toEqual([REVIEW, DISCARD_DRAFT]);
  });

  it('never offers a review without a draft to review', () => {
    const presentation = recordingCardPresentation(
      {
        kind: 'ready',
        recordingId: 'r1',
        counts: counts(9),
        skillId: null,
        skillName: null,
        warning: null,
        error: null,
      },
      true,
    );
    expect(presentation.actions).toEqual([TEACH, DISCARD]);
  });

  it('shows a discarding failure instead of the announcement, with the press still on offer', () => {
    // The failure is the newer fact, and what explains why the draft is still
    // on screen at all.
    const presentation = recordingCardPresentation(
      {
        kind: 'ready',
        recordingId: 'r1',
        counts: counts(9),
        skillId: 's1',
        skillName: 'open_chrome',
        warning: null,
        error: 'Could not discard the recording. Could not reach the server.',
      },
      true,
    );
    expect(presentation.message).toBe(
      'Could not discard the recording. Could not reach the server.',
    );
    expect(presentation.actions).toEqual([TEACH_QUIET, REVIEW, DISCARD_DRAFT]);

    const compiling = recordingCardPresentation(
      {
        kind: 'compiling',
        recordingId: 'r1',
        counts: counts(5),
        error: 'Could not discard the recording. Could not reach the server.',
      },
      true,
    );
    expect(compiling.message).toBe('Could not discard the recording. Could not reach the server.');
  });
});
