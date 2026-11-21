import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { readIdleStopMs } from './sandbox.config.js';

/**
 * The manual-takeover half of §8's activity clock.
 *
 * D-039 §8 counts the operator driving the desktop as work, and it is the only
 * kind of work with no durable record of its own: a turn leaves an `AgentTurn`
 * row and a recording leaves a `Recording` row, but a mouse move leaves
 * nothing. So it has to be written down as it happens, and that is the whole
 * job of this service.
 *
 * Why it coalesces
 *
 * The call site is `screen.input`, which carries every mouse move the operator
 * makes — hundreds a second during a drag. That path is deliberately built to
 * cost zero queries (membership in the subscriber set IS the authorisation,
 * D-036), and a write per event would undo that on the hottest path in the
 * product to move a timestamp a few milliseconds.
 *
 * One write per bot per minute is enough for a policy measured in half hours,
 * and the coalescing window is what keeps the input path effectively free.
 * The window is recorded BEFORE the write rather than after it, so a slow
 * database cannot let a burst of input stack up a burst of updates behind it;
 * a failed write clears the window again so the next event retries rather than
 * losing a minute of activity to one blip.
 */
@Injectable()
export class SandboxActivityService {
  private readonly logger = new Logger(SandboxActivityService.name);

  /**
   * How often one bot's clock may actually reach the database. Small against
   * `SANDBOX_IDLE_STOP_MS`'s 30-minute default, so the recorded time is never
   * meaningfully behind the real one, and large against a drag.
   */
  static readonly MAX_COALESCE_MS = 60_000;

  /**
   * Persist often enough that a configured idle deadline cannot overtake the
   * durable activity clock. `0` disables idle stop, so the normal one-minute
   * ceiling is sufficient in that case.
   */
  static coalesceMsFor(idleMs: number): number {
    if (idleMs === 0) return SandboxActivityService.MAX_COALESCE_MS;
    return Math.max(1, Math.min(SandboxActivityService.MAX_COALESCE_MS, Math.floor(idleMs / 2)));
  }

  /**
   * Last write per bot, in epoch ms. One number per bot that has ever been
   * driven by hand, which is bounded by the bot count and never grows with
   * traffic; a deleted bot leaves one stale entry behind for the process's
   * life, which is cheaper than the bookkeeping to remove it.
   */
  private readonly written = new Map<string, number>();
  /**
   * Every accepted input, including ones coalesced away from persistence.
   * The idle sweep consults this synchronously so a database write racing its
   * lifecycle claim cannot make fresh manual activity look old.
   */
  private readonly observed = new Map<string, number>();
  private readonly coalesceMs: number;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    this.coalesceMs = SandboxActivityService.coalesceMsFor(
      readIdleStopMs(process.env['SANDBOX_IDLE_STOP_MS']),
    );
  }

  /**
   * Record that a human just did something in this bot's desktop.
   *
   * Deliberately synchronous and unawaited: the caller is forwarding an RFB
   * message to a container, and an activity note must never be able to delay
   * or fail a keystroke. Errors are logged and dropped for the same reason —
   * the worst case is a sandbox stopping half an hour after it should have.
   */
  touch(botId: string): void {
    const now = Date.now();
    this.observed.set(botId, now);
    if (now - (this.written.get(botId) ?? 0) < this.coalesceMs) return;
    this.written.set(botId, now);

    void this.record(botId, new Date(now))
      .then((recorded) => {
        // A lifecycle claim can move RUNNING -> STARTING between forwarding
        // the input and this write. Zero rows is not durable activity, so let
        // the next message retry instead of coalescing it away for a minute.
        if (!recorded && this.written.get(botId) === now) this.written.delete(botId);
      })
      .catch((error: unknown) => {
        if (this.written.get(botId) === now) this.written.delete(botId);
        this.logger.debug(
          `could not record manual activity for bot ${botId}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      });
  }

  /** The freshest input observed by this process, whether persisted yet or not. */
  lastObservedAt(botId: string): Date | null {
    const at = this.observed.get(botId);
    return at === undefined ? null : new Date(at);
  }

  private async record(botId: string, at: Date): Promise<boolean> {
    // Pinned to RUNNING, not just the machine: a stop is in flight while the
    // row reads STARTING, and bumping the clock underneath it would say the
    // sandbox was busy at the moment it was being shut down.
    //
    // D-046: the clock belongs to the MACHINE, so one bot's input keeps the
    // machine alive for every bot attached to it. That is the behaviour idle
    // stop needs — a machine is idle only when none of its tenants is working
    // — and it is why this matches through the relation rather than on a key.
    const result = await this.prisma.sandbox.updateMany({
      where: { bots: { some: { id: botId } }, state: 'RUNNING' },
      data: { lastActiveAt: at },
    });
    return result.count === 1;
  }
}
