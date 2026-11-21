import { Inject, Injectable } from '@nestjs/common';
import type { RunStatus, TurnStatus } from '@prisma/client';
import { RunSkillBodySchema, type RunSkillBody } from '@crewaid/shared';

import { TanStackTurns } from '../agent/tanstack-turns.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { MessagesService } from '../messages/messages.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SandboxReadinessService } from '../sandbox/sandbox-readiness.service.js';
import { SkillRunService } from '../skills/skill-run.service.js';
import { ROUTINE_SCHEDULER, type RoutineScheduler } from './routine.queue.js';
import { dateInZone } from './routine-schedule.js';

/** How one firing ended, for the processor's log line and the tests. */
export type RoutineRunOutcome =
  | { readonly kind: 'ran'; readonly status: RunStatus }
  | { readonly kind: 'gone' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'expired' }
  /** Not the runner's: the processor skipped a firing that overlapped. */
  | { readonly kind: 'skipped'; readonly heldByJobId: string | null };

/**
 * What a routine DOES when it fires.
 *
 * A prompt routine is a message from the operator
 *
 * The prompt is posted as an ordinary USER message and answered by an
 * ordinary turn, through the same two calls `MessagesController.send` makes.
 * That is deliberate rather than provisional: a routine is the operator
 * asking the same thing on a schedule, and every property of a turn the
 * operator started — approvals, limits, memory, waking the computer on demand
 * — is one a scheduled turn needs too. A parallel "routine turn" would be a
 * second copy of all of it. What the row does not yet say is that a schedule
 * sent it; that is the provenance, and it lands with the task that
 * defines it rather than as a guess here.
 *
 * The job waits for the work
 *
 * `startTurn` resolves when the turn does, and `runToCompletion` when the
 * skill run does, so a firing's job is active for exactly as long as its work
 * is. That is what lets `lastStatus` be an outcome rather than "accepted",
 * and it is the span overlap suppression will be judged against.
 *
 * Authority is read from the row, at run time
 *
 * The job carries only a routine id. The owner is the routine's bot's user,
 * resolved when the firing runs, and every write after that is scoped by it:
 * a job is not a capability, and a routine deleted or disabled since it was
 * scheduled must not run as it was.
 */
