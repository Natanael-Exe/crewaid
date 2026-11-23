import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { COMPUTE_ALLOWANCE_EXHAUSTED_CODE, PLAN_REQUIRED_CODE } from '@crewaid/shared';
import type { ComputePolicy } from '../../sandbox/compute-policy.js';
import { TurnEventBus } from '../../agent/turn-event.bus.js';
import { BillingService } from './billing.service.js';
import { crossedLevel } from './usage-notice.js';

/**
 * The plan's answer to the sandbox lifecycle: which starts it covers,
 * whose computers idle-stop, and the record of time used.
 */
@Injectable()
export class BillingComputePolicy implements ComputePolicy {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {}

  async admit(userId: string): Promise<void> {
    const entitlement = await this.billing.entitlementFor(userId);
    if (entitlement.period === null) {
      throw new HttpException(
        {
          statusCode: 402,
          code: PLAN_REQUIRED_CODE,
          message: 'Choose a plan to start your computer.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const limit = entitlement.computeLimitSeconds;
    if (limit === null) return;
    const used = await this.billing.computeSecondsUsed(userId, entitlement.period.start);
    if (used < limit) return;
    throw new HttpException(
      {
        statusCode: 402,
        code: COMPUTE_ALLOWANCE_EXHAUSTED_CODE,
        message:
          'This period’s computer time is used up. It resets when your plan renews, or upgrade to keep working now.',
        detail: {
          usedSeconds: used,
          limitSeconds: limit,
          resetsAt: entitlement.period.end.toISOString(),
        },
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  async covers(userId: string): Promise<boolean> {
    const entitlement = await this.billing.entitlementFor(userId);
    if (entitlement.period === null) return false;
    const limit = entitlement.computeLimitSeconds;
    if (limit === null) return true;
    return (await this.billing.computeSecondsUsed(userId, entitlement.period.start)) < limit;
  }

  async idleStops(userId: string): Promise<boolean> {
    return (await this.billing.entitlementFor(userId)).idleStop;
  }

  async record(userId: string, seconds: number, now: Date): Promise<{ readonly stop: boolean }> {
    const entitlement = await this.billing.entitlementFor(userId, now);
    // No plan in force any more — it lapsed, or the computer was started
    // before billing was switched on. There is no period to count it in, and
    // nothing covers it running.
    if (entitlement.period === null) return { stop: true };
    const used = await this.billing.addComputeSeconds(userId, entitlement.period, seconds);
    const limit = entitlement.computeLimitSeconds;
    const level = crossedLevel(used - seconds, used, limit);
    if (level !== null) {
      this.events.emitUsageNotice(userId, {
        kind: 'compute',
        level,
        resetsAt: entitlement.period.end.toISOString(),
      });
    }
    return { stop: limit !== null && used >= limit };
  }
}
