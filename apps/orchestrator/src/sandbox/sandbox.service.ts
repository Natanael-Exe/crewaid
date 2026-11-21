import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Prisma, Sandbox, SandboxState } from '@prisma/client';
import {
  COMPUTER_BUSY_CODE,
  SANDBOX_CAPACITY_CODE,
  type SandboxStatusResponse,
} from '@crewaid/shared';

import { PrismaService } from '../prisma/prisma.service.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { readMaxRunning } from './sandbox.config.js';
import { COMPUTE_POLICY, type ComputePolicy } from './compute-policy.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox.provider.js';
import { SandboxWorkspaceService } from './sandbox-workspace.service.js';
import { lifecycleLeaseFresh, renewLifecycleLease } from './lifecycle-lease.js';
import { profilesOfComputer } from './attached-computer.js';

/** Shared with startup reconciliation so both agree on when a starter is abandoned. */
export const SANDBOX_LOCK_LEASE_MS = 60_000;

/**
 * Sandbox lifecycle.
 *
 * The concurrency lock
 *
 * §5 requires that two concurrent starts produce exactly one container, and
 * fires five at once and counts. The lock is a compare-and-swap on the
 * `Sandbox` row rather than a mutex:
 *
 * UPDATE "Sandbox" SET state = 'STARTING'
 * WHERE id = ? AND state IN ('STOPPED','ERROR','UNHEALTHY')
 *
 * `updateMany` reports how many rows it changed, and the row is the machine's
 * primary key, so exactly one caller sees 1 and every other sees 0. That caller creates the
 * container; the rest wait for it and return its result, which is what makes
 * five simultaneous starts one container and five identical answers.
 *
 * An in-process mutex would also pass the test today and would be wrong for a
 * reason the test cannot see: it holds only as long as there is one
 * orchestrator process. The database is already the thing that has to be right
 * when there is a second one, and the machine's primary key is already the
 * constraint that says so.
 *
 * widened what this serializes. The row is a COMPUTER, and several bots
 * may be attached to it, so two different bots asking to start now contend for
 * the same lease rather than for one each. That is correct and is the point:
 * there is one machine to bring up, and the second caller should get the first
 * caller's container rather than a second one.
 *
 * Start and stop both acquire this lease before touching Docker.
 * Completion and failure writes match the lease timestamp, preventing an
 * expired holder from overwriting a newer operation.
 *
 * A crashed starter would otherwise leave `STARTING` set forever and wedge the
 * bot permanently, so a `STARTING` row older than the start budget is
 * reclaimable — the lock has a lease, not a lifetime.
 *
 * Idempotence
 *
 * Both routes are declared idempotent. Starting a RUNNING sandbox
 * returns its status without touching Docker; stopping a STOPPED one does the
 * same. Neither is an error, because the caller's intent is already satisfied
 * and a 409 would make the desktop's state the client's problem to reconcile.
 *
 * Capacity admission (, §7)
 *
 * A second, separate question, asked before the lock: the lock answers "is
 * this bot already starting?" and admission answers "does the host have room?".
 * They are enforced together here because §12 rule 6 requires the
 * refusal to happen BEFORE the lease is claimed — a start refused with the row
 * left `STARTING` wedges that bot for the length of a lease, turning a
 * temporary "come back later" into a manual recovery.
 */
