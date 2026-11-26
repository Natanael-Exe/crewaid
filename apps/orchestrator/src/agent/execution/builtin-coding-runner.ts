import {
  chat,
  EventType,
  type ChatMiddleware,
  type ModelMessage,
  type SystemPrompt,
} from '@tanstack/ai';
import { z } from 'zod';
import { JsonSchema, projectPublicSpeech, type Json } from '@crewaid/shared';
import type { ToolSandboxSession } from '@crewaid/sandbox-core';
import type { StructuredLogger } from '../../logging/structured-logger.js';
import type { ResolvedTextModel } from '../../models/model-resolution.service.js';
import { historyBudget } from '../../models/context-budget.js';
import { normalizeModelError, normalizeRunError } from '../../models/normalize-error.js';
import { normalizeUsage, type NormalizedUsage } from '../../models/tanstack/usage.js';
import {
  catalogCostEstimate,
  modelKeyOf,
  productionCostEstimate,
  projectUsageForEvent,
  safeCostEstimate,
  type AiTelemetryCostResolver,
  type AiTelemetryEvent,
  type AiTelemetrySink,
} from '../../telemetry/ai-telemetry.js';
import { readContextTrimTokens } from '../agent-loop.config.js';
import { codingTools } from '../coding-tools.js';
import { computerTools } from '../computer-tools.js';
import type { MachineSeatPort } from '../machine-tools.js';
import { assessPolicy } from '../policy/policy.js';
import type { ToolPolicyStateService } from '../policy/state.service.js';
import { processTools } from '../process-tools.js';
import type { MachineProcessPort } from '../../sandbox/machine-process.service.js';
import { parseToolInput, tool, type ToolDefinition, type ToolSet } from '../tool-contract.js';
import { OBSERVING_BUILTIN, type RegisteredTool, type ToolContext } from '../tool-registry.js';
import { withCappedOutputs } from '../tool-result-projection.js';
import {
  createTurnLimitAccount,
  wrapUpCopy,
  wrapUpDue,
  type TurnLimitStop,
} from '../turn-limits.js';
import {
  codingTaskContextBlock,
  codingTaskUserPrompt,
  CODING_WORKER_STATIC_PROMPT,
} from '../coding/coding-instructions.js';
import type {
  CodingBlockedAction,
  CodingCommandRecord,
  CodingInvocation,
  CodingResult,
  CodingRunner,
  CodingTask,
  CodingTaskStatus,
  CodingTaskUsage,
  CodingTestReport,
} from '../coding/coding-runner.port.js';
import { providerCompaction } from './context-compaction.js';
import { PrivacyVault } from './privacy-vault.js';
import {
  scanForStall,
  stallBlockCopy,
  stallToolFailureBlockCopy,
  stallWarnCopy,
  type StallDetail,
} from './stall-guard.js';
import { tanstackTools } from './tanstack-tools.js';

const FINISH_TASK_TOOL = 'finish_task';
const ALLOWED_COMPUTER_TOOLS = new Set(['fs_read', 'fs_write', 'shell']);
const OBSERVATION_TOOLS = new Set(['fs_read', 'fs_grep', 'fs_glob', 'process_output']);
const MAX_SUMMARY_CHARS = 8_000;
const MAX_COMMANDS_TRACKED = 25;
const MAX_FILES_TRACKED = 60;
const CHANGE_SCAN_TIMEOUT_MS = 5_000;
/** Most paths one changed-files scan reads back. */
const CHANGE_SCAN_MAX_PATHS = 200;
/** Directories a changed-files scan skips: VCS metadata, dependencies, caches and build output. */
const CHANGE_SCAN_PRUNE = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.next',
  '.turbo',
  '.vite',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
];

const FinishTaskInputSchema = z.object({
  summary: z
    .string()
    .min(1)
    .max(MAX_SUMMARY_CHARS)
    .describe('Concise, factual summary of what changed, key decisions, and any blockers'),
  tests: z
    .object({
      status: z.enum(['passed', 'failed', 'not_run']),
      command: z.string().min(1).max(512).optional(),
      detail: z.string().min(1).max(1_000).optional(),
    })
    .describe('Honest status of verification commands actually run during this task'),
});

type FinishTaskInput = z.infer<typeof FinishTaskInputSchema>;

export interface CodingProcessPort extends MachineProcessPort {
  readonly stopRun?: (botId: string, runId: string) => Promise<unknown>;
}

