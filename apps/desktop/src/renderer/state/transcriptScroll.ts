/**
 * Where the transcript is relative to its newest message, and what that
 * distance means. Pure so it can be tested — the renderer's tests use
 * `renderToStaticMarkup`, so nothing that only exists inside a scroll event
 * is reachable from a test unless it lives here.
 *
 * Why two thresholds and not one
 *
 * They answer different questions, and one number cannot do both.
 *
 * `isPinned` is the edge the tail-follow is decided on: inside this band the
 * transcript is close enough to the newest message that following it is what
 * the operator wants, and a gesture that ends outside it is a reading
 * position. It has to be tight — a wider band would let the tail carry
 * somebody along from a place they deliberately stopped at.
 *
 * The jump button answers "is getting back to the newest message a chore?",
 * and at 24px the answer is no — it would appear and vanish while somebody
 * nudges a trackpad, which is worse than not having one. It waits until the
 * newest message is properly off screen.
 */

/** Close enough to the bottom that the streaming tail may follow. */
export const PINNED_PX = 24;

/** Far enough that scrolling back by hand is worth a button. */
export const JUMP_VISIBLE_PX = 240;

/** The three numbers every scroll container reports. */
export type ScrollMetrics = {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
};

/**
 * Pixels of content below the fold, never negative.
 *
 * Elastic overscroll on macOS reports a `scrollTop` past the end, which makes
 * the raw subtraction negative and — without the clamp — briefly reads as a
 * transcript scrolled somewhere it has never been.
 */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distance > 0 ? distance : 0;
}

/** At the bottom, for the purpose of following a streaming reply. */
export function isPinned(distance: number): boolean {
  return distance < PINNED_PX;
}

/** Far enough from the newest message to offer a way back to it. */
export function showsJumpButton(distance: number): boolean {
  return distance > JUMP_VISIBLE_PX;
}

/**
 * Movement smaller than this is a nudge, not a gesture.
 *
 * Trackpads, trackballs and elastic overscroll all report a couple of pixels
 * of movement for a press that was meant to be still, and un-pinning the tail
 * on one of those is a follow that stops for no visible reason.
 */
export const SCROLL_SLOP_PX = 2;

/** Start the network read with two screens of history still ahead of the reader. */
export function nearOlderHistory(metrics: ScrollMetrics): boolean {
  return metrics.scrollTop < Math.max(600, metrics.clientHeight * 2);
}

/**
 * Whether the tail may move the view, after one observed scroll.
 *
 * The follow cannot be read off the distance alone, because the distance is
 * only remeasured when a scroll fires and content growth fires none: a
 * transcript that judged itself on gestures could not tell somebody sitting at
 * the bottom from somebody who had scrolled up three lines, and the second of
 * those watches their answer arrive off screen while the first gets carried
 * along. So it is a mode with edges, and the edges are about INTENT:
 *
 * - **Inside the band: following.** Also where it starts — a transcript that
 * has just been opened is at its newest message.
 * - **An upward move past the band: not following.** The operator went to
 * read something, and pulling them back down on the next token is the
 * behaviour every chat client is careful not to have.
 * - **A downward move, or a nudge, that stops short of the band: unchanged.**
 * Halfway scrolled is a reading position, not a request to be carried
 * along — and every move this component makes itself is downward, so its
 * own writes can never un-pin the follow.
 */
export function followsAfterScroll(input: {
  readonly following: boolean;
  readonly distance: number;
  readonly scrollTop: number;
  readonly lastScrollTop: number;
}): boolean {
  if (isPinned(input.distance)) return true;
  if (input.scrollTop < input.lastScrollTop - SCROLL_SLOP_PX) return false;
  return input.following;
}
