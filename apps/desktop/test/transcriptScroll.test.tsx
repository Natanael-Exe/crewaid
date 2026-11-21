import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot } from '@crewaid/shared';
import { JumpToLatestButton, Transcript } from '../src/renderer/components/Transcript';
import {
  distanceFromBottom,
  followsAfterScroll,
  isPinned,
  JUMP_VISIBLE_PX,
  PINNED_PX,
  SCROLL_SLOP_PX,
  showsJumpButton,
} from '../src/renderer/state/transcriptScroll';

const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 600) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('CC-52 — where the transcript is', () => {
  it('measures what is still below the fold', () => {
    expect(distanceFromBottom(at(1400))).toBe(0);
    expect(distanceFromBottom(at(1000))).toBe(400);
    expect(distanceFromBottom(at(0))).toBe(1400);
  });

  it('never reports a negative distance', () => {
    // macOS elastic overscroll reports a scrollTop past the end. Unclamped,
    // the reader is briefly somewhere the transcript has never been.
    expect(distanceFromBottom(at(1480))).toBe(0);
    expect(isPinned(distanceFromBottom(at(1480)))).toBe(true);
  });

  it('counts a transcript shorter than its viewport as pinned', () => {
    expect(distanceFromBottom(at(0, 300, 600))).toBe(0);
    expect(showsJumpButton(distanceFromBottom(at(0, 300, 600)))).toBe(false);
  });

  it('keeps the pinned band tight, so the tail cannot yank a reader down', () => {
    expect(isPinned(PINNED_PX - 1)).toBe(true);
    expect(isPinned(PINNED_PX)).toBe(false);
  });

  it('does not offer the button until getting back is a chore', () => {
    // The two thresholds answer different questions, so there is a band where
    // the tail has stopped following and no button has appeared yet. That gap
    // is deliberate: a button that blinks on a trackpad nudge is worse than
    // no button.
    expect(isPinned(100)).toBe(false);
    expect(showsJumpButton(100)).toBe(false);

    expect(showsJumpButton(JUMP_VISIBLE_PX)).toBe(false);
    expect(showsJumpButton(JUMP_VISIBLE_PX + 1)).toBe(true);
  });

  it('puts the button below the pin, never above it', () => {
    // If these ever crossed, the button would be offered to somebody the
    // transcript is still auto-following.
    expect(JUMP_VISIBLE_PX).toBeGreaterThan(PINNED_PX);
  });
});

describe('the follow decision', () => {
  const at = (scrollTop: number, distance: number) => ({
    following: true,
    distance,
    scrollTop,
    lastScrollTop: scrollTop,
  });

  it('follows inside the pin band, whatever the gesture was', () => {
    expect(followsAfterScroll(at(2000, 0))).toBe(true);
    expect(followsAfterScroll({ ...at(1980, 20), following: false })).toBe(true);
  });

  it('stops following when the operator scrolls up past the band', () => {
    expect(followsAfterScroll({ ...at(1600, 400), lastScrollTop: 2000 })).toBe(false);
    // A follow that has already stopped stays stopped.
    expect(followsAfterScroll({ ...at(1600, 400), following: false, lastScrollTop: 2000 })).toBe(
      false,
    );
  });

  it('does not un-pin on the jitter a still hand reports', () => {
    expect(
      followsAfterScroll({ ...at(1976, PINNED_PX + 1), lastScrollTop: 1976 + SCROLL_SLOP_PX }),
    ).toBe(true);
  });

  it('treats a downward gesture that stops short of the band as a reading position', () => {
    // Halfway back down is not "carry me along" — and it is also the shape of
    // every scroll the component makes itself, which is why its own writes
    // can never stop the follow.
    expect(followsAfterScroll({ ...at(1700, 300), lastScrollTop: 1500 })).toBe(true);
    expect(followsAfterScroll({ ...at(1700, 300), following: false, lastScrollTop: 1500 })).toBe(
      false,
    );
  });
});

describe('CC-52 — the way back', () => {
  it('renders a labelled control, not a bare glyph', () => {
    const html = renderToStaticMarkup(<JumpToLatestButton onClick={() => {}} />);
    // The person who reaches this by keyboard or screen reader gets the same
    // sentence the hover title gives everyone else.
    expect(html).toContain('aria-label="Jump to the newest message"');
    expect(html).toContain('data-transcript-jump');
    expect(html).toContain('type="button"');
    // The arrow is decoration; the label already carries the meaning.
    expect(html).toContain('aria-hidden="true"');
  });

  it('is positioned against the transcript pane, not the window', () => {
    // `fixed` here would drift over the sidebar and the right rail, which are
    // siblings of this pane rather than children of it.
    const html = renderToStaticMarkup(<JumpToLatestButton onClick={() => {}} />);
    expect(html).toContain('absolute');
    expect(html).not.toContain('fixed');
  });

  it('is absent from a transcript that opens at the bottom', () => {
    // Paired with the presence assertions above, so this is a real absence:
    // the distance starts at 0, and 0 is not far enough to offer a way back.
    const html = renderToStaticMarkup(
      <Transcript
        bot={bot}
        connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
        messages={[]}
        pending={[]}
        onSend={() => {}}
        onStop={() => {}}
        onFiles={() => {}}
        onRemovePending={() => {}}
        onRetryPending={() => {}}
      />,
    );
    expect(html).toContain('data-transcript-scroll');
    expect(html).not.toContain('data-transcript-jump');
    expect(showsJumpButton(0)).toBe(false);
  });
});

const bot = {
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'clx1a2b3c4d5e6f7g8h9i0j2',
  name: 'Nathan Bot',
  role: 'Senior Frontend',
  avatarColor: '#e0447c',
  systemPrompt: '',
  modelId: 'default',
  autoReviewRules: [],
  status: 'IDLE',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
} as unknown as Bot;
