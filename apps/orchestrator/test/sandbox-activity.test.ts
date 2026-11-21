import { describe, expect, it, vi } from 'vitest';

import { SandboxActivityService } from '../src/sandbox/sandbox-activity.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * M2-BE-11 — the manual-takeover clock (§8).
 *
 * A unit test with a stub client, because what is under test is how OFTEN this
 * writes, not what it writes. The call site is `screen.input`, which carries
 * every mouse move the operator makes; that path is built to cost zero queries
 * (D-036), and the coalescing window is the only thing keeping it that way.
 */
function fakePrisma(): {
  prisma: PrismaService;
  updates: { where: unknown; data: unknown }[];
  fail: { with: Error | null };
} {
  const updates: { where: unknown; data: unknown }[] = [];
  const fail = { with: null as Error | null };
  const prisma = {
    sandbox: {
      updateMany: (args: { where: unknown; data: unknown }) => {
        if (fail.with !== null) return Promise.reject(fail.with);
        updates.push(args);
        return Promise.resolve({ count: 1 });
      },
    },
  } as unknown as PrismaService;
  return { prisma, updates, fail };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('SandboxActivityService', () => {
  it('records the first message it sees', async () => {
    const { prisma, updates } = fakePrisma();

    new SandboxActivityService(prisma).touch('bot-1');
    await flush();

    expect(updates).toHaveLength(1);
    // Pinned to RUNNING: a stop in flight reads STARTING, and bumping the
    // clock underneath it would claim the sandbox was busy at the moment it
    // was being shut down.
    expect(updates[0]?.where).toMatchObject({ bots: { some: { id: 'bot-1' } }, state: 'RUNNING' });
    expect(updates[0]?.data).toHaveProperty('lastActiveAt');
  });

  it('coalesces a burst into one write', async () => {
    const { prisma, updates } = fakePrisma();
    const activity = new SandboxActivityService(prisma);

    // What a single drag looks like on the wire.
    for (let i = 0; i < 500; i += 1) activity.touch('bot-1');
    await flush();

    expect(updates).toHaveLength(1);
  });

  it('keeps each bot on its own window', async () => {
    const { prisma, updates } = fakePrisma();
    const activity = new SandboxActivityService(prisma);

    activity.touch('bot-1');
    activity.touch('bot-2');
    await flush();

    expect(updates).toHaveLength(2);
  });

  it('writes again once the window has passed', async () => {
    const { prisma, updates } = fakePrisma();
    const activity = new SandboxActivityService(prisma);
    activity.touch('bot-1');
    await flush();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + SandboxActivityService.MAX_COALESCE_MS + 1);
      activity.touch('bot-1');
    } finally {
      vi.useRealTimers();
    }
    await flush();

    expect(updates).toHaveLength(2);
  });

  it('retries on the next message when a write fails', async () => {
    // The window is recorded BEFORE the write, so a slow database cannot let a
    // burst stack up writes behind it. That leaves one hole to close: a failed
    // write must not also cost a minute of activity, or one blip during a drag
    // could be the difference between a desktop staying up and being stopped.
    const { prisma, updates, fail } = fakePrisma();
    const activity = new SandboxActivityService(prisma);

    fail.with = new Error('connection reset');
    activity.touch('bot-1');
    await flush();
    expect(updates).toHaveLength(0);

    fail.with = null;
    activity.touch('bot-1');
    await flush();

    expect(updates).toHaveLength(1);
  });

  it('tracks every message in memory even when persistence is coalesced', async () => {
    const { prisma, updates } = fakePrisma();
    const activity = new SandboxActivityService(prisma);
    activity.touch('bot-1');
    await flush();

    vi.useFakeTimers();
    try {
      const later = Date.now() + 1_000;
      vi.setSystemTime(later);
      activity.touch('bot-1');
      expect(activity.lastObservedAt('bot-1')?.getTime()).toBe(later);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    expect(updates).toHaveLength(1);
  });

  it('persists more often than a shorter configured idle deadline', () => {
    expect(SandboxActivityService.coalesceMsFor(10_000)).toBe(5_000);
    expect(SandboxActivityService.coalesceMsFor(1)).toBe(1);
    expect(SandboxActivityService.coalesceMsFor(0)).toBe(SandboxActivityService.MAX_COALESCE_MS);
  });

  it('never rejects, whatever the database does', async () => {
    // The caller is forwarding an RFB message to a container. An activity note
    // must not be able to fail a keystroke, and an unhandled rejection out of
    // this path would take the orchestrator down over a database blip.
    const { prisma, fail } = fakePrisma();
    fail.with = new Error('connection reset');

    expect(() => new SandboxActivityService(prisma).touch('bot-1')).not.toThrow();
    await flush();
  });
});
