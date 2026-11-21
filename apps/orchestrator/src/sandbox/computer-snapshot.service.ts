import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Sandbox } from '@prisma/client';
import {
  COMPUTER_BUSY_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
  type ComputerSnapshotActivity,
  type ComputerSnapshotFailure,
  type ComputerSnapshotStatusResponse,
} from '@crewaid/shared';
import type { ComputerSnapshotObservation, ComputerSnapshots } from '@crewaid/sandbox-core';

import { PrismaService } from '../prisma/prisma.service.js';
import { profilesOfComputer } from './attached-computer.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox.provider.js';
import { SANDBOX_LOCK_LEASE_MS, SandboxService } from './sandbox.service.js';
import { lifecycleLeaseFresh } from './lifecycle-lease.js';

const UNSUPPORTED: ComputerSnapshotStatusResponse = {
  supported: false,
  snapshot: null,
  activity: null,
  lastError: null,
};

/**
 * One saved copy of the caller's computer: `GET /computer/snapshot`,
 * save and restore.
 *
 * Both writes answer as soon as the computer's lifecycle lease is held and run
 * on in this process, because a capture can take minutes. What this process is
 * doing and what last failed here are kept in memory: the provider reports what
 * it can see in flight, and a failure is a hint for the person who pressed the
 * button, not a record — a restart forgets it, and the next attempt clears it.
 */
@Injectable()
export class ComputerSnapshotService {
  private readonly logger = new Logger(ComputerSnapshotService.name);
  private readonly inFlight = new Map<string, ComputerSnapshotActivity>();
  private readonly failures = new Map<string, ComputerSnapshotFailure>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(SandboxService) private readonly sandboxes: SandboxService,
  ) {}

  async status(userId: string): Promise<ComputerSnapshotStatusResponse> {
    const snapshots = this.provider.snapshots;
    if (snapshots === undefined) return UNSUPPORTED;
    const computer = await this.computerOf(userId);
    if (computer === null || computer.workspacePending) {
      return { supported: true, snapshot: null, activity: null, lastError: null };
    }
    return this.describe(computer, await snapshots.inspect({ computerId: computer.id }));
  }

  async save(userId: string): Promise<ComputerSnapshotStatusResponse> {
    const { computer, snapshots } = await this.usable(userId);
    return this.run(computer, 'SAVING', 'SAVE_FAILED', snapshots, (signal) =>
      snapshots.take({ computerId: computer.id, abortSignal: signal }),
    );
  }

  async restore(userId: string): Promise<ComputerSnapshotStatusResponse> {
    const { computer, snapshots } = await this.usable(userId);
    return this.run(computer, 'RESTORING', 'RESTORE_FAILED', snapshots, async (signal) =>
      snapshots.restore({
        computerId: computer.id,
        keepProfiles: await profilesOfComputer(this.prisma, computer.id),
        leaveRunning: computer.state === 'RUNNING',
        abortSignal: signal,
      }),
    );
  }

  /**
   * Start `work` under the lease and answer once it is held, so a computer
   * someone else is moving is refused in the response rather than failing out
   * of sight.
   */
  private async run(
    computer: Sandbox,
    activity: ComputerSnapshotActivity,
    failure: ComputerSnapshotFailure,
    snapshots: ComputerSnapshots,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<ComputerSnapshotStatusResponse> {
    if (this.inFlight.has(computer.id)) throw new ConflictException({ code: COMPUTER_BUSY_CODE });
    this.inFlight.set(computer.id, activity);
    let seen: ComputerSnapshotObservation;
    try {
      seen = await snapshots.inspect({ computerId: computer.id });
      if (this.providerActivity(computer, seen) !== null) {
        throw new ConflictException({ code: COMPUTER_BUSY_CODE });
      }
      if (activity === 'RESTORING' && seen.snapshot === null) {
        throw new ConflictException({ code: SNAPSHOT_UNAVAILABLE_CODE });
      }
    } catch (error: unknown) {
      this.inFlight.delete(computer.id);
      throw error;
    }

    let held!: () => void;
    let refused!: (error: unknown) => void;
    const claimed = new Promise<void>((resolve, reject) => {
      held = resolve;
      refused = reject;
    });
    let started = false;
    void this.sandboxes
      .withComputerPaused(computer, work, async () => {
        await this.assertNoRunningTurns(computer);
        this.failures.delete(computer.id);
        started = true;
        held();
      })
      .then(
        () => this.inFlight.delete(computer.id),
        (error: unknown) => {
          this.inFlight.delete(computer.id);
          if (!started) {
            refused(error);
            return;
          }
          this.failures.set(computer.id, failure);
          const detail = error instanceof Error ? error.message : String(error);
          this.logger.error(`computer ${computer.id}: ${activity.toLowerCase()} failed: ${detail}`);
        },
      );
    await claimed;
    return { ...this.describe(computer, seen), activity, lastError: null };
  }

  private describe(
    computer: Sandbox,
    seen: ComputerSnapshotObservation,
  ): ComputerSnapshotStatusResponse {
    const local = this.inFlight.get(computer.id) ?? this.providerActivity(computer, seen);
    return {
      supported: true,
      snapshot:
        seen.snapshot === null
          ? null
          : {
              takenAt: new Date(seen.snapshot.takenAt).toISOString(),
              sizeBytes: seen.snapshot.sizeBytes,
              expiresAt:
                seen.snapshot.expiresAt === null
                  ? null
                  : new Date(seen.snapshot.expiresAt).toISOString(),
            },
      activity: local,
      lastError:
        local !== null
          ? null
          : (this.failures.get(computer.id) ?? (seen.lastError === null ? null : 'SAVE_FAILED')),
    };
  }

  private providerActivity(
    computer: Sandbox,
    seen: ComputerSnapshotObservation,
  ): ComputerSnapshotActivity | null {
    // A staged restore can be left behind after a crash. Only a live lease
    // can still be working on it, and a retry can clean up the old stage.
    if (
      seen.restoring &&
      computer.state === 'STARTING' &&
      lifecycleLeaseFresh(computer, Date.now(), SANDBOX_LOCK_LEASE_MS)
    )
      return 'RESTORING';
    return seen.saving ? 'SAVING' : null;
  }

  /** The caller's computer, provisioned, on a provider that can save one. */
  private async usable(
    userId: string,
  ): Promise<{ computer: Sandbox; snapshots: ComputerSnapshots }> {
    const snapshots = this.provider.snapshots;
    const computer = snapshots === undefined ? null : await this.computerOf(userId);
    // A computer whose machine has never been made has nothing to save yet.
    if (snapshots === undefined || computer === null || computer.workspacePending) {
      throw new ConflictException({ code: SNAPSHOT_UNAVAILABLE_CODE });
    }
    return { computer, snapshots };
  }

  /**
   * Check after claiming the computer. A new turn that needs the computer
   * waits for the lifecycle owner, and a turn that was already running vetoes
   * the operation before the machine is paused.
   */
  private async assertNoRunningTurns(computer: Sandbox): Promise<void> {
    const running = await this.prisma.agentTurn.count({
      where: { status: 'running', bot: { sandboxId: computer.id, userId: computer.userId } },
    });
    if (running > 0) throw new ConflictException({ code: COMPUTER_BUSY_CODE });
  }

  /** The one `attachToComputer` gives every bot of this user: their oldest. */
  private computerOf(userId: string): Promise<Sandbox | null> {
    return this.prisma.sandbox.findFirst({ where: { userId }, orderBy: { id: 'asc' } });
  }
}
