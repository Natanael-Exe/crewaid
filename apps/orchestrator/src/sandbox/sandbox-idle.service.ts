import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Sandbox, TurnStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { SandboxActivityService } from './sandbox-activity.service.js';
import { readIdleStopMs } from './sandbox.config.js';
import { COMPUTE_POLICY, type ComputePolicy } from './compute-policy.js';
import { SandboxService } from './sandbox.service.js';

/**
 * Idle stop.
 *
 * A running sandbox with nothing happening in it is a desktop, a browser and
 * an X server holding a slot the next bot cannot have. After a configurable
 * quiet period it is stopped. The workspace is untouched — D-039 §9 is
 * explicit that this is a stop, not a deletion, and nothing here deletes
 * anything.
 *
 * Watching is not working
 *
 * The load-bearing half of §8 is what does NOT count. The rail thumbnail is a
 * `screen.subscribe` held open for as long as the app is, so if a subscription
 * counted as activity, idle stop would never fire for any bot the operator can
 * see — which is every bot. D-031 says so directly: maintaining a thumbnail
 * must not keep compute alive.
 *
 * That is not implemented as a rule so much as an absence: this service never
 * consults `ScreenService`, has no reference to it, and could not observe a
 * subscription if it wanted to. Health polling is excluded the same way — it
 * is the orchestrator's own traffic, and traffic we generate ourselves can
 * never be evidence that a human or an agent needs the desktop.
 *
 * Why activity is read, not notified
 *
 * Work already leaves durable records: an `AgentTurn` row with its start and
 * end, a `Recording` row with the same. Reading them is exact across an
 * orchestrator restart, needs no cooperation from the agent loop or from M3's
 * recorder, and — the reason that matters — cannot be forgotten. A scheme
 * where each subsystem remembers to touch a timestamp fails silently in
 * exactly one direction: the sandbox that stops in the middle of the work
 * whose owner forgot the call. Manual takeover is the one kind of work with no
 * row of its own, which is why `SandboxActivityService` exists to write one.
 */
