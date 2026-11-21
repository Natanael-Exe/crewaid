import { describe, expect, it, vi } from 'vitest';

import { SandboxHealthService } from '../src/sandbox/sandbox-health.service.js';

describe('sandbox health sweep failure isolation', () => {
  it('keeps the sweep guard until slow probes finish after another row fails to persist', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prisma = {
      sandbox: {
        findMany: vi.fn().mockResolvedValue([
          { botId: 'failed', sessionId: 'failed', state: 'RUNNING', lastStartedAt: null },
          { botId: 'slow', sessionId: 'slow', state: 'RUNNING', lastStartedAt: null },
        ]),
        updateManyAndReturn: vi.fn().mockRejectedValue(new Error('database unavailable')),
      },
    };
    const provider = {
      checkHealth: vi.fn(async ({ sessionId }: { sessionId: string }) => {
        if (sessionId === 'slow') {
          await pending;
          return { ok: true };
        }
        return { ok: false, reason: 'container stopped' };
      }),
    };
    const service = new SandboxHealthService(prisma as never, provider as never, {} as never);
    let finished = false;
    const first = service.sweep().then(() => {
      finished = true;
    });
    try {
      // Flush the failed write and its rejection handlers, leaving the other probe pending.
      await new Promise((resolve) => setImmediate(resolve));
      expect(prisma.sandbox.updateManyAndReturn).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      await service.sweep();
      expect(prisma.sandbox.findMany).toHaveBeenCalledOnce();
    } finally {
      release();
      await first;
    }
    await service.sweep();
    expect(prisma.sandbox.findMany).toHaveBeenCalledTimes(2);
  });
});
