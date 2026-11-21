import { describe, expect, it } from 'vitest';
import {
  MIN_INLINE_TEXT_WIDTH,
  inlineTextareaWidth,
  needsStackedLayout,
} from '../src/renderer/components/composer/composerLayout';

// Pill geometry as rendered: px-1.5 pill padding, gap-1.5 columns, a 32px `+`,
// and a control cluster holding the model picker plus the 32px send button.
const PILL = {
  innerWidth: 600,
  attachWidth: 32,
  controlsWidth: 190,
  columnGap: 6,
} as const;

describe('composer inline/stacked layout', () => {
  it('gives the textarea what the controls and gaps leave behind', () => {
    expect(inlineTextareaWidth(PILL)).toBe(366);
  });

  it('shrinks the inline width as the model picker label grows', () => {
    const loading = inlineTextareaWidth({ ...PILL, controlsWidth: 150 });
    const unavailable = inlineTextareaWidth({ ...PILL, controlsWidth: 240 });
    expect(loading - unavailable).toBe(90);
  });

  it('stays inline while the probed draft is one line tall', () => {
    expect(needsStackedLayout({ inlineWidth: 366, probedHeight: 30, oneLineHeight: 30 })).toBe(
      false,
    );
  });

  it('tolerates a sub-pixel line box', () => {
    expect(needsStackedLayout({ inlineWidth: 366, probedHeight: 30.5, oneLineHeight: 30 })).toBe(
      false,
    );
  });

  it('stacks once the draft would wrap at the inline width', () => {
    expect(needsStackedLayout({ inlineWidth: 366, probedHeight: 52, oneLineHeight: 30 })).toBe(
      true,
    );
  });

  it('stacks unconditionally when the single row has no room left', () => {
    expect(
      needsStackedLayout({
        inlineWidth: MIN_INLINE_TEXT_WIDTH - 1,
        probedHeight: 30,
        oneLineHeight: 30,
      }),
    ).toBe(true);
  });

  it('decides from the inline width, not the rendered one — the anti-oscillation rule', () => {
    // A draft that wraps at the inline width but fits the full-width stacked
    // row must keep reporting "stacked", or the pill flip-flops per keystroke.
    const probedAtInlineWidth = 52;
    expect(
      needsStackedLayout({
        inlineWidth: inlineTextareaWidth(PILL),
        probedHeight: probedAtInlineWidth,
        oneLineHeight: 30,
      }),
    ).toBe(true);
  });
});
