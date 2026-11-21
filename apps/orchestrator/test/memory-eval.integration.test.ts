import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryService } from '../src/memory/memory.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  renderBlock,
  selectForInjection,
  type SelectableMemory,
} from '../src/memory/memory-select.js';
import {
  LAYER_1,
  RETRIEVAL_CASES,
  RETRIEVAL_CORPUS,
  SCENARIOS,
  type EvalMemory,
} from './memory-eval-corpus.js';
import { precisionAtK, recallAtK, reportSelection } from './memory-eval-metrics.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'usr_crewaid_singleton_v1';
const RUN_ID = randomUUID().slice(0, 8);

/**
 * CC-37 — the runner, and the numbers.
 *
 * CC-27 wrote the corpus and the metrics with no subject; CC-30 gave them a
 * selector; this puts the two together against a REAL database and writes the
 * result somewhere a reviewer can read it.
 *
 * ── WHAT THIS CAN AND CANNOT MEASURE ────────────────────────────────────────
 *
 * Everything here runs without a model, deliberately, so it can run in CI on
 * every change. That bounds what it is allowed to claim:
 *
 *   MEASURABLE: which rows are selected, how many characters they render to,
 *   retrieval precision and recall against hand-labelled queries (real
 *   Postgres FTS, no model involved), junk ratio, scope violations.
 *
 *   NOT MEASURABLE HERE: whether a bot USES what it was given, and the real
 *   chars-per-token ratio. Both need a live provider. The report records them
 *   as UNMEASURED rather than estimating — a number nobody measured, printed
 *   beside numbers somebody did, is the most expensive kind of wrong in an
 *   evidence pack.
 */
const REPORT_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'reviews',
  'evidence',
  'cc-37',
);

interface ScenarioResult {
  id: string;
  layer: 1 | 2;
  passed: boolean;
  injectedFacts: number;
  injectedChars: number;
  budgetChars: number;
  junkRatio: number;
  detail: string;
}

const scenarioResults: ScenarioResult[] = [];
const retrievalResults: Array<{
  id: string;
  query: string;
  precision: number;
  recall: number;
  returned: string[];
  relevant: string[];
}> = [];

function toSelectable(row: EvalMemory, thisBot: string, otherBot: string): SelectableMemory {
  const botId = row.owner === 'this-bot' ? thisBot : row.owner === 'other-bot' ? otherBot : null;
  return {
    id: row.id,
    botId,
    kind: row.kind,
    source: row.source,
    status: row.status,
    text: row.text,
    confirmations: row.confirmations,
    createdAt: new Date(Date.now() - row.ageDays * 86_400_000),
    lastUsedAt: null,
    expiresAt: null,
  };
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')('CC-37 memory eval', () => {
  let prisma: PrismaService;
  let memories: MemoryService;
  let botId: string;
  let otherBotId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    memories = new MemoryService(prisma);
    const make = async (name: string): Promise<string> =>
      (
        await prisma.bot.create({
          data: {
            userId: OWNER,
            name: `${name}-${RUN_ID}`,
            role: 'eval',
            avatarColor: '#8B6F47',
            systemPrompt: '',
            modelId: 'default',
          },
        })
      ).id;
    botId = await make('cc37-subject');
    otherBotId = await make('cc37-sibling');
  });

  afterAll(async () => {
    await prisma.memory.deleteMany({ where: { userId: OWNER } });
    await prisma.bot.deleteMany({ where: { id: { in: [botId, otherBotId] } } });
    await prisma.$disconnect();
    writeReport();
  });

  describe('selection, scored against the corpus', () => {
    for (const scenario of LAYER_1) {
      it(scenario.id, () => {
        const visible = scenario.seed
          .filter((r) => r.owner !== 'other-user')
          .map((r) => toSelectable(r, botId, otherBotId));
        const { selected } = selectForInjection(visible, {
          botId,
          budgetChars: scenario.budgetChars,
          now: new Date(),
        });
        const asEval = selected.map((m) => {
          const seeded = scenario.seed.find((s) => s.id === m.id);
          if (seeded === undefined) throw new Error(`selected ${m.id}, not in the seed`);
          return seeded;
        });
        const report = reportSelection(scenario, asEval);

        scenarioResults.push({
          id: scenario.id,
          layer: scenario.layer,
          passed: report.passed,
          injectedFacts: report.selectedIds.length,
          injectedChars: report.chars,
          budgetChars: report.budgetChars,
          junkRatio: report.junkRatio,
          detail: scenario.proves.split('.')[0] ?? '',
        });

        expect(report.passed, JSON.stringify(report)).toBe(true);
      });
    }
  });

  describe('retrieval, against real Postgres full-text search', () => {
    beforeAll(async () => {
      await prisma.memory.createMany({
        data: RETRIEVAL_CORPUS.map((row) => ({
          id: `${row.id}-${RUN_ID}`,
          userId: OWNER,
          botId: null,
          kind: row.kind,
          source: row.source,
          status: row.status,
          text: row.text,
        })),
      });
    });

    for (const testCase of RETRIEVAL_CASES) {
      it(`${testCase.id}: ${testCase.query}`, async () => {
        const hits = await memories.search(OWNER, botId, testCase.query, 8);
        const returned = hits
          .map((h) => h.id.replace(`-${RUN_ID}`, ''))
          .filter((id) => RETRIEVAL_CORPUS.some((r) => r.id === id));
        const relevant = [...testCase.relevant];

        retrievalResults.push({
          id: testCase.id,
          query: testCase.query,
          precision: precisionAtK(returned, relevant, 8),
          recall: recallAtK(returned, relevant, 8),
          returned,
          relevant,
        });

        // MEASURED, not asserted, except where a miss would mean the search
        // is not working at all.
        //
        // Two cases are EXPECTED to miss and are recorded rather than
        // enforced, because those gaps are the evidence for a decision that
        // has not been taken yet — whether to add a vector index — and
        // asserting them away would delete the reason to take it:
        //
        //   paraphrase-hard        no shared stem with the answer
        //   two-words-one-absent   websearch_to_tsquery ANDs its terms, so
        //                          one absent word returns nothing at all
        //
        // Everything else must find something. A miss there means stemming or
        // the index is not working, which is a defect rather than a limit.
        // CC-39 closed both of the expected misses: the ANY fallback finds
        // Every answerable query must return at least one relevant result
        // (regression guard over the earlier P 0.60 / R 0.60 baseline).
        if (relevant.length > 0) {
          expect(returned, `${testCase.id} found nothing relevant`).not.toHaveLength(0);
        }

        // RANK ORDER, not just membership. The fallback relaxes the filter to
        // ANY term, so something irrelevant can legitimately come back — what
        // must not happen is it coming back FIRST. The first version of the
        // fallback filtered with ANY and ranked with an AND query, so the
        // ranking never saw which row matched more terms; the aggregate
        // precision had already improved and hid it.
        if (relevant.length > 0 && returned.length > 0) {
          expect(returned[0], `${testCase.id} ranked an irrelevant row first`).toBeOneOf([
            ...relevant,
          ]);
        }

        // PRECISION, where precision is the claim. Everything above tolerates
        // a little extra — that is what recall costs — so nothing was stopping
        // a change from returning more and more while the report showed
        // precision falling and every assertion passed. A mutation running the
        // ANY fallback FIRST did exactly that and left the suite green.
        if (testCase.exact === true) {
          expect(
            [...returned].sort(),
            `${testCase.id} is exact: the strict pass answers it, so relaxing to ANY is a regression`,
          ).toEqual([...relevant].sort());
        }
      });
    }
  });

  it('writes the report', () => {
    // Placeholder so the write in afterAll has a case to hang a name on; the
    // numbers are gathered by everything above.
    expect(scenarioResults.length + retrievalResults.length).toBeGreaterThan(0);
  });
});

