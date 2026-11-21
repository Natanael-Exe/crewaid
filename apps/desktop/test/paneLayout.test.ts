import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANE_DIMENSIONS,
  PANE_SASH_WIDTH,
  RIGHT_RAIL_BOUNDS,
  SIDEBAR_BOUNDS,
  TRANSCRIPT_MIN_WIDTH,
  clampPaneDimensions,
  readPaneDimensions,
  resizePane,
  writePaneDimensions,
  type PaneDimensions,
  type StorageLike,
} from '../src/renderer/components/layout/paneLayout';

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('pane layout persistence and bounds', () => {
  it('uses the UI-spec defaults', () => {
    expect(DEFAULT_PANE_DIMENSIONS).toEqual({ sidebarWidth: 256, railWidth: 456 });
    expect(SIDEBAR_BOUNDS).toEqual({ min: 72, max: 360, default: 256 });
    expect(RIGHT_RAIL_BOUNDS).toEqual({ min: 300, max: 700, default: 456 });
    expect(TRANSCRIPT_MIN_WIDTH).toBe(400);
    expect(PANE_SASH_WIDTH).toBe(12);
  });

  it('falls back to defaults for missing or malformed storage', () => {
    const storage = new MemoryStorage();
    expect(readPaneDimensions(storage)).toEqual(DEFAULT_PANE_DIMENSIONS);
    storage.setItem('crewaid.pane-layout.v1', '{not-json');
    expect(readPaneDimensions(storage)).toEqual(DEFAULT_PANE_DIMENSIONS);
  });

  it('clamps persisted widths to each pane range', () => {
    const storage = new MemoryStorage();
    storage.setItem('crewaid.pane-layout.v1', JSON.stringify({ sidebarWidth: 1, railWidth: 9999 }));
    expect(readPaneDimensions(storage)).toEqual({ sidebarWidth: 72, railWidth: 700 });
  });

  it('round-trips persisted dimensions and tolerates storage failures', () => {
    const storage = new MemoryStorage();
    const dimensions: PaneDimensions = { sidebarWidth: 312, railWidth: 512 };
    writePaneDimensions(storage, dimensions);
    expect(readPaneDimensions(storage)).toEqual(dimensions);

    const brokenStorage: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => writePaneDimensions(brokenStorage, dimensions)).not.toThrow();
    expect(readPaneDimensions(brokenStorage)).toEqual(DEFAULT_PANE_DIMENSIONS);
  });

  it('keeps the transcript minimum when normalizing an oversized saved layout', () => {
    expect(clampPaneDimensions({ sidebarWidth: 360, railWidth: 700 }, 1200)).toEqual({
      sidebarWidth: 360,
      railWidth: 416,
    });
    expect(clampPaneDimensions({ sidebarWidth: 360, railWidth: 700 }, 1000)).toEqual({
      sidebarWidth: 276,
      railWidth: 300,
    });
  });

  it('clamps sidebar and rail drags independently, including the fluid center', () => {
    expect(resizePane(DEFAULT_PANE_DIMENSIONS, 'sidebar', 1)).toEqual({
      sidebarWidth: 72,
      railWidth: 456,
    });
    expect(resizePane(DEFAULT_PANE_DIMENSIONS, 'sidebar', 999)).toEqual({
      sidebarWidth: 360,
      railWidth: 456,
    });
    expect(resizePane(DEFAULT_PANE_DIMENSIONS, 'rail', 999)).toEqual({
      sidebarWidth: 256,
      railWidth: 700,
    });
    expect(resizePane(DEFAULT_PANE_DIMENSIONS, 'sidebar', 360, 1100)).toEqual({
      sidebarWidth: 220,
      railWidth: 456,
    });
    expect(resizePane(DEFAULT_PANE_DIMENSIONS, 'rail', 700, 1100)).toEqual({
      sidebarWidth: 256,
      railWidth: 420,
    });
  });
});
