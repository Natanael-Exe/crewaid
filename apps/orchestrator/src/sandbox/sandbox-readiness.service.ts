import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SandboxStatusResponse } from '@crewaid/shared';

import { SandboxService } from './sandbox.service.js';
import {
  SandboxLeaseService,
  type ComputerOwner,
  type KeepRunningLease,
} from './sandbox-lease.service.js';

/** A ready computer and the protection that is keeping it that way. */
export interface ReadyComputer {
  readonly status: SandboxStatusResponse;
  /** Release on completion, failure or cancellation — every path. */
  readonly lease: KeepRunningLease;
}

/**
 * Ensure-ready: the one path to a running computer.
 *
 * Everything that needs a desktop comes through here — opening the computer
 * from its rail card, starting a recording, beginning a skill or agent tool.
 * Not because a single function is tidier, but because the two halves below
 * have to happen in one order and nothing that wants a computer should be
 * choosing that order for itself.
 *
 * Protection first, then the runtime
 *
 * §17 requires ownership to exist BEFORE ensure-ready can race an idle-stop
 * claim, and the race is real in the case that looks least dangerous: the
 * sandbox is already `RUNNING` and already past its idle deadline. `start` is
 * idempotent, so it returns that row immediately without touching Docker —
 * and the sweep, which decided a moment ago that this sandbox was idle, is
 * free to stop it in the very next tick. The caller would be handed a desktop
 * that is being torn down.
 *
 * Claiming the lease first closes that: the sweep re-reads the row inside its
 * own lifecycle lease and sees a deadline in the future, so it puts the
 * sandbox back instead of stopping it (`stopIdle`'s `confirm`). Ordering is
 * the entire mechanism; there is no lock between these two services.
 *
 * The lease is re-asserted after readiness for the mirror case — a stop that
 * completed in the gap cleared the deadline on its way down, so the row that
 * is now running has no protection from the claim we made before it existed.
 *
 * What does not come through here
 *
 * Selecting a bot or a conversation, rendering a collapsed card, subscribing
 * to frames, health polling, and keeping the app open are NOT readiness
 * requests. That is enforced by absence, as it is in the idle sweep:
 * `ScreenService.subscribe` refuses a sandbox that is not running rather than
 * waking one, and nothing in the screen or health paths can reach this
 * service. A rail thumbnail that woke a computer would wake every bot the
 * operator can see, which is every bot.
 *
 * Switching bots and losing a viewer detach presentation only. Neither stops a
 * runtime nor cancels work: a lease outlives the socket that started the work,
 * and §8 decides when the runtime may stop.
 */
@Injectable()
export class SandboxReadinessService {
  private readonly logger = new Logger(SandboxReadinessService.name);

  constructor(
    @Inject(SandboxService) private readonly sandboxes: SandboxService,
    @Inject(SandboxLeaseService) private readonly leases: SandboxLeaseService,
  ) {}

  /**
   * Wake this bot's computer and hand back the protection holding it open.
   *
   * The caller owns the lease from here and must release it on every path.
   * Work that has a durable row of its own — an `AgentTurn`, a `Recording` —
   * is already owned by that row and can release as soon as the row
   * exists; work with no row holds the lease for its whole life.
   *
   * Storage, capacity admission, per-bot start serialization, resume/create
   * recovery and bridge readiness all belong to `SandboxService.start`, which
   * is why they are not repeated here: concurrent callers share its lock and
   * one result, so five simultaneous requests produce one container and five
   * identical answers. Its `503 SANDBOX_CAPACITY` reaches the caller
   * unchanged — the host being full is a temporary, retryable condition and
   * not a broken bot, and the workspace stays provisioned and stopped.
   *
   * Returns whatever state the lifecycle settled on, exactly as REST start
   * does. A caller that cannot proceed without a desktop checks
   * `status.state`; ensure-ready does not invent a failure the route contract
   * does not have.
   */
  async ensureReady(userId: string, botId: string, owner: ComputerOwner): Promise<ReadyComputer> {
    const lease = await this.leases.acquire(userId, botId, owner);
    try {
      const status = await this.sandboxes.start(userId, botId);
      await lease.renew();
      this.logger.log(`bot ${botId}: computer ready for ${owner} (${status.state})`);
      return { status, lease };
    } catch (error: unknown) {
      await lease.release();
      throw error;
    }
  }

  /**
   * Ensure-ready for work that has no durable row of its own, scoped so the
   * release cannot be forgotten on the failure path — which is the path that
   * matters, since a lease nobody released is what pins a container until its
   * bound expires.
   */
  async withComputer<T>(
    userId: string,
    botId: string,
    owner: ComputerOwner,
    work: (status: SandboxStatusResponse) => T | Promise<T>,
  ): Promise<T> {
    const ready = await this.ensureReady(userId, botId, owner);
    try {
      return await work(ready.status);
    } finally {
      await ready.lease.release();
    }
  }

  /**
   * Explicitly opening the computer, which is the start route.
   *
   * The lease covers the wake itself and is released as soon as the desktop
   * is up, because an operator looking at a screen is not work: releasing
   * records final activity, so the ordinary idle period runs from the moment
   * they opened it and their next keystroke extends it. A viewer that
   * kept a computer alive merely by watching is the thing D-031 forbids.
   */
  async open(userId: string, botId: string): Promise<SandboxStatusResponse> {
    return this.withComputer(userId, botId, 'explicit-open', (status) => status);
  }
}
