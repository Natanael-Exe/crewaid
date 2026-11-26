/**
 * The loop safety limits, read from the environment.
 *
 * Read once, at construction, and a malformed value throws there — the
 * `auth.guard.ts` pattern, for the same reason `sandbox.config.ts` uses it: a
 * ceiling that silently reads as `NaN` is a limit that looks configured and
 * is not. `stepCountIs(NaN)` never fires, so the turn would run until the
 * model stopped asking for tools.
 *
 * Collected here rather than inlined next to the agent because §6/M5 sets
 * three of these — steps, accumulated input tokens, wall clock — and the
 * defaults ARE the contract, so they belong where the next one can be added
 * beside them rather than in a second copy somewhere else.
 */

/** Default per-turn step ceiling (each step is one model call plus its tool calls). */
export const DEFAULT_MAX_STEPS = 25;

/** `AGENT_MAX_STEPS` — the per-turn step ceiling. */
export function readMaxSteps(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_STEPS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `AGENT_MAX_STEPS must be a whole number of steps >= 1, got ${JSON.stringify(raw)}. ` +
        'There is no "unlimited": a turn that can never be stopped by its own step ' +
        'ceiling is the runaway §6/M5 asks this limit to prevent.',
    );
  }
  return parsed;
}

/**
 * `prepareStep` trims context. This is the measured size at which it
 * starts.
 *
 * The number is the PREVIOUS step's input tokens as the provider counted
 * them, not an estimate over serialized JSON — `prepareStep` is handed every
 * prior `StepResult`, and each carries the usage the provider reported, so
 * the trigger is the real thing rather than a proxy for it.
 *
 * 100k sits comfortably inside the 200k window the D-002 providers offer,
 * which is deliberate on both sides. High enough that an ordinary turn never
 * trims — a trim is lossy and the cheapest trim is the one that does not
 * happen — and low enough that a tool-heavy turn is trimmed while the next
 * call still fits, rather than after the provider has already refused it.
 *
 * This is not a §7.2-style wall and D-047 does not apply: trimming is what
 * lets a long turn CONTINUE. Raising it does not buy an operator more work,
 * it buys a larger context per call until the provider's own limit refuses
 * the turn outright.
 */
export const DEFAULT_CONTEXT_TRIM_TOKENS = 100_000;

/** `AGENT_CONTEXT_TRIM_TOKENS` — the input-token size a step trims above. */
export function readContextTrimTokens(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONTEXT_TRIM_TOKENS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `AGENT_CONTEXT_TRIM_TOKENS must be a whole number of input tokens >= 1, got ` +
        `${JSON.stringify(raw)}. Set it high to trim rarely; there is no value meaning ` +
        '"never", because a turn that never trims is one the provider refuses instead.',
    );
  }
  return parsed;
}

/**
 * "150,000 accumulated input tokens per turn."
 *
 * The number is written down here because it is the one §6/M5 specifies and
 * an operator who wants the specified behaviour needs something to copy. It
 * is NOT the default — see `DEFAULT_MAX_TURN_TOKENS` and D-047.
 *
 * "Accumulated input tokens" is the sum over the turn's steps of what the
 * provider counted as input for each. It grows faster than a reader expects,
 * because every step re-sends the history: a turn of twenty steps at a steady
 * 8k of context has accumulated 160k input tokens without ever having sent a
 * large prompt. That is the number this bounds, and the reason the trim
 * is the thing that keeps a long turn under it.
 */
export const SPECIFIED_MAX_TURN_TOKENS = 150_000;

/**
 * "10-minute wall-clock timeout per turn." Specified, not default.
 */
export const SPECIFIED_MAX_TURN_MS = 600_000;

/**
 * Token and duration ceilings ship disabled (`0`) by default while accounting
 * remains active; operators can opt in via environment variables. The step
 * ceiling stays enabled at 25 so a runaway loop always terminates.
 */
