import { randomUUID } from 'node:crypto';
import { MODEL_REF_DEFAULT, NativeToolInputs, type Json } from '@crewaid/shared';

import {
  readCodingMaxMs,
  readCodingMaxSteps,
  readCodingMaxTokens,
} from './agent-loop.config.js';
import type { CodingRunStore } from './coding/coding-run-store.service.js';
import type {
  CodingProgressEvent,
  CodingResult,
  CodingRunner,
} from './coding/coding-runner.port.js';
import { tool } from './tool-contract.js';
import { CONTAINED_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';
import { MACHINE_HOME, resolveWorkspacePath } from './workspace-paths.js';

/** AG-UI custom event name emitted during a running `code_task` for live progress UI. */
export const CODING_PROGRESS_EVENT = 'crewaid.code_task.progress' as const;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${String(mins)}m` : `${String(mins)}m ${String(rem)}s`;
}

function progressPayload(
  toolCallId: string,
  event: CodingProgressEvent,
): Record<string, Json> {
  switch (event.kind) {
    case 'started':
      return {
        toolCallId,
        kind: event.kind,
        sessionId: event.sessionId,
        runnerId: event.runnerId,
        modelLabel: event.modelLabel,
        step: 0,
        maxSteps: event.maxSteps,
        cwd: event.cwd,
        filesChangedCount: 0,
      };
    case 'step':
      return {
        toolCallId,
        kind: event.kind,
        sessionId: event.sessionId,
        runnerId: event.runnerId,
        modelLabel: event.modelLabel,
        step: event.step,
        maxSteps: event.maxSteps,
        toolName: event.toolName,
        action: event.action,
        ...(event.target === undefined ? {} : { target: event.target }),
        ...(event.file === undefined ? {} : { file: event.file }),
        filesChangedCount: event.filesChangedCount,
      };
    case 'finished':
      return {
        toolCallId,
        kind: event.kind,
        sessionId: event.sessionId,
        runnerId: event.runnerId,
        modelLabel: event.modelLabel,
        status: event.status,
        step: event.steps,
        maxSteps: event.maxSteps,
        durationMs: event.durationMs,
        filesChangedCount: event.filesChangedCount,
      };
  }
}

function formatCodingResult(cwd: string, result: CodingResult): string {
  const metaParts: string[] = [
    `${String(result.steps)} ${result.steps === 1 ? 'step' : 'steps'}`,
    formatDuration(result.durationMs),
  ];
  if (result.usage !== undefined) {
    metaParts.push(result.usage.modelLabel);
  }
  const lines: string[] = [
    `code_task · ${result.status} (${metaParts.join(', ')})`,
    `cwd: ${cwd}`,
  ];

  if (result.summary !== '') {
    lines.push('', 'Summary:', result.summary);
  }

  if (result.filesChanged.length > 0) {
    lines.push('', `Files changed (${String(result.filesChanged.length)}):`);
    for (const file of result.filesChanged) {
      lines.push(`- ${file}`);
    }
  } else {
    lines.push('', 'Files changed: none');
  }

  const testParts: string[] = [result.tests.status];
  if (result.tests.command !== undefined) testParts.push(`(\`${result.tests.command}\`)`);
  if (result.tests.detail !== undefined) testParts.push(`— ${result.tests.detail}`);
  lines.push('', `Verification: ${testParts.join(' ')}`);

  if (result.commandsRun.length > 0) {
    lines.push('', 'Commands run:');
    for (const cmd of result.commandsRun) {
      const code = cmd.exitCode === null ? 'unknown exit' : `exit ${String(cmd.exitCode)}`;
      lines.push(`- \`${cmd.command}\` (${code})`);
    }
  }

  if (result.blockedActions.length > 0) {
    lines.push('', 'Blocked actions (policy/approval):');
    for (const blocked of result.blockedActions) {
      lines.push(`- ${blocked.toolName}: ${blocked.detail} (${blocked.reason})`);
    }
  }

  if (result.error !== undefined && result.summary !== result.error.message) {
    lines.push('', `Error (${result.error.code}): ${result.error.message}`);
  }

  return lines.join('\n');
}

export interface CodeTaskToolDeps {
  readonly runner: CodingRunner;
  readonly runs?: CodingRunStore | undefined;
  readonly maxSteps?: (() => number) | undefined;
  readonly maxDurationMs?: (() => number) | undefined;
  readonly maxTokens?: (() => number) | undefined;
}

