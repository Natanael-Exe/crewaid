/**
 * Chain identity for inter-bot messages.
 *
 * "Every exchange carries a `chainId` and a `hopCount`." Both columns have
 * existed since M0-03 landed §3 whole; this is where they get their values.
 * Pure functions, separated from delivery, because the arithmetic is the part
 * M7-QA-01 asserts and the part a reader has to be able to check by eye.
 */

/**
 * Where a message sits in a chain.
 *
 * The pair travels together everywhere — a hop count without the chain it
 * counts within is meaningless, and every consumer (the budget in M7-BE-03,
 * the repeat-send cap in M7-BE-04, the operator reading a log) needs both.
 */
export type ChainPosition = {
  readonly chainId: string;
  readonly hopCount: number;
};

/**
 * The position a message DELIVERED by this turn occupies.
 *
 * The chain id is the id of the message that started it
 *
 * A chain that begins here is identified by the trigger that began it, rather
 * than by a freshly minted id. Three things follow, and the third is why:
 *
 * - It needs no new source of identity. There is no cuid generator in this
 * process — ids come from `@default(cuid())` — and `randomUUID()` would
 * put a second id format in a column every other value of which is a row
 * id.
 * - It is already unique, because it is already a primary key.
 * - It is traceable. An operator holding a `chainId` from a log line can
 * look the row up and read the message that set the whole thing off. A
 * random id answers "which chain" and nothing else.
 *
 * Two sends in one turn are one chain
 *
 * Because they share a trigger, a bot that messages two peers in one turn
 * produces two deliveries in the SAME chain. That is the reading loop
 * protection needs: §6/M7's budget is "across all participants", so a
 * delegation that fans out has to accumulate against one total rather than
 * splitting into independent chains that each start from zero.
 *
 * The hop count is the trigger's, plus one
 *
 * Uniform whether the trigger came from a person or from another bot: a USER
 * message sits at hop 0, so the first delivery is hop 1. §6/M7's "`hopCount`
 * increments per delivery" is exactly this and nothing more.
 */
export function nextHop(trigger: {
  readonly id: string;
  readonly chainId: string | null;
  readonly hopCount: number;
}): ChainPosition {
  return {
    chainId: trigger.chainId ?? trigger.id,
    hopCount: trigger.hopCount + 1,
  };
}

/**
 * Whether a delivery at this position is allowed to happen at all.
 *
 * `maxHops` of 0 is "no ceiling", not "refuse everything". That
 * reading is the one an operator assumes and the one every other optional
 * ceiling in this codebase already uses, and getting it backwards would turn
 * the shipped default into a product that cannot deliver a single message.
 *
 * Checked at DELIVERY as well as at send, because the two are separated by a
 * queue: a job enqueued while the chain was under the bound must not be
 * delivered after something else pushed it over. The send path checks too, so
 * that the model is told immediately rather than learning nothing at all.
 */
export function isWithinHopLimit(position: ChainPosition, maxHops: number): boolean {
  return maxHops === 0 || position.hopCount <= maxHops;
}

/**
 * What a chain's participants are told when it stops.
 *
 * §6/M7 posts "a system message to both bots", and D-047 keeps that when it
 * removes the shipped ceiling: "a chain that ends must still say why."
 *
 * It names the limit and the number, because the operator reading it is the
 * person who can change it, and the sentence is the only place the key
 * appears outside `.env.example`.
 */
export function hopLimitNotice(maxHops: number): string {
  return (
    `This conversation between bots stopped after ${maxHops} messages, the limit set by ` +
    `CHAIN_MAX_HOPS. Nothing further was delivered. Raise or unset that limit to allow ` +
    'longer exchanges.'
  );
}

/**
 * The token ceiling that actually binds this hop (M7-BE-03).
 *
 * ── WHY THIS IS NOT `bot.tokenBudget ?? chainLimit` ─────────────────────────
 *
 * Because an unset per-bot cap means uncapped only BEFORE inheritance. Read
 * the bot's own field and a bot that declares nothing is unbounded — so one
 * such bot in a chain is the hole the whole budget drains through, and the
 * chain limit an operator set stops meaning anything as soon as a single
 * participant has no opinion. Resolving the effective cap from the declared
 * and the inherited value at each hop is what closes that: an unset bot
 * inherits the chain's, and where both exist the smaller one binds, because
 * a ceiling is a promise about a maximum and the tighter promise is the one
 * that has to hold.
 *
 * `botLimit` is `undefined` at every call site today — §3 has no per-bot
 * token column and inventing one is §0 rule 2's territory. The parameter and
 * the rule are here because the rule is the part that is expensive to get
 * wrong later: the column arrives into a function that already knows what to
 * do with it, rather than into a `??` somebody writes in a hurry.
 */
