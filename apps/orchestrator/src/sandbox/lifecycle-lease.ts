/** STARTING uses lastActiveAt as its heartbeat; lastStartedAt remains the immutable CAS fence. */
export function lifecycleLeaseFresh(
  row: { lastStartedAt: Date | null; lastActiveAt: Date | null },
  now: number,
  leaseMs: number,
): boolean {
  return (
    Math.max(row.lastStartedAt?.getTime() ?? 0, row.lastActiveAt?.getTime() ?? 0) >= now - leaseMs
  );
}

export interface LifecycleLease {
  readonly signal: AbortSignal;
  finish(): Promise<void>;
}

export function renewLifecycleLease(
  renew: () => Promise<boolean>,
  intervalMs: number,
): LifecycleLease {
  const controller = new AbortController();
  let pending = Promise.resolve();
  let stopped = false;
  let failure: Error | undefined;
  const timer = setInterval(() => {
    // Chain ticks: a slow database must never overlap two renewals.
    pending = pending.then(async () => {
      if (stopped) return;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Sandbox lifecycle lease renewal timed out')),
            intervalMs,
          ).unref();
        });
        if (!(await Promise.race([renew(), expired])))
          throw new Error('Sandbox lifecycle lease was lost');
      } catch (error: unknown) {
        failure = error instanceof Error ? error : new Error(String(error));
        stopped = true;
        clearInterval(timer);
        controller.abort(failure);
      } finally {
        clearTimeout(deadline);
      }
    });
  }, intervalMs).unref();
  return {
    signal: controller.signal,
    async finish(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await pending;
      if (failure !== undefined) throw failure;
    },
  };
}
