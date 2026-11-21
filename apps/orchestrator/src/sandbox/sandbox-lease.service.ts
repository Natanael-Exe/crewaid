import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { readIdleStopMs } from './sandbox.config.js';
import { SandboxIdleService } from './sandbox-idle.service.js';

/**
 * A renewable claim on a running sandbox.
 *
 * `renew` is called on positive progress; `release` on every completion,
 * failure and cancellation path. Neither can shorten the deadline, because the
 * column is shared: a second owner may still be depending on the time this one
 * put there.
 */
export interface KeepRunningLease {
  readonly botId: string;
  /**
   * Push the deadline out because this operation is still making progress.
   * Answers whether the extension reached the database; best-effort by
   * construction, since a missed renewal costs protection at worst and
   * expiry is the bound that makes that safe.
   */
  renew(): Promise<boolean>;
  /**
   * Stop renewing and record final activity, so the ordinary idle period
   * begins now rather than when this operation started. Never throws: it runs
   * on failure paths, and a cleanup that can fail a caller's error is worse
   * than one whose worst case is a deadline that expires on its own.
   */
  release(): Promise<void>;
}

/**
 * Who is holding a computer, for the log line. §16 lists the callers that may
 * ask for readiness, and §17 the managed operations that may hold it open
 * afterwards; naming them in a union is what keeps a sixth one from appearing
 * without a decision to point at.
 */
export type ComputerOwner = 'explicit-open' | 'recording' | 'skill' | 'agent-tool' | 'managed-job';

/**
 * Keep-running leases.
 *
 * §8 already counts an `AgentTurn` and a `Recording` as work, and reads them
 * straight from their own rows — exact across a restart, and impossible for
 * the agent loop or the recorder to forget. This service exists for the work
 * with NO row of its own: a skill run, an agent tool holding the desktop, a
 * managed background job or download that outlives the viewer. Those get the
 * one thing §8 left for them, `Sandbox.keepRunningUntil`, which until now
 * nothing ever wrote.
 *
 * Why a deadline rather than a flag
 *
 * A boolean "busy" bit set by an operation that then crashes pins a container
 * on 2 GiB of a full host forever, and nothing left behind knows enough to
 * clear it. A deadline is self-healing in the only direction that is safe: the
 * owner keeps pushing it while it is alive, and stops pushing it the moment it
 * is not. Expiry is therefore not a timeout on the work — it is how long a
 * crashed owner can go on protecting a sandbox, which is why the bound is
 * derived from the sweep below rather than made configurable (D-041 adds no
 * configuration key).
 *
 * Why it is monotonic
 *
 * One column, any number of owners. A skill run and a download can hold the
 * same desktop, so "release" cannot mean "clear": the second owner's promise
 * would go with it and its work would be stopped underneath it. Every write
 * here therefore only ever moves the deadline forward — in SQL, not in a
 * read-then-write, so two owners renewing at once cannot lose one of the two
 * extensions. Releasing stops renewing and marks the work finished; the
 * deadline it already bought stands until it expires, which costs at most one
 * bound of extra uptime and never costs a running job its desktop.
 *
 * What it deliberately cannot do
 *
 * There is no way to ask this service to protect "whatever the desktop is
 * doing". D-041 is explicit that a detached process with no lifecycle signal
 * is unsupported in M3, and that process count, focus, selected bot, screen
 * changes and low CPU are not substitutes for ownership. Protection starts
 * when a named caller acquires it and ends when that caller stops renewing;
 * nothing here observes the container at all.
 */
@Injectable()
export class SandboxLeaseService implements OnModuleDestroy {
  private readonly logger = new Logger(SandboxLeaseService.name);

  /**
   * How long protection outlives an owner that stopped renewing — the
   * documented bound M3-QA-07 crashes an owner to measure.
   *
   * Derived from the idle sweep rather than configured, because the two are
   * the same question asked from opposite sides and a second knob is one edit
   * away from a lease shorter than the interval that checks it. Three sweeps
   * means two consecutive missed renewals still leave protection standing, so
   * a database blip cannot stop a sandbox that is working.
   *
   * Never longer than the idle period itself: a crashed owner must not buy a
   * sandbox more uptime than simply doing nothing would have.
   */
  static leaseMsFor(idleMs: number): number {
    const bound = 3 * SandboxIdleService.sweepIntervalFor(idleMs);
    return idleMs > 0 ? Math.min(idleMs, bound) : bound;
  }

  /** A third of the bound, so protection survives two failed renewals. */
  static renewMsFor(idleMs: number): number {
    return Math.max(1, Math.floor(SandboxLeaseService.leaseMsFor(idleMs) / 3));
  }

