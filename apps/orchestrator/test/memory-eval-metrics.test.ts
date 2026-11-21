import { describe, expect, it } from 'vitest';

import { LAYER_1, SCENARIOS, type EvalMemory, type EvalScenario } from './memory-eval-corpus.js';
import {
  explain,
  precisionAtK,
  recallAtK,
  renderEntry,
  renderedChars,
  reportSelection,
} from './memory-eval-metrics.js';

/**
 * The corpus is the specification, so it gets checked like one. A scenario
 * that requires an id its own seed does not contain is not a hard expectation
 * — it is one that can never be met, and it would read as an implementation
 * bug the first time a selector ran against it.
 */
describe('corpus integrity', () => {
  it('names only ids that exist in its own seed', () => {
    for (const scenario of SCENARIOS) {
      const seeded = new Set(scenario.seed.map((m) => m.id));
      const named = [
        ...(scenario.expect.required ?? []),
        ...(scenario.expect.forbidden ?? []),
        ...(scenario.expect.junk ?? []),
      ];
      expect(
        named.filter((id) => !seeded.has(id)),
        `${scenario.id} names absent ids`,
      ).toEqual([]);
    }
  });

  it('gives every row in a scenario a distinct id', () => {
    for (const scenario of SCENARIOS) {
      const ids = scenario.seed.map((m) => m.id);
      expect(new Set(ids).size, `${scenario.id} has duplicate ids`).toBe(ids.length);
    }
  });

  it('never both requires and forbids the same row', () => {
    for (const scenario of SCENARIOS) {
      const forbidden = new Set(scenario.expect.forbidden ?? []);
      const contradictory = (scenario.expect.required ?? []).filter((id) => forbidden.has(id));
      expect(contradictory, `${scenario.id} contradicts itself`).toEqual([]);
    }
  });

  it('asks for something that fits the budget it sets', () => {
    // A scenario whose required rows cannot fit is unsatisfiable, and would
    // fail forever while looking like a selector defect.
    for (const scenario of SCENARIOS) {
      const required = requiredRows(scenario);
      expect(
        renderedChars(required),
        `${scenario.id} requires more than its own budget allows`,
      ).toBeLessThanOrEqual(scenario.budgetChars);
    }
  });

  it('keeps every layer-1 scenario decidable without a model or a database', () => {
    // Layer 1 is what runs in CI. A scenario that needs a real turn belongs in
    // layer 2 or it will be quietly skipped and stop guarding anything.
    for (const scenario of LAYER_1) {
      expect(scenario.expect.required ?? scenario.expect.forbidden, scenario.id).toBeDefined();
    }
  });
});

function requiredRows(scenario: EvalScenario): EvalMemory[] {
  const byId = new Map(scenario.seed.map((m) => [m.id, m]));
  return (scenario.expect.required ?? []).flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}

function rowOf(scenario: EvalScenario, id: string): EvalMemory {
  const row = scenario.seed.find((m) => m.id === id);
  if (row === undefined) throw new Error(`${scenario.id} has no row ${id}`);
  return row;
}

