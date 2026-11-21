import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Recording } from '@prisma/client';
import type {
  RecordingStatusResponse,
  RecordingWarning,
  StartRecordingBody,
  StartRecordingResponse,
} from '@crewaid/shared';

import { PrismaService } from '../prisma/prisma.service.js';
import { SeatControlService } from '../screen/seat-control.service.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { SandboxReadinessService } from '../sandbox/sandbox-readiness.service.js';
import { SKILL_COMPILE_QUEUE, type SkillCompileQueue } from '../skills/skill-compile.queue.js';
import { RecordingTeeService } from './recording-tee.service.js';
import type { TeeResult } from './recording-tee.service.js';
import { CdpAttachService } from './cdp-attach.service.js';
import { CdpCaptureService } from './cdp-capture.service.js';
import { ClickCorrelatorService } from './click-correlator.service.js';

/**
 * Recording lifecycle service.
 *
 * Scopes every query by caller `userId` (returning 404 for absent or foreign
 * rows) and wakes the sandbox through `SandboxReadinessService.ensureReady`
 * before creating the durable `Recording` row that protects it from idle sweep.
 */
@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);

  private readonly transitions = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RecordingTeeService) private readonly tee: RecordingTeeService,
    @Inject(CdpAttachService) private readonly cdp: CdpAttachService,
    @Inject(CdpCaptureService) private readonly capture: CdpCaptureService,
    @Inject(ClickCorrelatorService) private readonly correlator: ClickCorrelatorService,
    @Inject(SandboxReadinessService) private readonly computers: SandboxReadinessService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(SKILL_COMPILE_QUEUE) private readonly compiles: SkillCompileQueue,
    @Inject(SeatControlService) private readonly control?: SeatControlService,
  ) {
    // The ceilings are detected on the input path and settled here.
    // Registered rather than injected because the dependency already runs one
    // way: this service knows the tee, and the tee must not know it back.
    this.tee.onLimitReached((botId, recordingId, warning) => {
      void this.autoStop(botId, recordingId, warning);
    });
    // The other degradation, and the row's to record: an attach
    // that never landed — or a CDP connection that dropped mid-recording —
    // flips `cdpAvailable` false, so every reader of the row knows this
    // trace holds no CDP rows. Registered rather than pushed back, for the
    // same reason as the listener above.
    this.cdp.onUnavailable((botId, recordingId) => {
      void this.markCdpUnavailable(botId, recordingId);
    });
  }

  /**
   * Settle recordings left `RECORDING` by a process that is gone.
   *
   * The tee's active set is in memory, so such a row captures nothing — and
   * The idle sweep counts it as work, which would pin that bot's container
   * open for the life of this process. `FAILED` rather than `READY` because
   * the trace stops at an arbitrary point: compiling it would
   * produce a skill that silently does part of the task, which fails later and
   * further from its cause than not producing one at all.
   *
   * Driven from `main.ts` rather than an `OnApplicationBootstrap` hook, for
   * the same reason `recoverInterruptedTurns` is: the entrypoint is the one
   * place a real process starts, while integration suites boot `AppModule`
   * many times against one shared database and would otherwise have every app
   * settle every other suite's rows. The alternative — a hook plus an
   * environment flag to disable it — would be a new config key, and §0 rule 2
   * does not spend one where an explicit call does the same job.
   *
   * The query is an internal recovery operation over durable rows with no
   * principal to scope by, not a user-facing route; D-010 stays enforced at
   * the request edge.
   */
  async recoverInterruptedRecordings(): Promise<number> {
    const settled = await this.prisma.recording.updateMany({
      where: { state: 'RECORDING' },
      data: { state: 'FAILED', endedAt: new Date() },
    });
    if (settled.count > 0) {
      this.logger.warn(
        `marked ${settled.count} interrupted recording(s) FAILED: their capture did not survive a restart`,
      );
    }
    return settled.count;
  }

  /**
   * Re-queue recordings whose compile job did not survive a process.
   *
   * A `COMPILING` row left by a crash sits between "settled" and "enqueued" —
   * `finishCapture` cannot make those one transaction — and the job can also
   * have been lost with Redis. Either way nothing picks the row up again by
   * itself, which is the silent stranding the error column exists to
   * prevent. The job id is the recording id, so a row whose job is still in
   * Redis dedupes to a no-op; a row the queue refuses (no `REDIS_URL`) is
   * settled `FAILED` with the refusal as its reason. Every write here is
   * pinned to `COMPILING`, so a row someone settled while this pass was
   * running is not touched.
   *
   * Driven from `main.ts` exactly as `recoverInterruptedRecordings` is, and
   * for the same reason: suites boot `AppModule` many times against one
   * shared database, and a hook would make every boot settle every other
   * suite's rows.
   */
  async recoverStrandedCompilations(): Promise<number> {
    const stranded = await this.prisma.recording.findMany({
      where: { state: 'COMPILING' },
      select: { id: true, botId: true },
    });

    let requeued = 0;
    for (const recording of stranded) {
      try {
        await this.compiles.enqueue(recording.id);
        requeued += 1;
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `recording ${recording.id} could not be re-queued for compilation: ${detail}`,
        );
        const settled = await this.prisma.recording.updateMany({
          where: { id: recording.id, state: 'COMPILING' },
          data: { state: 'FAILED', error: detail },
        });
        if (settled.count > 0) {
          this.events.emitRecordingState(recording.botId, recording.id, 'FAILED');
        }
      }
    }

    if (requeued > 0) {
      this.logger.warn(`re-queued ${requeued} recording(s) stranded in COMPILING`);
    }
    return requeued;
  }

  /** `POST /bots/:id/recordings` — start recording `{intent?}` → `{recordingId}`. */
  async start(
    userId: string,
    botId: string,
    input: StartRecordingBody,
  ): Promise<StartRecordingResponse> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId },
      select: { id: true },
    });
    if (bot === null) throw new NotFoundException('Bot not found');

    // Synchronous, and before the first await: two requests arriving together
    // must not both wake a computer and both insert a row.
    if (!this.tee.reserve(botId)) {
      throw new ConflictException('This bot is already recording');
    }

    const admission = this.control?.seats.admitRecordingStart(botId);
    if (admission !== undefined && !admission.ok) {
      this.tee.abandon(botId);
      throw new ConflictException(admission.refusal.message);
    }
    try {
      const ready = await this.computers.ensureReady(userId, botId, 'recording');
      try {
        if (ready.status.state !== 'RUNNING') {
          throw new ConflictException(
            `the computer for bot ${botId} is ${ready.status.state}; a recording needs a running desktop`,
          );
        }
        const recording = await this.prisma.recording.create({
          data: { botId, intent: input.intent ?? null },
        });
        this.tee.begin(botId, recording.id, recording.startedAt);
        // The browser half of capture attaches for this recording's duration
        //. Deliberately not awaited: a recording start must not
        // wait on Chrome — through a Docker port mapping, a relay and a
        // handshake — and an attach that fails only costs the CDP layer.
        this.cdp.attach(botId, recording.id);
        // The capture script and its binding ride on that connection
        //. Also not awaited, and it awaits the attach itself
        // through `connectionFor`, so the order of these two lines is
        // convenience rather than ordering.
        this.capture.arm(botId, recording.id);
        this.events.emitRecordingState(botId, recording.id, recording.state);
        this.logger.log(`bot ${botId}: recording ${recording.id} started`);
        return { recordingId: recording.id };
      } finally {
        // The row is the protection from here. Releasing also records
        // final activity, so the idle clock runs from the wake rather than
        // from whenever the last renewal happened to land.
        await ready.lease.release();
      }
    } catch (error: unknown) {
      // Both sides of `begin`, because only one of them is reachable at a
      // time. Before it, the slot holds no recording and `abandon` frees it;
      // after it, `abandon` is a deliberate no-op and only `end` releases the
      // bot — without which the tee keeps capturing into a row the caller was
      // just told did not start, `reserve` refuses every later recording for
      // this bot, and nothing unwinds either until the 20-minute ceiling
      // fires. `end` never rejects (a failed batch is counted, not thrown) and
      // leaves the durable row to `recoverInterruptedRecordings`.
      this.tee.abandon(botId);
      void this.tee.end(botId);
      // Also fire-and-forget, and for the same reason: a start that failed
      // after attaching must not leave a socket behind. Both browser layers
      // come down in order — the capture's registrations are removed while
      // the connection is still open, then the attach closes the socket.
      void this.endBrowserCapture(botId);
      throw error;
    } finally {
      if (admission?.ok) admission.release();
    }
  }

  /**
   * `POST /recordings/:id/stop` — the "stop and enqueue compilation".
   *
   * Two steps, and the order matters. Capture ends first, because whether the
   * trace is whole decides whether compiling it is worth anything at all: a
   * trace with a hole compiles into a skill that silently skips whatever was
   * missing. Only a whole trace reaches `COMPILING`.
   */
  async stop(userId: string, recordingId: string): Promise<RecordingStatusResponse> {
    return this.transition(recordingId, () => this.stopRecording(userId, recordingId));
  }

  private async stopRecording(
    userId: string,
    recordingId: string,
  ): Promise<RecordingStatusResponse> {
    const recording = await this.findOwned(userId, recordingId);
    if (recording.state !== 'RECORDING') {
      throw new ConflictException(`recording ${recordingId} is ${recording.state}, not RECORDING`);
    }

    const result = await this.endCapture(recording.botId, recordingId);
    return this.finishCapture(recording, result);
  }

  /**
   * Settle a recording whose capture has just ended, and hand a whole trace to
   * the compiler.
   *
   * Shared by the operator's stop and the ceiling, because "capture
   * ended" means the same thing whichever stopped it — and a recording that
   * ran out of budget still reaches the compiler (D-044: a ceiling may not
   * skip compilation). The `warning` says which happened; what it changes is
   * decided by the compiler, on the other side of the queue.
   */
  private async finishCapture(
    recording: Recording,
    result: TeeResult | null,
    warning: RecordingWarning | null = null,
  ): Promise<RecordingStatusResponse> {
    // A hole in the trace is not a recoverable defect: the compiler cannot see
    // what is missing, so it would emit a skill that skips those steps.
    const lost = result?.lostEvents ?? 0;
    if (result === null || lost > 0) {
      // Without a live tee, completeness cannot be established (including a
      // retry after flushing succeeded but the state write failed).
      const error =
        result === null
          ? 'capture was already detached when this recording was settled, so its trace ' +
            'cannot be shown to be complete'
          : `${lost} captured events never reached the database, so the trace has a gap in it`;
      this.logger.error(`recording ${recording.id} failed: ${error}`);
      return this.settle(recording, 'FAILED', warning, error);
    }

    // The two layers saw the same physical clicks; mark the provable
    // pairs before the row can be read as compiling. The compiler is only ever
    // handed a trace this pass had its turn at (PRD §6/M4: "the compiler must
    // not emit both"). Best effort by contract — it never rejects, and a pass
    // that cannot run leaves the trace as captured.
    await this.correlator.correlate(recording.id);

    const compiling = await this.settleRow(recording, 'COMPILING', warning);
    try {
      await this.compiles.enqueue(recording.id);
      return this.describe(compiling);
    } catch (error: unknown) {
      // A `COMPILING` row with nothing behind it is a state nothing can
      // advance, which reads to the UI as a recording stuck forever. Failing
      // it here is what §6 asks for — "a FAILED recording with a readable
      // error" — and the reason is the one thing that tells an operator this
      // is a deployment problem rather than their recording.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`recording ${recording.id} could not be queued for compilation: ${detail}`);
      return this.settle(compiling, 'FAILED', warning, detail);
    }
  }

  /**
   * "Hard limits: 20 minutes, 5000 events. Exceeding either auto-stops
   * and marks the recording `READY` with a warning."
   *
   * Reached from the tee's listener, so there is nobody to answer: the frame
   * that crossed the ceiling was forwarded to the desktop and acknowledged
   * long before this runs. A failure here therefore has to be logged rather
   * than thrown — and it is survivable, because a row left `RECORDING` by a
   * failed settle is exactly what `recoverInterruptedRecordings` exists for.
   */
  private async autoStop(
    botId: string,
    recordingId: string,
    warning: RecordingWarning,
  ): Promise<void> {
    try {
      await this.transition(recordingId, () => this.stopAtLimit(botId, recordingId, warning));
    } catch (error: unknown) {
      this.logger.error(
        `recording ${recordingId} reached ${warning} but could not be settled: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async stopAtLimit(
    botId: string,
    recordingId: string,
    warning: RecordingWarning,
  ): Promise<void> {
    // Release capture before touching Postgres. If the database is temporarily
    // unavailable, keeping a limited entry in the active map would prevent a
    // new recording for this bot even though capture has already stopped. A
    // durable row that cannot be settled remains available to bootstrap
    // recovery; an in-memory slot otherwise has no recovery path in this
    // process.
    const result = await this.endCapture(botId, recordingId);

    // Unscoped by necessity: the ceiling is reached on the §4.3 input path,
    // which carries no principal by design. Nothing untrusted reaches
    // this id — it comes from the tee's own active set, which only an
    // owner-checked `start` can put a recording into.
    const recording = await this.prisma.recording.findUnique({ where: { id: recordingId } });
    // The operator's own stop can win this race, and whichever settles first
    // is the real one. A second settle would move `endedAt` and overwrite the
    // state a user action already chose.
    if (recording === null || recording.state !== 'RECORDING') return;

    // A trace cut short is still whole up to the point it stops, so it goes
    // to the compiler like any other — the compiler's own judgement of the
    // truncation happens there. A trace with a HOLE in it is not
    // whole, and reaching a ceiling does not make it so.
    await this.finishCapture(recording, result, warning);
  }

  /** `POST /recordings/:id/discard`. */
  async discard(userId: string, recordingId: string): Promise<RecordingStatusResponse> {
    return this.transition(recordingId, () => this.discardRecording(userId, recordingId));
  }

  private async discardRecording(
    userId: string,
    recordingId: string,
  ): Promise<RecordingStatusResponse> {
    const recording = await this.findOwned(userId, recordingId);
    // A COMPILING recording can be discarded, and that is new with M3-BE-06.
    // It used to be refused because nothing could advance that state, so a
    // discard would have stranded the row; now the compile job settles through
    // a compare-and-set pinned to `COMPILING`, so a discard that lands first
    // simply makes the job find no row to move and write nothing. Refusing
    // instead would mean an operator who stopped the wrong recording has to
    // watch it compile for up to a minute before they may throw it away.

    // Flushed rather than dropped: one path through the tee is easier to reason
    // about than two, and only the events since the last flush are in hand —
    // at most one batch, whether the recording is one second or twenty minutes
    // old. The rows go with the row when it is deleted (§3 cascades).
    await this.endCapture(recording.botId, recordingId);
    const updated = await this.prisma.$transaction(async (tx) => {
      // This write locks the recording row. It serializes with the compiler's
      // COMPILING -> READY compare-and-set: either compilation commits first
      // and its draft is deleted below, or discard commits first and prevents
      // the compiler from creating one.
      await tx.recording.update({
        where: { id: recording.id },
        data: { state: 'DISCARDED', endedAt: recording.endedAt ?? new Date() },
      });
      await tx.skill.deleteMany({
        where: {
          sourceRecordingId: recording.id,
          status: 'DRAFT',
          bot: { userId },
        },
      });
      const discarded = await tx.recording.findFirst({
        where: { id: recording.id, bot: { userId } },
      });
      if (discarded === null) throw new NotFoundException('Recording not found');
      return discarded;
    });
    this.events.emitRecordingState(updated.botId, updated.id, updated.state);
    this.logger.log(`bot ${updated.botId}: recording ${updated.id} is ${updated.state}`);
    return this.describe(updated);
  }

  /**
   * End all capture layers before anything is settled.
   *
   * Order is not cosmetic. `tee.end` removes the bot from the active set
   * synchronously, so no input frame can join a flush already on its way, and
   * the browser layers come down before the row is settled. Both must
   * complete first: a settle that ran with a layer still attached would
   * either cut off that layer's final events or leave a socket outliving the
   * recording it was opened for.
   */
  private async endCapture(botId: string, recordingId: string): Promise<TeeResult | null> {
    const result = await this.tee.end(botId, recordingId);
    await this.endBrowserCapture(botId, recordingId);
    return result;
  }

  /**
   * Take both browser layers down, in the only order that works.
   *
   * The capture is disarmed while the connection is still open — removing a
   * page's script registration is a command, and there is nothing left to
   * send it over once the attach has closed. The attach closes the socket
   * last. Both are bounded: `disarm` awaits whatever install is in flight,
   * and every CDP command carries a timeout, so a stop is never held hostage
   * by a sandbox that stopped answering.
   *
   * Unscoped from the start-failure path, where the row a recordingId would
   * name is the thing that failed to exist.
   */
  private async endBrowserCapture(botId: string, recordingId?: string): Promise<void> {
    if (recordingId === undefined) {
      await this.capture.disarm(botId);
      await this.cdp.detach(botId);
      return;
    }
    await this.capture.disarm(botId, recordingId);
    await this.cdp.detach(botId, recordingId);
  }

  /** `GET /recordings/:id` — state, event counts by layer, generated skill id. */
  async status(userId: string, recordingId: string): Promise<RecordingStatusResponse> {
    const recording = await this.findOwned(userId, recordingId);
    // Make the buffered tail durable first, so the count answered here is the
    // count a reader of the trace would find. The alternative — adding the
    // in-memory tally to the stored one — is two sources for one number, and
    // they disagree for as long as a flush is in flight.
    await this.tee.settle(recording.botId, recordingId);
    return this.describe(recording);
  }

  /** Re-read state after earlier mutations, including their final flush, finish. */
  private async transition<T>(recordingId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(recordingId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.transitions.set(recordingId, current);
    try {
      return await current;
    } finally {
      if (this.transitions.get(recordingId) === current) this.transitions.delete(recordingId);
    }
  }

  private async settle(
    recording: Recording,
    state: Recording['state'],
    warning: RecordingWarning | null = null,
    error: string | null = null,
  ): Promise<RecordingStatusResponse> {
    return this.describe(await this.settleRow(recording, state, warning, error));
  }

  private async settleRow(
    recording: Recording,
    state: Recording['state'],
    warning: RecordingWarning | null = null,
    error: string | null = null,
  ): Promise<Recording> {
    const updated = await this.prisma.recording.update({
      where: { id: recording.id },
      data: {
        state,
        // When CAPTURE ended, written once. A recording now passes through
        // two settlements — COMPILING then READY or FAILED — and moving this
        // on the second would date the recording to when the model answered
        // rather than to when the user stopped demonstrating.
        endedAt: recording.endedAt ?? new Date(),
        // Written only when there is one to write. `discard` settles an
        // already settled row, and clearing the reason a recording stopped
        // itself while deleting its trace would erase the answer to the only
        // question left about it.
        ...(warning === null ? {} : { warning }),
        ...(error === null ? {} : { error }),
      },
    });
    this.events.emitRecordingState(updated.botId, updated.id, updated.state);
    this.logger.log(`bot ${updated.botId}: recording ${updated.id} is ${updated.state}`);
    return updated;
  }

  /**
   * Record that a recording has no CDP connection (M4-BE-07, §6/M4's
   * degradation clause).
   *
   * The attach reports the two ways it can happen — the connect that never
   * landed, and the socket that dropped mid-recording — and they mean the
   * same thing to every reader of the row: this trace holds no CDP rows.
   * Nothing else moves. The state stays where capture is, `error` and
   * `warning` stay null (an unreachable browser is a mode, not a failure),
   * `endedAt` is untouched, and no frame is emitted — the flag is read back
   * through `status`, exactly as `warning` is, because §4.2's
   * `recording.state` carries states and not flags.
   *
   * Compare-and-set on `cdpAvailable: true`, so the flip happens once and
   * only once even if both moments are somehow reported, and a value
   * something else deliberately set is never overwritten. The write is
   * fire-and-forget with a log: its caller is the attach's own failure
   * path, which must never reject into the recording.
   */
  private async markCdpUnavailable(botId: string, recordingId: string): Promise<void> {
    try {
      const flipped = await this.prisma.recording.updateMany({
        where: { id: recordingId, cdpAvailable: true },
        data: { cdpAvailable: false },
      });
      if (flipped.count > 0) {
        this.logger.warn(
          `recording ${recordingId}: CDP is unavailable for bot ${botId}; ` +
            'capture continues at the X11 layer and the row records cdpAvailable=false',
        );
      }
    } catch (error: unknown) {
      // Losing the flag costs the readers their only hint that this trace
      // holds no CDP rows; it must not cost anything else.
      this.logger.error(
        `recording ${recordingId}: could not record the CDP degradation: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async describe(recording: Recording): Promise<RecordingStatusResponse> {
    const [grouped, skill] = await Promise.all([
      this.prisma.recordingEvent.groupBy({
        by: ['layer'],
        where: { recordingId: recording.id },
        _count: { _all: true },
      }),
      // A recording may have several version rows; the card follows
      // the newest one rather than whichever row Postgres happens to return.
      this.prisma.skill.findFirst({
        where: { sourceRecordingId: recording.id },
        orderBy: { version: 'desc' },
        select: { id: true },
      }),
    ]);

    const counts = { x11: 0, cdp: 0, atspi: 0 };
    for (const row of grouped) {
      if (row.layer === 'X11') counts.x11 = row._count._all;
      else if (row.layer === 'CDP') counts.cdp = row._count._all;
      else counts.atspi = row._count._all;
    }

    return {
      id: recording.id,
      state: recording.state,
      intent: recording.intent,
      cdpAvailable: recording.cdpAvailable,
      warning: recording.warning,
      error: recording.error,
      counts,
      skillId: skill?.id ?? null,
    };
  }

  /** One owner-scoped lookup, so every route above resolves through the owner (R7). */
  private async findOwned(userId: string, recordingId: string): Promise<Recording> {
    const recording = await this.prisma.recording.findFirst({
      where: { id: recordingId, bot: { userId } },
    });
    if (recording === null) throw new NotFoundException('Recording not found');
    return recording;
  }
}
