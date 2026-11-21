import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Sandbox } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { COMPUTE_POLICY, type ComputePolicy } from './compute-policy.js';
import { OCCUPIES_A_SLOT, SandboxService } from './sandbox.service.js';

const DEFAULT_METER_INTERVAL_MS = 60_000;

/** `SANDBOX_METER_INTERVAL_MS`; `0` or less turns the meter off. */
export function readMeterIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_METER_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`SANDBOX_METER_INTERVAL_MS must be a number of milliseconds, got ${raw}`);
  }
  return Math.trunc(value);
}

/**
 * Computer time, counted against each owner's plan.
 *
 * Runs only where a `ComputePolicy` is registered — a cloud server that bills —
 * so a self-hosted server never meters anything. Once a minute it counts, for
 * every computer that holds a slot on the host, the time since it was last
 * counted, and stops a running computer whose owner has used their hours or
 * no longer has a plan.
 *
 * A sweep, not a hook on every transition
 *
 * State moves in four services (lifecycle, leases, reconciliation, idle stop)
 * and a process can die between any two of them. A sweep over `meteredAt`
 * needs none of them to remember anything: the watermark survives a restart,
 * and the time counted is always "since the watermark, or since the last start
 * if that is later". What it gives up is at most one interval per stop — the
 * minute between the last count and the stop is not charged — which errs in
 * the customer's favour.
 *
 * And the watermark moves before the time is recorded
 *
 * A compare-and-swap on `meteredAt` claims each interval exactly once, so two
 * orchestrator processes, or a slow pass overlapping the next, cannot both
 * charge it. Claiming first means a crash between the claim and the record
 * loses that interval rather than charging it twice — the same direction of
 * error as above, on purpose.
 */
@Injectable()
export class SandboxMeterService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SandboxMeterService.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private metering = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SandboxService) private readonly sandboxes: SandboxService,
    @Optional() @Inject(COMPUTE_POLICY) private readonly policy?: ComputePolicy,
  ) {
    this.intervalMs = readMeterIntervalMs(process.env['SANDBOX_METER_INTERVAL_MS']);
  }

  onApplicationBootstrap(): void {
    if (this.policy === undefined || this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs).unref();
    this.logger.log(`computer time metered every ${this.intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Public so tests drive it with their own clock. */
  async sweep(now: Date = new Date()): Promise<void> {
    if (this.policy === undefined || this.metering) return;
    this.metering = true;
    try {
      const rows = await this.prisma.sandbox.findMany({
        where: {
          state: { in: [...OCCUPIES_A_SLOT] },
          // Reconciliation's verdict on a runtime it found gone: UNHEALTHY with
          // the container cleared. Nothing is running, so nothing is charged —
          // and when it is started again, counting resumes from that start.
          NOT: { state: 'UNHEALTHY', containerId: null },
        },
        include: { bots: { select: { id: true } } },
      });
      const results = await Promise.allSettled(rows.map((row) => this.meter(row, now)));
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.error(`computer metering failed: ${messageOf(result.reason)}`);
        }
      }
    } catch (error: unknown) {
      // Runs again next interval; a timer callback must never take the
      // process down over a database blip.
      this.logger.error(`computer metering pass failed: ${messageOf(error)}`);
    } finally {
      this.metering = false;
    }
  }

  private async meter(row: MeteredSandbox, now: Date): Promise<void> {
    if (this.policy === undefined) return;
    // The watermark only moves forward. A pass with an earlier clock — a slow
    // one overlapping the next, or another process whose clock is behind —
    // must not pull it back, or the time between would be charged again.
    if (row.meteredAt !== null && now.getTime() <= row.meteredAt.getTime()) return;
    const from = latest(row.meteredAt, row.lastStartedAt);
    // At most two intervals per pass: a gap longer than that is a process
    // that was not running, and time nobody watched is not charged.
    const seconds =
      from === null
        ? 0
        : Math.min(
            Math.floor((now.getTime() - from.getTime()) / 1000),
            Math.floor((2 * Math.max(this.intervalMs, DEFAULT_METER_INTERVAL_MS)) / 1000),
          );

    const claimed = await this.prisma.sandbox.updateMany({
      where: { id: row.id, meteredAt: row.meteredAt },
      data: { meteredAt: now },
    });
    if (claimed.count === 0 || seconds <= 0) return;

    const { stop } = await this.policy.record(row.userId, seconds, now);
    if (stop && (row.state === 'RUNNING' || row.state === 'UNHEALTHY')) {
      await this.stopForPlan(row);
    }
  }

  /**
   * Stop a computer whose owner's plan no longer covers it — running, or
   * unhealthy but possibly still running.
   *
   * Through the lifecycle's lease-holding stop, so it cannot race a start or a
   * stop already in flight, and with the plan asked again inside the lease: a
   * payment or an upgrade that landed after this pass decided keeps the
   * computer on. A start STARTING when the hours ran out is refused by the
   * same plan, or settles and is caught by the next pass.
   */
  private async stopForPlan(row: MeteredSandbox): Promise<void> {
    const policy = this.policy;
    if (policy === undefined) return;
    // A machine's frames are announced under a bot; any tenant will do.
    const tenant = row.bots[0];
    if (tenant === undefined) return;
    const stopped = await this.sandboxes.stopUncovered(
      { botId: tenant.id, computerId: row.id },
      async () => !(await policy.covers(row.userId)),
    );
    if (stopped) this.logger.log(`computer ${row.id}: stopped, its owner's plan does not cover it`);
  }
}

type MeteredSandbox = Sandbox & { readonly bots: readonly { readonly id: string }[] };

function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