describe('reportSelection', () => {
  it('passes the reference selection for every layer-1 scenario', () => {
    for (const scenario of LAYER_1) {
      const report = reportSelection(scenario, requiredRows(scenario));
      expect(report.passed, explain(report)).toBe(true);
    }
  });

  /**
   * Everything below deliberately breaks a passing selection one way at a
   * time. A metric that cannot be shown failing is not a measurement — it is a
   * function that returns true, and this corpus exists precisely to stop a
   * selector from being graded by one of those.
   */
  describe('fails when it should', () => {
    const scenario = LAYER_1.find((s) => s.id === 'scope-leak')!;

    it('reports a required row that was not selected', () => {
      const short = requiredRows(scenario).filter((m) => m.id !== 'global');
      const report = reportSelection(scenario, short);
      expect(report.passed).toBe(false);
      expect(report.missingRequired).toEqual(['global']);
      expect(explain(report)).toContain('missing global');
    });

    it('reports a forbidden row that was selected', () => {
      const leaked = [...requiredRows(scenario), rowOf(scenario, 'sibling')];
      const report = reportSelection(scenario, leaked);
      expect(report.passed).toBe(false);
      expect(report.presentForbidden).toEqual(['sibling']);
    });

    it('reports another user’s row as forbidden — the R7 case', () => {
      const leaked = [...requiredRows(scenario), rowOf(scenario, 'stranger')];
      const report = reportSelection(scenario, leaked);
      expect(report.passed).toBe(false);
      expect(report.presentForbidden).toEqual(['stranger']);
    });

    it('reports a fact that arrived shortened', () => {
      const [first, ...rest] = requiredRows(scenario);
      const half = [{ ...first!, text: first!.text.slice(0, 10) }, ...rest];
      const report = reportSelection(scenario, half);
      expect(report.passed).toBe(false);
      expect(report.truncated).toEqual([first!.id]);
      expect(explain(report)).toContain('half-included');
    });

    it('reports a row that is not in the seed at all', () => {
      const invented: EvalMemory = {
        id: 'invented',
        owner: 'user',
        kind: 'FACT',
        source: 'TOLD',
        status: 'ACTIVE',
        text: 'Something nobody seeded.',
        confirmations: 1,
        ageDays: 1,
      };
      const report = reportSelection(scenario, [...requiredRows(scenario), invented]);
      expect(report.passed).toBe(false);
      expect(report.unknown).toEqual(['invented']);
    });

    it('reports a selection that overruns the budget', () => {
      const tight = LAYER_1.find((s) => s.id === 'authority-beats-confirmations')!;
      const both = [rowOf(tight, 'stated'), rowOf(tight, 'guessed')];
      const report = reportSelection(tight, both);
      expect(report.passed).toBe(false);
      expect(report.withinBudget).toBe(false);
      expect(explain(report)).toContain('over budget');
    });
  });

  it('measures the junk ratio without failing on it', () => {
    const junky = LAYER_1.find((s) => s.id === 'junk-resistance')!;
    const withNoise = [...requiredRows(junky), rowOf(junky, 'noise-0')];
    const report = reportSelection(junky, withNoise);

    // Junk is reported, never asserted: the corpus records a human's opinion
    // that a row is worthless, and a build should not go red because a
    // selector disagreed. It goes in the evidence table so a change in the
    // number is visible.
    expect(report.junkSelected).toEqual(['noise-0']);
    expect(report.junkRatio).toBeCloseTo(1 / 4);
    expect(report.passed).toBe(true);
  });

  it('calls an empty selection junk-free rather than dividing by zero', () => {
    const junky = LAYER_1.find((s) => s.id === 'junk-resistance')!;
    expect(reportSelection(junky, []).junkRatio).toBe(0);
  });
});

describe('rendering', () => {
  it('renders one row per line, with nothing that varies between turns', () => {
    const line = renderEntry({ text: 'Deploys run from the repo root.' });
    expect(line).toBe('- Deploys run from the repo root.\n');
  });

  it('counts exactly what it renders', () => {
    const scenario = LAYER_1.find((s) => s.id === 'scope-leak')!;
    const rows = requiredRows(scenario);
    expect(renderedChars(rows)).toBe(rows.map(renderEntry).join('').length);
  });
});

describe('precision and recall', () => {
  it('scores a perfect result at 1', () => {
    expect(precisionAtK(['a', 'b'], ['a', 'b'], 2)).toBe(1);
    expect(recallAtK(['a', 'b'], ['a', 'b'], 2)).toBe(1);
  });

  it('separates precision from recall', () => {
    // Two returned, one relevant, and two relevant existed: half precise, half complete.
    expect(precisionAtK(['a', 'x'], ['a', 'b'], 2)).toBe(0.5);
    expect(recallAtK(['a', 'x'], ['a', 'b'], 2)).toBe(0.5);
  });

  it('does not credit a relevant result found past k', () => {
    expect(recallAtK(['x', 'y', 'a'], ['a'], 2)).toBe(0);
    expect(precisionAtK(['x', 'y', 'a'], ['a'], 2)).toBe(0);
  });

  it('calls recall complete when nothing was relevant', () => {
    // Otherwise a query with no right answer scores 0 and drags an average
    // down for behaving correctly.
    expect(recallAtK([], [], 8)).toBe(1);
  });

  it('scores an empty return at zero precision rather than NaN', () => {
    expect(precisionAtK([], ['a'], 8)).toBe(0);
  });
});
