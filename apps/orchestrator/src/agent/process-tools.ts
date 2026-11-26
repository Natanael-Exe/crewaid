import { NativeToolInputs } from '@crewaid/shared';

import { tool } from './tool-contract.js';
import { CONTAINED_BUILTIN, OBSERVING_BUILTIN, SENSITIVE_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';
import type { MachineSeatPort } from './machine-tools.js';
import { seatEnv } from './seat-env.js';
import { MACHINE_HOME, resolveWorkspacePath } from './workspace-paths.js';
import type {
  MachineProcessPort,
  ManagedProcessInfo,
  ManagedProcessOutput,
} from '../sandbox/machine-process.service.js';

/**
 * Managed background process tools: `process_start`, `process_output`, `process_stop`.
 *
 * Designed for dev servers and >120s test/build runs that exceed `shell`'s bound.
 * Approval polarity matches the rest of the computer surface:
 * - `process_start` is `SENSITIVE_BUILTIN` (arbitrary command, same gate as `shell`).
 * - `process_output` is `OBSERVING_BUILTIN` (read-only inspection).
 * - `process_stop` is `CONTAINED_BUILTIN` (terminates a process this bot started).
 */

const MAX_OUTPUT_CHARS = 16_000;
const DEFAULT_WAIT_MS = 5_000;

function failure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${detail}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

function formatExpiry(expiresAtMs: number): string {
  return new Date(expiresAtMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function statusLine(info: ManagedProcessInfo): string {
  if (info.status === 'running') {
    return `running (${formatDuration(info.remainingSec)} left; auto-stops at ${formatExpiry(info.expiresAtMs)})`;
  }
  const exitPart = info.exitCode === null ? 'exited' : `exited (code ${info.exitCode})`;
  return info.stopReason !== null ? `${exitPart}, reason: ${info.stopReason}` : exitPart;
}

function boundedOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const kept = text.slice(text.length - MAX_OUTPUT_CHARS);
  return `… truncated to last ${MAX_OUTPUT_CHARS.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters:\n${kept}`;
}

function formatProcessList(items: readonly ManagedProcessInfo[]): string {
  if (items.length === 0) return 'No running or recent background processes for this bot.';
  return items
    .map(
      (item) =>
        `${item.processId} · ${statusLine(item)}\n  cwd: ${item.cwd}\n  cmd: ${item.command}`,
    )
    .join('\n');
}

function formatProcessOutput(res: ManagedProcessOutput): string {
  const lines = [
    `${res.processId} · ${statusLine(res)}`,
    `offset: ${res.offset} -> nextOffset: ${res.nextOffset} (${res.totalBytes} bytes total)`,
  ];
  if (res.truncated) {
    lines.push(
      `[older output before byte ${res.droppedBytes} was evicted from the 512 KiB ring buffer]`,
    );
  }
  const body = res.output.trimEnd();
  if (body === '') {
    lines.push(res.status === 'running' ? '(no new output yet)' : '(no new output)');
  } else {
    lines.push(`output:\n${boundedOutput(body)}`);
  }
  return lines.join('\n');
}

export function processTools(deps: {
  readonly machines: MachineSeatPort;
  readonly processes: MachineProcessPort;
}): RegisteredTool[] {
  return [
    {
      name: 'process_start',
      behavior: SENSITIVE_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Start a managed background process on this bot’s computer (for dev servers, watchers, ' +
            'or build/test runs longer than shell’s 120s limit). Returns a processId and explicit ' +
            'time limit (default 30m). Processes from a cancelled turn are stopped automatically; ' +
            'processes from a finished turn stay running until process_stop or the time limit, so ' +
            'stop dev servers when you finish verifying them.',
          inputSchema: NativeToolInputs.process_start,
          execute: async (
            {
              command,
              cwd,
              maxDurationSec,
            }: {
              command: string;
              cwd?: string | undefined;
              maxDurationSec?: number | undefined;
            },
            { abortSignal }: { abortSignal?: AbortSignal },
          ) => {
            if (command.trim() === '') return 'process_start failed: a command is required';
            const ownArea = `${MACHINE_HOME}/agents/${context.botId}`;
            const targetCwd = cwd === undefined || cwd.trim() === '' ? ownArea : cwd;
            const verdict = resolveWorkspacePath(context.botId, targetCwd, context.groupId ?? null);
            if (!verdict.ok) return `process_start refused: ${verdict.reason}`;
            const isAborted = (): boolean => abortSignal?.aborted === true;
            if (isAborted()) {
              return 'process_start: the turn was cancelled before the process started.';
            }

            try {
              // Wake the computer first through the shared turn session path.
              await context.session();
              if (isAborted()) {
                return 'process_start: the turn was cancelled before the process started.';
              }
              let env: Record<string, string>;
              try {
                env = seatEnv(await deps.machines.ensureSeatFor(context.botId));
              } catch {
                env = { DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: '' };
              }
              const started = await deps.processes.start({
                userId: context.userId,
                botId: context.botId,
                runId: context.runId,
                command,
                cwd: verdict.path,
                env,
                maxDurationSec,
              });
              return [
                `Started background process ${started.processId} (${started.status})`,
                `cwd: ${started.cwd}`,
                `time limit: ${formatDuration(started.maxDurationSec)} (auto-stops at ${formatExpiry(started.expiresAtMs)} unless stopped earlier with process_stop)`,
                'Use process_output to read logs and process_stop when finished.',
              ].join('\n');
            } catch (error) {
              return failure('process_start', error);
            }
          },
        }),
    },
    {
      name: 'process_output',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Inspect a managed background process started with process_start. Pass processId (and ' +
            'nextOffset from the previous call) to read incremental logs, waiting up to waitMs ' +
            '(default 5000ms, max 30000ms) for new output or exit. Omit processId to list your ' +
            'running and recently exited processes.',
          inputSchema: NativeToolInputs.process_output,
          execute: async (
            {
              processId,
              offset,
              waitMs,
            }: {
              processId?: string | undefined;
              offset?: number | undefined;
              waitMs?: number | undefined;
            },
            { abortSignal }: { abortSignal?: AbortSignal },
          ) => {
            try {
              if (processId === undefined) {
                const items = await deps.processes.list(context.botId);
                return formatProcessList(items);
              }
              const res = await deps.processes.readOutput({
                botId: context.botId,
                processId,
                offset: offset ?? 0,
                waitMs: waitMs ?? DEFAULT_WAIT_MS,
                abortSignal,
              });
              if (res === null) {
                return `process_output: no background process named ${processId} was found (it may have expired or the computer restarted).`;
              }
              return formatProcessOutput(res);
            } catch (error) {
              if (abortSignal?.aborted === true) {
                return 'process_output: stopped waiting because the turn was cancelled.';
              }
              return failure('process_output', error);
            }
          },
        }),
    },
    {
      name: 'process_stop',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Stop a running managed background process (and its child process group) started with ' +
            'process_start. Always call this when finished with a dev server or watcher so the ' +
            'computer can idle-stop cleanly.',
          inputSchema: NativeToolInputs.process_stop,
          execute: async ({ processId }: { processId: string }) => {
            try {
              const res = await deps.processes.stop(context.botId, processId);
              if (res === null) {
                return `process_stop: no background process named ${processId} was found.`;
              }
              const tail = res.output.trimEnd();
              return [
                `Stopped ${res.processId} · ${statusLine(res)}`,
                ...(tail === '' ? [] : [`tail output:\n${boundedOutput(tail)}`]),
              ].join('\n');
            } catch (error) {
              return failure('process_stop', error);
            }
          },
        }),
    },
  ];
}
