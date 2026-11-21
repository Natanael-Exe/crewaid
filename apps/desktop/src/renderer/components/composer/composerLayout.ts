import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Composer row layout — inline vs stacked.
 *
 * The pill runs as ONE row while the draft still fits beside the controls
 * (`[+] [text] [model picker] [send]`), and splits into TWO rows the moment
 * the text would wrap: the textarea takes a full-width row of its own and the
 * controls drop underneath it. Same move as the mainstream chat composers.
 *
 * Why a measured probe instead of a line count: the draft soft-wraps, so
 * neither `rows` (always 1 — auto-grow drives `style.height`, never the
 * attribute) nor the newline count sees a wrap coming.
 *
 * Why the probe runs at the INLINE width rather than the rendered width: the
 * two modes would otherwise feed each other. Stacking makes the textarea
 * wider, the text fits on one line again, it unstacks, the text wraps, and the
 * pill oscillates on every keystroke around the boundary. The question is
 * always "would this fit on the single row?", which is independent of the mode
 * currently on screen — so the answer is stable, and no hysteresis is needed.
 *
 * The probe writes width/height onto the real textarea and restores both in
 * the same synchronous pass, so nothing is painted mid-measurement. It uses
 * the real element (not a mirror) to keep font, letter-spacing and word-break
 * metrics exactly those of the thing being measured.
 */

export interface InlineWidthMetrics {
  /** Pill width with its own horizontal padding already removed. */
  readonly innerWidth: number;
  readonly attachWidth: number;
  readonly controlsWidth: number;
  /** Grid column gap — one on each side of the textarea. */
  readonly columnGap: number;
}

/** Width the textarea gets when the whole composer shares one row. */
export function inlineTextareaWidth(metrics: InlineWidthMetrics): number {
  return metrics.innerWidth - metrics.attachWidth - metrics.controlsWidth - metrics.columnGap * 2;
}

/**
 * Below this a single row is hopeless — the picker plus both buttons already
 * own the pill — so stack unconditionally rather than squeezing the draft into
 * a sliver. A floor, not a normal state: the transcript's 480px minimum keeps
 * real layouts well above it even with a long model label.
 */
export const MIN_INLINE_TEXT_WIDTH = 64;

export interface StackDecision {
  readonly inlineWidth: number;
  /** Textarea scrollHeight measured at `inlineWidth`. */
  readonly probedHeight: number;
  /** Height of exactly one line: line-height + vertical padding. */
  readonly oneLineHeight: number;
}

export function needsStackedLayout({
  inlineWidth,
  probedHeight,
  oneLineHeight,
}: StackDecision): boolean {
  if (inlineWidth < MIN_INLINE_TEXT_WIDTH) return true;
  // 1px of slack: sub-pixel line boxes must not read as a second line.
  return probedHeight > oneLineHeight + 1;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function useComposerLayout(
  draft: string,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
) {
  const pillRef = useRef<HTMLDivElement | null>(null);
  const attachRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const [stacked, setStacked] = useState(false);

  const measure = useCallback(() => {
    const pill = pillRef.current;
    const textarea = textareaRef.current;
    const attach = attachRef.current;
    const controls = controlsRef.current;
    if (!pill || !textarea || !attach || !controls) return;

    const pillStyle = getComputedStyle(pill);
    const innerWidth =
      pill.clientWidth -
      finite(parseFloat(pillStyle.paddingLeft), 0) -
      finite(parseFloat(pillStyle.paddingRight), 0);
    const inlineWidth = inlineTextareaWidth({
      innerWidth,
      attachWidth: attach.getBoundingClientRect().width,
      controlsWidth: controls.getBoundingClientRect().width,
      columnGap: finite(parseFloat(pillStyle.columnGap), 0),
    });

    const textStyle = getComputedStyle(textarea);
    const fontSize = finite(parseFloat(textStyle.fontSize), 14);
    const oneLineHeight =
      // `line-height: normal` parses to NaN; fall back to a plausible ratio.
      finite(parseFloat(textStyle.lineHeight), fontSize * 1.5) +
      finite(parseFloat(textStyle.paddingTop), 0) +
      finite(parseFloat(textStyle.paddingBottom), 0);

    const previousWidth = textarea.style.width;
    const previousHeight = textarea.style.height;
    textarea.style.width = `${Math.max(inlineWidth, 0)}px`;
    textarea.style.height = 'auto';
    const probedHeight = textarea.scrollHeight;
    // Restore before yielding: auto-grow owns `height`, the grid owns `width`.
    textarea.style.width = previousWidth;
    textarea.style.height = previousHeight;

    setStacked(needsStackedLayout({ inlineWidth, probedHeight, oneLineHeight }));
  }, [textareaRef]);

  useEffect(() => {
    measure();
  }, [draft, measure]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    // The pill's width follows the sidebar/rail sashes; the controls' width
    // follows the model picker's label (`Loading models…` → a model name →
    // `Models unavailable` + Retry), which moves the wrap point on its own.
    const observer = new ResizeObserver(() => measure());
    for (const target of [pillRef.current, attachRef.current, controlsRef.current]) {
      if (target) observer.observe(target);
    }
    return () => observer.disconnect();
  }, [measure]);

  return { pillRef, attachRef, controlsRef, stacked };
}
