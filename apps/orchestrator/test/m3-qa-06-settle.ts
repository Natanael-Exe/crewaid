import { setTimeout as sleep } from 'node:timers/promises';

/**
 * M3-QA-06 determinism guard — the settle logic, extracted so the suite and its
 * unit demonstration (`m3-qa-06-settle-logic.test.ts`) exercise the SAME code.
 *
 * Why it exists: the check used to sample
 * at the first instant a CDP read matched `url === EXPECTED_URL`. A navigation
 * can commit — the target list flips to the new URL — while the page is still
 * visibly the old one: his run 2 was recorded `finalUrl=https://example.com/`
 * with `finalTitle="New Tab"` and a screenshot still showing the New Tab page.
 * Sampling that instant made the check a timing lottery.
 *
 * Settled means BOTH:
 *   - the read matches the expectation (url, and title when one is expected), AND
 *   - two CONSECUTIVE reads, at least `settleMs` apart, are identical — the
 *     observable stopped moving, so any paint nominally catching up with the
 *     navigation has had a bounded margin to land.
 *
 * On timeout this THROWS. A page that never settles must fail the check with a
 * readable, last-read-bearing message; it must never be sampled early.
 */
export interface PageSample {
  url: string;
  title: string;
}

export interface SettleOptions {
  /** Upper bound on how long to wait for a settled state, in ms. */
  timeoutMs: number;
  /**
   * Minimum wall-clock gap between the two consecutive identical reads that
   * prove the page stopped moving, in ms. ~250 ms covers a frame plus a paint.
   */
  settleMs?: number;
}

const describeSample = (sample: PageSample | null): string =>
  sample === null ? 'no page target' : `url=${sample.url} — "${sample.title}"`;

export async function waitForSettledPage(
  read: () => Promise<PageSample | null>,
  expected: { url: string; title?: string },
  what: string,
  options: SettleOptions,
): Promise<PageSample> {
  const settleMs = options.settleMs ?? 250;
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const matches = (sample: PageSample): boolean =>
    sample.url === expected.url &&
    (expected.title === undefined || sample.title === expected.title);

  let previous: PageSample | null = null;
  let previousAt = 0;
  let reads = 0;
  for (;;) {
    const current = await read();
    reads += 1;
    const now = Date.now();
    if (current !== null && matches(current)) {
      const stoppedMoving =
        previous !== null &&
        current.url === previous.url &&
        current.title === previous.title &&
        now - previousAt >= settleMs;
      if (stoppedMoving) return current;
    }
    if (now >= deadline) {
      throw new Error(
        `timed out waiting for ${what} — ${reads} reads over ${now - startedAt} ms, ` +
          `never observed the settled state (url=${expected.url}` +
          (expected.title === undefined ? '' : ` + title="${expected.title}"`) +
          `, held identical across two reads ≥ ${settleMs} ms apart); ` +
          `last read: ${describeSample(current)}`,
      );
    }
    previous = current;
    previousAt = now;
    await sleep(settleMs);
  }
}
