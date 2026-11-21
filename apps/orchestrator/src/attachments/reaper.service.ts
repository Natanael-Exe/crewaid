import { mkdir, statfs } from 'node:fs/promises';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { ARTIFACT_REAP_ON_QUEUE } from './artifact-reap.queue.js';
import { ARTIFACT_STORE, type ArtifactStore } from './artifact-store.js';
import {
  UNCLAIMED_TTL_MS,
  readArtifactMaxTotalBytes,
  readArtifactMaxUserBytes,
  readMinFreeBytes,
  readReapIntervalMs,
  readReapOnBoot,
  requireArtifactDir,
} from './attachments.config.js';
import { DiskArtifactStore } from './disk-artifact-store.js';

type SweepResult = { deleted: number; failed: number };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function artifactCapacityException(message: string): HttpException {
  return new HttpException({ statusCode: 507, code: 'ARTIFACT_CAPACITY', message }, 507);
}

/**
 * Owns attachment retention and host-wide upload admission.
 *
 * A reaper cannot make the artifact store and Postgres one atomic resource. It
 * therefore locks each candidate row, re-checks the expiry fence, deletes the
 * object, and only then deletes the row in the same database transaction. A
 * message claim blocks on that row lock: whichever operation owns the row
 * first decides its lifecycle. A real delete failure rolls the transaction
 * back so the durable row remains available for a later retry.
 *
 * Upload admission uses a transaction-scoped advisory lock around the
 * aggregates, disk check, and row insert. The per-user cap applies to every
 * store; the host-wide cap and the free-disk floor guard a local disk, so
 * they apply to the disk store only. The insert reserves the admitted
 * bytes before another process may count again, so a burst of uploads cannot
 * pass the cap one request at a time and exceed it together. File I/O happens
 * after commit so a slow disk never holds a database transaction open.
 */
@Injectable()
export class AttachmentReaperService implements OnApplicationBootstrap, OnModuleDestroy {
  /** Unique among this application's Postgres advisory locks. */
  private static readonly CAPACITY_LOCK_KEY = 5_390_031;

  private readonly logger = new Logger(AttachmentReaperService.name);
  private readonly maxTotalBytes: number;
  private readonly maxUserBytes: number;
  private readonly minFreeBytes: number;
  private readonly reapIntervalMs: number;
  private readonly reapOnBoot: boolean;

