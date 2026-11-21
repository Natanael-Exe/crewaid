/**
 * §6/M5's loop safety limits — the accounting, and the decision it feeds.
 *
 * Three ceilings on one turn: steps taken, input tokens accumulated, and time
 * spent working. This module owns all three so they are compared in one place
 * and reported in one vocabulary; the runner owns where they are consulted and
 * the service owns what a user is told.
 *
 * D-047 applies to two of them. A wall that refuses work the operator asked
 * for ships OFF, and `0` is how each says so — `AGENT_MAX_TURN_TOKENS` and
 * `AGENT_MAX_TURN_MS` are both absent by default, so a stock install has the
 * accounting and none of the refusals. The step ceiling is the exception, and
 * for a measured reason rather than an inherited one: an agent built with no
 * stop condition at all runs 20 steps, because that is the AI SDK's own
 * default (measured against ai@7.0.89). "Off" is not one of the states the
 * loop offers, so the only question the step ceiling asks is which number, and
 * §6/M5 answers 25.
 *
 * Nothing here imports the AI SDK. The numbers arrive as numbers so the whole
 * decision is a pure function over three integers, which is the part worth
 * pinning with fixtures rather than with a mock provider.
 */

/** Which ceiling ended a turn. */
export type TurnLimitKind = 'steps' | 'tokens' | 'duration';

/**
 * The three §6/M5 ceilings. `0` on any axis means no ceiling there.
 *
 * Not `undefined`, because these are read from the environment and an absent
 * variable already means "no ceiling" — one representation for one idea, the
 * same convention the other token ceilings use.
 */
export type TurnLimits = {
  readonly maxSteps: number;
  readonly maxTurnTokens: number;
  readonly maxTurnMs: number;
};

/** What a turn has spent so far, on the three axes the limits bound. */
export type TurnLimitObservation = {
  readonly steps: number;
  readonly tokens: number;
  readonly elapsedMs: number;
};

/**
 * The ceiling a turn reached, carrying the number it hit AND the number it
 * was measured against.
 *
 * Both, because the message a user reads has to name the limit that fired to
 * be worth posting, and the operator raising it needs to see what it was set
 * to. A turn that stopped "at the step limit" tells neither.
 */
export type TurnLimitStop = {
  readonly kind: TurnLimitKind;
  readonly limit: number;
  readonly observed: number;
};

/**
 * The decision, as a total function: the first ceiling this observation has
 * reached, or `undefined` while it is inside all three.
 *
 * `>=` rather than `>`: a limit of 25 steps means the turn may TAKE 25, not
 * that it may take 26. The SDK's own `stepCountIs` compares with `===` for
 * the same boundary, which works only because it is consulted after every
 * step; `>=` holds even when a count arrives already past the line, which is
 * what happens when a suspended round is checked after the fact.
 *
 * The order is fixed and it is the order of the answer's usefulness. A turn
 * that crossed two ceilings on the same step is reported on the one whose
 * configuration an operator is most likely to want to change, and steps is
 * the axis §6/M5 writes an acceptance criterion about.
 */
export function limitReached(
  limits: TurnLimits,
  observed: TurnLimitObservation,
): TurnLimitStop | undefined {
  if (limits.maxSteps > 0 && observed.steps >= limits.maxSteps) {
    return { kind: 'steps', limit: limits.maxSteps, observed: observed.steps };
  }
  if (limits.maxTurnTokens > 0 && observed.tokens >= limits.maxTurnTokens) {
    return { kind: 'tokens', limit: limits.maxTurnTokens, observed: observed.tokens };
  }
  if (limits.maxTurnMs > 0 && observed.elapsedMs >= limits.maxTurnMs) {
    return { kind: 'duration', limit: limits.maxTurnMs, observed: observed.elapsedMs };
  }
  return undefined;
}

/** One finished round's contribution to the turn's totals. */
export type TurnLimitRound = {
  readonly steps: number;
  readonly tokens: number;
};

const NO_ROUND: TurnLimitRound = { steps: 0, tokens: 0 };

/**
 * A turn's running totals, across however many agent streams it took.
 *
 * Mutable and per-turn, like the usage totals it sits beside. It exists
 * because M5-BE-09 made a turn one stream PER APPROVAL ROUND: `stopWhen`
 * counts inside one `stream()` call, so a per-round ceiling would hand a turn
 * a fresh budget every time it asked a question.
 */
export type TurnLimitAccount = {
  /** Steps completed in the rounds that have already finished. */
  readonly steps: () => number;
  /** Input tokens accumulated in the rounds that have already finished. */
  readonly tokens: () => number;
  /** Time the turn has spent WORKING; see `suspend`. */
  readonly elapsedMs: () => number;
  /** Start the clock for a round. Idempotent. */
  readonly resume: () => void;
  /** Stop the clock. Idempotent. */
  readonly suspend: () => void;
  /** Fold a finished round into the turn's totals. */
  readonly recordRound: (round: TurnLimitRound) => void;
  /**
   * Test the totals, optionally plus a round still in flight. Records the
   * first ceiling reached, which is what `stopped` reports afterwards.
   */
  readonly check: (round?: TurnLimitRound) => TurnLimitStop | undefined;
  /** The ceiling that ended this turn, if one did. */
  readonly stopped: () => TurnLimitStop | undefined;
};

