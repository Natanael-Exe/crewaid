import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_CHAIN_TOKENS,
  DEFAULT_MAX_HOPS,
  SPECIFIED_MAX_CHAIN_TOKENS,
  SPECIFIED_MAX_HOPS,
  DEFAULT_MAX_REPEAT_SENDS,
  SPECIFIED_MAX_REPEAT_SENDS,
  readChainLimits,
  readMaxChainTokens,
  readMaxHops,
  readMaxRepeatSends,
} from '../src/interbot/chain.config.js';
import {
  botGoneNotice,
  deliveryFailedNotice,
  deliveryReceiptNotice,
  hopLimitNotice,
  isWithinHopLimit,
  isWithinRepeatCap,
  isWithinTokenBudget,
  repeatCapNotice,
  tokenBudgetNotice,
} from '../src/interbot/chain.js';

/**
 * M7-BE-02 — §6/M7's loop limits as D-047 leaves them.
 *
 * The cases are about the two ways this can be wrong in a way nothing else
 * notices: a default that refuses work the operator asked for, and a `0` read
 * as a ceiling of zero rather than as no ceiling. The second would ship a
 * product that cannot deliver one message, and it would do it with every test
 * that configures a limit still passing.
 */

describe('M7-BE-02 CHAIN_MAX_HOPS', () => {
  it('is off unless set, and §6/M7s number is written down but not applied', () => {
    expect(readMaxHops(undefined)).toBe(DEFAULT_MAX_HOPS);
    expect(readMaxHops('')).toBe(DEFAULT_MAX_HOPS);
    expect(DEFAULT_MAX_HOPS).toBe(0);
    // Kept as the value an operator who wants §6/M7's behaviour copies, and
    // the value the acceptance-criterion test sets (D-047).
    expect(SPECIFIED_MAX_HOPS).toBe(10);
  });

  it('takes a ceiling an operator sets', () => {
    expect(readMaxHops('10')).toBe(10);
    expect(readMaxHops('1')).toBe(1);
    expect(readChainLimits({ CHAIN_MAX_HOPS: '6' })).toEqual({
      maxHops: 6,
      maxTokens: 0,
      maxRepeatSends: 0,
    });
    expect(readChainLimits({})).toEqual({ maxHops: 0, maxTokens: 0, maxRepeatSends: 0 });
  });

  it('refuses a value that would look configured and never fire', () => {
    // The whole reason this parses at boot: `Number('ten')` is NaN, and NaN
    // compares false against every hop count there will ever be.
    for (const bad of ['ten', '1.5', '-1', 'Infinity']) {
      expect(() => readMaxHops(bad), bad).toThrow(/CHAIN_MAX_HOPS/);
    }
  });
});

describe('M7-BE-02 what the ceiling means', () => {
  it('treats 0 as no ceiling rather than as a ceiling of zero', () => {
    expect(isWithinHopLimit({ chainId: 'c', hopCount: 1 }, 0)).toBe(true);
    expect(isWithinHopLimit({ chainId: 'c', hopCount: 10_000 }, 0)).toBe(true);
  });

  it('allows the hop that reaches the limit and refuses the one past it', () => {
    expect(isWithinHopLimit({ chainId: 'c', hopCount: 9 }, 10)).toBe(true);
    // §6/M7: "at MAX_HOPS … delivery is dropped" — the tenth hop is the last
    // one delivered, and the eleventh is the one the chain stops on.
    expect(isWithinHopLimit({ chainId: 'c', hopCount: 10 }, 10)).toBe(true);
    expect(isWithinHopLimit({ chainId: 'c', hopCount: 11 }, 10)).toBe(false);
  });

  it('names the key in the notice, because its reader is who can change it', () => {
    const notice = hopLimitNotice(10);
    expect(notice).toContain('CHAIN_MAX_HOPS');
    expect(notice).toContain('10');
  });
});

