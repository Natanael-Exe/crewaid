import { describe, expect, it } from 'vitest';

import { waitForSettledPage, type PageSample } from './m3-qa-06-settle.js';

/**
 * M3-QA-06 guard fix (PR #108 HOLD) — unit-level demonstration, no Docker, no
 * DB, runs in the normal suite everywhere.
 *
 * Earlier sampling recorded `finalUrl=https://example.com/` with
 * `finalTitle="New Tab"` and a screenshot still on the New Tab page — the
 * navigation had committed but not yet rendered. This file drives the SAME
 * forced-slow-settle sequence through
 *   (1) the old logic (kept here only to pin the race), and
 *   (2) the settle guard (`waitForSettledPage`) the suite now uses,
 * and asserts the timeout path FAILS instead of returning an early sample.
 */

const EXPECTED_URL = 'https://example.com/';
const EXPECTED_TITLE = 'Example Domain';

/** A read function serving a fixed script; past the end it repeats the last entry. */
const scriptedReader = (
  script: PageSample[],
): { read: () => Promise<PageSample | null>; reads: () => number } => {
  let index = 0;
  return {
    read: async () => {
      const next = script[Math.min(index, script.length - 1)] ?? null;
      index += 1;
      return next;
    },
    reads: () => index,
  };
};

/**
 * The race: the URL commits (target list flips) two
 * reads before the title and pixels do. A static New Tab page stays on the
 * third entry until the render lands on the fourth.
 */
const SLOW_SETTLE: PageSample[] = [
  { url: 'chrome://newtab/', title: 'New Tab' },
  { url: EXPECTED_URL, title: 'New Tab' }, // committed, not yet rendered ← the race
  { url: EXPECTED_URL, title: 'New Tab' },
  { url: EXPECTED_URL, title: EXPECTED_TITLE }, // rendered
];

/** The sampling that shipped at 3df7f1f (executeSkill's poll): first URL match wins. */
const oldSample = async (read: () => Promise<PageSample | null>): Promise<PageSample | null> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await read();
    if (current !== null && current.url === EXPECTED_URL) return current;
  }
  throw new Error('old sampler: the URL never matched');
};

describe('M3-QA-06 settle guard (PR #108 HOLD fix)', () => {
  it('pins the race: the OLD sampling records a page that was never painted', async () => {
    const reader = scriptedReader(SLOW_SETTLE);
    const sampled = await oldSample(reader.read);
    // What the check compared at the URL-match instant — the
    // `finalUrl=https://example.com/` + `finalTitle="New Tab"` failure mode.
    expect(sampled?.url).toBe(EXPECTED_URL);
    expect(sampled?.title).toBe('New Tab');
    // It returned on the second read: every later, rendered frame was ignored.
    expect(reader.reads()).toBe(2);
  });

  it('the settle guard waits for the paint — same script, rendered title', async () => {
    const reader = scriptedReader(SLOW_SETTLE);
    const settled = await waitForSettledPage(
      reader.read,
      { url: EXPECTED_URL, title: EXPECTED_TITLE },
      'the page to settle on example.com',
      { timeoutMs: 5_000, settleMs: 20 },
    );
    expect(settled).toEqual({ url: EXPECTED_URL, title: EXPECTED_TITLE });
    // It read past every racing frame and confirmed the settled one twice:
    // read 1 = NTP, reads 2-3 raced, read 4 was the first render, read 5 the
    // confirmation. (Dropping the two-identical-reads rule would return at
    // read 4 — sampling the first render before it held — and fail this
    // assertion: the guard's binding requirement, pinned.)
    expect(reader.reads()).toBeGreaterThanOrEqual(5);
  });

  it('a page that never paints FAILS the check — never an early sample', async () => {
    // url matches the expectation forever; the title never leaves the old page.
    const stuck = scriptedReader([{ url: EXPECTED_URL, title: 'New Tab' }]);
    let caught: Error | null = null;
    try {
      await waitForSettledPage(
        stuck.read,
        { url: EXPECTED_URL, title: EXPECTED_TITLE },
        'run 2 to settle on example.com',
        { timeoutMs: 300, settleMs: 20 },
      );
    } catch (error: unknown) {
      caught = error as Error;
    }
    expect(caught, 'the guard must throw, not return the unpainted state').not.toBeNull();
    // The message must carry the state that was actually seen for triage
    // when a run settles before the page renders.
    expect(caught?.message).toContain('timed out waiting for run 2 to settle on example.com');
    expect(caught?.message).toContain('last read: url=https://example.com/ — "New Tab"');
  });
});
