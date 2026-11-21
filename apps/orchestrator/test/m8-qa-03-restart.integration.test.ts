import { afterEach, describe, expect, it } from 'vitest';

import { reconcileSchedules } from '../src/routines/routine-schedule.reconciler.js';
import { SchedulerHarness } from './m8-scheduler-harness.js';

/**
 * M8-QA-03 — §6/M8: "Routines survive an orchestrator restart without
 * duplicating or skipping." "Restart the orchestrator between two firings,
 * assert no duplicate and no gap."
 *
 * A restart here is what one is in production: the worker AND the queue
 * client close, the process is gone for a while, and a new one opens its own
 * client, runs the boot reconciliation (D-119) against the same rows, and
 * starts a worker. Only Redis carries anything across.
 */

const REDIS_URL = process.env['REDIS_URL'];
const NY = 'America/New_York';
const ROUTINE = { id: 'survivor', cron: '*/5 * * * *', timezone: NY };
const at = (hhmm: string) => Date.parse(`2026-06-01T${hhmm}:00Z`);

describe.skipIf(REDIS_URL === undefined || REDIS_URL === '')(
  'a restart between firings (real redis, fake clock)',
  () => {
    let h: SchedulerHarness | undefined;
    afterEach(async () => {
      await h?.close();
      h = undefined;
    });

    /** The new process's boot: reconcile against the routine's row, then work. */
    async function boot(harness: SchedulerHarness): Promise<void> {
      await reconcileSchedules([ROUTINE], await harness.scheduler.scheduled(), harness.scheduler);
      harness.startWorker();
    }

    it('restarting between two firings: the next slot fires once, and so does the one after', async () => {
      h = new SchedulerHarness(REDIS_URL!, new Date(at('13:02')));
      await h.scheduler.schedule(ROUTINE);
      h.startWorker();

      await h.advanceTo(at('13:05'));
      await h.waitForFirings(1);

      // Down and back up at 13:07, before the next slot.
      await h.restart(() => h!.advanceTo(at('13:07')));
      await boot(h);

      await h.advanceTo(at('13:10'));
      await h.waitForFirings(2);
      await h.advanceTo(at('13:15'));
      await h.waitForFirings(3);
      await h.settle();

      expect(h.firedSlots()).toEqual([at('13:05'), at('13:10'), at('13:15')]);
    }, 30_000);

    it('a slot that falls due while the process is down fires once when it returns — no gap', async () => {
      h = new SchedulerHarness(REDIS_URL!, new Date(at('13:02')));
      await h.scheduler.schedule(ROUTINE);
      h.startWorker();
      await h.advanceTo(at('13:05'));
      await h.waitForFirings(1);

      // Down from 13:06 to 13:12: the 13:10 slot comes due with no worker.
      await h.restart(() => h!.advanceTo(at('13:12')));
      await boot(h);
      await h.waitForFirings(2);

      await h.advanceTo(at('13:15'));
      await h.waitForFirings(3);
      await h.settle();

      // 13:10 ran late, once; 13:15 ran on time, once.
      expect(h.firedSlots()).toEqual([at('13:05'), at('13:10'), at('13:15')]);
    }, 30_000);

    it('the boot reconciliation leaves a live schedule alone, so it cannot add a firing', async () => {
      h = new SchedulerHarness(REDIS_URL!, new Date(at('13:02')));
      await h.scheduler.schedule(ROUTINE);
      const before = (await h.queue.getDelayed()).map((job) => job.id);

      await h.restart();
      const report = await reconcileSchedules(
        [ROUTINE],
        await h.scheduler.scheduled(),
        h.scheduler,
      );

      expect(report).toEqual({ scheduled: [], unscheduled: [], invalid: [] });
      expect((await h.queue.getDelayed()).map((job) => job.id)).toEqual(before);
    }, 30_000);

    it('restarting twice in one period still fires the next slot exactly once', async () => {
      h = new SchedulerHarness(REDIS_URL!, new Date(at('13:02')));
      await h.scheduler.schedule(ROUTINE);
      h.startWorker();

      await h.restart(() => h!.advanceTo(at('13:03')));
      await boot(h);
      await h.restart(() => h!.advanceTo(at('13:04')));
      await boot(h);

      await h.advanceTo(at('13:05'));
      await h.waitForFirings(1);
      await h.settle();

      expect(h.firedSlots()).toEqual([at('13:05')]);
    }, 30_000);

    it('down for several slots: the overdue firing runs once, then the schedule resumes', async () => {
      // §6/M8 asks for no gap across a restart BETWEEN two firings. An outage
      // spanning several slots is coalesced — the scheduler runs the one that
      // was due and continues from now — rather than replayed as a burst of
      // stale runs. Pinned here so the behaviour is a decision, not an accident.
      h = new SchedulerHarness(REDIS_URL!, new Date(at('13:02')));
      await h.scheduler.schedule(ROUTINE);
      h.startWorker();
      await h.advanceTo(at('13:05'));
      await h.waitForFirings(1);

      await h.restart(() => h!.advanceTo(at('13:22')));
      await boot(h);
      await h.waitForFirings(2);
      await h.advanceTo(at('13:25'));
      await h.waitForFirings(3);
      await h.settle();

      expect(h.firedSlots()).toEqual([at('13:05'), at('13:10'), at('13:25')]);
    }, 30_000);
  },
);
