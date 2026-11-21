import { describe, expect, it } from 'vitest';

import {
  effectiveTokenBudget,
  isWithinHopLimit,
  isWithinRepeatCap,
  isWithinTokenBudget,
  nextHop,
  type ChainPosition,
} from '../src/interbot/chain.js';

/**
 * M7-QA-01 — independent verification of §6/M7's chain arithmetic.
 *
 * NOT a re-run of the M7-BE-02/03/04 cases. Those assert the functions at
 * hand-picked points, which is the right shape for a unit under development
 * and the wrong shape for verification: a function and a test written
 * together can share a misreading of the spec and agree with each other all
 * the way to production.
 *
 * So these drive a SIMULATED CHAIN — bots actually passing a message back and
 * forth — and check it against numbers derived from §6/M7's own sentences:
 *
 *   "hopCount increments per delivery"
 *   "at MAX_HOPS (default 10) delivery is dropped"
 *   "Each chainId carries a token budget … across all participants"
 *   "A bot may not send more than 3 messages to the same bot within one chain"
 *
 * The oracle for each is computed here, by counting, rather than taken from
 * the code under test.
 */

/** A trigger message, as the tool sees one. */
type Trigger = { id: string; chainId: string | null; hopCount: number };

/**
 * Walk a chain, letting each recipient reply to whoever wrote to them.
 *
 * Returns every delivery that was PERMITTED under `maxHops`, in order. The
 * loop bound is deliberately far past any cap under test: a limit that never
 * fires must show up as a run that hits the bound, not as a test that stops
 * counting at the right answer by construction.
 */
function walkChain(origin: Trigger, maxHops: number, attempts = 50): ChainPosition[] {
  const delivered: ChainPosition[] = [];
  let trigger = origin;
  for (let i = 0; i < attempts; i += 1) {
    const position = nextHop(trigger);
    if (!isWithinHopLimit(position, maxHops)) break;
    delivered.push(position);
    // The delivered message becomes the recipient's trigger, which is exactly
    // what the delivery service hands `startTurn`.
    trigger = { id: `msg_${i}`, chainId: position.chainId, hopCount: position.hopCount };
  }
  return delivered;
}

const USER_TRIGGER: Trigger = { id: 'msg_root', chainId: null, hopCount: 0 };

describe('M7-QA-01 hop accounting', () => {
  it('numbers deliveries 1,2,3,… and never renumbers the chain', () => {
    const delivered = walkChain(USER_TRIGGER, 10);

    // "hopCount increments per delivery": the nth delivery is hop n. Derived
    // by counting the deliveries, not by reading the counter back.
    expect(delivered.map((position) => position.hopCount)).toEqual(
      delivered.map((_, index) => index + 1),
    );
    // One chain throughout, identified by the message that began it.
    expect(new Set(delivered.map((position) => position.chainId))).toEqual(new Set(['msg_root']));
  });

  it('permits exactly MAX_HOPS deliveries, at every cap', () => {
    // §6/M7: "at MAX_HOPS … delivery is dropped". The oracle is the cap
    // itself — a chain capped at n delivers n messages and then stops — and
    // it is checked across the range rather than at one point, because an
    // off-by-one is invisible at whichever point a test happens to pick.
    for (const cap of [1, 2, 3, 5, 10, 25]) {
      expect(walkChain(USER_TRIGGER, cap), `cap ${cap}`).toHaveLength(cap);
    }
  });

  it('never stops a chain when no cap is set, which is what 0 means', () => {
    // D-047's shipped default. Read as a cap of zero this returns nothing,
    // and the product delivers no message at all.
    expect(walkChain(USER_TRIGGER, 0, 40)).toHaveLength(40);
  });

  it('carries on counting from wherever a chain already was', () => {
    // A hop is the trigger's plus one whether the trigger came from a person
    // (hop 0) or from another bot. Verified by resuming mid-chain and
    // checking the numbering continues rather than restarting.
    const resumed = walkChain({ id: 'msg_x', chainId: 'chain_k', hopCount: 6 }, 10);

    expect(resumed.map((position) => position.hopCount)).toEqual([7, 8, 9, 10]);
    expect(resumed.every((position) => position.chainId === 'chain_k')).toBe(true);
  });

  it('keeps a fan-out in one chain, so a budget cannot be split to evade it', () => {
    // Two sends from ONE turn share a trigger. §6/M7's budget is "across all
    // participants", which is only meaningful if a bot cannot start a fresh
    // chain by messaging two peers instead of one.
    const first = nextHop(USER_TRIGGER);
    const second = nextHop(USER_TRIGGER);

    expect(first).toEqual(second);
  });
});