/** Maximum prior messages seeded into a new turn (40 ≈ 20 exchanges). */
/**
 * How many times a turn stopped by a ceiling may be continued.
 *
 * §6/M5 ends a turn that hits a limit with a system message and IDLE, and
 * nothing read that message — so a bot with half a task done stopped until a
 * human arrived. This is the number that lets it carry on, and the reason a
 * 25-step turn that continues is better than a 10,000-step turn: the work is
 * checkpointed per step, cheap to lose, and bounded by something an operator
 * can see.
 *
 * It needs a bound of its OWN rather than relying on the ceilings, because
 * two of the three ship off — "the limits will stop it" is not true
 * here. Three continuations is four turns, so 100 steps at the default step
 * ceiling: enough for real unattended work, and short enough that a model
 * looping on a bad plan stops being expensive before anyone notices it.
 *
 * `0` disables continuation entirely and restores the stop-and-wait.
 */
export const DEFAULT_MAX_CONTINUATIONS = 3;

/** `AGENT_MAX_CONTINUATIONS` — 0 means a limit stop ends the work, as before. */
export function readMaxContinuations(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONTINUATIONS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `AGENT_MAX_CONTINUATIONS must be a whole number >= 0 (0 disables continuation), ` +
        `got ${JSON.stringify(raw)}. There is no "unlimited": a turn that continues ` +
        'forever is the runaway this bound exists to make visible.',
    );
  }
  return parsed;
}

export const DEFAULT_HISTORY_MESSAGES = 40;

