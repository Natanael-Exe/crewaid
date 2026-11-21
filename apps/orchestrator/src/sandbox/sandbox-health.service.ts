import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Sandbox, SandboxState } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { SANDBOX_PROVIDER, type SandboxHealth, type SandboxProvider } from './sandbox.provider.js';

/**
 * Health polling (M2-BE-05, WebSocket `sandbox.state`).
 *
 * A sandbox can stop serving without anyone calling stop — the container is
 * killed, the desktop wedges, the host reboots. Nothing in the request path
 * notices, because the request path only runs when someone makes a request.
 * This sweeps every settled sandbox on an interval and writes what it finds.
 *
 * Why it may not touch every row
 *
 * `Sandbox.state` is not just a status field: `STARTING` in that column IS the
 * start lock, and `lastStartedAt` is its lease. So a poll that wrote states
 * freely would be writing to a mutex it does not hold. Marking a `STARTING`
 * row `UNHEALTHY` releases someone else's lock in the middle of a create —
 * which is precisely how a second container appears for one bot, the thing
 * M2-BE-04 exists to prevent. Writing `RUNNING` over one is the same bug
 * wearing a friendlier state.
 *
 * Two independent fences, because this one is worth over-engineering:
 *
 * 1. The query selects only settled states. `STARTING` is never a candidate,
 * and neither is `STOPPED` or `ERROR` — an operator put those there
 * deliberately and a poll second-guessing them would resurrect a sandbox
 * nobody asked for.
 * 2. Every write is a compare-and-swap pinned to BOTH the state and the
 * exact `lastStartedAt` that were read. `claim()` changes both when it
 * takes the lock, so a lifecycle operation that started after the probe
 * began reduces this write to zero rows. The lease timestamp is already
 * the fencing token for start and stop; the poll simply joins the scheme
 * rather than inventing a second one.
 *
 * Fence 1 alone would still lose the read-probe-write race; fence 2 alone
 * would rely on nobody ever adding a state to the query. Together, a poll can
 * only ever move a row it observed settled and that nothing has touched since.
 *
 * What it deliberately does not do
 *
 * It does not restart, recreate, or clean up anything. Detecting that a
 * desktop is gone and deciding what to do about it are different jobs with
 * different failure modes, and D-031 is explicit that a missing runtime must
 * surface as a recoverable error rather than silently become a fresh empty
 * desktop. Reconciling provider state — orphaned containers, partial creation,
 * partial teardown — is M2-BE-12. This only ever reports.
 */