/**
 * Delegated `code_task` built-in backed by a `CodingRunner` port (D-241 Step 3).
 *
 * Keeps multi-file coding work in a dedicated sub-loop with its own step budget
 * and coding-aware compaction so compiler and test noise never bloat the main
 * bot's conversation context, while the bot keeps its Crewaid tools (browser,
 * screen recording, Work board, GitHub PR publication).
 */
export function codeTaskTool(deps: CodeTaskToolDeps): RegisteredTool {
  const resolveMaxSteps =
    deps.maxSteps ?? (() => readCodingMaxSteps(process.env['AGENT_CODING_MAX_STEPS']));
  const resolveMaxDurationMs =
    deps.maxDurationMs ?? (() => readCodingMaxMs(process.env['AGENT_CODING_MAX_MS']));
  const resolveMaxTokens =
    deps.maxTokens ?? (() => readCodingMaxTokens(process.env['AGENT_CODING_MAX_TOKENS']));

  return {
    name: 'code_task',
    behavior: CONTAINED_BUILTIN,
    build: (context: ToolContext) =>
      tool({
        description:
          'Delegate a multi-file or multi-step software engineering task to a focused coding ' +
          'worker running on this bot’s computer with its own step budget. Use this for ' +
          'implementing features, refactoring across files, debugging test failures, or running ' +
          'iterative edit-and-test cycles; keep quick 1-2 file checks or single edits direct. ' +
          'Changes stay local on disk (the worker never pushes to GitHub or opens PRs).',
        inputSchema: NativeToolInputs.code_task,
        execute: async (
          {
            goal,
            cwd,
            context: extraContext,
            verifyCommand,
          }: {
            goal: string;
            cwd?: string | undefined;
            context?: string | undefined;
            verifyCommand?: string | undefined;
          },
          options,
        ) => {
          const ownArea = `${MACHINE_HOME}/agents/${context.botId}`;
          const targetCwd = cwd === undefined || cwd.trim() === '' ? ownArea : cwd;
          const verdict = resolveWorkspacePath(
            context.botId,
            targetCwd,
            context.groupId ?? null,
            context.workingDirectory,
          );
          if (!verdict.ok) return `code_task refused: ${verdict.reason}`;

          const sessionId = `code_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
          let persisted = false;
          if (deps.runs !== undefined) {
            try {
              await deps.runs.start({
                id: sessionId,
                userId: context.userId,
                botId: context.botId,
                parentRunId: context.runId ?? null,
                runnerKind: deps.runner.kind,
                runnerId: deps.runner.id,
                cwd: verdict.path,
              });
              persisted = true;
            } catch {
              // Recording failure must not stop an authorized coding task.
            }
          }

          let result: CodingResult | undefined;
          try {
            result = await deps.runner.run(
              {
                goal,
                cwd: verdict.path,
                ...(extraContext === undefined ? {} : { context: extraContext }),
                ...(verifyCommand === undefined ? {} : { verifyCommand }),
              },
              {
                sessionId,
                userId: context.userId,
                botId: context.botId,
                groupId: context.groupId ?? null,
                parentRunId: context.runId,
                parentModelRef: context.botModelId ?? MODEL_REF_DEFAULT,
                codingModelRef: context.codingModelId ?? null,
                maxSteps: resolveMaxSteps(),
                maxDurationMs: resolveMaxDurationMs(),
                maxTokens: resolveMaxTokens(),
                language: context.language ?? null,
                session: context.session,
                ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
                onProgress: (event) => {
                  options.emit?.(CODING_PROGRESS_EVENT, progressPayload(options.toolCallId, event));
                },
              },
            );
            return formatCodingResult(verdict.path, result);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return `code_task failed: ${detail}`;
          } finally {
            if (persisted && deps.runs !== undefined) {
              await deps.runs
                .settle({
                  id: sessionId,
                  userId: context.userId,
                  botId: context.botId,
                  modelId: result?.usage?.modelKey ?? null,
                  status: result?.status ?? 'failed',
                  steps: result?.steps ?? 0,
                  workingMs: result?.durationMs ?? 0,
                  inputTokens: result?.usage?.inputTokens ?? 0,
                  outputTokens: result?.usage?.outputTokens ?? 0,
                  cachedInputTokens: result?.usage?.cachedInputTokens ?? 0,
                  cacheCreationTokens: result?.usage?.cacheCreationTokens ?? 0,
                  filesChanged: result?.filesChanged ?? [],
                  errorCode: result?.error?.code ?? (result === undefined ? 'UNKNOWN' : null),
                })
                .catch(() => undefined);
            }
          }
        },
      }),
  };
}
