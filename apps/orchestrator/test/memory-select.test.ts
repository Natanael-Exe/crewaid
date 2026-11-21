import { describe, expect, it } from 'vitest';

import { LAYER_1, type EvalMemory, type EvalScenario } from './memory-eval-corpus.js';
import { explain, reportSelection } from './memory-eval-metrics.js';
import {
  compareForInjection,
  renderBlock,
  renderEntry,
  selectForInjection,
  type SelectableMemory,
} from '../src/memory/memory-select.js';

const THIS_BOT = 'bot_this';
const OTHER_BOT = 'bot_other';
const NOW = new Date('2026-09-16T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function toSelectable(row: EvalMemory): SelectableMemory {
  const botId = row.owner === 'this-bot' ? THIS_BOT : row.owner === 'other-bot' ? OTHER_BOT : null;
  return {
    id: row.id,
    botId,
    kind: row.kind,
    source: row.source,
    status: row.status,
    text: row.text,
    confirmations: row.confirmations,
    createdAt: new Date(NOW.getTime() - row.ageDays * DAY_MS),
    lastUsedAt: null,
    expiresAt: null,
  };
}

/**
 * What the QUERY hands the selector.
 *
 * `other-user` rows are dropped here rather than being passed in and expected
 * to be filtered, because that is where they are actually stopped: R7 scopes
 * by `userId` in the WHERE clause, and a selector that re-checked ownership
 * would be a post-filter hiding a missing scope rather than a second guard.
 * The claim that another user's memory never arrives is asserted against a
 * real database in memory.service.integration.test.ts, where it can fail.
 *
 * `other-bot` rows ARE passed in, because excluding them is the selector's
 * job and the corpus should be able to catch it not doing it.
 */
function visibleToSelector(scenario: EvalScenario): SelectableMemory[] {
  return scenario.seed.filter((r) => r.owner !== 'other-user').map(toSelectable);
}

describe('CC-30 selectForInjection against the CC-27 corpus', () => {
  for (const scenario of LAYER_1) {
    it(`${scenario.id}: ${scenario.proves.split('.')[0]}`, () => {
      const { selected } = selectForInjection(visibleToSelector(scenario), {
        botId: THIS_BOT,
        budgetChars: scenario.budgetChars,
        now: NOW,
      });

      // The corpus scores the selection; the metric names what went wrong.
      const asEval = selected.map((m) => {
        const seeded = scenario.seed.find((s) => s.id === m.id);
        if (seeded === undefined) throw new Error(`selected ${m.id}, which is not in the seed`);
        return seeded;
      });
      const report = reportSelection(scenario, asEval);
      expect(report.passed, explain(report)).toBe(true);
    });
  }
});

describe('compareForInjection', () => {
  const base: SelectableMemory = {
    id: 'a',
    botId: null,
    kind: 'FACT',
    source: 'TOLD',
    status: 'ACTIVE',
    text: 'x',
    confirmations: 1,
    createdAt: NOW,
    lastUsedAt: null,
    expiresAt: null,
  };

  it("puts a bot's own memory before the user's global one", () => {
    const own = { ...base, id: 'own', botId: THIS_BOT };
    const global = { ...base, id: 'global', botId: null };
    expect([global, own].sort(compareForInjection).map((m) => m.id)).toEqual(['own', 'global']);
  });

  it('puts what the user said before what a model inferred, at any confirmation count', () => {
    // The ordering bug a naive `confirmations DESC` ships: a distillation
    // sweep re-confirms its own guesses every pass, so the guess would win.
    const told = { ...base, id: 'told', source: 'TOLD' as const, confirmations: 1 };
    const distilled = { ...base, id: 'distilled', source: 'DISTILLED' as const, confirmations: 99 };
    expect([distilled, told].sort(compareForInjection).map((m) => m.id)).toEqual([
      'told',
      'distilled',
    ]);
  });

  it('uses confirmations only to break a tie of equal authority', () => {
    const once = { ...base, id: 'once', confirmations: 1 };
    const often = { ...base, id: 'often', confirmations: 5 };
    expect([once, often].sort(compareForInjection).map((m) => m.id)).toEqual(['often', 'once']);
  });

  it('is a total order, so an unchanged memory renders identically', () => {
    // Two rows equal on every signal would otherwise sort by whatever order
    // the database returned them in, and the prompt prefix cache would miss
    // for a reason nobody could see.
    const x = { ...base, id: 'x' };
    const y = { ...base, id: 'y' };
    expect([x, y].sort(compareForInjection).map((m) => m.id)).toEqual(['x', 'y']);
    expect([y, x].sort(compareForInjection).map((m) => m.id)).toEqual(['x', 'y']);
  });
});

