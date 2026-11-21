import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import {
  COMPUTER_BUSY_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
  type ComputerSnapshotStatusResponse,
} from '@crewaid/shared';
import type { ComputerSnapshotObservation, ComputerSnapshots } from '@crewaid/sandbox-core';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { ComputerSnapshotService } from '../src/sandbox/computer-snapshot.service.js';
import { SandboxService } from '../src/sandbox/sandbox.service.js';
import { SANDBOX_PROVIDER } from '../src/sandbox/sandbox.provider.js';
import { privateComputerBot } from './computer-fixtures.js';
import { FakeProvider } from './sandbox-fakes.js';
import { conversationIdOf } from './turn-fixtures.js';

/**
 * D-237 — save, replace and restore a computer's one snapshot.
 *
 * A real database, because the lease is the `Sandbox` row's compare-and-swap,
 * and a fake provider whose snapshots record what they were asked to do.
 */
const DATABASE_URL = process.env['DATABASE_URL'];

class FakeSnapshots implements ComputerSnapshots {
  readonly saved = new Map<string, number>();
  readonly takeCalls: string[] = [];
  readonly restoreCalls: { computerId: string; keepProfiles: readonly string[] }[] = [];
  /** Holds take and restore open until released, to watch them in flight. */
  gate: Promise<void> = Promise.resolve();
  failWith: Error | null = null;
  restoring = false;

  inspect = ({ computerId }: { computerId: string }): Promise<ComputerSnapshotObservation> => {
    const takenAt = this.saved.get(computerId);
    return Promise.resolve({
      snapshot: takenAt === undefined ? null : { takenAt, sizeBytes: 2_048, expiresAt: null },
      saving: false,
      restoring: this.restoring,
      lastError: null,
    });
  };

  take = async ({ computerId }: { computerId: string }): Promise<void> => {
    this.takeCalls.push(computerId);
    await this.gate;
    if (this.failWith !== null) throw this.failWith;
    this.saved.set(computerId, Date.now());
  };

  restore = async (options: {
    computerId: string;
    keepProfiles: readonly string[];
  }): Promise<void> => {
    this.restoreCalls.push({ computerId: options.computerId, keepProfiles: options.keepProfiles });
    await this.gate;
    if (this.failWith !== null) throw this.failWith;
  };
}