export function effectiveTokenBudget(chainLimit: number, botLimit: number | undefined): number {
  const declared = botLimit ?? 0;
  if (chainLimit === 0) return declared;
  if (declared === 0) return chainLimit;
  return Math.min(chainLimit, declared);
}

/** Whether a chain that has spent `spent` tokens may take another hop. */
export function isWithinTokenBudget(spent: number, budget: number): boolean {
  return budget === 0 || spent < budget;
}

/**
 * §6/M7's acceptance criterion: a chain exhausting its budget "terminates and
 * reports ACTUAL tokens spent".
 *
 * The number spent, not the number remaining, and both of them rather than
 * just the ceiling: an operator deciding whether to raise `CHAIN_MAX_TOKENS`
 * needs to know how far past it the work actually was.
 */
export function tokenBudgetNotice(spent: number, budget: number): string {
  return (
    `This conversation between bots stopped after spending ${spent.toLocaleString('en-US')} ` +
    `tokens, against the ${budget.toLocaleString('en-US')} allowed by CHAIN_MAX_TOKENS. ` +
    'Nothing further was delivered. Raise or unset that limit to allow more work per chain.'
  );
}

/**
 * Whether one bot may message a particular peer again in this chain.
 *
 * `alreadySent` is how many have already arrived, so the comparison is `<`:
 * with a cap of 3 the fourth is the one refused, which is §6/M7's "may not
 * send MORE THAN 3".
 */
export function isWithinRepeatCap(alreadySent: number, cap: number): boolean {
  return cap === 0 || alreadySent < cap;
}

/**
 * What a chain says when one bot has been talking to the same peer too often.
 *
 * Names the peer, because unlike the other two ceilings this one is about a
 * PAIR: the chain may have plenty of hops and plenty of budget left, and the
 * operator reading this needs to know which conversation inside it stopped.
 */
export function repeatCapNotice(peerName: string, cap: number): string {
  return (
    `This bot has already sent ${cap} message${cap === 1 ? '' : 's'} to ${peerName} in this ` +
    'chain, the limit set by CHAIN_MAX_REPEAT_SENDS, so nothing further was delivered to them. ' +
    'Raise or unset that limit to allow a longer back-and-forth with one bot.'
  );
}

/**
 * What the surviving bot is told when the one it messaged is gone
 * (M7-BE-05).
 *
 * §6/M7 wants a chain whose participant is deleted to "terminate cleanly
 * rather than dead-lettering forever", and D-047 keeps clean termination on
 * its list of what does not change. Clean is not the same as silent: the
 * sender is sitting on a delegation it believes was accepted, and without
 * this it waits for a reply that can never arrive — which is a hang the
 * operator diagnoses by reading logs.
 *
 * Only the sender ever reads this. If the SENDER is the one deleted, the
 * intended recipient never knew a message existed, and a note in its
 * transcript would be the first it heard of a conversation that never
 * happened.
 */
export function botGoneNotice(peerName: string): string {
  return (
    `${peerName} is no longer on this team, so the message sent to them was not delivered ` +
    'and this exchange has ended. Nothing is waiting on them.'
  );
}

/**
 * The receipt a sender gets when its message actually arrived.
 *
 * "Queued" was the last true sentence the sender ever heard: between the
 * tool result and the receiving transcript sat a worker, a database and a
 * turn start, and nothing in any transcript said which side of them a message
 * ended on. Measured in the wild twice in one evening — once as a model that
 * wrote "Sent." without ever calling the tool, and once as an operator
 * concluding from the silence that delivery depends on the receiver being
 * awake. A one-line receipt is the observable fact both readings were
 * missing: it exists only when a delivery happened.
 */
export function deliveryReceiptNotice(receiverName: string): string {
  return `Your message to ${receiverName} was delivered to their conversation.`;
}

/**
 * What the sender is told when a delivery died on the machinery, after every
 * retry.
 *
 * The refusals above are correct endings and return from `deliver` as
 * outcomes. This one is different: the job THREW — a database that was away,
 * a conversation row that should exist and does not — and a thrown delivery
 * used to leave exactly one trace, a log line nobody reads, on a message the
 * sender still believes is in flight. The retry buys back the blip; this is
 * what the sender gets when even that ran out.
 */
export function deliveryFailedNotice(receiverName: string, detail: string): string {
  const cause = detail.replace(/\s+/g, ' ').slice(0, 240);
  return (
    `Your message to ${receiverName} could not be delivered (${cause}), so it never reached ` +
    'their conversation. Send it again, or do the work yourself.'
  );
}