describe('selectForInjection bounds', () => {
  const row = (
    id: string,
    text: string,
    over: Partial<SelectableMemory> = {},
  ): SelectableMemory => ({
    id,
    botId: null,
    kind: 'FACT',
    source: 'TOLD',
    status: 'ACTIVE',
    text,
    confirmations: 1,
    createdAt: NOW,
    lastUsedAt: null,
    expiresAt: null,
    ...over,
  });

  const opts = { botId: THIS_BOT, budgetChars: 100, now: NOW };

  it('never half-includes a fact', () => {
    const long = row('long', 'x'.repeat(200));
    const { selected, droppedCount } = selectForInjection([long], opts);
    expect(selected).toEqual([]);
    expect(droppedCount).toBe(1);
  });

  it('does not let one oversized fact evict every shorter one behind it', () => {
    const big = row('big', 'x'.repeat(200), { confirmations: 99 });
    const small = row('small', 'fits');
    const { selected, droppedCount } = selectForInjection([big, small], opts);
    expect(selected.map((m) => m.id)).toEqual(['small']);
    expect(droppedCount).toBe(1);
  });

  it('counts exactly what it renders', () => {
    const rows = [row('a', 'one'), row('b', 'two')];
    const { selected } = selectForInjection(rows, opts);
    const rendered = selected.map(renderEntry).join('');
    expect(rendered.length).toBeLessThanOrEqual(opts.budgetChars);
  });

  it('injects nothing at a zero budget', () => {
    const { selected, droppedCount } = selectForInjection([row('a', 'one')], {
      ...opts,
      budgetChars: 0,
    });
    expect(selected).toEqual([]);
    expect(droppedCount).toBe(1);
  });

  it('drops an expired TASK_STATE and keeps an unexpired one', () => {
    const stale = row('stale', 'Migration written; validation remains.', {
      kind: 'TASK_STATE',
      expiresAt: new Date(NOW.getTime() - 1),
    });
    const live = row('live', 'Migration merged; index next.', {
      kind: 'TASK_STATE',
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
    const { selected } = selectForInjection([stale, live], opts);
    expect(selected.map((m) => m.id)).toEqual(['live']);
  });

  it("excludes another bot's private memory", () => {
    const mine = row('mine', 'Mine.', { botId: THIS_BOT });
    const theirs = row('theirs', 'Theirs.', { botId: OTHER_BOT });
    const { selected } = selectForInjection([mine, theirs], opts);
    expect(selected.map((m) => m.id)).toEqual(['mine']);
  });
});

describe('author attribution on shared facts', () => {
  const row = (
    id: string,
    text: string,
    over: Partial<SelectableMemory> = {},
  ): SelectableMemory => ({
    id,
    botId: null,
    kind: 'FACT',
    source: 'TOLD',
    status: 'ACTIVE',
    text,
    confirmations: 1,
    createdAt: NOW,
    lastUsedAt: null,
    expiresAt: null,
    ...over,
  });

  const NAMES = new Map([
    [THIS_BOT, 'Nathan'],
    [OTHER_BOT, 'Quill'],
  ]);

  it('prefixes a shared row with its author', () => {
    // The measured failure: an unattributed workspace fact about a report
    // Nathan built was presented by Exe as its own work. The name is what
    // lets a reader tell whose the work is.
    const line = renderEntry(
      row('a', 'The Kreova report lives at /home/bot/kreova-research.', {
        authorBotId: THIS_BOT,
      }),
      NAMES,
    );
    expect(line).toBe('- [from Nathan] The Kreova report lives at /home/bot/kreova-research.\n');
  });

  it('falls back to "a teammate" when the author bot is gone', () => {
    // A deleted author SetNulls nothing here — the row still names the id, but
    // the name lookup misses. An id rendered raw would leak nothing but reads
    // as noise; "a teammate" is the honest rendering.
    const line = renderEntry(row('a', 'A fact.', { authorBotId: 'bot_deleted' }), NAMES);
    expect(line).toBe('- [from a teammate] A fact.\n');
  });

  it('renders an unknown id as a teammate even with no names map', () => {
    const line = renderEntry(row('a', 'A fact.', { authorBotId: 'bot_x' }));
    expect(line).toBe('- [from a teammate] A fact.\n');
  });

  it('leaves a shared row without an author unattributed', () => {
    // The corpus's rows have no authorBotId at all — every existing fixture
    // must render byte-identically to before.
    expect(renderEntry(row('a', 'A fact.'), NAMES)).toBe('- A fact.\n');
  });

  it('never attributes a private row, even though it has an author', () => {
    // A private row's author IS its scope — "Yours alone" already says whose
    // it is, and "[from me]" on my own notes is noise.
    const line = renderEntry(
      row('a', 'My note.', { botId: THIS_BOT, authorBotId: THIS_BOT }),
      NAMES,
    );
    expect(line).toBe('- My note.\n');
  });

  it('prices the prefix into the selection budget', () => {
    // The prefix is rendered bytes; a selector that ignored it would admit
    // rows whose rendered form overruns the budget.
    const text = 'A claim about the work that is moderately long.';
    const priced = selectForInjection([row('a', text, { authorBotId: THIS_BOT })], {
      botId: THIS_BOT,
      budgetChars: renderEntry(row('a', text, { authorBotId: THIS_BOT }), NAMES).length - 1,
      now: NOW,
      authorNames: NAMES,
    });
    expect(priced.selected).toEqual([]);
    expect(priced.droppedCount).toBe(1);
  });

  it('renders the same block the selector priced', () => {
    const rows = [
      row('a', 'Alpha.', { authorBotId: THIS_BOT }),
      row('b', 'Beta.', { botId: THIS_BOT, authorBotId: THIS_BOT }),
    ];
    const budget = renderBlock(rows, NAMES).length;
    const { selected } = selectForInjection(rows, {
      botId: THIS_BOT,
      budgetChars: budget,
      now: NOW,
      authorNames: NAMES,
    });
    // Both rows fit the budget that priced them WITH their prefixes, so both
    // survive — in the selector's order (own before global), and rendering
    // byte-identically to the same rows passed straight to the renderer.
    expect(selected.map((m) => m.id)).toEqual(['b', 'a']);
    const sorted = [...rows].sort(compareForInjection);
    expect(renderBlock(selected, NAMES)).toBe(renderBlock(sorted, NAMES));
  });
});
