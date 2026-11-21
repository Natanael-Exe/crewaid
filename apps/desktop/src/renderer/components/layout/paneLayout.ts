export const PANE_LAYOUT_STORAGE_KEY = 'crewaid.pane-layout.v1' as const;

export const SIDEBAR_BOUNDS = {
  min: 72,
  max: 360,
  default: 256,
} as const;

export const RIGHT_RAIL_BOUNDS = {
  min: 300,
  max: 700,
  default: 456,
} as const;

export const TRANSCRIPT_MIN_WIDTH = 400 as const;
export const PANE_SASH_WIDTH = 12 as const;

export interface PaneDimensions {
  readonly sidebarWidth: number;
  readonly railWidth: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_PANE_DIMENSIONS: PaneDimensions = {
  sidebarWidth: SIDEBAR_BOUNDS.default,
  railWidth: RIGHT_RAIL_BOUNDS.default,
};

type Pane = keyof PaneDimensions;
type Bounds = { readonly min: number; readonly max: number };

function finiteRounded(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

function clamp(value: number, bounds: Bounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

function boundsFor(pane: Pane): Bounds {
  return pane === 'sidebarWidth' ? SIDEBAR_BOUNDS : RIGHT_RAIL_BOUNDS;
}

function widthFor(input: Partial<PaneDimensions>, pane: Pane): number {
  const bounds = boundsFor(pane);
  const fallback = pane === 'sidebarWidth' ? SIDEBAR_BOUNDS.default : RIGHT_RAIL_BOUNDS.default;
  return clamp(finiteRounded(input[pane], fallback), bounds);
}

/**
 * Normalizes saved dimensions and, when a container width is known, keeps the
 * transcript at its practical minimum by shrinking the rail first, then the
 * sidebar. The order preserves the sidebar's familiar width when possible.
 */
export function clampPaneDimensions(
  input: Partial<PaneDimensions>,
  containerWidth?: number,
): PaneDimensions {
  let sidebarWidth = widthFor(input, 'sidebarWidth');
  let railWidth = widthFor(input, 'railWidth');

  if (containerWidth !== undefined && Number.isFinite(containerWidth) && containerWidth > 0) {
    const availableForPanes = Math.max(
      0,
      Math.floor(containerWidth) - TRANSCRIPT_MIN_WIDTH - PANE_SASH_WIDTH * 2,
    );
    const minimumCombined = SIDEBAR_BOUNDS.min + RIGHT_RAIL_BOUNDS.min;

    if (availableForPanes < minimumCombined) {
      // The window itself is narrower than the product's practical minimum.
      // Keep both panes at their legal minima and let the center overflow
      // rather than violating either pane's clamp.
      sidebarWidth = SIDEBAR_BOUNDS.min;
      railWidth = RIGHT_RAIL_BOUNDS.min;
    } else {
      let overflow = Math.max(0, sidebarWidth + railWidth - availableForPanes);
      const railReduction = Math.min(overflow, railWidth - RIGHT_RAIL_BOUNDS.min);
      railWidth -= railReduction;
      overflow -= railReduction;
      sidebarWidth -= Math.min(overflow, sidebarWidth - SIDEBAR_BOUNDS.min);
    }
  }

  return { sidebarWidth, railWidth };
}

function parseStoredDimensions(raw: string | null): Partial<PaneDimensions> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const sidebarWidth = record['sidebarWidth'];
    const railWidth = record['railWidth'];
    return {
      ...(typeof sidebarWidth === 'number' ? { sidebarWidth } : {}),
      ...(typeof railWidth === 'number' ? { railWidth } : {}),
    };
  } catch {
    return null;
  }
}

export function readPaneDimensions(storage: StorageLike | null | undefined): PaneDimensions {
  if (storage === null || storage === undefined) return DEFAULT_PANE_DIMENSIONS;
  try {
    return clampPaneDimensions(
      parseStoredDimensions(storage.getItem(PANE_LAYOUT_STORAGE_KEY)) ?? {},
    );
  } catch {
    return DEFAULT_PANE_DIMENSIONS;
  }
}

export function writePaneDimensions(
  storage: StorageLike | null | undefined,
  dimensions: PaneDimensions,
): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(PANE_LAYOUT_STORAGE_KEY, JSON.stringify(clampPaneDimensions(dimensions)));
  } catch {
    // Private browsing and hardened Electron profiles can reject localStorage.
    // The shell remains usable for the current session in that case.
  }
}

/**
 * Applies one drag/keyboard result while preserving the opposite pane. The
 * fluid transcript gets the remaining width, never less than its minimum when
 * the container has enough room to satisfy all three panes.
 */
export function resizePane(
  current: PaneDimensions,
  pane: 'sidebar' | 'rail',
  requestedWidth: number,
  containerWidth?: number,
): PaneDimensions {
  const normalized = clampPaneDimensions(current);
  const key: Pane = pane === 'sidebar' ? 'sidebarWidth' : 'railWidth';
  const bounds = boundsFor(key);
  let max = bounds.max;

  if (containerWidth !== undefined && Number.isFinite(containerWidth) && containerWidth > 0) {
    const otherWidth = pane === 'sidebar' ? normalized.railWidth : normalized.sidebarWidth;
    max = Math.min(
      max,
      Math.max(
        bounds.min,
        Math.floor(containerWidth) - TRANSCRIPT_MIN_WIDTH - PANE_SASH_WIDTH * 2 - otherWidth,
      ),
    );
  }

  const nextWidth = clamp(finiteRounded(requestedWidth, normalized[key]), {
    min: bounds.min,
    max,
  });
  return pane === 'sidebar'
    ? { sidebarWidth: nextWidth, railWidth: normalized.railWidth }
    : { sidebarWidth: normalized.sidebarWidth, railWidth: nextWidth };
}