  private timer: NodeJS.Timeout | null = null;
  private sweepInFlight: Promise<SweepResult> | null = null;
  private lastSuccessfulSweepAt = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    /**
     * With Redis, the periodic pass is a BullMQ job and this
     * service keeps no timer. Optional so a caller constructing the service
     * directly (the capacity suites) gets M2's in-process behaviour.
     */
    @Optional() @Inject(ARTIFACT_REAP_ON_QUEUE) private readonly reapOnQueue: boolean = false,
    @Optional()
    @Inject(ARTIFACT_STORE)
    private readonly artifacts: ArtifactStore = new DiskArtifactStore(),
  ) {
    this.maxTotalBytes = readArtifactMaxTotalBytes(process.env['ARTIFACT_MAX_TOTAL_MB']);
    this.maxUserBytes = readArtifactMaxUserBytes(process.env['ARTIFACT_MAX_USER_MB']);
    this.minFreeBytes = readMinFreeBytes(process.env['ARTIFACT_MIN_FREE_MB']);
    this.reapIntervalMs = readReapIntervalMs(process.env['ARTIFACT_REAP_INTERVAL_MS']);
    this.reapOnBoot = readReapOnBoot(process.env['ARTIFACT_REAP_ON_BOOT']);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.reapOnBoot) await this.sweep();
    if (this.reapIntervalMs === 0) {
      this.logger.log('periodic artifact reaping disabled');
      return;
    }
    // The queue owns the cadence; `ArtifactReapScheduler` says so at boot.
    if (this.reapOnQueue) return;
    this.timer = setInterval(() => void this.sweep(), this.reapIntervalMs).unref();
    this.logger.log(`artifact reaper runs every ${this.reapIntervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Coalesce overlapping callers onto the same pass instead of racing it. */
  sweep(): Promise<SweepResult> {
    if (this.sweepInFlight !== null) return this.sweepInFlight;
    const pass = this.runSweep()
      .catch((error: unknown) => {
        this.logger.error(`artifact reaper scan failed: ${messageOf(error)}`);
        return { deleted: 0, failed: 1 };
      })
      .finally(() => {
        if (this.sweepInFlight === pass) this.sweepInFlight = null;
      });
    this.sweepInFlight = pass;
    return pass;
  }

  /**
   * Uploads opportunistically refresh cleanup before checking capacity. A
   * disabled interval also disables this hook, which keeps shared test and
   * maintenance databases from being swept implicitly.
   */
  async reapIfStale(maxAgeMs = 60_000): Promise<void> {
    if (this.reapIntervalMs === 0) return;
    if (Date.now() - this.lastSuccessfulSweepAt > maxAgeMs) await this.sweep();
  }

  /**
   * Reserve capacity by inserting the Attachment inside one serialized,
   * short database transaction. The caller writes bytes only after this
   * returns and removes the still-unclaimed reservation if that write fails.
   */
  async reserveUploadCapacity<T>(
    ownerId: string,
    incomingBytes: number,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const onDisk = this.artifacts.kind === 'disk';
    const artifactDir = onDisk ? requireArtifactDir() : null;
    if (artifactDir !== null) {
      try {
        await mkdir(artifactDir, { recursive: true });
      } catch (error: unknown) {
        throw artifactCapacityException(
          `Artifact storage is unavailable at ${artifactDir}: ${messageOf(error)}`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AttachmentReaperService.CAPACITY_LOCK_KEY}::bigint)`;

      const owned = await tx.attachment.aggregate({
        where: { ownerId },
        _sum: { sizeBytes: true },
      });
      const ownedBytes = owned._sum.sizeBytes ?? 0;
      if (ownedBytes + incomingBytes > this.maxUserBytes) {
        throw artifactCapacityException(
          `Your file storage is full: this upload would use ${ownedBytes + incomingBytes} ` +
            `of ${this.maxUserBytes} bytes.`,
        );
      }

      if (artifactDir === null) return operation(tx);

      const aggregate = await tx.attachment.aggregate({ _sum: { sizeBytes: true } });
      const totalBytes = aggregate._sum.sizeBytes ?? 0;
      if (totalBytes + incomingBytes > this.maxTotalBytes) {
        throw artifactCapacityException(
          `Artifact quota exceeded: this upload would use ${totalBytes + incomingBytes} ` +
            `of ${this.maxTotalBytes} bytes.`,
        );
      }

      if (this.minFreeBytes > 0) {
        let freeBytes: number;
        try {
          const stats = await statfs(artifactDir);
          freeBytes = stats.bsize * stats.bavail;
        } catch (error: unknown) {
          throw artifactCapacityException(
            `Artifact disk capacity could not be measured at ${artifactDir}: ${messageOf(error)}`,
          );
        }
        if (freeBytes - incomingBytes < this.minFreeBytes) {
          throw artifactCapacityException(
            `Artifact volume requires ${this.minFreeBytes} bytes free after each upload; ` +
              `this upload would leave ${Math.max(0, freeBytes - incomingBytes)} bytes.`,
          );
        }
      }

      return operation(tx);
    });
  }

  private async runSweep(): Promise<SweepResult> {
    const cutoff = new Date(Date.now() - UNCLAIMED_TTL_MS);
    let candidates: { id: string }[];
    try {
      candidates = await this.prisma.attachment.findMany({
        // A deliverable's file outlives its message and is not garbage.
        where: { messageId: null, deliverable: null, createdAt: { lt: cutoff } },
        select: { id: true },
      });
    } catch (error: unknown) {
      this.logger.error(`artifact reaper scan failed: ${messageOf(error)}`);
      return { deleted: 0, failed: 1 };
    }

    let deleted = 0;
    let failed = await this.retryObjectDeletions();
    for (const candidate of candidates) {
      try {
        const didDelete = await this.reapOne(candidate.id, cutoff);
        if (didDelete) deleted += 1;
      } catch (error: unknown) {
        failed += 1;
        this.logger.error(`artifact reaper failed for ${candidate.id}: ${messageOf(error)}`);
      }
    }

    if (failed === 0) this.lastSuccessfulSweepAt = Date.now();
    if (deleted > 0 || failed > 0) {
      this.logger.log(`artifact reaper completed: ${deleted} deleted, ${failed} failed`);
    }
    return { deleted, failed };
  }

  /** Rows are enqueued by PostgreSQL even when a bot or message deletion cascades. */
  private async retryObjectDeletions(): Promise<number> {
    let failed = 0;
    const cutoff = new Date();
    for (;;) {
      const batch = await this.prisma.artifactDeletion.findMany({
        where: { retryAt: { lte: cutoff } },
        orderBy: [{ retryAt: 'asc' }, { storageKey: 'asc' }],
        take: 100,
      });
      for (const { storageKey } of batch) {
        try {
          await this.artifacts.delete(storageKey);
          await this.prisma.artifactDeletion.deleteMany({ where: { storageKey } });
        } catch (error) {
          failed++;
          this.logger.warn(`Artifact deletion will retry for ${storageKey}: ${messageOf(error)}`);
          await this.prisma.artifactDeletion.updateMany({
            where: { storageKey },
            data: { retryAt: new Date(Date.now() + 60_000) },
          });
        }
      }
      if (batch.length < 100) return failed;
    }
  }

  private async reapOne(attachmentId: string, cutoff: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Attachment" WHERE "id" = ${attachmentId} FOR UPDATE`;
      const row = await tx.attachment.findFirst({
        where: { id: attachmentId, messageId: null, deliverable: null, createdAt: { lt: cutoff } },
        select: { id: true, storageKey: true },
      });
      if (row === null) return false;

      // Absent counts as deleted; anything else throws and keeps the row.
      await this.artifacts.delete(row.storageKey);

      const deletion = await tx.attachment.deleteMany({
        where: { id: row.id, messageId: null, deliverable: null, createdAt: { lt: cutoff } },
      });
      await tx.artifactDeletion.deleteMany({ where: { storageKey: row.storageKey } });
      return deletion.count === 1;
    });
  }
}
