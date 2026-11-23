import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Auto-grow behavior for the composer textarea.
 *
 * HeroUI v3's TextArea has NO auto-grow (verified against the installed tree: the props are
 * rows/cols/value/defaultValue/onChange/placeholder/disabled/readOnly), so the
 * composer hand-rolls it. This hook is the hand-roll, extracted so it can be
 * unit-tested without rendering.
 *
 * Mechanics: on every value change, reset height to auto (collapses to one
 * line), read scrollHeight, and clamp to [minHeight, maxHeight]. The max clamp
 * is what keeps a 2000-word draft from swallowing the transcript — past the
 * clamp the textarea scrolls internally, like every mainstream chat app.
 *
 * Why not CSS `field-sizing: content`: supported in Chrome 123+, but Electron
 * 44 ships Chromium 134+... actually it DOES cover it. We still measure: the
 * measurement approach is renderer-agnostic, testable in jsdom-free unit
 * tests, and degrades identically if the CSS route is ever removed upstream.
 * Keep one mechanism, not two.
 */

export interface AutoGrowOptions {
  minHeight?: number;
  maxHeight?: number;
}

export function useAutoGrow(
  value: string,
  { minHeight = 24, maxHeight = 160 }: AutoGrowOptions = {},
) {
  const [height, setHeight] = useState(minHeight);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    setHeight(next);
  }, [minHeight, maxHeight]);

  useEffect(() => {
    measure();
  }, [value, measure]);

  // Fonts load / window resizes change line wrapping; re-measure on resize.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return [ref, height] as const;
}

/**
 * IME-safe Enter handling.
 *
 * Enter submits, Shift+Enter newlines — EXCEPT while an IME composition is in
 * flight (Chinese/Japanese/Korean input renders candidates through Enter
 * presses; submitting mid-composition sends garbage or eats a candidate).
 * `event.isComposing` + keyCode 229 covers Chromium's two signals.
 *
 * Extracted as a pure predicate so the state machine tests it directly.
 */
export function shouldSubmitOnEnter(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  if (event.key !== 'Enter') return false;
  if (event.shiftKey) return false;
  if (event.isComposing) return false;
  if (event.keyCode === 229) return false;
  return true;
}
