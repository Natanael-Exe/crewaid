/**
 * CC-27 — the measurements, kept separate from the corpus that feeds them.
 *
 * Pure functions over plain objects: no database, no model, no network, no
 * clock. That is what lets layer 1 run on every change in CI, and it is what
 * makes a scoring change reviewable as a diff of which facts moved in and out
 * rather than as an argument about whether the memory "feels" better.
 *
 * ── THE RENDERING IS DEFINED HERE, ON PURPOSE ───────────────────────────────
 *
 * A character budget is meaningless until something says how a row becomes
 * characters. That belongs with the measurement rather than with the renderer,
 * because the alternative is a budget the renderer can satisfy by changing its
 * own formatting — the bound would move whenever the prose did. So CC-32's
 * renderer is written to match `renderEntry`, and a deliberate change to the
 * block's shape is a change to this function and shows up as one.
 */

import type { EvalMemory, EvalScenario } from './memory-eval-corpus.js';

/**
 * One row, one line. Deterministic and free of anything that varies between
 * two turns where memory did not change — no timestamps, no counts, no ids —
 * because a block that re-renders differently every turn invalidates the
 * provider's prefix cache for everything after it.
 */
export function renderEntry(memory: Pick<EvalMemory, 'text'>): string {
  // Mirrors memory-select.ts, INCLUDING the delimiter neutralisation (CC-35).
  // If the two disagree, a fact containing the closing tag costs a different
  // number of characters in production than the corpus budgeted for it, and
  // the budget case would pass while the real block overran.
  return `- ${memory.text.replace(/<(\/?)memory>/gi, '[$1memory]')}\n`;
}

export function renderBlock(memories: readonly EvalMemory[]): string {
  return memories.map(renderEntry).join('');
}

export function renderedChars(memories: readonly EvalMemory[]): number {
  return renderBlock(memories).length;
}

export interface SelectionReport {
  readonly scenarioId: string;
  readonly selectedIds: readonly string[];
  readonly chars: number;
  readonly budgetChars: number;
  readonly withinBudget: boolean;
  /** Required by the scenario and not selected. */
  readonly missingRequired: readonly string[];
  /** Forbidden by the scenario and selected anyway. */
  readonly presentForbidden: readonly string[];
  /** Selected with text that does not match the seed row — a half-included fact. */
  readonly truncated: readonly string[];
  /** Selected but not present in the seed at all. */
  readonly unknown: readonly string[];
  readonly junkSelected: readonly string[];
  /** Selected rows a human labelled worthless, over rows selected. Measured, not asserted. */
  readonly junkRatio: number;
  readonly passed: boolean;
}

/**
 * Scores one selection against one scenario.
 *
 * Takes the selected ROWS rather than their ids, so a fact that arrived
 * shortened can be caught. Half a fact is not a shorter fact — "deploys run
 * from the repo" inverts nothing and means nothing, and a budget met by
 * trimming mid-sentence is worse than one met by dropping the row.
 */
export function reportSelection(
  scenario: EvalScenario,
  selected: readonly EvalMemory[],
): SelectionReport {
  const seedById = new Map(scenario.seed.map((m) => [m.id, m]));
  const selectedIds = selected.map((m) => m.id);
  const chosen = new Set(selectedIds);

  const unknown = selectedIds.filter((id) => !seedById.has(id));
  const truncated = selected
    .filter((m) => {
      const seeded = seedById.get(m.id);
      return seeded !== undefined && seeded.text !== m.text;
    })
    .map((m) => m.id);

  const missingRequired = (scenario.expect.required ?? []).filter((id) => !chosen.has(id));
  const presentForbidden = (scenario.expect.forbidden ?? []).filter((id) => chosen.has(id));
  const junkSelected = (scenario.expect.junk ?? []).filter((id) => chosen.has(id));

  const chars = renderedChars(selected);
  const withinBudget = chars <= scenario.budgetChars;

  return {
    scenarioId: scenario.id,
    selectedIds,
    chars,
    budgetChars: scenario.budgetChars,
    withinBudget,
    missingRequired,
    presentForbidden,
    truncated,
    unknown,
    junkSelected,
    junkRatio: selectedIds.length === 0 ? 0 : junkSelected.length / selectedIds.length,
    passed:
      withinBudget &&
      missingRequired.length === 0 &&
      presentForbidden.length === 0 &&
      truncated.length === 0 &&
      unknown.length === 0,
  };
}

/**
 * Why a report failed, as one line fit for an assertion message. A bare
 * `expect(report.passed).toBe(true)` tells whoever broke it nothing, and this
 * corpus is precisely where "it went red" is not enough information.
 */
export function explain(report: SelectionReport): string {
  if (report.passed) return `${report.scenarioId}: passed`;
  const faults: string[] = [];
  if (!report.withinBudget)
    faults.push(`over budget (${report.chars}/${report.budgetChars} chars)`);
  if (report.missingRequired.length > 0)
    faults.push(`missing ${report.missingRequired.join(', ')}`);
  if (report.presentForbidden.length > 0)
    faults.push(`must not include ${report.presentForbidden.join(', ')}`);
  if (report.truncated.length > 0) faults.push(`half-included ${report.truncated.join(', ')}`);
  if (report.unknown.length > 0) faults.push(`not in the seed: ${report.unknown.join(', ')}`);
  return `${report.scenarioId}: ${faults.join('; ')}`;
}

/** Of the first k returned, the share that are relevant. */
export function precisionAtK(
  returned: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (k <= 0) return 0;
  const head = returned.slice(0, k);
  if (head.length === 0) return 0;
  const wanted = new Set(relevant);
  return head.filter((id) => wanted.has(id)).length / head.length;
}

/** Of everything relevant, the share found in the first k. */
export function recallAtK(
  returned: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (relevant.length === 0) return 1;
  if (k <= 0) return 0;
  const head = new Set(returned.slice(0, k));
  return relevant.filter((id) => head.has(id)).length / relevant.length;
}
