import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { correlateClicks } from './click-correlator.js';

/**
 * Writes the M4 correlator's judgement into the trace.
 *
 * The judgement itself is `correlateClicks` in `click-correlator.ts` — pure,
 * tested against literals. This is only its persistence: read the recording's
 * rows, pair them, and set `correlatedWithId` on BOTH sides of every pair, so
 * a reader of either row can find the other.
 *
 * Why this runs at stop, and why it never fails the recording
 *
 * The rows only have ids once they are in Postgres — the tee batches writes
 * and `RecordingEvent.id` is assigned by the client before the insert — so a
 * pass over the durable trace is the first moment a pair can be written at
 * all. It runs while the recording is being settled (the lifecycle's
 * `finishCapture`, before the row reaches `COMPILING`), which is what makes
 * "the compiler must not emit both" a property of every trace that reaches
 * the compiler: a compile is only ever enqueued after this pass had its turn.
 *
 * The pass is BEST EFFORT by contract, and it resolves rather than rejects —
 * mirroring the tee's settle and the CDP flag's write. The trace is already
 * complete and worth compiling without it; a correlation that could not be
 * read or written costs the compiler its ability to prove two rows are one
 * action, which degrades how it reads those clicks, and must never cost the
 * recording itself. The failure is logged with its cause; the caller — a stop
 * the operator is waiting on — has nothing to do with it either way.
 *
 * Why one transaction
 *
 * Every pair is two writes that must agree (each row naming the other), and
 * the invariant worth keeping is "correlated rows come in pairs": a partial
 * pass that marked one side of some pairs and not others would leave rows
 * whose `correlatedWithId` points at a row that does not point back. One
 * transaction makes the pass all-or-nothing; a failure marks nothing, which
 * is the honest state — this trace has no proven pairs.
 *
 * Idempotent by construction: the judgement is a pure function of the rows
 * and the write is a set of `updateMany`s pinned to each row's id, so a
 * second run (a retried settle, recovery) writes the same values again and
 * changes nothing.
 */
@Injectable()
export class ClickCorrelatorService {
  private readonly logger = new Logger(ClickCorrelatorService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Mark every X11 click this trace holds together with the CDP click that is
   * provably the same action. Resolves with the number of pairs marked; never
   * rejects (see the class comment).
   */
  async correlate(recordingId: string): Promise<number> {
    try {
      const rows = await this.prisma.recordingEvent.findMany({
        where: { recordingId },
        orderBy: { tsOffsetMs: 'asc' },
        select: { id: true, tsOffsetMs: true, layer: true, type: true, payload: true },
      });

      const pairs = correlateClicks(rows);
      if (pairs.length === 0) return 0;

      await this.prisma.$transaction(
        pairs.flatMap((pair) => [
          this.prisma.recordingEvent.updateMany({
            where: { id: pair.x11Id },
            data: { correlatedWithId: pair.cdpId },
          }),
          this.prisma.recordingEvent.updateMany({
            where: { id: pair.cdpId },
            data: { correlatedWithId: pair.x11Id },
          }),
        ]),
      );

      this.logger.log(
        `recording ${recordingId}: correlated ${pairs.length} click(s) across layers`,
      );
      return pairs.length;
    } catch (error: unknown) {
      this.logger.error(
        `recording ${recordingId}: the click correlation pass failed; the trace is ` +
          `unchanged and compiles without it: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }
}