describe('M7-BE-03 CHAIN_MAX_TOKENS', () => {
  it('is off unless set, with §6/M7s number written down but not applied', () => {
    expect(readMaxChainTokens(undefined)).toBe(DEFAULT_MAX_CHAIN_TOKENS);
    expect(DEFAULT_MAX_CHAIN_TOKENS).toBe(0);
    expect(SPECIFIED_MAX_CHAIN_TOKENS).toBe(200_000);
    expect(readChainLimits({ CHAIN_MAX_TOKENS: '200000' })).toEqual({
      maxHops: 0,
      maxTokens: 200_000,
      maxRepeatSends: 0,
    });
  });

  it('refuses a value that would look configured and never fire', () => {
    for (const bad of ['lots', '-5', '1e5.5']) {
      expect(() => readMaxChainTokens(bad), bad).toThrow(/CHAIN_MAX_TOKENS/);
    }
  });

  it('treats 0 as no budget rather than as a budget of zero', () => {
    expect(isWithinTokenBudget(10_000_000, 0)).toBe(true);
    expect(isWithinTokenBudget(999, 1_000)).toBe(true);
    // Spending the budget exactly ends it: the next hop would go over.
    expect(isWithinTokenBudget(1_000, 1_000)).toBe(false);
  });

  it('reports what was spent, not only what was allowed', () => {
    const notice = tokenBudgetNotice(201_234, 200_000);
    expect(notice).toContain('201,234');
    expect(notice).toContain('200,000');
    expect(notice).toContain('CHAIN_MAX_TOKENS');
  });
});

describe('M7-BE-04 CHAIN_MAX_REPEAT_SENDS', () => {
  it('is off unless set, with §6/M7s number written down but not applied', () => {
    expect(readMaxRepeatSends(undefined)).toBe(DEFAULT_MAX_REPEAT_SENDS);
    expect(DEFAULT_MAX_REPEAT_SENDS).toBe(0);
    expect(SPECIFIED_MAX_REPEAT_SENDS).toBe(3);
    expect(readChainLimits({ CHAIN_MAX_REPEAT_SENDS: '3' })).toEqual({
      maxHops: 0,
      maxTokens: 0,
      maxRepeatSends: 3,
    });
  });

  it('refuses a value that would look configured and never fire', () => {
    for (const bad of ['three', '-1', '2.5']) {
      expect(() => readMaxRepeatSends(bad), bad).toThrow(/CHAIN_MAX_REPEAT_SENDS/);
    }
  });

  it('allows the message that REACHES the cap and refuses the one past it', () => {
    // §6/M7: "may not send more than 3". Off by one here and a cap of 3
    // silently means 2, which nothing else in the system would contradict.
    expect(isWithinRepeatCap(2, 3)).toBe(true);
    expect(isWithinRepeatCap(3, 3)).toBe(false);
    expect(isWithinRepeatCap(9_999, 0)).toBe(true);
  });

  it('names the peer in the notice, because the chain itself may be fine', () => {
    const notice = repeatCapNotice('Quill', 3);
    expect(notice).toContain('Quill');
    expect(notice).toContain('CHAIN_MAX_REPEAT_SENDS');
    expect(repeatCapNotice('Quill', 1)).toContain('1 message to');
  });
});

describe('M7-BE-05 when a participant is deleted', () => {
  it('names the bot that is gone, from the name the sender addressed', () => {
    // The row it would otherwise be read from is exactly the row that no
    // longer exists, which is why the job carries the name.
    const notice = botGoneNotice('Quill');
    expect(notice).toContain('Quill');
    expect(notice).toContain('no longer on this team');
    // And says the waiting is over, because the sender's whole problem is
    // that it is holding a plan whose next step cannot happen.
    expect(notice).toContain('Nothing is waiting on them');
  });
});

describe('the receipt and the failure notice, the two endings a sender reads', () => {
  it('says a delivered message arrived, in one line', () => {
    // Measured absence, not a nicety: before this sentence the last thing a
    // sender's transcript ever said about its own send was "queued", so a
    // delivery and a vanished one looked identical from the only place the
    // operator reads.
    const notice = deliveryReceiptNotice('Quill');
    expect(notice).toContain('Quill');
    expect(notice).toContain('was delivered');
    expect(notice.split('\n')).toHaveLength(1);
  });

  it('names the receiver and the cause when a delivery died, and says to resend', () => {
    const notice = deliveryFailedNotice('Quill', 'Connection terminated unexpectedly');
    expect(notice).toContain('Quill');
    expect(notice).toContain('could not be delivered');
    expect(notice).toContain('Connection terminated unexpectedly');
    // The sender is the one bot that can act on this.
    expect(notice).toContain('Send it again');
  });

  it('flattens a multi-line database error into one readable line', () => {
    // A Prisma failure arrives as a paragraph; a transcript row is a sentence.
    const notice = deliveryFailedNotice('Quill', 'P2002\n\nUnique constraint\n  failed');
    expect(notice).not.toContain('\n\n');
    expect(notice).toContain('P2002 Unique constraint failed');
  });

  it('bounds a pathological cause rather than writing it whole', () => {
    const notice = deliveryFailedNotice('Quill', 'x'.repeat(5_000));
    expect(notice.length).toBeLessThan(400);
  });
});
