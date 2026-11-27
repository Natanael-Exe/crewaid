import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { computeLocalTaskPayloadHash, normalizeRelativeCwd } from '@crewaid/acp-core';
import {
  NativeToolInputs,
  type Json,
  type LocalConnectorHarnessId,
  type LocalConnectorView,
} from '@crewaid/shared';

import { readCodingMaxMs } from '../agent/agent-loop.config.js';
import { CODING_PROGRESS_EVENT, codingProgressPayload } from '../agent/code-task-tool.js';
import type { CodingRunStore } from '../agent/coding/coding-run-store.service.js';
import type { CommitAdapter } from '../agent/policy/policy.js';
import { tool } from '../agent/tool-contract.js';
import {
  LOCAL_CONNECTOR_BUILTIN,
  OBSERVING_BUILTIN,
  type RegisteredTool,
  type ToolContext,
} from '../agent/tool-registry.js';
import { ConnectorDispatchError } from './connector-ws.host.js';
import type { DispatchConnectorResolution } from './connectors.service.js';
import type { LocalCodingResult, LocalTaskRunInput } from './local-connector-runner.service.js';

export interface LocalConnectorToolsStore {
  list(userId: string): Promise<{ readonly connectors: readonly LocalConnectorView[] }>;
  resolveForDispatch(userId: string, id: string): Promise<DispatchConnectorResolution>;
}

export interface LocalConnectorTaskRunner {
  runLocalTask(input: LocalTaskRunInput): Promise<LocalCodingResult>;
}

export interface LocalConnectorToolsDeps {
  readonly userId: string;
  readonly botId: string;
  readonly botName: string;
  readonly connectors: LocalConnectorToolsStore;
  readonly runner: LocalConnectorTaskRunner;
  readonly runs?: CodingRunStore | undefined;
  readonly maxDurationMs?: (() => number) | undefined;
}

const LocalTaskOutcomeSchema = z.object({
  crewaidLocalTask: z.object({
    status: z.enum(['committed', 'refused', 'uncertain']),
    reference: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
  }),
});

/**
 * Deterministic prompt construction shared between `CommitAdapter.proposal`
 * (approval binding) and `execute` (dispatched frame) so both compute the exact
 * same `payloadHash`.
 */
export function buildLocalTaskPrompt(goal: string, context?: string): string {
  const trimmedGoal = goal.trim();
  const trimmedContext = context?.trim();
  if (trimmedContext === undefined || trimmedContext === '') {
    return trimmedGoal;
  }
  return `${trimmedGoal}\n\nContext:\n${trimmedContext}`;
}

export function resolveConnectorHarness(
  connector: LocalConnectorView,
  requested?: LocalConnectorHarnessId,
): { readonly ok: true; readonly harness: LocalConnectorHarnessId } | { readonly ok: false; readonly message: string } {
  if (requested !== undefined) {
    if (!connector.harnesses.includes(requested)) {
      const available =
        connector.harnesses.length === 0 ? 'none' : connector.harnesses.join(', ');
      return {
        ok: false,
        message: `Harness "${requested}" is not available on connector "${connector.name}" (available: ${available}).`,
      };
    }
    return { ok: true, harness: requested };
  }
  const fallback = connector.defaultHarness ?? connector.harnesses[0];
  if (fallback === undefined) {
    return {
      ok: false,
      message: `Connector "${connector.name}" reported no installed coding harnesses.`,
    };
  }
  return { ok: true, harness: fallback };
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${String(mins)}m` : `${String(mins)}m ${String(rem)}s`;
}

function formatLocalCodingResult(
  connector: LocalConnectorView,
  relativeCwd: string,
  harness: LocalConnectorHarnessId,
  result: LocalCodingResult,
): string {
  const metaParts: string[] = [
    connector.name,
    result.agentName ?? harness,
    `${String(result.steps)} ${result.steps === 1 ? 'step' : 'steps'}`,
    formatDuration(result.durationMs),
    `mode: ${result.reportMode}`,
  ];
  const lines: string[] = [
    `local_code_task · ${result.status} (${metaParts.join(', ')})`,
    `workspace: ${connector.workspaceName ?? connector.name} (${relativeCwd})`,
  ];

  if (result.gitBranch !== undefined || result.headSha !== undefined) {
    const gitParts: string[] = [];
    if (result.gitBranch !== undefined) gitParts.push(`branch=${result.gitBranch}`);
    if (result.headSha !== undefined) gitParts.push(`head=${result.headSha}`);
    lines.push(`git: ${gitParts.join(' ')}`);
  }

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

  if (result.commandsRun.length > 0) {
    lines.push('', 'Commands run:');
    for (const cmd of result.commandsRun) {
      const status =
        cmd.exitCode === 0 ? 'completed' : cmd.exitCode === null ? 'unknown' : 'failed';
      lines.push(`- \`${cmd.command}\` (${status})`);
    }
  }

  if (result.diffExcerpt !== undefined && result.diffExcerpt !== '') {
    lines.push('', 'Diff excerpt:', result.diffExcerpt);
  }

  if (result.transcriptExcerpt !== undefined && result.transcriptExcerpt !== '') {
    lines.push('', 'Transcript excerpt:', result.transcriptExcerpt);
  }

  if (result.error !== undefined && result.summary !== result.error.message) {
    lines.push('', `Error (${result.error.code}): ${result.error.message}`);
  }

  return lines.join('\n');
}