/** `AGENT_HISTORY_MESSAGES` — 0 seeds nothing, which is the pre-M5-BE-29 behaviour. */
export function readHistoryMessages(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HISTORY_MESSAGES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `AGENT_HISTORY_MESSAGES must be a whole number of messages >= 0 ` +
        `(0 seeds none), got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

/**
 * The standing memory's share of every prompt, in CHARACTERS.
 *
 * Why the number is so small
 *
 * Because the multiplier is large. `instructions` is re-sent on EVERY model
 * call of every step, not once per turn, so 2,000 characters on a 25-step turn
 * is roughly 12,500 tokens of memory rather than 500. Anyone reading this
 * bound as stingy has priced it per turn.
 *
 * Why characters and not tokens
 *
 * There is no tokenizer in this repo and there should not be one. `js-tiktoken`
 * would be a new pinned dependency AND wrong — Claude's tokenizer is not
 * public, so it would give a precise number about a different model, which is
 * worse than an honest approximation. Anthropic's count_tokens endpoint is a
 * network round trip on the turn-start path. Characters are exactly countable,
 * deterministic in tests, and already how every other bound here is expressed
 * (the memory's 16,000, the board's 32,000, MODEL_RESULT_MAX_BYTES).
 *
 * CC-37 measures the real chars-per-token ratio against recorded
 * `AgentTurn.inputTokens` and is expected to move this number. The bound stays
 * in characters either way.
 */
/**
 * The seed's OTHER bound, the one `AGENT_HISTORY_MESSAGES` cannot be.
 *
 * A message count says nothing about size. Forty short exchanges and forty
 * pasted stack traces are the same number and nowhere near the same prompt,
 * so the count alone lets a handful of long messages fill a context window
 * that every other bound in this file is carefully protecting. Pre-existing,
 * and the kind of thing the memory feature would be blamed for the first time
 * a turn overflowed.
 *
 * ~6k tokens at the measured ratio, which is generous: this is a backstop
 * against pathological messages, not a second opinion about how much history
 * is useful. `AGENT_HISTORY_MESSAGES` is still the knob for that.
 */
/**
 * How often the extraction sweep runs. **0 disables it, and 0
 * is the default.**
 *
 * Shipped off, and not out of caution about cost. D-064 puts `remember` and
 * `forget` on the `ask` fallthrough, so the operator was promised that memory
 * writes are approved; a background worker writing memories silently revokes
 * that promise. Turning this on is a product-policy decision, not a tuning
 * one, and it belongs to whoever made the promise.
 *
 * What makes it survivable when it IS on: every write lands as `CANDIDATE`,
 * which is searchable and never injected. A wrong inference becomes a search
 * result rather than a standing truth.
 */
export const DEFAULT_MEMORY_DISTILL_INTERVAL_MS = 0;

/** `AGENT_MEMORY_DISTILL_INTERVAL_MS` — 0 disables the sweep entirely. */
export function readMemoryDistillIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MEMORY_DISTILL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `AGENT_MEMORY_DISTILL_INTERVAL_MS must be a whole number of milliseconds >= 0 ` +
        `(0 disables), got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

/**
 * How many new messages a bot must accumulate before it is worth a model call.
 *
 * Triggered by WORK, not by the clock. A sweep that fires on an interval alone
 * spends a model call to read "thanks" — and the cost of extraction is one
 * call per bot per pass, so the thing that must be bounded is how often a pass
 * finds anything worth reading.
 */
export const DEFAULT_MEMORY_DISTILL_MIN_MESSAGES = 8;

export function readMemoryDistillMinMessages(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MEMORY_DISTILL_MIN_MESSAGES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `AGENT_MEMORY_DISTILL_MIN_MESSAGES must be a whole number >= 1, got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

/** The most messages one pass will read. Bounds the prompt, not the backlog. */
export const MEMORY_DISTILL_WINDOW = 20;

export const DEFAULT_HISTORY_CHARS = 24_000;

/** `AGENT_HISTORY_CHARS` — 0 disables the size bound, leaving only the count. */
export function readHistoryChars(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HISTORY_CHARS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `AGENT_HISTORY_CHARS must be a whole number of characters >= 0 ` +
        `(0 leaves only AGENT_HISTORY_MESSAGES), got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

export const DEFAULT_MEMORY_BUDGET_CHARS = 2_000;

/** `AGENT_MEMORY_BUDGET_CHARS` — 0 injects nothing, the pre-CC-32 behaviour. */
export function readMemoryBudgetChars(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MEMORY_BUDGET_CHARS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `AGENT_MEMORY_BUDGET_CHARS must be a whole number of characters >= 0 ` +
        `(0 injects none), got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

export const DEFAULT_MAX_TURN_TOKENS = 0;
export const DEFAULT_MAX_TURN_MS = 0;

/** Shared by both readers below; `0` is a legal value and means "no ceiling". */
function readOptionalCeiling(key: string, raw: string | undefined, unit: string): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `${key} must be a whole number of ${unit} >= 0 (0, or absent, means no ceiling), ` +
        `got ${JSON.stringify(raw)}. A ceiling that parses as NaN compares false against ` +
        'every measurement, so it would look configured and never fire.',
    );
  }
  return parsed;
}

/** `AGENT_MAX_TURN_TOKENS` — the accumulated-input-token ceiling. */
export function readMaxTurnTokens(raw: string | undefined): number {
  return readOptionalCeiling('AGENT_MAX_TURN_TOKENS', raw, 'input tokens');
}

/** `AGENT_MAX_TURN_MS` — the per-turn clock, in milliseconds of work. */
export function readMaxTurnMs(raw: string | undefined): number {
  return readOptionalCeiling('AGENT_MAX_TURN_MS', raw, 'milliseconds');
}

/** Default step ceiling for a delegated `code_task` coding sub-loop. */
export const DEFAULT_CODING_MAX_STEPS = 60;

/** Default wall-clock ceiling for a delegated `code_task` run (15 minutes). */
export const DEFAULT_CODING_MAX_MS = 15 * 60 * 1000;

/** Default accumulated input-token ceiling for `code_task` (`0` disables, matching turns). */
export const DEFAULT_CODING_MAX_TOKENS = 0;

/** `AGENT_CODING_MAX_STEPS` — step ceiling for a single `code_task` coding run. */
export function readCodingMaxSteps(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CODING_MAX_STEPS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `AGENT_CODING_MAX_STEPS must be a whole number of steps >= 1, got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

/** `AGENT_CODING_MAX_MS` — wall-clock limit in milliseconds for `code_task` (`0` disables). */
export function readCodingMaxMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CODING_MAX_MS;
  return readOptionalCeiling('AGENT_CODING_MAX_MS', raw, 'milliseconds');
}

/** `AGENT_CODING_MAX_TOKENS` — accumulated input-token ceiling for `code_task` (`0` disables). */
export function readCodingMaxTokens(raw: string | undefined): number {
  return readOptionalCeiling('AGENT_CODING_MAX_TOKENS', raw, 'input tokens');
}
