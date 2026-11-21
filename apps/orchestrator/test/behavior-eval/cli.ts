import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProviderKindSchema, type ProviderKind } from '@crewaid/shared';

import { buildTextAdapter } from '../../src/models/tanstack/text-adapter.js';
import { CASES } from './cases.js';
import {
  exitCodeFor,
  modelJudge,
  orchestratorSubject,
  renderReport,
  runSuite,
  runnerSubject,
  type EvalSubject,
} from './harness.js';

/**
 * CC-18 against real models: `pnpm --filter @crewaid/orchestrator eval:behavior`.
 *
 * Configured entirely from the environment, and every variable is prefixed
 * EVAL_ on purpose. V1 removed the process-wide provider keys from the
 * orchestrator (D-083); reusing their names here would suggest the
 * orchestrator reads them again.
 *
 *   EVAL_MODELS            provider:model, comma-separated — each runs every case
 *                          in process, through the real turn runner. Two entries
 *                          are a provider:model swap, scored side by side.
 *   EVAL_API_KEY_<KIND>    the key for that provider kind (ANTHROPIC, OPENAI, OPENROUTER)
 *   EVAL_JUDGE             provider:model that grades the rubric checks; without
 *                          it they are reported as NOT SCORED, never as passed
 *   EVAL_ORCHESTRATOR_URL  a running orchestrator, e.g. http://localhost:3000 …
 *   EVAL_ORCHESTRATOR_TOKEN  … and a session token for it
 *   EVAL_ORCHESTRATOR_MODEL  optional provider:model the created bots use
 *   EVAL_KEEP_BOTS=1       keep each case's bot (and so its turns) for measuring
 *   EVAL_REPORT_DIR        where report.txt and report.json go
 *                          (default .artifacts/behavior-eval)
 *
 * Exit 0 all scored cases passed, 1 a regression, 2 a harness failure.
 * Every run spends real tokens.
 */

function modelFromKey(key: string) {
  const separator = key.indexOf(':');
  const kind = ProviderKindSchema.safeParse(key.slice(0, separator));
  if (separator < 1 || !kind.success || kind.data === 'custom') {
    throw new Error(`"${key}" is not provider:model with provider anthropic, openai or openrouter`);
  }
  const apiKey = process.env[`EVAL_API_KEY_${kind.data.toUpperCase()}`];
  if (apiKey === undefined || apiKey === '') {
    throw new Error(`EVAL_API_KEY_${kind.data.toUpperCase()} is required for ${key}`);
  }
  return buildTextAdapter({
    kind: kind.data satisfies ProviderKind,
    apiKey,
    endpoint: null,
    upstreamModelId: key.slice(separator + 1),
  }).adapter;
}

function listFrom(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

async function main(): Promise<number> {
  const subjects: EvalSubject[] = listFrom(process.env['EVAL_MODELS']).map((key) => {
    const model = modelFromKey(key);
    return runnerSubject(key, () => model);
  });

  const url = process.env['EVAL_ORCHESTRATOR_URL'];
  if (url !== undefined && url !== '') {
    const token = process.env['EVAL_ORCHESTRATOR_TOKEN'];
    if (token === undefined || token === '') {
      throw new Error('EVAL_ORCHESTRATOR_TOKEN is required with EVAL_ORCHESTRATOR_URL');
    }
    const modelId = process.env['EVAL_ORCHESTRATOR_MODEL'];
    subjects.push(
      orchestratorSubject(`orchestrator${modelId ? ` (${modelId})` : ''}`, {
        baseUrl: url,
        token,
        ...(modelId !== undefined && modelId !== '' && { modelId }),
        ...(process.env['EVAL_KEEP_BOTS'] === '1' && { keepBots: true }),
      }),
    );
  }

  if (subjects.length === 0) {
    throw new Error('Nothing to evaluate: set EVAL_MODELS, EVAL_ORCHESTRATOR_URL, or both.');
  }

  const judgeKey = process.env['EVAL_JUDGE'];
  const judge =
    judgeKey !== undefined && judgeKey !== '' ? modelJudge(modelFromKey(judgeKey)) : undefined;

  const results = await runSuite(CASES, subjects, judge);
  const report = renderReport(results);
  const dir = process.env['EVAL_REPORT_DIR'] ?? join(process.cwd(), '.artifacts', 'behavior-eval');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.txt'), `${report}\n`);
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${report}\n\nwritten to ${dir}\n`);
  return exitCodeFor(results);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // A run that could not start is a harness failure: it proved nothing.
    process.exitCode = 2;
  },
);
