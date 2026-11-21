/**
 * The ceilings a chain of inter-bot messages runs under.
 *
 * Why they are all off by default
 *
 * D-047 amends the defaults: "the product's job is to make spend and
 * runaway loops visible and bounded by the OPERATOR, not to pick the bound for
 * them." Ten hops is roughly five round trips — a PM delegating to a developer
 * and a reviewer exhausts it before lunch — so the number §6/M7 writes down
 * stays written down here, as the value an operator who wants it copies, and
 * the shipped default stops being a refusal.
 *
 * D-047 also records the argument against, and it is worth re-reading before
 * anyone changes these: "the operator can stop it" assumes the operator is
 * watching, and the premise of an unattended team is that they are not. The
 * answer chosen was disclosure rather than a wall — the accounting still runs,
 * every stop is logged under its `chainId`, and a chain that ends still says
 * why in both transcripts. What is gone is only the automatic refusal.
 *
 * Read once at construction, and a malformed value throws there — the
 * `auth.guard.ts` pattern, for the reason `agent-loop.config.ts` gives: a
 * ceiling that silently reads as `NaN` compares false against every
 * measurement, so it looks configured and never fires.
 */

/**
 * "at `MAX_HOPS` (default 10) delivery is dropped".
 *
 * Specified, not default. The number is here because an operator who wants
 * The behaviour needs something to copy, and because the test for the
 * acceptance criterion sets the limit it asserts.
 */
export const SPECIFIED_MAX_HOPS = 10;

/** The accounting stays, the default stops being a refusal. */
export const DEFAULT_MAX_HOPS = 0;

/**
 * Shared by every chain ceiling; `0` is a legal value and means "no ceiling".
 *
 * A separate reader from `agent-loop.config.ts`'s `readOptionalCeiling`
 * despite the identical shape, because the two families bound different
 * things and their messages have to say which: a turn's ceiling stops one
 * bot's work, a chain's stops a conversation between several. Sharing the
 * function would mean sharing the sentence.
 */
function readChainCeiling(key: string, raw: string | undefined, unit: string): number {
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

/** `CHAIN_MAX_HOPS` — the `MAX_HOPS`, off unless an operator sets it. */
export function readMaxHops(raw: string | undefined): number {
  return readChainCeiling('CHAIN_MAX_HOPS', raw, 'hops');
}

/**
 * "Each `chainId` carries a token budget (default 200,000 across all
 * participants)."
 *
 * Specified, not default — D-047 gives this one the same treatment as the hop
 * limit: "the accounting stays, the default stops being a refusal."
 */
export const SPECIFIED_MAX_CHAIN_TOKENS = 200_000;

/** D-047 again: off unless an operator asks for a wall. */
export const DEFAULT_MAX_CHAIN_TOKENS = 0;

/** `CHAIN_MAX_TOKENS` — every token every participant spent on one chain. */
export function readMaxChainTokens(raw: string | undefined): number {
  return readChainCeiling('CHAIN_MAX_TOKENS', raw, 'tokens');
}

/**
 * "A bot may not send more than 3 messages to the same bot within one
 * chain."
 *
 * Specified, not default, and D-047 is blunt about why: three messages to the
 * same bot per chain is "a PM that may speak to its developer three times,
 * ever". The COUNTER is the valuable part — a bot sending the same peer the
 * same thing in a loop is the signal this rule was built to catch — but as
 * something an operator reads and can bound rather than a shipped ceiling.
 */
export const SPECIFIED_MAX_REPEAT_SENDS = 3;

/** Off, like the other two. */
export const DEFAULT_MAX_REPEAT_SENDS = 0;

/** `CHAIN_MAX_REPEAT_SENDS` — messages from one bot to one peer, per chain. */
export function readMaxRepeatSends(raw: string | undefined): number {
  return readChainCeiling('CHAIN_MAX_REPEAT_SENDS', raw, 'messages');
}

/** Every chain ceiling this deployment runs under, resolved once. */
export type ChainLimits = {
  /** 0 means a chain is never stopped for being long. */
  readonly maxHops: number;
  /** 0 means a chain is never stopped for being expensive. */
  readonly maxTokens: number;
  /** 0 means one bot may message another as often as the chain allows. */
  readonly maxRepeatSends: number;
};

export function readChainLimits(env: NodeJS.ProcessEnv = process.env): ChainLimits {
  return {
    maxHops: readMaxHops(env['CHAIN_MAX_HOPS']),
    maxTokens: readMaxChainTokens(env['CHAIN_MAX_TOKENS']),
    maxRepeatSends: readMaxRepeatSends(env['CHAIN_MAX_REPEAT_SENDS']),
  };
}

/**
 * The DI token the resolved limits are provided under.
 *
 * Injected rather than read from `process.env` in each constructor, and the
 * difference is testability in the exact case that matters: D-047 ships every
 * ceiling OFF, so a suite proving that a limit FIRES has to configure one.
 * With an environment read per constructor that means mutating `process.env`
 * before a Nest context is built and hoping nothing else in the run reads it
 * first — which is a shared-state test, and the shared state is global.
 *
 * The factory still runs at module init, so a malformed value still fails at
 * boot rather than at the first delivery.
 */
export const CHAIN_LIMITS = 'CHAIN_LIMITS';