@Injectable()
export class SandboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SandboxService.name);

  /** Lease duration comfortably above the 20s cold-start budget to prevent duplicate containers. */
  private static readonly LOCK_LEASE_MS = SANDBOX_LOCK_LEASE_MS;

  /** How long a losing caller waits for the winner before giving up. */
  private static readonly FOLLOWER_TIMEOUT_MS = 45_000;
  private static readonly POLL_MS = 100;

  /** Bounded retries after losing the CAS to a concurrent stop or health transition. */
  private static readonly START_CLAIM_ATTEMPTS = 3;

  /** Transaction-scoped Postgres advisory lock key serializing host capacity admission. */
  private static readonly ADMISSION_LOCK_KEY = 5_390_039;

  /** Host concurrent-sandbox ceiling, validated once at boot. */
  private readonly maxRunning: number;
  private recoveryTimer?: NodeJS.Timeout;
  private recovering = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(SandboxWorkspaceService) private readonly workspaces: SandboxWorkspaceService,
    @Optional() @Inject(COMPUTE_POLICY) private readonly policy?: ComputePolicy,
  ) {
    this.maxRunning = readMaxRunning(process.env['SANDBOX_MAX_RUNNING']);
  }

  onApplicationBootstrap(): void {
    if (!this.provider.workspaceOnFirstStart) return;
    void this.recoverPendingPauses();
    this.recoveryTimer = setInterval(() => void this.recoverPendingPauses(), 30_000).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.recoveryTimer);
  }

  async recoverPendingPauses(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const rows = await this.prisma.sandbox.findMany({ where: { pausePending: true } });
      for (const row of rows) {
        try {
          await this.recoverPause(row);
        } catch (error) {
          this.logger.warn(`Runtime pause for ${row.id} will retry: ${String(error)}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Runtime pause recovery will retry: ${String(error)}`);
    } finally {
      this.recovering = false;
    }
  }

  private async recoverPause(row: Sandbox): Promise<void> {
    const lease = await this.claimFrom(this.prisma, row, 'stop');
    if (lease === null) return;
    await this.finishStop(
      { computerId: row.id, botId: row.id },
      lease,
      row.lastError ?? 'An interrupted Runtime operation was recovered.',
    );
  }

  /** `GET /bots/:id/sandbox` — state + resolution. */
  async status(userId: string, botId: string): Promise<SandboxStatusResponse> {
    const computerId = await this.attachedComputer(userId, botId);
    // A detached bot reports STOPPED rather than 404: §4.1 promises a state,
    // and "this bot has no machine yet" is a state the operator acts on by
    // pressing start, not an error they can do anything about.
    if (computerId === null) return toStatus(botId, null);
    return toStatus(botId, await this.prisma.sandbox.findUnique({ where: { id: computerId } }));
  }

  /** `POST /bots/:id/sandbox/start` — idempotent; resumes by sessionId when present. */
  async start(userId: string, botId: string): Promise<SandboxStatusResponse> {
    await this.assertOwned(userId, botId);
    // The plan first, ahead of storage and the host's capacity. A
    // refusal here is about this account and stays true until it pays or the
    // period turns over; reporting "the host is full" instead would send the
    // operator to stop a sibling's computer for nothing. Every wake — a turn's
    // tools, a routine, a recording, a skill run — comes through this method.
    await this.policy?.admit(userId);
    // Attaches this bot to a machine if it has none, which is also what
    // provisions the workspace. Every step below addresses the machine.
    await this.workspaces.ensure(userId, botId);
    const target = await this.requireAttachment(userId, botId);

    let lease: Date | null;
    for (let attempt = 1; ; attempt += 1) {
      const admission = await this.admitAndClaim(target);
      if (!admission.admitted) throw hostIsFull(admission.running, this.maxRunning);
      lease = admission.lease;
      if (lease !== null) break;
      const settled = await this.awaitSettled(target);
      // Only RUNNING satisfies "start this sandbox". Every other settled state
      // means the compare-and-swap lost to a concurrent writer — a stop that
      // finished first, or a health poll moving the row to UNHEALTHY between
      // this claim's read and its write — and the caller still
      // wants the desktop up, so claim again rather than hand back the state a
      // racing writer happened to leave behind.
      //
      // Bounded, because re-claiming only helps while someone else is making
      // progress. An unbounded loop here would spin for as long as anything
      // kept moving the row, and answering with the state we can see beats
      // never answering at all.
      if (settled.state === 'RUNNING') return settled;
      if (attempt >= SandboxService.START_CLAIM_ATTEMPTS) return settled;
    }

    const renewing = this.renew(target, lease);
    try {
      const status = await this.bringUp(target, lease, renewing);
      await this.announce(target.computerId, status);
      return status;
    } catch (error: unknown) {
      await renewing.finish().catch(() => undefined);
      const failed = await this.recordFailure(target, lease, error);
      if (failed?.pausePending) {
        await this.recoverPause(failed).catch((cause: unknown) => {
          this.logger.warn(`Runtime pause for ${target.computerId} will retry: ${String(cause)}`);
        });
      }
      throw error;
    } finally {
      await renewing.finish().catch(() => undefined);
    }
  }

  /** `POST /bots/:id/sandbox/stop` — shares the start lease to serialize Docker I/O. */
  async stop(userId: string, botId: string): Promise<SandboxStatusResponse> {
    await this.assertOwned(userId, botId);
    const computerId = await this.attachedComputer(userId, botId);
    // Nothing to stop, and nothing to create in order to stop it.
    if (computerId === null) return toStatus(botId, null);
    return this.bringDown({ botId, computerId });
  }

  /**
   * Run `work` on this computer while it is paused, holding its
   * lifecycle lease, then put it back the way it was found.
   *
   * Paused rather than running because a snapshot is taken of, or restored
   * onto, a machine nothing is using, and because pausing through the session
   * and waking through `bringUp` is the one path that rebuilds tunnels, ports
   * and the screen afterwards. Runtime would pause a running machine for a
   * capture by itself, but behind this lease, leaving listeners nothing
   * reopens.
   *
   * A failed `work` still puts the computer back before it is rethrown: a
   * snapshot that could not be saved must not leave a computer down. Only a
   * failure to bring it back is recorded as the computer's own.
   */
  async withComputerPaused(
    row: Sandbox,
    work: (signal: AbortSignal) => Promise<void>,
    onHeld: () => Promise<void>,
  ): Promise<void> {
    if (row.state !== 'RUNNING' && row.state !== 'STOPPED') {
      throw new ConflictException({ code: COMPUTER_BUSY_CODE });
    }
    const lease = await this.claimFrom(this.prisma, row, 'hold');
    if (lease === null) throw new ConflictException({ code: COMPUTER_BUSY_CODE });
    try {
      await onHeld();
    } catch (error: unknown) {
      await this.release(row.id, lease, row.state);
      throw error;
    }
    const target: Attachment = { botId: row.id, computerId: row.id };
    const renewing = this.renew(target, lease);
    let failure: Error | null = null;
    try {
      if (row.state === 'RUNNING') {
        const session = await this.provider.attachSession({ sessionId: row.sessionId ?? row.id });
        if (session !== null) await session.stop();
      }
      renewing.signal.throwIfAborted();
      await work(renewing.signal);
    } catch (error: unknown) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    try {
      // A lost lease means another lifecycle owner moved the row; it is theirs.
      if (!renewing.signal.aborted) {
        if (row.state === 'RUNNING') {
          const status = await this.bringUp(target, lease, renewing);
          await this.announce(row.id, status);
        } else {
          await renewing.finish();
          await this.release(row.id, lease, 'STOPPED');
        }
      }
    } catch (error: unknown) {
      await renewing.finish().catch(() => undefined);
      const failed = await this.recordFailure(target, lease, error);
      if (failed?.pausePending) {
        await this.recoverPause(failed).catch((cause: unknown) => {
          this.logger.warn(`Runtime pause for ${row.id} will retry: ${String(cause)}`);
        });
      }
      throw error;
    } finally {
      await renewing.finish().catch(() => undefined);
    }
    if (failure !== null) throw failure;
  }

  /**
   * Stop a sandbox nobody asked to stop (M2-BE-11, §8 idle stop).
   *
   * No principal, because a background sweep has none — the same exemption the
   * health poll carries, and the reason this is not reachable from a route:
   * The stop is `stop` above and keeps its ownership check.
   *
   * `confirm` runs INSIDE the lifecycle lease rather than before it. The sweep
   * decided this sandbox was idle by reading rows a moment ago; a turn or a
   * recording that began in the gap would otherwise lose its desktop, and the
   * operator would see a bot stop in the middle of working. Holding the lease
   * first and asking again second closes that gap on this side: from the CAS
   * onward nothing else can move the row, so the answer cannot go stale
   * between the question and the stop.
   *
   * Returns whether it actually stopped, so the caller can log the difference
   * between "idle, stopped it" and "changed its mind" rather than assume.
   */
  async stopIdle(target: Attachment, confirm: () => Promise<boolean>): Promise<boolean> {
    // Not the retry loop `stop` uses: a sweep has no user waiting on it and
    // runs again shortly. Losing the claim means someone else is already
    // moving this row, and the right response is to leave it to them.
    const lease = await this.claimRunningStop(target.computerId);
    if (lease === null) return false;

    let confirmed = false;
    try {
      confirmed = await confirm();
    } finally {
      if (!confirmed) await this.release(target.computerId, lease);
    }
    if (!confirmed) return false;

    await this.finishStop(target, lease);
    return true;
  }

  /**
   * Stop a computer its owner's plan no longer covers.
   *
   * Unlike idle stop this takes `UNHEALTHY` computers too: a container that
   * stopped answering may still be running, and it is still being metered, so
   * leaving it to reconciliation would charge time no plan covers for as long
   * as it stays sick. `confirm` runs inside the lease for the same reason as
   * `stopIdle`'s — a payment that landed since the meter decided must win.
   * Released, the row goes back to the state it was claimed from.
   */
  async stopUncovered(target: Attachment, confirm: () => Promise<boolean>): Promise<boolean> {
    const row = await this.prisma.sandbox.findUniqueOrThrow({ where: { id: target.computerId } });
    if (row.state !== 'RUNNING' && row.state !== 'UNHEALTHY') return false;
    const lease = await this.claimFrom(this.prisma, row, 'stop');
    if (lease === null) return false;

    let confirmed = false;
    try {
      confirmed = await confirm();
    } finally {
      if (!confirmed) await this.release(target.computerId, lease, row.state);
    }
    if (!confirmed) return false;

    await this.finishStop(target, lease);
    return true;
  }

  /** The stop itself, once a caller has been authorised (or is the sweep). */
  private async bringDown(target: Attachment): Promise<SandboxStatusResponse> {
    let lease: Date | null;
    for (;;) {
      const row = await this.prisma.sandbox.findUnique({ where: { id: target.computerId } });
      if (row === null || row.state === 'STOPPED') return toStatus(target.botId, row);
      lease = await this.claim(target.computerId, 'stop');
      if (lease !== null) break;
      await this.awaitSettled(target);
    }
    return this.finishStop(target, lease);
  }

  private async finishStop(
    target: Attachment,
    lease: Date,
    failure?: string,
  ): Promise<SandboxStatusResponse> {
    const renewing = this.renew(target, lease);
    let observedContainerId: string | undefined;
    try {
      const row = await this.prisma.sandbox.findUniqueOrThrow({
        where: { id: target.computerId },
      });
      // Also recover the stable lookup key after a crash before first persistence.
      const session = await this.provider.attachSession({
        sessionId: row.sessionId ?? target.computerId,
      });
      observedContainerId = session?.containerId;
      renewing.signal.throwIfAborted();
      if (session !== null) await session.stop();
      await renewing.finish();
      const status = await this.settle(target, lease, {
        state: failure === undefined ? 'STOPPED' : 'ERROR',
        pausePending: false,
        vncPort: null,
        cdpPort: null,
        bridgePort: null,
        lastError: failure ?? null,
        // A lease says "keep this RUNNING until T". Once it is down the
        // lease has nothing left to protect, and carrying it into the next
        // start would make a sandbox unstoppable for a promise made about a
        // session that no longer exists.
        keepRunningUntil: null,
      });
      await this.announce(target.computerId, status);
      return status;
    } catch (error: unknown) {
      await this.recordFailure(target, lease, error, observedContainerId);
      throw error;
    } finally {
      await renewing.finish().catch(() => undefined);
    }
  }

  private async recordFailure(
    target: Attachment,
    lease: Date,
    error: unknown,
    observedContainerId?: string,
  ): Promise<Sandbox | undefined> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `sandbox lifecycle failed for computer ${target.computerId} (bot ${target.botId}): ${message}`,
    );
    const failed = await this.prisma.sandbox.updateManyAndReturn({
      where: { id: target.computerId, state: 'STARTING', lastStartedAt: lease },
      data: {
        state: this.provider.workspaceOnFirstStart ? 'UNHEALTHY' : 'ERROR',
        pausePending: this.provider.workspaceOnFirstStart === true,
        ...(observedContainerId === undefined ? {} : { containerId: observedContainerId }),
        lastError: message,
      },
    });
    // An expired holder must never overwrite or announce its successor's state.
    if (failed[0] !== undefined)
      await this.announce(target.computerId, toStatus(target.botId, failed[0]));
    return failed[0];
  }

  // the lock

  /**
   * Admission and the start lock, in one critical section.
   *
   * The advisory lock spans BOTH the count and the claim, because the claim is
   * what makes this bot one of the things being counted. Reading five and then
   * becoming the sixth is only correct if nothing else can read five in
   * between; see `ADMISSION_LOCK_KEY`.
   *
   * A bot that already occupies a slot is admitted without counting at all,
   * and that is not an optimisation. Restarting an `UNHEALTHY` sandbox does
   * not add a sandbox — the container is already there, already counted — so
   * charging it for a slot it holds would make a full host one where the sick
   * ones can never be recovered. It also keeps the idempotent start honest:
   * asking a RUNNING sandbox to start must never answer "the host is full".
   */
  private async admitAndClaim(target: Attachment): Promise<Admission> {
    return this.prisma.$transaction(async (tx) => {
      // `$executeRaw`, not `$queryRaw`: the function returns `void`, and
      // Prisma's row deserializer has no mapping for a void column.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SandboxService.ADMISSION_LOCK_KEY}::bigint)`;
      const row = await tx.sandbox.findUniqueOrThrow({ where: { id: target.computerId } });

      if (!OCCUPIES_A_SLOT.includes(row.state)) {
        const running = await tx.sandbox.count({ where: { state: { in: [...OCCUPIES_A_SLOT] } } });
        // Nothing has been written yet, so the refusal leaves the row exactly
        // as it was found — D-039 §12 rule 6, and what M2-QA-08 asserts.
        if (running >= this.maxRunning) return { admitted: false, running };
      }

      return { admitted: true, lease: await this.claimFrom(tx, row, 'start') };
    });
  }

  /**
   * Claim the lifecycle lease. Only the successful CAS receives a timestamp;
   * `botId` is unique, so the row is the mutex.
   */
  private async claim(computerId: string, operation: 'start' | 'stop'): Promise<Date | null> {
    const row = await this.prisma.sandbox.findUniqueOrThrow({ where: { id: computerId } });
    return this.claimFrom(this.prisma, row, operation);
  }

  /** Idle stop owns RUNNING rows only; unhealthy runtime recovery is reconciliation's job. */
  private async claimRunningStop(computerId: string): Promise<Date | null> {
    const row = await this.prisma.sandbox.findUniqueOrThrow({ where: { id: computerId } });
    if (row.state !== 'RUNNING') return null;
    return this.claimFrom(this.prisma, row, 'stop');
  }

  /**
   * The compare-and-swap, against a row the caller has already read.
   *
   * Split out so admission can read the row once and claim from that same
   * read inside its transaction. The parameter is named `tx` deliberately:
   * `test/prisma-allowlist.test.ts` discovers call sites by receiver name, and
   * a Prisma client reaching this file under any other name would be invisible
   * to the R7 audit.
   */
  private async claimFrom(
    tx: Prisma.TransactionClient,
    row: Sandbox,
    operation: 'start' | 'stop' | 'hold',
  ): Promise<Date | null> {
    const computerId = row.id;
    if (operation === 'start' && row.state === 'RUNNING') return null;
    if (operation === 'stop' && row.state === 'STOPPED') return null;
    if (
      row.state === 'STARTING' &&
      lifecycleLeaseFresh(row, Date.now(), SandboxService.LOCK_LEASE_MS)
    )
      return null;

    // Monotonic even for two claims in the same millisecond. This is also the
    // fencing token on completion, so an expired caller cannot release a new lease.
    const lease = new Date(Math.max(Date.now(), (row.lastStartedAt?.getTime() ?? 0) + 1));
    // Only a start seeds the heartbeat. A stop claim must leave `lastActiveAt`
    // alone: idle stop re-checks its idle clock after claiming, and writing the
    // lease time here would make every computer look freshly active.
    const claimed = await tx.sandbox.updateMany({
      where: { id: computerId, state: row.state, lastStartedAt: row.lastStartedAt },
      data: {
        state: 'STARTING',
        lastStartedAt: lease,
        ...(operation === 'start'
          ? { lastActiveAt: lease, pausePending: this.provider.workspaceOnFirstStart === true }
          : {}),
        lastError: null,
      },
    });
    return claimed.count === 1 ? lease : null;
  }

  /**
   * Hand a claimed lease back without doing anything with it.
   *
   * Pinned to the lease like every other completion write, so an expired
   * holder cannot undo a newer operation. Zero rows means exactly that, and it
   * is not an error — someone else owns the row now and their state is the
   * current one. No §4.2 frame either: nothing ever became visible to a
   * client, so there is no transition to announce.
   */
  private async release(
    computerId: string,
    lease: Date,
    to: SandboxState = 'RUNNING',
  ): Promise<void> {
    await this.prisma.sandbox.updateMany({
      where: { id: computerId, state: 'STARTING', lastStartedAt: lease },
      data: { state: to },
    });
  }

  /**
   * Wait for whoever holds the lock. Returns their result, so every caller in a
   * concurrent burst answers the same thing.
   */
  private async awaitSettled(target: Attachment): Promise<SandboxStatusResponse> {
    const deadline = Date.now() + SandboxService.FOLLOWER_TIMEOUT_MS;

    for (;;) {
      const row = await this.prisma.sandbox.findUnique({ where: { id: target.computerId } });
      if (row === null || row.state !== 'STARTING') return toStatus(target.botId, row);

      if (Date.now() > deadline) {
        // Deliberately not "take the lock anyway": the holder may still be
        // mid-create, and stealing it here is how a second container appears.
        throw new Error(
          `computer ${target.computerId} was still STARTING after ` +
            `${SandboxService.FOLLOWER_TIMEOUT_MS}ms`,
        );
      }
      await delay(SandboxService.POLL_MS);
    }
  }

  // the slow half, run only by the lock holder

  private renew(target: Attachment, lease: Date) {
    return renewLifecycleLease(async () => {
      const updated = await this.prisma.sandbox.updateMany({
        where: { id: target.computerId, state: 'STARTING', lastStartedAt: lease },
        data: { lastActiveAt: new Date() },
      });
      return updated.count === 1;
    }, SandboxService.LOCK_LEASE_MS / 4);
  }

  private async bringUp(
    target: Attachment,
    lease: Date,
    renewing: ReturnType<typeof renewLifecycleLease>,
  ): Promise<SandboxStatusResponse> {
    const row = await this.prisma.sandbox.findUnique({ where: { id: target.computerId } });
    // The sessionId is stable for the machine's life: §5 resumes by it across
    // orchestrator restarts, and minting a fresh one per start would strand
    // the previous container under a name nothing looks for.
    const sessionId = row?.sessionId ?? target.computerId;

    const session = await this.acquire(
      sessionId,
      target.computerId,
      row?.workspacePending === true,
      renewing.signal,
    );
    const [rfb, cdp, bridge] = await Promise.all([
      session.getPortEndpoint({ port: 5900 }),
      session.getPortEndpoint({ port: 9222 }),
      session.getPortEndpoint({ port: 7070 }),
    ]);

    await renewing.finish();
    return this.settle(target, lease, {
      state: 'RUNNING',
      workspacePending: false,
      pausePending: false,
      // The clock starts here, so a sandbox that has just come up gets a full
      // idle period rather than inheriting whatever the last session left.
      lastActiveAt: new Date(),
      sessionId: session.id,
      containerId: session.containerId,
      widthPx: session.screen.widthPx,
      heightPx: session.screen.heightPx,
      vncPort: portOf(rfb.url),
      cdpPort: portOf(cdp.url),
      bridgePort: portOf(bridge.url),
      lastError: null,
    });
  }

  private async settle(
    target: Attachment,
    lease: Date,
    data: Prisma.SandboxUpdateManyMutationInput,
  ): Promise<SandboxStatusResponse> {
    const updated = await this.prisma.sandbox.updateManyAndReturn({
      where: { id: target.computerId, state: 'STARTING', lastStartedAt: lease },
      data,
    });
    const row = updated[0];
    if (row === undefined) throw new ServiceUnavailableException('Sandbox lifecycle lease expired');
    return toStatus(target.botId, row);
  }

  /**
   * Resume existing containers, including one left behind before persistence.
   * Create only when the lookup is absent: a readiness or daemon failure must
   * retain its original error instead of trying to create over an existing name.
   */
  private async acquire(
    sessionId: string,
    computerId: string,
    workspacePending: boolean,
    abortSignal: AbortSignal,
  ) {
    // Lookup even without a stored sessionId: the first creator may have died
    // after Docker create but before saving the row. The key is still botId.
    const existing = await this.provider.attachSession({ sessionId });
    if (existing !== null)
      return this.provider.resumeSession({
        sessionId,
        abortSignal,
        ...(workspacePending ? { ensureWorkspaceRetention: true } : {}),
      });
    // `identity` is what the provider keys the durable workspace on, so it is
    // the COMPUTER, not the session. They carry the same
    // string today, which is exactly why this is passed explicitly: a future
    // session id that diverged would otherwise strand a machine's files under
    // a name nothing looks for, and nothing would fail until someone went
    // looking for them.
    return this.provider.createSession({
      sessionId,
      identity: computerId,
      requireExistingWorkspace: !workspacePending || !this.provider.workspaceOnFirstStart,
      abortSignal,
      // A computer that comes back from its snapshot keeps only the
      // profiles that still belong to it.
      ...(this.provider.snapshots === undefined
        ? {}
        : { snapshotProfiles: () => profilesOfComputer(this.prisma, computerId) }),
    });
  }

  // plumbing

  /**
   * R7: resolve the bot through its owner first. A 404 covers both "no such
   * bot" and "not yours" — never leak existence across the boundary.
   */
  private async assertOwned(userId: string, botId: string): Promise<void> {
    const bot = await this.prisma.bot.findFirst({ where: { id: botId, userId } });
    if (bot === null) throw new NotFoundException('Bot not found');
  }

  /**
   * The machine this bot works on, or `null` when it is attached to none.
   *
   * Scoped by `userId` in the same query rather than after it: this is the
   * only place a request turns a bot id into a machine id, so it is the only
   * place that could hand one user's computer to another's bot.
   */
  private async attachedComputer(userId: string, botId: string): Promise<string | null> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: { sandboxId: true },
    });
    if (bot === null) throw new NotFoundException('Bot not found');
    return bot.sandboxId;
  }

  /**
   * The same, for a caller that has already made sure one exists.
   *
   * `start` calls `workspaces.ensure` first, which attaches the bot to a
   * machine and provisions its storage, so a null here is not "no machine
   * yet" — it is that attachment having silently failed, and a 503 says so
   * rather than letting the next query throw something unreadable.
   */
  private async requireAttachment(userId: string, botId: string): Promise<Attachment> {
    const computerId = await this.attachedComputer(userId, botId);
    if (computerId === null) {
      throw new ServiceUnavailableException('This bot is not attached to a computer');
    }
    return { botId, computerId };
  }

  /** §4.2 `sandbox.state`. Broadcast, never awaited — a lost frame must not fail a start. */
  private async announce(computerId: string, status: SandboxStatusResponse): Promise<void> {
    try {
      const bots = await this.prisma.bot.findMany({
        where: { sandboxId: computerId },
        select: { id: true },
      });
      for (const bot of bots) {
        this.events.emitSandboxState(bot.id, status.state, status.widthPx, status.heightPx);
      }
    } catch (error: unknown) {
      this.logger.warn(`Computer state notification failed: ${String(error)}`);
    }
  }
}

