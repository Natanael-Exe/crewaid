import { describe, expect, it, vi } from 'vitest';

import { SILENT_SCREEN_LOGGER } from './logger.js';
import { ScreenStreamHub } from './screen-stream-hub.js';
import { serveScreenViewer, type ViewerSocket } from './serve-viewer.js';

describe('serveScreenViewer', () => {
  it.each([2, 3])(
    'does not open a stream for a socket already closing or closed (state %s)',
    async (readyState) => {
      const connect = vi.fn(() => Promise.resolve(null));
      const hub = new ScreenStreamHub({ logger: SILENT_SCREEN_LOGGER, connect });
      const socket: ViewerSocket = {
        readyState,
        bufferedAmount: 0,
        send: vi.fn(),
        close: vi.fn(),
        terminate: vi.fn(),
        on: vi.fn(),
      };

      await serveScreenViewer({
        hub,
        key: 'seat',
        expiresAt: Date.now() + 60_000,
        socket,
        quality: 3,
        logger: SILENT_SCREEN_LOGGER,
      });

      expect(connect).not.toHaveBeenCalled();
      expect(hub.streamCount()).toBe(0);
    },
  );
});
