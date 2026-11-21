import type { SandboxStatusResponse } from '@crewaid/shared';

import type { ComputerOwner, KeepRunningLease } from '../sandbox/sandbox-lease.service.js';
import type { StructuredLogger } from '../logging/structured-logger.js';

/**
 * The turn's computer, obtained on demand.
 *
 * §16 gives everything that needs a desktop one entry point,
 * `SandboxReadinessService`. This is the agent loop's use of it, and the whole
 * of its job is WHEN to call it:
 *
 * A text-only turn starts nothing
 *
 * Most turns are a question and an answer. Waking a container for one is 2 GiB
 * and several seconds of host budget spent on a bot that was never going to
 * touch a screen, and with D-046's shared computer it is spent on behalf of
 * every bot attached to it. So readiness is not part of starting a turn: it
 * happens on the FIRST tool that needs it, and a turn where no such tool runs
 * never reaches `SandboxReadinessService` at all. `wasRequested()` is how a
 * test states that rather than hopes it.
 *
 * Once per turn, even in parallel
 *
 * A step may call several tools at once and each of them wants the same
 * desktop. The in-flight promise is shared, so five concurrent `ensure()`
 * calls make one readiness request and get one answer. `SandboxService.start`
 * would already collapse them onto its own per-bot lock, but that is a reason
 * not to depend on it: the lease acquired before each call is this layer's,
 * and five acquisitions for one turn is five writes and five owners to
 * release.
 *
 * The protection is held, not inferred
 *
 * A non-terminal `AgentTurn` already blocks the idle sweep on its own
 * (`sandbox-idle.service.ts` reads the row), so a turn is protected without
 * any lease at all. The explicit lease is still taken and still held to the
 * end of the turn because §17's ordering is what closes the ensure-ready race
 * — protection must exist BEFORE the runtime call can race an idle-stop claim
 * — and because the idle sweep ranks an explicit lease above every inference
 * below it. Inference is right until the day a status is added to
 * `TERMINAL_TURN_STATUSES` and a turn silently stops counting as work.
 *
 * `dispose()` is the release, and it runs on completion, failure and
 * cancellation alike. A lease nobody released is what pins a container until
 * its bound expires.
 *
 * A failure is not remembered as one
 *
 * `503 SANDBOX_CAPACITY` reaches the caller unchanged and means the
 * host is momentarily full — "a temporary, retryable condition and not a
 * broken bot". Caching the rejection would turn one full moment into a turn
 * that can never touch a desktop again, so only success is memoized and a
 * later tool gets a fresh attempt.
 */
export interface TurnComputer {
  /**
   * The computer this turn's tools act on, started if it is not already.
   *
   * Returns whatever state the lifecycle settled on, exactly as REST start
   * does — a caller that cannot proceed without a desktop checks
   * `status.state` rather than expecting a throw.
   */
  ensure(): Promise<SandboxStatusResponse>;
  /** Whether anything in this turn actually asked for a desktop. */
  wasRequested(): boolean;
  /**
   * Let go of the desktop without ending the turn.
   *
   * A turn suspended on an approval is waiting on a person, and a person may
   * take three seconds or go to bed. Until this existed the suspension held
   * the machine open for as long as they took: the lease is an explicit
   * promise about wall-clock time and outranks every inference the idle sweep
   * makes, so a bot parked on one `shell` prompt pinned 2 GiB indefinitely —
   * and under D-046 it pinned it on behalf of every bot attached to the same
   * computer.
   *
   * NOT `dispose()`: the turn is not over, and it will need a desktop again
   * the moment the answer arrives. So the lease goes back and the memoised
   * status is forgotten, which is the part that matters — `ensure()` caches
   * success, and a turn that resumed against a cached `RUNNING` for a machine
   * the sweep has since stopped would hand its tools a container that is not
   * there. After this, the next `ensure()` is a fresh readiness request and
   * starts the machine again if it has to.
   *
   * Idempotent, and safe on a turn that never asked for a desktop.
   */
  release(): Promise<void>;
  /** Release the lease for good. Idempotent; every turn exit path calls it. */
  dispose(): Promise<void>;
}

/** The slice of `SandboxReadinessService` this needs, as a port so it tests without one. */
export interface TurnReadinessPort {
  ensureReady(
    userId: string,
    botId: string,
    owner: ComputerOwner,
  ): Promise<{ status: SandboxStatusResponse; lease: KeepRunningLease }>;
}

export function createTurnComputer(deps: {
  readiness: TurnReadinessPort;
  userId: string;
  botId: string;
  logger?: StructuredLogger | undefined;
}): TurnComputer {
  let inFlight: Promise<SandboxStatusResponse> | undefined;
  let lease: KeepRunningLease | undefined;
  let requested = false;
  let disposed = false;

  return {
    wasRequested: () => requested,

    async ensure(): Promise<SandboxStatusResponse> {
      requested = true;
      if (disposed) {
        // A tool that outlived its own turn must not wake a desktop nobody
        // is going to release.
        throw new Error('The turn that owns this computer has already finished.');
      }
      if (inFlight !== undefined) return inFlight;

      const attempt = (async (): Promise<SandboxStatusResponse> => {
        const ready = await deps.readiness.ensureReady(deps.userId, deps.botId, 'agent-tool');
        if (disposed) {
          // Cancelled while the wake was in flight: nothing will call
          // dispose again, so this lease is released here or never.
          await ready.lease.release();
          throw new Error('The turn that owns this computer was cancelled.');
        }
        lease = ready.lease;
        deps.logger?.info('turn.computer.ready', { state: ready.status.state });
        return ready.status;
      })();

      inFlight = attempt;
      try {
        return await attempt;
      } catch (error) {
        // Only success is memoized — see the header. A capacity refusal is
        // the host being momentarily full, not this turn being unable to
        // ever hold a desktop.
        if (inFlight === attempt) inFlight = undefined;
        throw error;
      }
    },

    async release(): Promise<void> {
      if (disposed) return;
      // Forgotten whether or not a lease is held: the memoised status is the
      // dangerous half. A suspension long enough for the sweep to stop the
      // machine is exactly the case where a cached `RUNNING` would be a lie.
      inFlight = undefined;
      const held = lease;
      lease = undefined;
      if (held === undefined) return;
      await held.release();
      deps.logger?.info('turn.computer.suspended', {});
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const held = lease;
      lease = undefined;
      if (held === undefined) return;
      await held.release();
      deps.logger?.info('turn.computer.released', {});
    },
  };
}