/**
 * The states that occupy a slot on the host.
 *
 * `STARTING` counts because a start in flight is already consuming the host —
 * the container is being created right now. `UNHEALTHY` counts because the
 * container very likely still exists and still holds its memory; a sandbox
 * that stopped answering did not stop costing anything. Excluding either is
 * how a ceiling of six ends up running nine.
 *
 * Exported so the tests count the same set the service does rather than a
 * hand-copied list that can drift from it.
 */
export const OCCUPIES_A_SLOT: readonly SandboxState[] = ['STARTING', 'RUNNING', 'UNHEALTHY'];

/**
 * A bot and the machine it works on.
 *
 * Both halves travel together because the two questions a lifecycle operation
 * asks have different answers now: every row it reads or writes is keyed on
 * the COMPUTER, and every §4.1 response and §4.2 frame it produces is about
 * the BOT that asked. Passing one string and deriving the other at each site
 * is how a machine ends up announced under a sibling's name.
 */
export type Attachment = { readonly botId: string; readonly computerId: string };

/** The outcome of `admitAndClaim`: a lease, or the count that refused it. */
type Admission = { admitted: true; lease: Date | null } | { admitted: false; running: number };

/**
 * The refusal.
 *
 * 503 rather than 409, and the difference is the whole point: the condition is
 * temporary and the identical request succeeds once something stops. `code`
 * carries `SANDBOX_CAPACITY` because "the host is full" and "Docker is broken"
 * are different problems with different actions, and an operator staring at a
 * generic failure cannot tell which one they have. The shape is the existing
 * `ApiErrorSchema`, whose `code` is a free-form string — no error enum grows
 * to say this.
 */
function hostIsFull(running: number, limit: number): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    code: SANDBOX_CAPACITY_CODE,
    message:
      `This host is already running ${running} of ${limit} sandboxes. ` +
      'Stop one before starting another.',
    detail: { running, limit },
  });
}

/**
 * A bot with no Sandbox row — or attached to no machine at all — has a stopped
 * sandbox, not a missing one. The row is an implementation detail of this
 * service; §4.1 promises a state.
 */
function toStatus(botId: string, row: Sandbox | null): SandboxStatusResponse {
  return {
    botId,
    state: row?.state ?? 'STOPPED',
    widthPx: row?.widthPx ?? 1280,
    heightPx: row?.heightPx ?? 800,
    lastError: row?.lastError ?? null,
  };
}

/**
 * The published host port, read back out of the endpoint URL.
 *
 * D-012 hands out a URL rather than a port, and Sandbox.vncPort is an Int, so
 * something has to bridge the two. Doing it here keeps `getPortEndpoint` the
 * only thing that knows how a sandbox is addressed — nothing downstream
 * reassembles a URL from these columns.
 */
function portOf(url: string): number | null {
  const port = Number.parseInt(new URL(url).port, 10);
  return Number.isInteger(port) ? port : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