@Injectable()
export class RoutineRunnerService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(TanStackTurns) private readonly turns: TanStackTurns,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(SkillRunService) private readonly skillRuns: SkillRunService,
    @Inject(ROUTINE_SCHEDULER) private readonly scheduler: RoutineScheduler,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(SandboxReadinessService) private readonly computers: SandboxReadinessService,
  ) {}

  async run(routineId: string): Promise<RoutineRunOutcome> {
    const routine = await this.prisma.routine.findUnique({
      where: { id: routineId },
      include: { bot: { select: { userId: true } } },
    });

    // A scheduler whose row is gone fires forever unless something removes
    // it, and nothing else will: the delete that should have did not reach
    // Redis. The firing that notices is the one place left to do it.
    if (routine === null) {
      this.logger.info('routine.run.dropped', { routineId, reason: 'gone' });
      await this.scheduler.unschedule(routineId);
      return { kind: 'gone' };
    }

    const context = this.logger.child({ botId: routine.botId });
    if (!routine.enabled) {
      context.info('routine.run.dropped', { routineId, reason: 'disabled' });
      await this.scheduler.unschedule(routineId);
      return { kind: 'disabled' };
    }
    if (routine.endsOn !== null && dateInZone(new Date(), routine.timezone) > routine.endsOn) {
      context.info('routine.run.dropped', { routineId, reason: 'expired' });
      await this.scheduler.unschedule(routineId);
      return { kind: 'expired' };
    }

    const userId = routine.bot.userId;
    await this.record(routineId, userId, { lastRunAt: new Date(), lastStatus: 'RUNNING' });
    context.info('routine.run.started', { routineId });

    let status: RunStatus;
    try {
      status =
        routine.skillId !== null
          ? await this.runSkill(userId, routine.skillId, routine.skillParams)
          : await this.runPrompt(userId, routine.botId, triggerText(routine), routine.id);
    } catch (error) {
      // Recorded before it is rethrown: the row is what the operator reads,
      // and a failure that only reached the worker's log would leave the
      // panel saying RUNNING for a firing that is long over.
      await this.record(routineId, userId, { lastStatus: 'FAILED' });
      context.warn('routine.run.failed', {
        routineId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }

    await this.record(routineId, userId, { lastStatus: status });
    context.info('routine.run.settled', { routineId, status });
    return { kind: 'ran', status };
  }

  /**
   * "A routine whose bot's sandbox is stopped starts (or resumes) the
   * sandbox first, then runs."
   *
   * The wake is the shared ensure-ready path and nothing else —
   * storage, capacity admission, resume-or-create and bridge readiness all
   * live in `SandboxService.start` behind it. The lease is claimed BEFORE the
   * prompt is posted, and that ordering is what makes a full host harmless: a
   * capacity refusal throws here, the firing records FAILED, and no message
   * exists to be answered twice when the next slot runs. It is held until the
   * turn ends, so the idle sweep cannot stop the computer under the work, and
   * released on every path by `withComputer`.
   *
   * A skill routine needs none of this: `SkillRunService` already runs every
   * skill inside `withComputer(..., 'skill',...)`.
   */
  private async runPrompt(
    userId: string,
    botId: string,
    prompt: string,
    routineId: string,
  ): Promise<RunStatus> {
    return this.computers.withComputer(userId, botId, 'managed-job', async () => {
      // The message says which routine posted it, so what the turn
      // attaches is filed under that routine's goal.
      const created = await this.messages.createUserMessage(
        userId,
        botId,
        { content: prompt },
        { routineId },
      );
      // The HTTP route answers its caller with the row; a firing has no
      // caller, so an open client learns of the message the way it learns of
      // any other it did not send.
      this.events.emitCreated(botId, created);
      await this.turns.startStored(userId, botId, {
        id: created.id,
        content: created.content,
        chainId: created.chainId,
        hopCount: 0,
      });
      const turn = await this.prisma.agentTurn.findFirst({
        where: { triggerMessageId: created.id, bot: { userId } },
        select: { status: true },
      });
      return runStatusOfTurn(turn?.status ?? null);
    });
  }

  private async runSkill(userId: string, skillId: string, params: unknown): Promise<RunStatus> {
    const { status } = await this.skillRuns.runToCompletion(userId, skillId, skillParamsOf(params));
    return status;
  }

  private async record(
    routineId: string,
    userId: string,
    data: { lastRunAt?: Date; lastStatus: RunStatus },
  ): Promise<void> {
    await this.prisma.routine.updateMany({ where: { id: routineId, bot: { userId } }, data });
  }
}

/**
 * A turn's status in the routine's vocabulary.
 *
 * No turn at all means `startTurn` deferred: another turn was running, and
 * the prompt is queued behind it. That is PENDING — the work is
 * owed, not done and not failed. A turn parked on an approval has not
 * finished either, so it reads as RUNNING until the operator answers.
 */
export function runStatusOfTurn(status: TurnStatus | null): RunStatus {
  switch (status) {
    case null:
      return 'PENDING';
    case 'running':
    case 'interrupted':
      return 'RUNNING';
    case 'completed':
      return 'SUCCEEDED';
    case 'aborted':
      return 'CANCELLED';
    case 'failed':
      return 'FAILED';
  }
}

/**
 * `Routine.skillParams` as a skill run's params.
 *
 * Parsed by the shared schema rather than cast: the column is untyped JSON,
 * and a value that is not an object is a routine that cannot run as written —
 * a FAILED firing says so, where running the skill with no params instead
 * would do something the operator did not schedule.
 */
function skillParamsOf(value: unknown): RunSkillBody['params'] {
  if (value === null) return {};
  const parsed = RunSkillBodySchema.shape.params.safeParse(value);
  if (!parsed.success) throw new Error("the routine's skillParams is not a JSON object");
  return parsed.data;
}

/**
 * "exactly one of prompt or skillId". A row with neither was written
 * around the CRUD's validation; posting an empty message for it would start
 * a turn about nothing, so the firing fails and says why.
 */
function promptOf(prompt: string | null): string {
  if (prompt === null || prompt.trim() === '') {
    throw new Error('the routine has neither a prompt nor a skill to run');
  }
  return prompt;
}

/**
 * What a prompt routine posts.
 *
 * The operator's own routine posts its prompt verbatim: it IS the operator
 * asking again. A routine the bot scheduled for itself is labelled as
 * one, because the message lands as a USER row, and a bot's note to its
 * future self rendered as if the operator had typed it would be a false
 * statement in the transcript about who asked.
 */
export function triggerText(routine: {
  readonly name: string;
  readonly prompt: string | null;
  readonly origin: 'OPERATOR' | 'BOT';
}): string {
  const prompt = promptOf(routine.prompt);
  return routine.origin === 'BOT'
    ? `Scheduled follow-up you set for yourself ("${routine.name}"):\n\n${prompt}`
    : prompt;
}
