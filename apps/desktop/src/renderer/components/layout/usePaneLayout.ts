import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import {
  clampPaneDimensions,
  readPaneDimensions,
  resizePane,
  writePaneDimensions,
  type PaneDimensions,
  type StorageLike,
} from './paneLayout';

function browserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function usePaneLayout(containerRef: RefObject<HTMLDivElement | null>): {
  readonly dimensions: PaneDimensions;
  readonly resizeSidebar: (width: number) => void;
  readonly resizeRail: (width: number) => void;
} {
  const [saved, setSaved] = useState<PaneDimensions>(() => readPaneDimensions(browserStorage()));
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    const measure = () => setContainerWidth(Math.round(container.getBoundingClientRect().width));
    measure();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(container);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [containerRef]);

  const dimensions = clampPaneDimensions(saved, containerWidth > 0 ? containerWidth : undefined);

  useEffect(() => {
    if (
      saved.sidebarWidth !== dimensions.sidebarWidth ||
      saved.railWidth !== dimensions.railWidth
    ) {
      setSaved(dimensions);
    }
  }, [dimensions.railWidth, dimensions.sidebarWidth, saved.sidebarWidth, saved.railWidth]);

  useEffect(() => {
    writePaneDimensions(browserStorage(), dimensions);
  }, [dimensions.railWidth, dimensions.sidebarWidth]);

  const resizeSidebar = useCallback(
    (width: number) => {
      setSaved((current) =>
        resizePane(current, 'sidebar', width, containerWidth > 0 ? containerWidth : undefined),
      );
    },
    [containerWidth],
  );

  const resizeRail = useCallback(
    (width: number) => {
      setSaved((current) =>
        resizePane(current, 'rail', width, containerWidth > 0 ? containerWidth : undefined),
      );
    },
    [containerWidth],
  );

  return {
    dimensions,
    resizeSidebar,
    resizeRail,
  };
}