@Injectable()
export class SandboxHealthService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SandboxHealthService.name);

  /**
   * M2-QA-04 asserts UNHEALTHY "within one poll interval", so the interval is
   * the test's tolerance as much as the detection latency. Ten seconds keeps a
   * killed desktop visible fast enough to act on while leaving §7.4's <2% idle
   * CPU budget untouched — six sandboxes is six HTTP probes per ten seconds.
   */
  static readonly DEFAULT_INTERVAL_MS = 10_000;

  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  /** A sweep in flight. A slow daemon must not stack ticks on top of it. */
  private sweeping = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {
    this.intervalMs = readInterval(process.env['SANDBOX_HEALTH_INTERVAL_MS']);
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) {
      this.logger.log('sandbox health polling disabled (SANDBOX_HEALTH_INTERVAL_MS <= 0)');
      return;
    }
    // `unref` so the poll is never the reason the process stays alive: a
    // ten-second timer would otherwise hold a test runner and a shutdown open.
    this.timer = setInterval(() => void this.sweep(), this.intervalMs).unref();
    this.logger.log(`sandbox health polling every ${this.intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every settled sandbox. Public because the tests drive it
   * directly — asserting "UNHEALTHY within one interval" by sleeping through a
   * real interval measures the clock, not the transition.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = await this.prisma.sandbox.findMany({
        // Spread: Prisma's `in` takes a mutable array, and the constant is
        // readonly so nothing can quietly add STARTING to it at a call site.
        where: { state: { in: [...SETTLED_LIVE_STATES] }, pausePending: false },
        // D-046: the frame this sweep emits is addressed to a bot, so the
        // tenants come back with the machine rather than in a second query a
        // concurrent attach could change underneath.
        include: { bots: { select: { id: true } } },
      });
      // Concurrent: the probes are independent, and §7.5 caps this at six
      // sandboxes. Sequential would make one wedged bridge delay the detection
      // of every sandbox behind it by its own 2 s timeout.
      const results = await Promise.allSettled(rows.map((row) => this.reconcile(row)));
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.error(`sandbox health reconciliation failed: ${messageOf(result.reason)}`);
        }
      }
    } catch (error: unknown) {
      // A sweep is best-effort by construction — it runs again in an interval.
      // It must never reject: an unhandled rejection from a timer callback
      // takes the orchestrator down over a transient database blip.
      this.logger.error(`sandbox health sweep failed: ${messageOf(error)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Read-only snapshot for `GET /health` (CC-02).
   *
   * The sweep WRITES state; this does not. It answers the same question the
   * poll asks — "is this sandbox serving right now" — without touching the
   * lock discipline described above: no state writes, no frames, no lease
   * traffic. `healthy` means "declared RUNNING and its bridge answers this
   * instant"; every other state answers false WITHOUT a probe, because a
   * stopped sandbox is not sick — it is stopped, and the state next to it is
   * what says so.
   */
  async snapshot(
    userId: string,
  ): Promise<{ botId: string; state: SandboxState; healthy: boolean }[]> {
    // D-046: one machine can carry several bots, and the caller's report is
    // read per bot. Fanning the machine's answer out across its tenants keeps
    // the same probe result appearing more than once — true, and less
    // misleading than reporting a machine under one arbitrary tenant.
    const rows = await this.prisma.sandbox.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
      include: { bots: { select: { id: true }, orderBy: { id: 'asc' } } },
    });
    const probed = await Promise.all(
      rows.map(async (row) => {
        if (row.state !== 'RUNNING') return { row, healthy: false };
        try {
          const health = await this.provider.checkHealth({
            sessionId: row.sessionId ?? row.id,
          });
          return { row, healthy: health.ok };
        } catch {
          // `checkHealth` throws only when the daemon itself is unreachable.
          // There is no sandbox state to protect on this path, so the honest
          // answer to "is it serving" is no.
          return { row, healthy: false };
        }
      }),
    );
    return probed
      .flatMap(({ row, healthy }) =>
        row.bots.map((bot) => ({ botId: bot.id, state: row.state, healthy })),
      )
      .sort((a, b) => a.botId.localeCompare(b.botId));
  }

  private async reconcile(row: SandboxWithTenants): Promise<void> {
    // Falls back to the machine's id for the same reason `bringUp` does: a
    // container created before its session id was persisted still answers to
    // that key.
    const sessionId = row.sessionId ?? row.id;

    let health: SandboxHealth;
    try {
      health = await this.provider.checkHealth({ sessionId });
    } catch (error: unknown) {
      // `checkHealth` answers for sandbox faults and throws only when the
      // daemon itself is unreachable. That says nothing about this sandbox, so
      // leaving the row alone is the honest response — marking it UNHEALTHY
      // would turn one Docker hiccup into a fleet-wide state change.
      this.logger.warn(`health probe for computer ${row.id} could not run: ${messageOf(error)}`);
      return;
    }

    const next: SandboxState = health.ok ? 'RUNNING' : 'UNHEALTHY';
    // No transition, no write and no frame. A §4.2 frame per sandbox per
    // interval forever would be a heartbeat the protocol never asked for.
    if (next === row.state) return;

    const settled = await this.prisma.sandbox.updateManyAndReturn({
      where: { id: row.id, state: row.state, lastStartedAt: row.lastStartedAt },
      data: { state: next, lastError: health.ok ? null : health.reason },
    });

    const updated = settled[0];
    // Zero rows means a start or stop claimed the lease between the probe and
    // this write. Their state is newer than ours and theirs is the one that
    // holds the lock — say nothing.
    if (updated === undefined) return;

    if (health.ok) {
      this.logger.log(`computer ${row.id}: recovered, ${row.state} -> RUNNING`);
    } else {
      this.logger.warn(
        `computer ${row.id}: unhealthy, ${row.state} -> UNHEALTHY: ${health.reason}`,
      );
    }
    // §4.2 frames are addressed to a bot, and every tenant's client is looking
    // at this machine — so each gets told. One frame under an arbitrary tenant
    // would leave the others showing a desktop that is no longer there.
    for (const bot of row.bots) {
      this.events.emitSandboxState(bot.id, next, updated.widthPx, updated.heightPx);
    }
  }
}

/**
 * The states a poll may move.
 *
 * `RUNNING` can fall over and `UNHEALTHY` can come back — a bridge that was
 * briefly unreachable should not leave the bot needing a manual start. Every
 * other state is either held by the lock (`STARTING`) or was reached on
 * purpose (`STOPPED`, `ERROR`), and a background sweep does not get to
 * overrule either.
 */
const SETTLED_LIVE_STATES: readonly SandboxState[] = ['RUNNING', 'UNHEALTHY'];

/** `0` disables polling — the tests drive `sweep()` directly. */
function readInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return SandboxHealthService.DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`SANDBOX_HEALTH_INTERVAL_MS must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** A machine plus the bots attached to it (D-046). */
type SandboxWithTenants = Sandbox & { readonly bots: readonly { readonly id: string }[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
