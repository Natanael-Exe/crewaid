/**
 * What a hosted service's plan has to say about computers.
 *
 * The sandbox lifecycle asks; it never decides. On a cloud server with billing
 * the billing module answers under `COMPUTE_POLICY`; anywhere else nothing is
 * registered and every caller treats that as "no limits" — which is what a
 * self-hosted server is, by definition rather than by configuration.
 *
 * A port rather than an import so the arrow runs billing → sandbox and never
 * back: the lifecycle would otherwise learn what a plan is, and a self-hosted
 * build would carry code that only exists to say no.
 */
export interface ComputePolicy {
  /**
   * Refuse a start this account's plan does not cover, by throwing the
   * refusal the caller should see (a 402 naming why). Resolves when allowed.
   */
  admit(userId: string): Promise<void>;
  /**
   * Whether the plan covers a running computer right now: one is in force and
   * its hours are not used up. Asked again inside the stop's lease, so a
   * payment or an upgrade that landed after the meter decided keeps the
   * computer on.
   */
  covers(userId: string): Promise<boolean>;
  /** Whether this account's idle computers stop. Pro's stay on. */
  idleStops(userId: string): Promise<boolean>;
  /**
   * Count `seconds` of computer time against this account's current period,
   * and answer whether its computer must now stop — the limit is reached, or
   * no plan is in force any more.
   */
  record(userId: string, seconds: number, now: Date): Promise<{ readonly stop: boolean }>;
}

export const COMPUTE_POLICY = Symbol('COMPUTE_POLICY');