export interface BuiltInCodingRunnerDeps {
  readonly resolveModel: (userId: string, modelRef: string) => Promise<ResolvedTextModel>;
  readonly machines: MachineSeatPort;
  readonly processes?: CodingProcessPort | undefined;
  readonly policyState: Pick<ToolPolicyStateService, 'read'>;
  readonly logger: Pick<StructuredLogger, 'warn'> & Partial<Pick<StructuredLogger, 'info'>>;
  readonly telemetry?: AiTelemetrySink | undefined;
  readonly costResolver?: AiTelemetryCostResolver | undefined;
  readonly now?: (() => number) | undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function previewActionTarget(value: unknown, maxChars = 60): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`;
}

function basenameOf(filePath: string): string {
  const trimmed = filePath.trim().replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/**
 * What one inner step is doing. `target` is what the desktop shows next to its
 * own translated title for `toolName`; `action` is an English line for logs and
 * for a client that predates `target`. Paths are reduced to their basename so
 * the card never shows a `/home/bot/...` path.
 */
function describeInnerAction(
  toolName: string,
  args: Json,
): { readonly action: string; readonly target?: string; readonly file?: string } {
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args) ? args : undefined;
  const rawPath = previewActionTarget(record?.['path'], 120);
  const file = rawPath === undefined ? undefined : basenameOf(rawPath);
  const withTarget = (verb: string, fallback: string, target: string | undefined) =>
    target === undefined ? { action: fallback } : { action: `${verb} ${target}`, target };
  switch (toolName) {
    case 'fs_read':
      return {
        ...withTarget('Reading', 'Reading file', file),
        ...(file === undefined ? {} : { file }),
      };
    case 'fs_edit':
      return {
        ...withTarget('Editing', 'Editing file', file),
        ...(file === undefined ? {} : { file }),
      };
    case 'fs_write':
      return {
        ...withTarget('Writing', 'Writing file', file),
        ...(file === undefined ? {} : { file }),
      };
    case 'fs_grep':
      return withTarget(
        'Searching',
        'Searching files',
        previewActionTarget(record?.['pattern'], 40),
      );
    case 'fs_glob':
      return withTarget('Finding', 'Finding files', previewActionTarget(record?.['pattern'], 40));
    case 'shell':
      return withTarget('Running', 'Running command', previewActionTarget(record?.['command'], 50));
    case 'process_start':
      return withTarget(
        'Starting',
        'Starting process',
        previewActionTarget(record?.['command'], 50),
      );
    case 'process_output':
      return { action: 'Checking process output' };
    case 'process_stop':
      return { action: 'Stopping process' };
    case FINISH_TASK_TOOL:
      return { action: 'Wrapping up coding task' };
    default:
      return { action: `Running ${toolName}` };
  }
}

const EDITED_PATH_RE = /^edited (.+?) \(\d+ replacement/;
const WROTE_PATH_RE = /^wrote [\d,]+ bytes to (.+)$/;
const SHELL_EXIT_RE = /^exit (-?\d+)\b/;

function displayChangedPath(filePath: string, cwd: string): string {
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

function extractWrittenPath(toolName: string, output: unknown, cwd: string): string | null {
  if (typeof output !== 'string') return null;
  const firstLine = output.split('\n', 1)[0] ?? '';
  const raw =
    toolName === 'fs_edit'
      ? (EDITED_PATH_RE.exec(firstLine)?.[1]?.trim() ?? null)
      : toolName === 'fs_write'
        ? (WROTE_PATH_RE.exec(firstLine)?.[1]?.trim() ?? null)
        : null;
  return raw === null ? null : displayChangedPath(raw, cwd);
}

function extractShellExitCode(output: unknown): number | null {
  if (typeof output !== 'string') return null;
  const match = SHELL_EXIT_RE.exec(output);
  if (match?.[1] !== undefined) return Number(match[1]);
  if (output.startsWith('shell: the command was still running after')) return 124;
  return null;
}

/**
 * The container's clock, read before the coding model acts, so the scan at the
 * end can list what was modified after it. Null when it cannot be read.
 */
async function containerClock(
  session: ToolSandboxSession,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted === true) return null;
  try {
    const res = await session.run({
      command: 'date +%s.%N',
      abortSignal:
        signal === undefined
          ? AbortSignal.timeout(CHANGE_SCAN_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(CHANGE_SCAN_TIMEOUT_MS)]),
    });
    const value = res.stdout.trim();
    return res.exitCode === 0 && /^\d+(\.\d+)?$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Files under `cwd` modified after `since`, relative to `cwd`, so edits made
 * through `shell` (formatters, codegen, `mv`) are reported alongside the
 * fs_edit/fs_write receipts.
 *
 * Deliberately not `git status`. This runs with no approval, and Git runs
 * commands a repository configures — `core.fsmonitor`, clean filters, a `.git`
 * file pointing at another config, a submodule's own config — so a repository
 * the bot works in could make this call execute code nobody approved. `find`
 * reads nothing the repository controls and does not follow symlinks. Deleted
 * files are not reported.
 */
async function filesModifiedSince(
  session: ToolSandboxSession,
  cwd: string,
  since: string,
): Promise<string[] | null> {
  const prune = CHANGE_SCAN_PRUNE.map((name) => `-name ${shellQuote(name)}`).join(' -o ');
  try {
    const res = await session.run({
      command:
        `find . \\( ${prune} \\) -prune -o -type f -newermt "@$CREWAID_SINCE" -print ` +
        `2>/dev/null | head -n ${String(CHANGE_SCAN_MAX_PATHS)}`,
      workingDirectory: cwd,
      env: { CREWAID_SINCE: since },
      abortSignal: AbortSignal.timeout(CHANGE_SCAN_TIMEOUT_MS),
    });
    if (res.exitCode !== 0) return null;
    return res.stdout
      .split('\n')
      .map((line) => line.trim().replace(/^\.\//, ''))
      .filter((line) => line !== '');
  } catch {
    return null;
  }
}

function formatBlockedDetail(toolName: string, args: Json): string {
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args) ? args : undefined;
  const candidate =
    previewActionTarget(record?.['command'], 120) ??
    previewActionTarget(record?.['path'], 120) ??
    previewActionTarget(record?.['pattern'], 120);
  return candidate ?? toolName;
}

function extractLastAssistantText(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role !== 'assistant' || message.content === null) {
      continue;
    }
    if (typeof message.content === 'string') {
      const cleaned = projectPublicSpeech(message.content).trim();
      if (cleaned !== '') return cleaned;
    } else if (Array.isArray(message.content)) {
      const joined = message.content
        .flatMap((part) => (part.type === 'text' ? [part.content] : []))
        .join('\n');
      const cleaned = projectPublicSpeech(joined).trim();
      if (cleaned !== '') return cleaned;
    }
  }
  return '';
}

function buildSystemPrompts(
  resolvedKind: ResolvedTextModel['kind'],
  contextBlock: string,
  vault: PrivacyVault | undefined,
): SystemPrompt[] {
  const redact = (value: string): string => (vault === undefined ? value : vault.redactText(value));
  const staticPrompt = redact(CODING_WORKER_STATIC_PROMPT);
  const dynamicContext = redact(contextBlock);
  if (resolvedKind === 'anthropic') {
    return [
      { content: staticPrompt, metadata: { cache_control: { type: 'ephemeral' } } },
      { content: dynamicContext },
    ];
  }
  return [`${staticPrompt}\n\n${dynamicContext}`];
}

/**
 * Lean Pi-inspired built-in coding runner executing in the orchestrator over
 * `@tanstack/ai` `chat()` with coding-only tools, live inner policy checks,
 * `crewaid-v2` compaction, `PrivacyVault`, stall detection, and telemetry.
 */
export class BuiltInCodingRunner implements CodingRunner {
  readonly id = 'builtin';
  readonly kind = 'builtin' as const;

  constructor(private readonly deps: BuiltInCodingRunnerDeps) {}

  async run(task: CodingTask, invocation: CodingInvocation): Promise<CodingResult> {
    const logger = this.deps.logger;
    const now = this.deps.now ?? (() => Date.now());
    const startedAt = now();
    const elapsedMs = () => Math.max(0, now() - startedAt);
    const isParentAborted = (): boolean => invocation.abortSignal?.aborted === true;
    const emitProgress = (event: Parameters<NonNullable<CodingInvocation['onProgress']>>[0]) => {
      try {
        invocation.onProgress?.(event);
      } catch {
        // Progress observers must never fail the coding task.
      }
    };

    if (isParentAborted()) {
      return {
        status: 'cancelled',
        runnerKind: this.kind,
        runnerId: this.id,
        sessionId: invocation.sessionId,
        summary: 'Coding task was cancelled before starting.',
        filesChanged: [],
        tests: { status: 'not_run' },
        commandsRun: [],
        blockedActions: [],
        steps: 0,
        durationMs: elapsedMs(),
      };
    }

    const modelRef = invocation.codingModelRef ?? invocation.parentModelRef;
    let resolved: ResolvedTextModel;
    try {
      resolved = await this.deps.resolveModel(invocation.userId, modelRef);
    } catch (error) {
      const normalized = normalizeModelError(error, {
        modelId: modelRef,
        language: invocation.language,
      });
      return {
        status: 'failed',
        runnerKind: this.kind,
        runnerId: this.id,
        sessionId: invocation.sessionId,
        summary: normalized.message,
        filesChanged: [],
        tests: { status: 'not_run' },
        commandsRun: [],
        blockedActions: [],
        steps: 0,
        durationMs: elapsedMs(),
        error: { code: normalized.code, message: normalized.message },
      };
    }

    if (!resolved.capabilities.tools) {
      return {
        status: 'failed',
        runnerKind: this.kind,
        runnerId: this.id,
        sessionId: invocation.sessionId,
        summary: `${resolved.label} does not support tool calling, so it cannot run coding tasks. Choose a tool-capable coding model.`,
        filesChanged: [],
        tests: { status: 'not_run' },
        commandsRun: [],
        blockedActions: [],
        steps: 0,
        durationMs: elapsedMs(),
        error: {
          code: 'INVALID_REQUEST',
          message: `${resolved.label} does not support tool calling.`,
        },
      };
    }

    emitProgress({
      kind: 'started',
      sessionId: invocation.sessionId,
      runnerId: this.id,
      modelLabel: resolved.label,
      maxSteps: invocation.maxSteps,
      cwd: task.cwd,
    });

    const controller = new AbortController();
    const cancel = () => controller.abort('CODING_TASK_CANCELLED');
    invocation.abortSignal?.addEventListener('abort', cancel, { once: true });
    if (isParentAborted()) cancel();

    const vault = process.env['AGENT_PRIVACY_VAULT'] === 'false' ? undefined : new PrivacyVault();
    const costResolver = this.deps.costResolver ?? productionCostEstimate;
    const modelKey = modelKeyOf(resolved.kind, resolved.upstreamModelId);

    const filesChangedSet = new Set<string>();
    const commandsRun: CodingCommandRecord[] = [];
    const blockedActions: CodingBlockedAction[] = [];
    let finishedReport: FinishTaskInput | undefined;
    let lastMessages: readonly ModelMessage[] = [];
    let stepsDone = 0;
    let stall: StallDetail | undefined;
    let stallClosing = false;
    let wrapUpSent = false;
    const stallWarned = new Set<string>();
    const pendingNotices: string[] = [];

    const usageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      calls: 0,
    };
    const callStarts = new Map<number, number>();
    const callsRecorded = new Set<number>();

    const recordTelemetry = (
      iteration: number,
      outcome: AiTelemetryEvent['outcome'],
      reported: NormalizedUsage | null,
      errorCode?: string,
    ): void => {
      const started = callStarts.get(iteration);
      if (
        this.deps.telemetry === undefined ||
        started === undefined ||
        callsRecorded.has(iteration)
      ) {
        return;
      }
      callsRecorded.add(iteration);
      try {
        const usage = {
          inputTokens: reported?.inputTokens,
          outputTokens: reported?.outputTokens,
          totalTokens: reported === null ? undefined : reported.inputTokens + reported.outputTokens,
          cacheReadTokens: reported?.cachedInputTokens,
          cacheWriteTokens: reported?.cacheCreationTokens,
          usageUnknown: reported === null,
        };
        const event: AiTelemetryEvent = {
          schemaVersion: 1,
          event: 'ai.model-call',
          outcome,
          provider: resolved.kind,
          model: resolved.upstreamModelId,
          ...projectUsageForEvent(usage),
          latencyMs: Math.max(0, now() - started),
          estimatedCostUsd: safeCostEstimate(
            costResolver,
            resolved.kind,
            resolved.upstreamModelId,
            usage,
          ),
          botId: invocation.botId,
          ...(invocation.parentRunId === undefined ? {} : { runId: invocation.parentRunId }),
          ...(errorCode === undefined ? {} : { errorCode }),
        };
        void Promise.resolve(this.deps.telemetry.record(event)).catch(() => undefined);
      } catch {
        // Telemetry failures must never fail the coding task.
      }
    };

    const recordOpenTelemetry = (outcome: AiTelemetryEvent['outcome'], errorCode?: string) => {
      for (const iteration of callStarts.keys())
        recordTelemetry(iteration, outcome, null, errorCode);
    };

    // Memoize session access, and read the container's clock on first wake for the changed-files scan.
    let sandboxSession: ToolSandboxSession | undefined;
    let changesSince: string | null = null;
    const ensureSession = async (): Promise<ToolSandboxSession> => {
      if (sandboxSession === undefined) {
        sandboxSession = await invocation.session();
      }
      return sandboxSession;
    };

    // The moment before the model makes any edits (best-effort).
    if (!controller.signal.aborted) {
      try {
        const liveSession = await ensureSession();
        changesSince = await containerClock(liveSession, controller.signal);
      } catch {
        // Session wake failures surface through tool calls or abort cleanly below.
      }
    }

    const subContext: ToolContext = {
      userId: invocation.userId,
      botId: invocation.botId,
      ...(invocation.parentRunId === undefined ? {} : { runId: invocation.parentRunId }),
      groupId: invocation.groupId,
      workingDirectory: task.cwd,
      language: invocation.language,
      trigger: { id: invocation.sessionId, chainId: null, hopCount: 0 },
      attachmentHost: () =>
        Promise.reject(new Error('File attachments are not available inside code_task.')),
      browser: () => Promise.reject(new Error('Browser tools are not available inside code_task.')),
      useIdentity: () =>
        Promise.reject(new Error('Identity switching is not available inside code_task.')),
      session: ensureSession,
    };

    const rawEntries: RegisteredTool[] = [
      ...computerTools({ machines: this.deps.machines }).filter((entry) =>
        ALLOWED_COMPUTER_TOOLS.has(entry.name),
      ),
      ...codingTools(),
      ...(this.deps.processes === undefined
        ? []
        : processTools({ machines: this.deps.machines, processes: this.deps.processes })),
      {
        name: FINISH_TASK_TOOL,
        behavior: OBSERVING_BUILTIN,
        build: () =>
          tool({
            description:
              'Complete the coding task and return a structured summary and verification report to the calling bot.',
            inputSchema: FinishTaskInputSchema,
            execute: (input: FinishTaskInput) => {
              finishedReport = input;
              return 'Coding task report recorded.';
            },
          }),
      },
    ];

    const subToolSet: ToolSet = {};
    for (const entry of rawEntries) {
      const built = entry.build(subContext);
      const execute = built.execute;
      if (execute === undefined) {
        subToolSet[entry.name] = built;
        continue;
      }

      const wrapped: ToolDefinition = {
        ...built,
        execute: async (rawInput, options) => {
          if (controller.signal.aborted || options.abortSignal?.aborted === true) {
            return 'TOOL_CANCELLED: the coding task was cancelled.';
          }

          const resolvedInput = vault === undefined ? rawInput : vault.resolveValue(rawInput);
          let validatedArgs: Json;
          try {
            validatedArgs = JsonSchema.parse(
              await parseToolInput(built.inputSchema, resolvedInput),
            );
          } catch (error) {
            return error instanceof Error
              ? `INVALID_ARGUMENTS: ${error.message}`
              : 'INVALID_ARGUMENTS: invalid tool arguments.';
          }

          const described = describeInnerAction(entry.name, validatedArgs);
          emitProgress({
            kind: 'step',
            sessionId: invocation.sessionId,
            runnerId: this.id,
            modelLabel: resolved.label,
            step: stepsDone + 1,
            maxSteps: invocation.maxSteps,
            toolName: entry.name,
            action: described.action,
            ...(described.target === undefined ? {} : { target: described.target }),
            ...(described.file === undefined ? {} : { file: described.file }),
            filesChangedCount: filesChangedSet.size,
          });

          if (entry.name !== FINISH_TASK_TOOL) {
            try {
              const policyState = await this.deps.policyState.read(
                invocation.userId,
                invocation.botId,
                {
                  name: entry.name,
                  args: validatedArgs,
                  behavior: entry.behavior,
                },
                false,
              );
              // In ASK mode the operator already approved the outer `code_task`
              // call upfront; evaluate inner tools with AUTO fallthrough over
              // the bot's exact autoReviewRules so approved edits/tests work
              // while deny rules and destructive-shell ask rules stay blocked.
              const effectiveSnapshot =
                policyState.snapshot.mode === 'ASK'
                  ? { ...policyState.snapshot, mode: 'AUTO' as const }
                  : policyState.snapshot;
              const verdict = assessPolicy({
                name: entry.name,
                args: validatedArgs,
                behavior: entry.behavior,
                snapshot: effectiveSnapshot,
                memory: [],
              });
              if (verdict.decision === 'deny') {
                const reason = verdict.code ?? 'POLICY_DENIED';
                blockedActions.push({
                  toolName: entry.name,
                  detail: formatBlockedDetail(entry.name, validatedArgs),
                  reason,
                });
                return `${reason}: this action is blocked by the bot's policy.`;
              }
              if (verdict.decision === 'ask') {
                blockedActions.push({
                  toolName: entry.name,
                  detail: formatBlockedDetail(entry.name, validatedArgs),
                  reason: 'APPROVAL_REQUIRED',
                });
                return (
                  `APPROVAL_REQUIRED: ${entry.name} requires operator approval under this bot's policy ` +
                  'and cannot prompt mid-code_task. Choose a safer alternative, or call finish_task and ' +
                  'report what needs approval so the calling bot can ask the operator directly.'
                );
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : 'POLICY_UNAVAILABLE';
              blockedActions.push({
                toolName: entry.name,
                detail: formatBlockedDetail(entry.name, validatedArgs),
                reason: detail,
              });
              return `POLICY_UNAVAILABLE: ${detail}`;
            }
          }

          const output: unknown = await execute(validatedArgs, options);

          if (entry.name === 'fs_edit' || entry.name === 'fs_write') {
            const written = extractWrittenPath(entry.name, output, task.cwd);
            if (written !== null && filesChangedSet.size < MAX_FILES_TRACKED) {
              filesChangedSet.add(written);
            }
          } else if (entry.name === 'shell' && commandsRun.length < MAX_COMMANDS_TRACKED) {
            const command =
              typeof validatedArgs === 'object' &&
              validatedArgs !== null &&
              !Array.isArray(validatedArgs) &&
              typeof validatedArgs['command'] === 'string'
                ? validatedArgs['command'].trim()
                : '';
            if (command !== '') {
              commandsRun.push({
                command: previewActionTarget(command, 160) ?? command,
                exitCode: extractShellExitCode(output),
              });
            }
          }

          return output;
        },
      };
      subToolSet[entry.name] = wrapped;
    }

    const cappedTools = tanstackTools(withCappedOutputs(subToolSet));
    const finishOnlyTools = cappedTools.filter((item) => item.name === FINISH_TASK_TOOL);

    const limits = createTurnLimitAccount(
      {
        maxSteps: invocation.maxSteps,
        maxTurnTokens: invocation.maxTokens,
        maxTurnMs: invocation.maxDurationMs,
      },
      now,
    );
    limits.resume();

    const historyTokens = historyBudget(
      resolved.contextWindow,
      readContextTrimTokens(process.env['AGENT_CONTEXT_TRIM_TOKENS']),
    );

    const codingLifecycleMiddleware: ChatMiddleware = {
      name: 'crewaid-coding-lifecycle',
      onConfig(ctx, config) {
        if (ctx.phase !== 'beforeModel') return;
        lastMessages = config.messages;

        if (!wrapUpSent && wrapUpDue(stepsDone, invocation.maxSteps)) {
          wrapUpSent = true;
          pendingNotices.push(
            `${wrapUpCopy(stepsDone, invocation.maxSteps)} Call finish_task as soon as you have verified or summarized your progress.`,
          );
        }

        if (limits.check() !== undefined) {
          controller.abort('CODING_BUDGET_EXHAUSTED');
          ctx.abort('Coding task budget exhausted.');
          return;
        }

        callStarts.set(ctx.iteration, now());

        const baseMessages = config.providerMessages ?? config.messages;
        const redacted =
          vault === undefined ? [...baseMessages] : vault.redactMessages(baseMessages);
        const notices = pendingNotices.splice(0, pendingNotices.length);
        const providerMessages: ModelMessage[] =
          notices.length === 0
            ? redacted
            : [
                ...redacted,
                ...notices.map((content): ModelMessage => ({
                  role: 'user',
                  content: vault === undefined ? content : vault.redactText(content),
                })),
              ];

        return {
          providerMessages,
          ...(stall === undefined ? {} : { tools: finishOnlyTools }),
        };
      },
      onUsage(ctx, reported) {
        const normalized = normalizeUsage(resolved.kind, reported);
        recordTelemetry(ctx.iteration, 'success', normalized);
        if (normalized === null) return;
        usageTotals.inputTokens += normalized.inputTokens;
        usageTotals.outputTokens += normalized.outputTokens;
        usageTotals.cachedInputTokens += normalized.cachedInputTokens;
        usageTotals.cacheCreationTokens += normalized.cacheCreationTokens;
        usageTotals.calls += 1;
        limits.recordRound({ steps: 0, tokens: normalized.inputTokens });
      },
      onBeforeToolCall(ctx, hook) {
        if (ctx.signal?.aborted || controller.signal.aborted) {
          return { type: 'skip', result: 'TOOL_CANCELLED: no action was dispatched.' };
        }
        if (stall !== undefined && hook.toolName !== FINISH_TASK_TOOL) {
          return {
            type: 'skip',
            result: 'STALL_STOPPED: call finish_task now with your current findings.',
          };
        }
        return undefined;
      },
      onShouldContinue(ctx, loopState) {
        lastMessages = ctx.messages;
        recordTelemetry(ctx.iteration, 'success', null);
        stepsDone += 1;
        limits.recordRound({ steps: 1, tokens: 0 });

        if (finishedReport !== undefined) return false;
        if (loopState.finishReason != null && loopState.finishReason !== 'tool_calls') {
          return true;
        }

        const found = scanForStall(ctx.messages, undefined, OBSERVATION_TOOLS);
        if (found.worst === 'block' && stall === undefined) {
          stall = { repeats: found.repeats, why: found.why, tool: found.tool };
          pendingNotices.push(
            `${
              found.why === 'same-result'
                ? stallBlockCopy(found.repeats)
                : stallToolFailureBlockCopy(found.tool, found.repeats)
            } Call finish_task now.`,
          );
          logger.warn('coding.task.stall.blocked', {
            sessionId: invocation.sessionId,
            botId: invocation.botId,
            tool: found.tool,
            repeats: found.repeats,
            why: found.why,
          });
        } else if (found.worst === 'warn') {
          const key = `${found.tool}:${String(found.repeats)}`;
          if (!stallWarned.has(key)) {
            stallWarned.add(key);
            pendingNotices.push(stallWarnCopy(found.repeats));
          }
        }

        if (
          stall !== undefined &&
          (loopState.finishReason === null || loopState.finishReason === 'tool_calls')
        ) {
          if (stallClosing) return false;
          stallClosing = true;
        }

        return limits.check() === undefined;
      },
    };

    let runError: { readonly code: string; readonly message: string } | undefined;
    let streamError: unknown;
    let lastStreamedText = '';

    try {
      const systemPrompts = buildSystemPrompts(
        resolved.kind,
        codingTaskContextBlock({
          botId: invocation.botId,
          groupId: invocation.groupId,
          task,
        }),
        vault,
      );
      const initialUserMessage: ModelMessage = {
        role: 'user',
        content: codingTaskUserPrompt(task),
      };

      for await (const chunk of chat({
        adapter: resolved.adapter,
        debug: false,
        messages: [initialUserMessage],
        systemPrompts,
        tools: cappedTools,
        abortController: controller,
        agentLoopStrategy: ({ lastTurnToolCallCount }) =>
          lastTurnToolCallCount > 0 && finishedReport === undefined,
        middleware: [
          codingLifecycleMiddleware,
          providerCompaction({
            maxTokens: historyTokens,
            onCompact: (info) =>
              logger.info?.('coding.task.context.compacted', {
                sessionId: invocation.sessionId,
                botId: invocation.botId,
                ...info,
              }),
          }),
        ],
      })) {
        if (chunk.type === EventType.TEXT_MESSAGE_START) {
          lastStreamedText = '';
        } else if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
          lastStreamedText += chunk.delta;
        } else if (chunk.type === EventType.RUN_ERROR) {
          const normalized = normalizeRunError(chunk, {
            modelId: resolved.modelId,
            modelLabel: resolved.label,
            language: invocation.language,
            capabilities: resolved.capabilities,
            ...(resolved.included ? {} : { source: resolved.connectionName }),
          });
          runError = { code: normalized.code, message: normalized.message };
        }
      }
      recordOpenTelemetry('success');
    } catch (error) {
      streamError = error;
      if (isParentAborted()) {
        recordOpenTelemetry('interrupted');
      } else if (limits.stopped() !== undefined) {
        recordOpenTelemetry('interrupted');
      } else {
        const normalized = normalizeModelError(error, {
          modelId: resolved.modelId,
          modelLabel: resolved.label,
          language: invocation.language,
          capabilities: resolved.capabilities,
          ...(resolved.included ? {} : { source: resolved.connectionName }),
        });
        runError = { code: normalized.code, message: normalized.message };
        recordOpenTelemetry('error', normalized.code);
        logger.warn('coding.task.failed', {
          sessionId: invocation.sessionId,
          botId: invocation.botId,
          errorCode: normalized.code,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    } finally {
      limits.suspend();
      invocation.abortSignal?.removeEventListener('abort', cancel);
    }

    const cancelled = isParentAborted();
    if (cancelled && invocation.parentRunId !== undefined) {
      await this.deps.processes
        ?.stopRun?.(invocation.botId, invocation.parentRunId)
        .catch(() => undefined);
    }

    // Best-effort: files modified since then, including those changed through shell.
    if (!cancelled && sandboxSession !== undefined && changesSince !== null) {
      const modified = await filesModifiedSince(sandboxSession, task.cwd, changesSince);
      for (const relPath of modified ?? []) {
        if (filesChangedSet.size >= MAX_FILES_TRACKED) break;
        filesChangedSet.add(relPath);
      }
    }

    const stoppedBy: TurnLimitStop | undefined = limits.stopped();
    let status: CodingTaskStatus;
    if (cancelled) {
      status = 'cancelled';
    } else if (finishedReport !== undefined) {
      status = 'completed';
    } else if (runError !== undefined || (streamError !== undefined && stoppedBy === undefined)) {
      status = 'failed';
    } else if (stall !== undefined) {
      status = 'stalled';
    } else if (stoppedBy !== undefined) {
      status = 'limit_reached';
    } else {
      status = 'incomplete';
    }

    const rawSummary =
      finishedReport?.summary ??
      (cancelled
        ? 'Coding task was cancelled.'
        : runError !== undefined
          ? runError.message
          : projectPublicSpeech(lastStreamedText).trim() ||
            extractLastAssistantText(lastMessages) ||
            (stoppedBy !== undefined
              ? `Coding task reached its ${stoppedBy.kind} limit (${String(stoppedBy.observed)}/${String(stoppedBy.limit)}) before finishing.`
              : stall !== undefined
                ? `Coding task paused after repeating ${stall.tool} ${String(stall.repeats)} times without progress.`
                : 'Coding task ended without calling finish_task.'));

    const resolvedSummary = vault === undefined ? rawSummary : vault.resolveText(rawSummary);
    const cleanedSummary = projectPublicSpeech(resolvedSummary).trim().slice(0, MAX_SUMMARY_CHARS);

    const rawTests = finishedReport?.tests ?? {
      status: 'not_run' as const,
      command: undefined,
      detail: undefined,
    };
    const tests: CodingTestReport = {
      status: rawTests.status,
      ...(rawTests.command === undefined
        ? {}
        : {
            command: vault === undefined ? rawTests.command : vault.resolveText(rawTests.command),
          }),
      ...(rawTests.detail === undefined
        ? {}
        : { detail: vault === undefined ? rawTests.detail : vault.resolveText(rawTests.detail) }),
    };

    const estimatedCostUsd =
      usageTotals.calls === 0
        ? 0
        : catalogCostEstimate(resolved.kind, resolved.upstreamModelId, {
            inputTokens: usageTotals.inputTokens,
            outputTokens: usageTotals.outputTokens,
            totalTokens: usageTotals.inputTokens + usageTotals.outputTokens,
            cacheReadTokens: usageTotals.cachedInputTokens,
            cacheWriteTokens: usageTotals.cacheCreationTokens,
          });

    const usage: CodingTaskUsage = {
      modelKey,
      modelLabel: resolved.label,
      inputTokens: usageTotals.inputTokens,
      outputTokens: usageTotals.outputTokens,
      cachedInputTokens: usageTotals.cachedInputTokens,
      cacheCreationTokens: usageTotals.cacheCreationTokens,
      calls: usageTotals.calls,
      estimatedCostUsd,
    };

    const durationMs = elapsedMs();
    const filesChanged = [...filesChangedSet];

    emitProgress({
      kind: 'finished',
      sessionId: invocation.sessionId,
      runnerId: this.id,
      modelLabel: resolved.label,
      status,
      steps: stepsDone,
      maxSteps: invocation.maxSteps,
      durationMs,
      filesChangedCount: filesChanged.length,
    });

    return {
      status,
      runnerKind: this.kind,
      runnerId: this.id,
      sessionId: invocation.sessionId,
      summary: cleanedSummary,
      filesChanged,
      tests,
      commandsRun,
      blockedActions,
      steps: stepsDone,
      durationMs,
      usage,
      ...(runError === undefined ? {} : { error: runError }),
    };
  }
}