@Injectable()
export class SandboxIdleService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SandboxIdleService.name);

  /**
   * How often the sweep runs, derived rather than configured: D-039 §11 names
   * three keys and a fourth would be drift. A tenth of the idle period keeps
   * the overshoot proportional — a 30-minute policy acts within three minutes
   * of the deadline — and the bounds stop a very short period from turning
   * into a busy loop, or a very long one from making the sweep so rare that a
   * restart could sit between two of them.
   */
  static sweepIntervalFor(idleMs: number): number {
    return Math.min(60_000, Math.max(10_000, Math.round(idleMs / 10)));
  }

  private readonly idleMs: number;
  private timer: NodeJS.Timeout | null = null;
  /** A sweep in flight. A slow stop must not stack ticks on top of it. */
  private sweeping = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SandboxService) private readonly sandboxes: SandboxService,
    @Inject(SandboxActivityService) private readonly activity: SandboxActivityService,
    // Absent unless this is a cloud server that bills.
    @Optional() @Inject(COMPUTE_POLICY) private readonly policy?: ComputePolicy,
  ) {
    this.idleMs = readIdleStopMs(process.env['SANDBOX_IDLE_STOP_MS']);
  }

  onApplicationBootstrap(): void {
    if (this.idleMs <= 0) {
      this.logger.log('sandbox idle stop disabled (SANDBOX_IDLE_STOP_MS <= 0)');
      return;
    }
    const interval = SandboxIdleService.sweepIntervalFor(this.idleMs);
    // `unref` for the same reason the health poll does it: a background policy
    // must never be the thing keeping a shutdown or a test runner open.
    this.timer = setInterval(() => void this.sweep(), interval).unref();
    this.logger.log(`sandbox idle stop after ${this.idleMs}ms, checked every ${interval}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every running sandbox. Public because the tests drive it
   * directly — asserting a 30-minute policy by waiting 30 minutes measures the
   * clock rather than the decision.
   */
  async sweep(): Promise<void> {
    if (this.idleMs <= 0 || this.sweeping) return;
    this.sweeping = true;
    try {
      // RUNNING only. `UNHEALTHY` also holds a slot, and reclaiming those is
      // real work — but it is reconciliation's: deciding whether a
      // sandbox that stopped answering should be stopped, resumed or replaced
      // needs the provider's view of the container, which idle stop never
      // looks at. Stopping one here on a timer would destroy the evidence.
      const rows = await this.prisma.sandbox.findMany({
        where: { state: 'RUNNING' },
        include: { bots: { select: { id: true } } },
      });
      const results = await Promise.allSettled(rows.map((row) => this.consider(row)));
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.error(`sandbox idle check failed: ${messageOf(result.reason)}`);
        }
      }
    } catch (error: unknown) {
      // Best-effort by construction; it runs again next interval. An unhandled
      // rejection out of a timer callback would take the orchestrator down
      // over a transient database blip.
      this.logger.error(`sandbox idle sweep failed: ${messageOf(error)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async consider(row: SandboxWithTenants): Promise<void> {
    // The plan decides whether an idle computer stops. Asked per pass rather
    // than remembered, so a change of plan takes effect at the next sweep.
    if (this.policy !== undefined && !(await this.policy.idleStops(row.userId))) return;
    if (!(await this.isIdle(row))) return;

    // A machine's §4.2 frame is announced under a bot, so pick one.
    // Which one does not matter to the sweep — every tenant's client shows
    // the same machine going down — but there must BE one, and a machine with
    // no tenants left is not something the sweep should stop: deleting the
    // last bot already removed it, and a row that outlived that is
    // reconciliation's to explain.
    const tenant = row.bots[0];
    if (tenant === undefined) return;

    const stopped = await this.sandboxes.stopIdle(
      { botId: tenant.id, computerId: row.id },
      async () => {
        // Asked again with the lifecycle lease held, against a fresh read: the
        // decision above was made before the lock, and a turn or a keystroke
        // that arrived in between must still win. See `stopIdle`.
        const current = await this.prisma.sandbox.findUnique({
          where: { id: row.id },
          include: { bots: { select: { id: true } } },
        });
        return current !== null && (await this.isIdle(current));
      },
    );

    if (stopped) {
      this.logger.log(
        `computer ${row.id} (${row.bots.length} bot(s)): stopped after ${this.idleMs}ms idle`,
      );
    }
  }

  /**
   * The question, against durable rows rather than connection state.
   *
   * D-046 widened it from one bot to every bot on the machine, and the
   * direction matters: a machine is idle only when **none** of its tenants is
   * working. Asking per bot would stop a desktop out from under a working
   * sibling, and it would do so more often the more bots are attached —
   * exactly backwards, and silent when it happens.
   */
  private async isIdle(row: SandboxWithTenants): Promise<boolean> {
    const now = Date.now();
    const tenantIds = row.bots.map((bot) => bot.id);
    // No tenants means no work can be in flight, but also nothing to keep the
    // machine for. Left to reconciliation rather than stopped here.
    if (tenantIds.length === 0) return false;

    // An explicit lease outranks everything below it: it is a promise someone
    // made about wall-clock time, not an inference from observed work.
    if (row.keepRunningUntil !== null && row.keepRunningUntil.getTime() > now) return false;

    const [activeTurn, turn, activeRecording, recording] = await Promise.all([
      // A sibling can finish while another bot is still working. Check all
      // non-terminal turns independently of the latest activity timestamp.
      this.prisma.agentTurn.findFirst({
        where: {
          botId: { in: tenantIds },
          status: { notIn: [...TURN_STATUSES_WITHOUT_A_DESKTOP] },
        },
      }),
      this.prisma.agentTurn.findFirst({
        where: { botId: { in: tenantIds } },
        orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
      }),
      this.prisma.recording.findFirst({
        where: { botId: { in: tenantIds }, state: 'RECORDING' },
      }),
      this.prisma.recording.findFirst({
        where: { botId: { in: tenantIds } },
        orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
      }),
    ]);

    // Non-terminal by exclusion, so a status added later reads as work in
    // progress and keeps the desktop up. The other direction — listing the
    // statuses that count as active — makes a new one silently stoppable, and
    // the symptom would be a bot losing its desktop mid-task.
    if (activeTurn !== null) return false;
    // COMPILING deliberately does not count: it reads events already stored
    // and needs no desktop, and treating it as work would let one stuck
    // compile pin a sandbox open indefinitely. Its timestamps still feed the
    // clock below, so the idle period starts when the recording ended.
    if (activeRecording !== null) return false;

    const marks = [
      // `lastActiveAt` is null for any row that predates D-039; `lastStartedAt`
      // is the honest fallback, because a sandbox has at least been running
      // since it started.
      row.lastActiveAt ?? row.lastStartedAt,
      // Every accepted input is visible here synchronously, including one
      // whose durable write lost a race with the lifecycle claim above.
      // Any tenant's input keeps the machine alive.
      ...tenantIds.map((botId) => this.activity.lastObservedAt(botId)),
      turn === null ? null : (turn.endedAt ?? turn.startedAt),
      recording === null ? null : (recording.endedAt ?? recording.startedAt),
    ].filter((mark): mark is Date => mark !== null);

    // No clock at all. Not idle — unknown, and stopping a sandbox on no
    // evidence is how a background policy destroys work it never observed.
    if (marks.length === 0) return false;

    const last = Math.max(...marks.map((mark) => mark.getTime()));
    return now - last >= this.idleMs;
  }
}

/**
 * The turn statuses that are over.
 *
 * Still by exclusion everywhere it is used: a status added later reads as work
 * in progress and keeps the desktop up, and the other direction — listing what
 * counts as active — makes a new one silently stoppable, with a bot losing its
 * desktop mid-task as the symptom.
 */
const TERMINAL_TURN_STATUSES: readonly TurnStatus[] = ['completed', 'failed', 'aborted'];

/**
 * The statuses that do not hold a machine open.
 *
 * `interrupted` is the one addition, and it is not "the turn is over":
 * the turn is very much alive and will want a desktop again the moment
 * somebody answers. What it is not doing is USING one. A suspension lasts as
 * long as the person takes, which may be three seconds or overnight, and
 * until this list existed that whole time held the container — on behalf of
 * every bot attached to the same computer.
 *
 * Safe only because the other half exists. `TurnComputer.release` hands the
 * lease back when the turn suspends and forgets its memoised readiness, so a
 * machine the sweep stops here is genuinely unclaimed, and the turn that
 * resumes asks for it again rather than acting on a container that is no
 * longer there. Removing either half alone is a bug: without the release the
 * lease outranks this sweep and nothing stops; without this list the release
 * hands back a lease nobody then acts on.
 *
 * Deliberately NOT extended to anything else. Every other non-terminal status
 * means a turn that is running, and those keep their desktop.
 */
const TURN_STATUSES_WITHOUT_A_DESKTOP: readonly TurnStatus[] = [
  ...TERMINAL_TURN_STATUSES,
  'interrupted',
];

/**
 * A machine plus the bots attached to it.
 *
 * The sweep needs both halves in one read: the tenants decide whether the
 * machine is idle, and it would be wrong to ask that question against a list
 * fetched after the row — a bot attached in between would have its work
 * ignored by a decision already made.
 */
type SandboxWithTenants = Sandbox & { readonly bots: readonly { readonly id: string }[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