function conflictCode(error: unknown): unknown {
  if (!(error instanceof ConflictException)) return undefined;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'D-237 computer snapshots (real db)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let sandboxes: SandboxService;
    let service: ComputerSnapshotService;
    let provider: FakeProvider & { snapshots?: ComputerSnapshots };
    let snapshots: FakeSnapshots;
    let userId: string;
    let botId: string;
    const users: string[] = [];

    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      provider = new FakeProvider();
      const moduleRef = await Test.createTestingModule({
        imports: [(await import('../src/sandbox/sandbox.module.js')).SandboxModule],
      })
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      sandboxes = app.get(SandboxService);
      service = app.get(ComputerSnapshotService);
    });

    afterAll(async () => {
      await prisma?.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
      await app?.close();
    });

    beforeEach(async () => {
      snapshots = new FakeSnapshots();
      provider.snapshots = snapshots;
      // A user of its own, so "their oldest computer" is this test's.
      userId = `usr_d237_${randomUUID().slice(0, 8)}`;
      users.push(userId);
      await prisma.user.create({
        data: { id: userId, name: 'Snapshot', email: `${userId}@test.invalid` },
      });
      const bot = await privateComputerBot(prisma, provider, userId, {
        name: `d237-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      botId = bot.id;
    });

    async function settled(): Promise<ComputerSnapshotStatusResponse> {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const status = await service.status(userId);
        if (status.activity === null) return status;
        if (Date.now() > deadline) throw new Error('snapshot work never settled');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    async function stateOf(): Promise<string | undefined> {
      return (await prisma.sandbox.findUnique({ where: { id: botId } }))?.state;
    }

    it('answers supported: false where the provider cannot snapshot', async () => {
      delete provider.snapshots;
      expect(await service.status(userId)).toEqual({
        supported: false,
        snapshot: null,
        activity: null,
        lastError: null,
      });
      await expect(service.save(userId)).rejects.toSatisfy(
        (error) => conflictCode(error) === SNAPSHOT_UNAVAILABLE_CODE,
      );
    });

    it('saves a stopped computer without starting it', async () => {
      let release!: () => void;
      snapshots.gate = new Promise((resolve) => (release = resolve));
      const resumes = provider.resumeCalls;

      const accepted = await service.save(userId);
      expect(accepted.activity).toBe('SAVING');
      // The lease is held while it saves, so nothing else can move the computer.
      expect(await stateOf()).toBe('STARTING');
      release();

      const done = await settled();
      expect(done.snapshot?.sizeBytes).toBe(2_048);
      expect(done.lastError).toBeNull();
      expect(snapshots.takeCalls).toEqual([botId]);
      expect(await stateOf()).toBe('STOPPED');
      expect(provider.resumeCalls).toBe(resumes);
    });

    it('pauses a running computer for the save and brings it back', async () => {
      await sandboxes.start(userId, botId);
      expect(await stateOf()).toBe('RUNNING');
      const stops = provider.stopCalls;

      await service.save(userId);
      await settled();

      expect(provider.stopCalls).toBe(stops + 1);
      expect(await stateOf()).toBe('RUNNING');
    });

    it('refuses while a bot on the computer is working', async () => {
      await prisma.agentTurn.create({
        data: {
          botId,
          conversationId: await conversationIdOf(prisma, botId),
          triggerMessageId: `msg_${randomUUID()}`,
          status: 'running',
        },
      });
      await expect(service.save(userId)).rejects.toSatisfy(
        (error) => conflictCode(error) === COMPUTER_BUSY_CODE,
      );
      expect(snapshots.takeCalls).toEqual([]);
    });

    it('refuses a second save while one is under way', async () => {
      let release!: () => void;
      snapshots.gate = new Promise((resolve) => (release = resolve));
      await service.save(userId);
      await expect(service.save(userId)).rejects.toSatisfy(
        (error) => conflictCode(error) === COMPUTER_BUSY_CODE,
      );
      release();
      await settled();
      expect(snapshots.takeCalls).toHaveLength(1);
    });

    it('accepts exactly one of two simultaneous saves and retains its activity', async () => {
      let release!: () => void;
      snapshots.gate = new Promise((resolve) => (release = resolve));
      try {
        const responses = await Promise.allSettled([service.save(userId), service.save(userId)]);
        expect(responses.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(
          responses.flatMap((r) => (r.status === 'rejected' ? [conflictCode(r.reason)] : [])),
        ).toEqual([COMPUTER_BUSY_CODE]);
        expect((await service.status(userId)).activity).toBe('SAVING');
        await expect(service.save(userId)).rejects.toSatisfy(
          (error) => conflictCode(error) === COMPUTER_BUSY_CODE,
        );
      } finally {
        release();
      }
      await settled();
      expect(snapshots.takeCalls).toHaveLength(1);
    });

    it('ignores a staged restore left behind after its lifecycle lease', async () => {
      snapshots.saved.set(botId, Date.now());
      snapshots.restoring = true;
      expect((await service.status(userId)).activity).toBeNull();
      await expect(service.restore(userId)).resolves.toMatchObject({ activity: 'RESTORING' });
      await settled();
    });

    it('reports a failed save and leaves the computer as it was', async () => {
      snapshots.failWith = new Error('capture failed');
      await service.save(userId);
      const done = await settled();
      expect(done.lastError).toBe('SAVE_FAILED');
      expect(done.snapshot).toBeNull();
      expect(await stateOf()).toBe('STOPPED');
    });

    it('refuses to restore before anything is saved', async () => {
      await expect(service.restore(userId)).rejects.toSatisfy(
        (error) => conflictCode(error) === SNAPSHOT_UNAVAILABLE_CODE,
      );
      expect(snapshots.restoreCalls).toEqual([]);
    });

    it('restores, keeping every profile that still belongs to the computer', async () => {
      await prisma.identity.create({ data: { sandboxId: botId, name: 'company-google' } });
      snapshots.saved.set(botId, Date.now() - 60_000);
      await sandboxes.start(userId, botId);

      const accepted = await service.restore(userId);
      expect(accepted.activity).toBe('RESTORING');
      const done = await settled();

      expect(done.lastError).toBeNull();
      expect(snapshots.restoreCalls).toHaveLength(1);
      expect([...(snapshots.restoreCalls[0]?.keepProfiles ?? [])].sort()).toEqual(
        [botId, 'company-google'].sort(),
      );
      // It was running, so it is brought back up on the restored machine.
      expect(await stateOf()).toBe('RUNNING');
    });

    it('reports a failed restore', async () => {
      snapshots.saved.set(botId, Date.now());
      snapshots.failWith = new Error('restore failed');
      await service.restore(userId);
      expect((await settled()).lastError).toBe('RESTORE_FAILED');
      expect(await stateOf()).toBe('STOPPED');
    });
  },
);