  private readonly leaseMs: number;
  private readonly renewMs: number;
  /** Live renewal timers, so shutdown stops them rather than leaking one per lease. */
  private readonly renewing = new Set<() => void>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    const idleMs = readIdleStopMs(process.env['SANDBOX_IDLE_STOP_MS']);
    this.leaseMs = SandboxLeaseService.leaseMsFor(idleMs);
    this.renewMs = SandboxLeaseService.renewMsFor(idleMs);
  }

  /** The bound, for callers that document or assert it. */
  get boundMs(): number {
    return this.leaseMs;
  }

  /**
   * Claim protection for one bot's computer.
   *
   * §17 requires ownership to exist BEFORE ensure-ready can race an idle-stop
   * claim, so this is written first and `release` is the asymmetric half.
   *
   * What this does NOT do is decide whether the caller may have it. `extend`
   * answers `false` rather than throwing whenever its `WHERE` finds nothing,
   * and that is the right shape for the case it exists for — another owner
   * already holding a LONGER deadline, which is a success for this caller —
   * but it makes "no such row" and "not this user's bot" indistinguishable
   * from it. The ownership fence is `SandboxService.start`, which every
   * readiness path calls immediately after this and which resolves the bot
   * through its owner and throws. Do not read a resolved lease as proof the
   * caller owns the bot; it is a deadline write, not an authorisation.
   *
   * Renewal runs on a timer for as long as the owner holds the handle. What it
   * observes is a real lifecycle signal and no more than that — this operation
   * is still running in this process. If the process dies the timer dies with
   * it, which is exactly the crash recovery the bound is for.
   */
  async acquire(userId: string, botId: string, owner: ComputerOwner): Promise<KeepRunningLease> {
    await this.extend(userId, botId);

    let timer: NodeJS.Timeout | null = null;
    const stopRenewing = (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      this.renewing.delete(stopRenewing);
    };

    const renew = async (): Promise<boolean> => {
      if (timer === null) return false;
      try {
        return await this.extend(userId, botId);
      } catch (error: unknown) {
        // Bounded by expiry, so a blip costs protection rather than the work.
        this.logger.debug(
          `could not renew the ${owner} lease on bot ${botId}: ${messageOf(error)}`,
        );
        return false;
      }
    };

    // `unref`, like every other background timer here: protection must never
    // be the thing keeping a shutdown or a test runner open.
    timer = setInterval(() => void renew(), this.renewMs).unref();
    this.renewing.add(stopRenewing);

    return {
      botId,
      renew,
      release: async (): Promise<void> => {
        if (timer === null) return;
        stopRenewing();
        try {
          await this.markFinalActivity(userId, botId);
        } catch (error: unknown) {
          this.logger.debug(
            `could not record the end of ${owner} work on bot ${botId}: ${messageOf(error)}`,
          );
        }
      },
    };
  }

  onModuleDestroy(): void {
    for (const stopRenewing of [...this.renewing]) stopRenewing();
  }

  /**
   * Move the deadline forward, never back.
   *
   * The comparison is in the `where` clause rather than in a read followed by
   * a write, so it is one statement and two owners renewing at the same
   * instant cannot lose the later of the two extensions: Read Committed
   * re-evaluates the predicate against the row version the concurrent update
   * left, and a row that no longer qualifies is simply skipped.
   *
   * Not pinned to `RUNNING`. Ownership is claimed before the container exists
   * — that is the whole point of claiming it first — and a deadline on a
   * stopped sandbox protects nothing until it starts. `finishStop` clears it
   * on the way down, so it cannot outlive the session it was promised about.
   */
  private async extend(userId: string, botId: string): Promise<boolean> {
    const until = new Date(Date.now() + this.leaseMs);
    const extended = await this.prisma.sandbox.updateMany({
      where: {
        // The lease is the machine's, held on behalf of a bot. Scoped
        // through the tenant rather than on the machine's own `userId` so the
        // check still answers "is this caller's bot on this machine", which is
        // the question ownership was asking before the machine had an owner
        // column of its own.
        bots: { some: { id: botId, userId } },
        OR: [{ keepRunningUntil: null }, { keepRunningUntil: { lt: until } }],
      },
      data: { keepRunningUntil: until },
    });
    return extended.count === 1;
  }

  /**
   * The work finished here, so the clock starts here.
   *
   * Pinned to `RUNNING` for the same reason the manual-takeover clock is: a
   * stop holds the row as `STARTING`, and bumping the clock underneath it
   * would say the sandbox was busy at the moment it was being shut down. Also
   * monotonic — a slow release must not drag the clock back over an input the
   * operator sent while it was completing.
   */
  private async markFinalActivity(userId: string, botId: string): Promise<void> {
    const at = new Date();
    await this.prisma.sandbox.updateMany({
      where: {
        bots: { some: { id: botId, userId } },
        state: 'RUNNING',
        OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: at } }],
      },
      data: { lastActiveAt: at },
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
