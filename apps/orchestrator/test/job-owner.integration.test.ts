import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SkillCompileService } from '../src/skills/skill-compile.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { signIn, signOutAndDelete, type SignedInUser } from './auth-fixture.js';

/**
 * V1-10 — a background job keeps the owner it was authorized with.
 *
 * A skill compile runs on a worker. By the time it does, the person who
 * recorded it may have closed their laptop, signed out, or never been
 * connected to this process at all — the job arrives from Redis, not from a
 * request. So "who is this for" has exactly one honest answer: the owner
 * PERSISTED with the work.
 *
 * ── THE MISTAKE THIS IS AIMED AT ────────────────────────────────────────────
 *
 * It is not exotic. While wiring a principal through V1-08 and V1-09, the
 * obvious thing to reach for when a job needs a userId is the one the
 * orchestrator already has in hand — the socket's. That compiles, runs, and is
 * silently wrong twice over: on a shared install the job bills and reads as
 * whoever happens to be connected, and work that was already authorized dies
 * the moment its socket closes.
 *
 * `eslint.config.mjs` fences the import (probe:
 * `v1-10-job-reads-live-principal.probe.ts`). These cases fence the BEHAVIOUR,
 * which a lint rule cannot see: that the id actually used is the row's.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

let prisma: PrismaService;
let owner: SignedInUser;
let stranger: SignedInUser;

/**
 * Records which owner reached model resolution, then stops the compile.
 *
 * The refusal is deliberate: everything after resolution is the compiler's
 * business and needs a real trace on disk, while the only thing this suite
 * asserts is WHOSE id crossed that boundary. `run()` catches it and settles
 * the recording FAILED, which is a real path rather than a hole in the fake.
 */
function resolverSpy(seen: string[]): { models: unknown } {
  return {
    models: {
      resolveText: (userId: string) => {
        seen.push(userId);
        return Promise.reject(new Error('stop after resolution'));
      },
      setAddressResolverForTests: () => undefined,
    },
  };
}

const events = {
  emitRecordingState: () => undefined,
  emitSkillCompiled: () => undefined,
} as unknown as TurnEventBus;

async function recordingFor(userId: string, label: string): Promise<string> {
  // A computer on record, because the compiler needs the resolution the
  // coordinates were captured at and refuses without it — again BEFORE
  // resolution, so a bot with no sandbox would never reach the assertion.
  const sandbox = await prisma.sandbox.create({
    data: { userId, state: 'RUNNING', widthPx: 1280, heightPx: 800 },
  });
  const bot = await prisma.bot.create({
    data: {
      userId,
      name: `v110-${label}-${RUN_ID}`,
      role: 'fixture',
      avatarColor: '#8B6F47',
      systemPrompt: '',
      modelId: 'default',
      sandboxId: sandbox.id,
    },
  });
  const recording = await prisma.recording.create({
    data: { botId: bot.id, intent: 'do the thing', state: 'COMPILING' },
  });
  // One event, because a recording that captured nothing is refused BEFORE
  // resolution — a model handed an empty trace invents a plausible script, so
  // the compiler stops first. Without this the resolver is never reached and
  // every case here passes for the wrong reason.
  await prisma.recordingEvent.create({
    data: {
      recordingId: recording.id,
      tsOffsetMs: 0,
      layer: 'X11',
      type: 'click',
      payload: { x: 10, y: 10 },
    },
  });
  return recording.id;
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'V1-10 — a job runs as its persisted owner',
  () => {
    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      owner = await signIn(prisma, { label: `owner_${RUN_ID}` });
      stranger = await signIn(prisma, { label: `stranger_${RUN_ID}` });
    });

    afterAll(async () => {
      if (prisma !== undefined) {
        if (owner !== undefined) await signOutAndDelete(prisma, owner.userId);
        if (stranger !== undefined) await signOutAndDelete(prisma, stranger.userId);
        await prisma.$disconnect();
      }
    });

    it("resolves the model as the recording's bot owner", async () => {
      const seen: string[] = [];
      const { models } = resolverSpy(seen);
      const recordingId = await recordingFor(owner.userId, 'basic');

      await new SkillCompileService(prisma, events, models as never).run(recordingId);

      expect(seen).toEqual([owner.userId]);
    });

    it('runs after the owner signs out, because the work was already authorized', async () => {
      // Revoking a session ends INTERACTIVE access (V1-09 makes that bite at
      // the next frame). It must not reach back and kill a compile that was
      // authorized when the recording was stopped — the person pressed the
      // button, and closing their laptop is not a retraction.
      const shortLived = await signIn(prisma, { label: `gone_${RUN_ID}` });
      try {
        const recordingId = await recordingFor(shortLived.userId, 'signedout');
        await prisma.session.deleteMany({ where: { userId: shortLived.userId } });

        const seen: string[] = [];
        const { models } = resolverSpy(seen);
        await new SkillCompileService(prisma, events, models as never).run(recordingId);

        // Still ran, and still as them.
        expect(seen).toEqual([shortLived.userId]);
      } finally {
        await signOutAndDelete(prisma, shortLived.userId);
      }
    });

    it('does not borrow the owner of whoever else is signed in', async () => {
      // THE SHARED-INSTALL CASE. `stranger` has a live session for the whole
      // suite; a job that reached for "the user we have" rather than the
      // row's would pick them up here, and on one account the difference is
      // invisible — which is why this needs two.
      const seen: string[] = [];
      const { models } = resolverSpy(seen);
      const recordingId = await recordingFor(owner.userId, 'shared');

      await new SkillCompileService(prisma, events, models as never).run(recordingId);

      expect(seen).toEqual([owner.userId]);
      expect(seen).not.toContain(stranger.userId);
    });

    it('settles the recording rather than leaving it COMPILING', async () => {
      // The compile above fails at resolution on purpose, so this pins what a
      // failure does to the row: a job that rejects with nothing written
      // leaves COMPILING for good, and nothing else revisits it.
      const recordingId = await recordingFor(owner.userId, 'settles');
      const { models } = resolverSpy([]);

      await new SkillCompileService(prisma, events, models as never).run(recordingId);

      const row = await prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
      expect(row.state).not.toBe('COMPILING');
    });
  },
);
