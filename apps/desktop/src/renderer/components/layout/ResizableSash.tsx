import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from 'react';
import { isRtlLocale } from '@crewaid/shared';
import { useLocale } from '../../i18n/i18n';

/** Which edge of the window the pane sits on, in reading order: a sidebar is at the start. */
export type SashSide = 'start' | 'end';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ResizableSash({
  side,
  value,
  min,
  max,
  onResize,
  label,
}: {
  readonly side: SashSide;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onResize: (width: number) => void;
  readonly label: string;
}) {
  // Right to left, the start is on the right: the drag and the arrow keys follow the page.
  const left = (side === 'start') !== isRtlLocale(useLocale());
  const [dragging, setDragging] = useState(false);
  const dragCleanup = useRef<(() => void) | null>(null);
  const dragState = useRef<{ startX: number; startValue: number } | null>(null);

  const finishDrag = useCallback(() => {
    dragCleanup.current?.();
    dragCleanup.current = null;
    dragState.current = null;
    setDragging(false);
  }, []);

  useEffect(() => {
    return () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
      dragState.current = null;
    };
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragState.current = { startX: event.clientX, startValue: value };
      setDragging(true);

      const onPointerMove = (move: globalThis.PointerEvent) => {
        const start = dragState.current;
        if (start === null) return;
        const delta = left ? move.clientX - start.startX : start.startX - move.clientX;
        onResize(clamp(start.startValue + delta, min, max));
      };
      const onPointerUp = () => finishDrag();

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp, { once: true });
      window.addEventListener('pointercancel', onPointerUp, { once: true });
      dragCleanup.current = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };
    },
    [finishDrag, left, max, min, onResize, value],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      let next: number | null = null;
      if (event.key === 'Home') next = min;
      else if (event.key === 'End') next = max;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const grows = left ? event.key === 'ArrowRight' : event.key === 'ArrowLeft';
        const step = event.shiftKey ? 32 : 16;
        next = value + (grows ? step : -step);
      }
      if (next === null) return;
      event.preventDefault();
      onResize(clamp(next, min, max));
    },
    [left, max, min, onResize, value],
  );

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      data-pane-sash={side}
      data-dragging={dragging || undefined}
      className="crewaid-pane-sash shrink-0"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