export function createTurnLimitAccount(
  limits: TurnLimits,
  now: () => number = Date.now,
  initial: TurnLimitObservation = { steps: 0, tokens: 0, elapsedMs: 0 },
): TurnLimitAccount {
  let steps = initial.steps;
  let tokens = initial.tokens;
  let settledMs = initial.elapsedMs;
  let runningSince: number | undefined;
  let stop: TurnLimitStop | undefined;

  // `Math.max(0, …)` because `Date.now()` is not monotonic: an NTP step
  // backwards mid-turn would otherwise subtract from the elapsed total and a
  // clock that can run backwards is a limit that can un-fire.
  const elapsedMs = (): number =>
    settledMs + (runningSince === undefined ? 0 : Math.max(0, now() - runningSince));

  return {
    steps: () => steps,
    tokens: () => tokens,
    elapsedMs,
    resume: () => {
      runningSince ??= now();
    },
    /**
     * The clock measures the turn's own work, and stops while the turn is
     * suspended waiting for an operator to answer an approval.
     *
     * This is a choice, not an omission. §6/M5 calls the limit a wall clock,
     * and the strict reading would keep counting — but what the limit exists
     * to bound is a runaway loop, and a turn waiting on a human is the
     * opposite of runaway. D-051 named the failure: a clock that runs while
     * someone reads the command they were asked to approve fires at the one
     * moment that helps nobody, and `bot.cancel` already ends a wait. So the
     * number an operator configures is time the BOT spent, which is also the
     * only part of it they can act on by raising the ceiling.
     */
    suspend: () => {
      if (runningSince === undefined) return;
      settledMs += Math.max(0, now() - runningSince);
      runningSince = undefined;
    },
    recordRound: (round) => {
      steps += round.steps;
      tokens += round.tokens;
    },
    check: (round = NO_ROUND) => {
      const reached = limitReached(limits, {
        steps: steps + round.steps,
        tokens: tokens + round.tokens,
        elapsedMs: elapsedMs(),
      });
      // First one wins: a turn is stopped once, and the round that stopped it
      // is the one worth reporting. A later check — the suspension probe runs
      // after the stop conditions — must not overwrite it with the same
      // ceiling measured a few milliseconds later.
      stop ??= reached;
      return reached;
    },
    stopped: () => stop,
  };
}

function fmtCount(value: number): string {
  return value.toLocaleString('en-US');
}

function fmtDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** D-206: an actual stop needs an action; internal budgets stay in logs and model instructions. */
export function turnLimitCopy(_stop: TurnLimitStop): string {
  return 'The bot paused before finishing. Anything it finished is above — send a message to carry on from there.';
}

/**
 * The MODEL's half: which ceiling fired, and the key that sets it.
 *
 * Exported because the model is told this on a continuation (M5-BE-19), and
 * precision is what that reader needs — naming the ceiling is what stops it
 * re-planning from the same starting point and walking into the same wall on
 * the same step. It is deliberately NOT what the person is shown; see
 * `turnLimitCopy` above for that half and why they differ (D-093).
 */
export function turnLimitSentence(stop: TurnLimitStop): string {
  switch (stop.kind) {
    case 'steps':
      return (
        `This turn stopped after ${fmtCount(stop.observed)} steps, its AGENT_MAX_STEPS ` +
        `ceiling of ${fmtCount(stop.limit)}.`
      );
    case 'tokens':
      return (
        `This turn stopped after ${fmtCount(stop.observed)} input tokens, reaching its ` +
        `AGENT_MAX_TURN_TOKENS ceiling of ${fmtCount(stop.limit)}.`
      );
    case 'duration':
      return (
        `This turn stopped after ${fmtDuration(stop.observed)} of work, reaching its ` +
        `AGENT_MAX_TURN_MS ceiling of ${fmtDuration(stop.limit)}. Time spent waiting for ` +
        `an approval does not count towards it.`
      );
  }
}

/**
 * The share of the step budget at which the model is told to start finishing
 * (Hermes Agent's wrap-up notice, which turns the last stretch of a budget
 * into completing rather than amputating). Without it a model learns it hit a
 * wall only by hitting it: the ceiling stops it mid-task, the continuation
 * re-plans, and a task that needed patience arrives at its ceiling four
 * times without a deliverable. One-shot, like the warning it mirrors.
 */
export const WRAP_UP_RATIO = 0.8;

/** Whether the wrap-up notice is due at this many completed steps. */
export function wrapUpDue(stepsDone: number, maxSteps: number): boolean {
  return maxSteps > 0 && stepsDone >= Math.ceil(maxSteps * WRAP_UP_RATIO);
}

/** What the model is told as the step budget runs down. */
export function wrapUpCopy(stepsDone: number, maxSteps: number): string {
  return (
    `[SYSTEM NOTICE] You have used ${fmtCount(stepsDone)} of this turn's ${fmtCount(maxSteps)} ` +
    'steps. Wrap up now: stop starting new lines of work, and produce the final answer or ' +
    'deliverable from the state you already have. Do not stop solely because of this notice — ' +
    'finish the task with the steps that remain.'
  );
}

/**
 * What the model is told when a ceiling cut its work short.
 *
 * The conversation is already in the prompt, including the request
 * this is continuing, so this does not repeat the task — it says why the work
 * stopped and what to do about it. Naming the ceiling matters: without it the
 * model re-plans from the same starting point and walks into the same wall on
 * the same step.
 *
 * Here rather than in either coordinator, because both engines continue a
 * limit stop and a second wording would be a second answer to why the last
 * run ended (D-191 §4).
 */
export function continuationInstruction(stop: TurnLimitStop): string {
  return (
    `Your previous turn was cut short. ${turnLimitSentence(stop)} ` +
    'Continue the work from where it stopped. Do not start over and do not repeat what is ' +
    'already done above — pick up at the next step. If a smaller number of larger steps ' +
    'would finish it, take that route.'
  );
}
