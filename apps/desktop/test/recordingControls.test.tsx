import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import { RecordingControls } from '../src/renderer/screen/RecordingControls';
import type { RecordingView } from '../src/renderer/state/chatReducer';

/**
 * The recording cluster in the viewer's footer (M3-FE-01, M3-FE-02, D-098).
 *
 * Driven through the same `RecordingView` values the reducer produces, so
 * this asserts what the full-screen surface will actually draw. The live
 * canvas around it is noVNC's and is covered by the screen-lifecycle probe
 * instead.
 */
function render(recording: RecordingView | undefined, live = true): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <RecordingControls
        recording={recording}
        live={live}
        onTeach={() => undefined}
        onStop={() => undefined}
        onDiscard={() => undefined}
        onReview={() => undefined}
      />
    </I18nProvider>,
  );
}

function actionTag(html: string, action: string): string {
  return html.match(new RegExp(`<button[^>]*data-recording-action="${action}"[^>]*>`))?.[0] ?? '';
}

describe('RecordingControls (M3-FE-01)', () => {
  it('offers "Teach a task" on an idle live desktop, and nothing on a dead one', () => {
    const html = render(undefined, true);
    expect(html).toContain('data-recording-phase="idle"');
    expect(html).toContain('data-recording-action="teach"');
    expect(html).toContain('Teach a task');

    // D-038: nowhere to demonstrate the task, nothing to offer.
    expect(render(undefined, false)).toBe('');
  });

  it('shows the dot, the word, the live counter and the way out while capturing', () => {
    const html = render({
      kind: 'recording',
      recordingId: 'r1',
      counts: { x11: 42, cdp: 0 },
      lastType: 'type',
      error: null,
    });
    expect(html).toContain('data-recording-phase="recording"');
    expect(html).toContain('data-recording-indicator');
    expect(html).toContain('data-recording-counter');
    expect(html).toContain('42 events · typing');
    expect(html).toContain('data-recording-action="stop"');
    expect(html).toContain('Stop');
    // D-098: the take can be abandoned without stopping it first.
    expect(html).toContain('data-recording-action="discard"');
    expect(html).toContain('Cancel');
  });

  it('locks the stop button while the stop call is out', () => {
    const html = render({
      kind: 'stopping',
      recordingId: 'r1',
      counts: { x11: 3, cdp: 0 },
      lastType: null,
    });
    expect(html).toContain('data-recording-phase="stopping"');
    expect(html).toContain('Stopping');
    // On the stop button itself. A bare /disabled/ over the whole document
    // passes on any element carrying any attribute containing that word,
    // including `aria-disabled="false"` somewhere else in the row.
    expect(actionTag(html, 'stop')).toMatch(/\bdisabled\b/);
    // The stop is already out; a discard racing it would decide the outcome by
    // which call landed last.
    expect(html).not.toContain('data-recording-action="discard"');
  });

  it('reads the D-042 sentence for a truncated recording', () => {
    const html = render({
      kind: 'ready',
      recordingId: 'r1',
      counts: { x11: 5000, cdp: 0 },
      skillId: null,
      skillName: null,
      warning: 'TIME_LIMIT',
      error: null,
    });
    expect(html).toContain('data-recording-message');
    expect(html).toMatch(/20-minute limit/);
  });

  it('carries the normalized failure copy, never a raw body', () => {
    const html = render({
      kind: 'failed',
      recordingId: null,
      message: 'Could not reach the server.',
    });
    expect(html).toContain('data-recording-phase="failed"');
    expect(html).toContain('Could not reach the server.');
    expect(html).toContain('data-recording-action="teach"');
  });
});

describe('RecordingControls — the draft review affordance (M3-FE-02)', () => {
  const ready: RecordingView = {
    kind: 'ready',
    recordingId: 'r1',
    counts: { x11: 9, cdp: 0 },
    skillId: 's1',
    skillName: 'open_chrome',
    warning: null,
    error: null,
  };

  it('offers a fresh take, the review and the discard, in that draw order', () => {
    const html = render(ready, true);
    expect(html).toContain('Draft skill “open_chrome” is ready.');
    expect(html).toContain('data-recording-action="teach"');
    expect(html).toContain('data-recording-action="review"');
    expect(html).toContain('Review draft');
    // D-098: the draft is the one thing on this card that can be destroyed, and
    // the press says so.
    expect(html).toContain('data-recording-action="discard"');
    expect(html).toContain('Discard draft');
    // The review is the primary; teaching comes first in draw order and steps
    // back, and the discard sits last.
    expect(html.indexOf('data-recording-action="teach"')).toBeLessThan(
      html.indexOf('data-recording-action="review"'),
    );
    expect(html.indexOf('data-recording-action="review"')).toBeLessThan(
      html.indexOf('data-recording-action="discard"'),
    );
  });

  it('keeps the review reachable after the desktop dies — and drops teaching', () => {
    const html = render(ready, false);
    expect(html).toContain('data-recording-action="review"');
    expect(html).toContain('Review draft');
    expect(html).not.toContain('data-recording-action="teach"');
    // Discarding a draft needs no desktop either — the skill outlives the
    // computer, and so does the decision to throw it away.
    expect(html).toContain('data-recording-action="discard"');
  });

  it('offers no review before a draft exists', () => {
    const html = render({
      kind: 'ready',
      recordingId: 'r1',
      counts: { x11: 9, cdp: 0 },
      skillId: null,
      skillName: null,
      warning: null,
      error: null,
    });
    expect(html).not.toContain('data-recording-action="review"');
    expect(html).toContain('data-recording-action="teach"');
  });
});