function formatConnectorList(connectors: readonly LocalConnectorView[]): string {
  if (connectors.length === 0) {
    return 'No local connectors are paired for this account.';
  }
  const lines: string[] = [`Local connectors (${String(connectors.length)}):`];
  for (const connector of connectors) {
    const state = connector.status === 'ONLINE' ? (connector.busy ? 'ONLINE (busy)' : 'ONLINE') : connector.status;
    const workspace = connector.workspaceName ?? 'not connected yet';
    const harnesses =
      connector.harnesses.length === 0 ? 'none' : connector.harnesses.join(', ');
    const defaultLabel =
      connector.defaultHarness === null ? '' : `, default=${connector.defaultHarness}`;
    lines.push(
      `- ${connector.name} (id: ${connector.id}) · ${state} · workspace: ${workspace} · harnesses: ${harnesses}${defaultLabel} · reportMode: ${connector.reportMode}`,
    );
  }
  return lines.join('\n');
}

/**
 * Per-turn local connector tools (`list_local_connectors`, `local_code_task`),
 * offered only when the user has at least one paired non-revoked connector.
 *
 * `local_code_task` carries `LOCAL_CONNECTOR_BUILTIN` (`alwaysAsk: true`) and a
 * `CommitAdapter` binding the exact target connector, normalized `relativeCwd`,
 * resolved harness, and SHA-256 `payloadHash` into `ApprovalBinding.commit`.
 */