function writeReport(): void {
  if (scenarioResults.length === 0 && retrievalResults.length === 0) return;
  mkdirSync(REPORT_DIR, { recursive: true });

  const lines: string[] = [];
  lines.push('CC-37 — memory eval report');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push('model:     NONE — every number below is measured without a provider');
  lines.push('');

  lines.push('SELECTION (layer 1, the CC-27 corpus)');
  lines.push('-'.repeat(60));
  lines.push('scenario                        pass  facts  chars/budget  junk');
  for (const r of scenarioResults) {
    lines.push(
      `${r.id.padEnd(31)} ${(r.passed ? 'yes' : 'NO ').padEnd(5)} ${String(r.injectedFacts).padStart(5)}  ` +
        `${`${r.injectedChars}/${r.budgetChars}`.padStart(12)}  ${r.junkRatio.toFixed(2)}`,
    );
  }
  lines.push('');

  const budgetRespected = scenarioResults.every((r) => r.injectedChars <= r.budgetChars);
  lines.push(`budget respected in every scenario: ${budgetRespected ? 'yes' : 'NO'}`);
  lines.push('');

  lines.push('RETRIEVAL (real Postgres FTS, hand-labelled queries)');
  lines.push('-'.repeat(60));
  lines.push('case                  P@8    R@8   returned / relevant');
  for (const r of retrievalResults) {
    lines.push(
      `${r.id.padEnd(21)} ${r.precision.toFixed(2)}  ${r.recall.toFixed(2)}   ` +
        `${r.returned.length} / ${r.relevant.length}`,
    );
  }
  const scored = retrievalResults.filter((r) => r.relevant.length > 0);
  const meanRecall = scored.reduce((s, r) => s + r.recall, 0) / Math.max(1, scored.length);
  const meanPrecision = scored.reduce((s, r) => s + r.precision, 0) / Math.max(1, scored.length);
  lines.push('');
  lines.push(`mean P@8 over answerable queries: ${meanPrecision.toFixed(2)}`);
  lines.push(`mean R@8 over answerable queries: ${meanRecall.toFixed(2)}`);
  lines.push('');

  lines.push('NOT MEASURED HERE, AND WHY');
  lines.push('-'.repeat(60));
  lines.push('chars-per-token ratio     needs a live provider; AgentTurn.inputTokens is the');
  lines.push('                          source, and nothing here calls a model. The budget is');
  lines.push('                          in CHARACTERS precisely so it does not depend on this.');
  lines.push('tokens with memory on/off same reason. The CHARACTER delta is exact and is the');
  lines.push('                          chars column above; converting it to tokens without a');
  lines.push('                          measured ratio would be arithmetic dressed as evidence.');
  lines.push('knowledge recall          whether a bot USES what it was handed is a question');
  lines.push('                          only a real turn can answer. The mechanical half — that');
  lines.push('                          the fact reaches the prompt — is CC-32.');
  lines.push('');
  lines.push('The retrieval numbers ARE the baseline CC-39 has to beat, and');
  lines.push('`paraphrase-hard` is the gap that would justify a vector index.');

  writeFileSync(join(REPORT_DIR, 'report.txt'), `${lines.join('\n')}\n`);
  writeFileSync(
    join(REPORT_DIR, 'report.json'),
    `${JSON.stringify({ scenarios: scenarioResults, retrieval: retrievalResults }, null, 2)}\n`,
  );
}

// Referenced so the import is not dropped; SCENARIOS carries the layer-2 cases
// this runner declares but cannot execute.
void SCENARIOS;