describe('M7-QA-01 token accounting', () => {
  /** What a chain has spent, summed the way `/usage` sums a turn. */
  function spend(
    turns: ReadonlyArray<{
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheCreationTokens: number;
    }>,
  ): number {
    return turns.reduce(
      (total, turn) =>
        total +
        turn.inputTokens +
        turn.outputTokens +
        turn.cachedInputTokens +
        turn.cacheCreationTokens,
      0,
    );
  }

  const TURNS = [
    { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 0, cacheCreationTokens: 0 },
    { inputTokens: 4_000, outputTokens: 800, cachedInputTokens: 500, cacheCreationTokens: 250 },
    { inputTokens: 9_000, outputTokens: 1_500, cachedInputTokens: 2_000, cacheCreationTokens: 0 },
  ];

  it('spends every counter D-009(3) records, not only fresh input', () => {
    // 1,200 + 5,550 + 12,500. Cached reads and cache writes are real tokens
    // an operator is billed for, so a budget that ignored them would let a
    // cache-heavy chain run indefinitely under a ceiling that looks enforced.
    expect(spend(TURNS)).toBe(19_250);
  });

  it('stops the chain on the turn that crosses the line, not the one after', () => {
    // Walked, not asserted at a point: spend turn by turn and record where a
    // 6,000-token budget first refuses.
    let running = 0;
    const refusedAfter: number[] = [];
    for (const [index, turn] of TURNS.entries()) {
      if (!isWithinTokenBudget(running, 6_000)) {
        refusedAfter.push(index);
        break;
      }
      running += spend([turn]);
    }

    // 1,200 then 6,750 — the third turn is the first one refused.
    expect(refusedAfter).toEqual([2]);
  });

  it('treats a budget of 0 as no budget, at any spend', () => {
    expect(isWithinTokenBudget(spend(TURNS) * 1_000, 0)).toBe(true);
  });

  it('spends exactly up to the budget and no further', () => {
    for (const budget of [1, 10, 1_000]) {
      expect(isWithinTokenBudget(budget - 1, budget), `${budget} - 1`).toBe(true);
      expect(isWithinTokenBudget(budget, budget), `${budget}`).toBe(false);
    }
  });
});

describe('M7-QA-01 which budget binds', () => {
  it('matches the table D-047s inheritance rule implies', () => {
    // chain, bot, expected — every combination of unset/looser/tighter.
    const table: Array<[number, number | undefined, number]> = [
      [0, undefined, 0],
      [0, 0, 0],
      [0, 25_000, 25_000],
      [200_000, undefined, 200_000],
      [200_000, 0, 200_000],
      [200_000, 50_000, 50_000],
      [50_000, 200_000, 50_000],
      [50_000, 50_000, 50_000],
    ];

    for (const [chain, bot, expected] of table) {
      expect(effectiveTokenBudget(chain, bot), `chain ${chain}, bot ${bot}`).toBe(expected);
    }
  });

  it('never lets a bot without an opinion escape the chains ceiling', () => {
    // The failure D-047 names: "a single uncapped bot becomes the hole that
    // drains the chain". Stated as a property over the whole table rather
    // than as one case, because the hole is whichever row nobody wrote.
    for (const chain of [1, 1_000, 200_000]) {
      for (const bot of [undefined, 0]) {
        expect(effectiveTokenBudget(chain, bot), `chain ${chain}, bot ${bot}`).toBe(chain);
      }
    }
  });
});

describe('M7-QA-01 the per-pair cap', () => {
  it('permits exactly `cap` messages from one bot to one peer', () => {
    for (const cap of [1, 2, 3, 7]) {
      let sent = 0;
      while (isWithinRepeatCap(sent, cap) && sent < 100) sent += 1;
      // The oracle is §6/M7's sentence: "may not send more than 3" means the
      // third lands and the fourth does not.
      expect(sent, `cap ${cap}`).toBe(cap);
    }
  });

  it('is unbounded at 0, like every other ceiling D-047 turned off', () => {
    expect(isWithinRepeatCap(10_000, 0)).toBe(true);
  });
});