export function localConnectorTools(deps: LocalConnectorToolsDeps): readonly RegisteredTool[] {
  const resolveMaxDurationMs =
    deps.maxDurationMs ?? (() => readCodingMaxMs(process.env['AGENT_CODING_MAX_MS']));

  async function prepareLocalDispatch(args: unknown) {
    const parsed = NativeToolInputs.local_code_task.parse(args);
    const resolved = await deps.connectors.resolveForDispatch(deps.userId, parsed.connectorId);
    if (!resolved.ok) {
      throw new Error(`${resolved.code}: ${resolved.message}`);
    }
    const harnessVerdict = resolveConnectorHarness(resolved.connector, parsed.harness);
    if (!harnessVerdict.ok) {
      throw new Error(`HARNESS_UNAVAILABLE: ${harnessVerdict.message} (no action was dispatched).`);
    }
    let relativeCwd: string;
    try {
      relativeCwd = normalizeRelativeCwd(parsed.relativeCwd);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`INVALID_ARGUMENTS: ${detail} (no action was dispatched).`, { cause: error });
    }
    const prompt = buildLocalTaskPrompt(parsed.goal, parsed.context);
    const payloadHash = computeLocalTaskPayloadHash({
      botId: deps.botId,
      connectorId: resolved.connector.id,
      relativeCwd,
      harness: harnessVerdict.harness,
      prompt,
      ...(parsed.verifyCommand === undefined ? {} : { verifyCommand: parsed.verifyCommand }),
    });
    return {
      parsed,
      connector: resolved.connector,
      harness: harnessVerdict.harness,
      relativeCwd,
      prompt,
      payloadHash,
    };
  }

  const commitAdapter: CommitAdapter = {
    proposal: async (args: Json) => {
      const prepared = await prepareLocalDispatch(args);
      const account =
        prepared.connector.workspaceName === null ||
        prepared.connector.workspaceName === prepared.connector.name
          ? prepared.connector.name
          : `${prepared.connector.name} (${prepared.connector.workspaceName})`;
      return {
        account: account.slice(0, 320),
        destinations: [`${prepared.connector.id}:${prepared.relativeCwd}`],
        contentRevision: prepared.payloadHash,
      };
    },
    outcome: (output: unknown) => {
      const parsed = LocalTaskOutcomeSchema.safeParse(output);
      if (!parsed.success) return Promise.resolve({ status: 'uncertain' as const });
      const meta = parsed.data.crewaidLocalTask;
      if (meta.status === 'committed' && meta.reference !== undefined) {
        return Promise.resolve({ status: 'committed' as const, reference: meta.reference });
      }
      if (meta.status === 'refused' && meta.code !== undefined) {
        return Promise.resolve({ status: 'refused' as const, code: meta.code });
      }
      return Promise.resolve({ status: 'uncertain' as const });
    },
  };

  const listTool: RegisteredTool = {
    name: 'list_local_connectors',
    behavior: OBSERVING_BUILTIN,
    build: (context: ToolContext) =>
      tool({
        description:
          'List the user’s paired local repository connectors (`crewaid-connect`), including ' +
          'whether each connector is online or busy, its workspace name, available coding ' +
          'harnesses (such as Claude Code, Codex, OpenCode, or Antigravity), and report mode.',
        inputSchema: NativeToolInputs.list_local_connectors,
        execute: async () => {
          const { connectors } = await deps.connectors.list(context.userId);
          return formatConnectorList(connectors);
        },
      }),
  };

  const taskTool: RegisteredTool = {
    name: 'local_code_task',
    behavior: LOCAL_CONNECTOR_BUILTIN,
    commitAdapter,
    build: (context: ToolContext) =>
      tool({
        description:
          'Delegate a coding task to a local ACP coding harness running on the user’s own machine ' +
          'via a paired `crewaid-connect` connector. Always requires explicit operator approval ' +
          'in Crewaid (and, by default, confirmation in the local terminal). Call ' +
          '`list_local_connectors` first to confirm the connector id, online state, and available harnesses.',
        inputSchema: NativeToolInputs.local_code_task,
        execute: async (input, options) => {
          let prepared: Awaited<ReturnType<typeof prepareLocalDispatch>>;
          try {
            prepared = await prepareLocalDispatch(input);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const code = message.split(':')[0]?.trim() || 'DISPATCH_REFUSED';
            return {
              text: `local_code_task refused: ${message}`,
              crewaidLocalTask: { status: 'refused' as const, code },
            };
          }

          const sessionId = `lcode_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
          const runnerId = `acp:local:${prepared.harness}`;
          const recordedCwd = `${prepared.connector.workspaceName ?? prepared.connector.name}:${prepared.relativeCwd}`;
          let persisted = false;
          if (deps.runs !== undefined) {
            try {
              await deps.runs.start({
                id: sessionId,
                userId: context.userId,
                botId: context.botId,
                parentRunId: context.runId ?? null,
                runnerKind: 'acp_local',
                runnerId,
                cwd: recordedCwd,
                connectorId: prepared.connector.id,
                payloadHash: prepared.payloadHash,
                reportMode: prepared.connector.reportMode,
              });
              persisted = true;
            } catch {
              // Recording failure must not stop an authorized local coding task.
            }
          }

          let result: LocalCodingResult | undefined;
          let dispatchErrorCode: string | null = null;
          try {
            result = await deps.runner.runLocalTask({
              connectorId: prepared.connector.id,
              connectorName: prepared.connector.name,
              sessionId,
              payloadHash: prepared.payloadHash,
              botId: context.botId,
              botName: context.botName ?? deps.botName,
              relativeCwd: prepared.relativeCwd,
              harness: prepared.harness,
              prompt: prepared.prompt,
              ...(prepared.parsed.verifyCommand === undefined
                ? {}
                : { verifyCommand: prepared.parsed.verifyCommand }),
              maxDurationMs: resolveMaxDurationMs(),
              ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
              onProgress: (event) => {
                options.emit?.(
                  CODING_PROGRESS_EVENT,
                  codingProgressPayload(options.toolCallId, event),
                );
              },
            });

            const text = formatLocalCodingResult(
              prepared.connector,
              prepared.relativeCwd,
              prepared.harness,
              result,
            );
            if (result.error?.code === 'LOCAL_TASK_DECLINED') {
              return {
                text,
                crewaidLocalTask: { status: 'refused' as const, code: 'LOCAL_TASK_DECLINED' },
              };
            }
            if (result.status === 'completed' || result.status === 'incomplete') {
              return {
                text,
                crewaidLocalTask: { status: 'committed' as const, reference: sessionId },
              };
            }
            return {
              text,
              crewaidLocalTask: { status: 'uncertain' as const },
            };
          } catch (error: unknown) {
            if (error instanceof ConnectorDispatchError) {
              dispatchErrorCode = error.code;
              return {
                text: `local_code_task refused (${error.code}): ${error.message}`,
                crewaidLocalTask: { status: 'refused' as const, code: error.code },
              };
            }
            const detail = error instanceof Error ? error.message : String(error);
            dispatchErrorCode = 'UNKNOWN';
            return {
              text: `local_code_task failed: ${detail}`,
              crewaidLocalTask: { status: 'uncertain' as const },
            };
          } finally {
            if (persisted && deps.runs !== undefined) {
              await deps.runs
                .settle({
                  id: sessionId,
                  userId: context.userId,
                  botId: context.botId,
                  modelId: null,
                  status: result?.status ?? 'failed',
                  steps: result?.steps ?? 0,
                  workingMs: result?.durationMs ?? 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  filesChanged: result?.filesChanged ?? [],
                  errorCode: result?.error?.code ?? dispatchErrorCode,
                  acpSessionId: result?.acpSessionId ?? null,
                })
                .catch(() => undefined);
            }
          }
        },
      }),
  };

  return [listTool, taskTool];
}
