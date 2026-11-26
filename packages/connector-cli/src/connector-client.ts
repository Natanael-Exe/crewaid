import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import {
  computeLocalTaskPayloadHash,
  createChildProcessTransport,
  resolveHarnessCommand,
  runAcpSession,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpProgressUpdate,
  type ResolvedHarnessCommand,
} from '@crewaid/acp-core';
import {
  CONNECTOR_PROTOCOL_VERSION,
  ConnectorServerFrameSchema,
  type ConnectorClientFrame,
  type ConnectorTaskDispatchFrame,
  type ConnectorTaskProgressFrame,
  type ConnectorTaskResultFrame,
  type LocalConnectorHarnessId,
  type LocalConnectorReportMode,
} from '@crewaid/shared';
import { WebSocket, type RawData } from 'ws';

import type { LocalTaskConfirmRequest } from './local-prompts.js';
import { resolveConfinedCwd } from './path-guard.js';

const WS_OPEN = 1;
const MAX_STDERR_TAIL_BYTES = 4_096;
const PERMANENT_CLOSE_CODES = new Set([4001, 4003]);

/** Variables that belong to this CLI and must never reach a coding harness. */
const CONNECTOR_ONLY_ENV = ['CREWAID_CONNECTOR_TOKEN'] as const;

/**
 * The environment a harness is started with: the user's own, minus the
 * connector's secrets. A harness is an AI agent acting on a prompt that came
 * from the server, so anything in its environment can end up in a command it
 * runs or in the summary it sends back. The user's own credentials (their
 * harness logins, git) stay, because the harness needs them to work.
 */
export function harnessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of CONNECTOR_ONLY_ENV) delete copy[name];
  return copy;
}

export interface ConnectorClientOptions {
  readonly wsUrl: string;
  readonly token: string;
  readonly cliVersion: string;
  readonly workspaceRoot: string;
  readonly workspaceName: string;
  readonly hostName?: string;
  readonly harnesses: readonly LocalConnectorHarnessId[];
  readonly defaultHarness: LocalConnectorHarnessId | null;
  readonly customCommand?: string;
  readonly reportMode: LocalConnectorReportMode;
  readonly trustServerApprovals: boolean;
  readonly disconnectGraceMs: number;
  readonly verbose?: boolean;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly log?: (line: string) => void;
  readonly confirmTask: (req: LocalTaskConfirmRequest, signal: AbortSignal) => Promise<boolean>;
  readonly requestPermission: (
    req: AcpPermissionRequest,
    signal: AbortSignal,
  ) => Promise<AcpPermissionDecision>;
  /** Test seam to override harness command resolution (e.g. pointing to mock-acp-agent.mjs). */
  readonly resolveHarness?: (harness: LocalConnectorHarnessId) => ResolvedHarnessCommand;
  /** Test seam to inspect/capture raw harness stderr chunks. */
  readonly onHarnessStderr?: (chunk: string) => void;
}

interface ActiveLocalTask {
  readonly sessionId: string;
  readonly abortController: AbortController;
  graceTimer: NodeJS.Timeout | undefined;
  pendingResult: ConnectorTaskResultFrame | undefined;
}

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function mapProgressUpdate(
  sessionId: string,
  update: AcpProgressUpdate,
): ConnectorTaskProgressFrame {
  switch (update.kind) {
    case 'started':
      return {
        type: 'task.progress',
        sessionId,
        kind: 'started',
        acpSessionId: update.acpSessionId,
        harness: update.harness,
        ...(update.agentName === undefined ? {} : { agentName: update.agentName }),
      };
    case 'step':
      return {
        type: 'task.progress',
        sessionId,
        kind: 'step',
        acpSessionId: update.acpSessionId,
        step: update.step,
        toolKind: update.toolKind,
        toolName: update.toolName,
        title: update.title,
        ...(update.target === undefined ? {} : { target: update.target }),
        ...(update.file === undefined ? {} : { file: update.file }),
        filesChangedCount: update.filesChangedCount,
      };
    case 'waiting_local_permission':
      return {
        type: 'task.progress',
        sessionId,
        kind: 'waiting_local_permission',
        acpSessionId: update.acpSessionId,
        toolCallId: update.toolCallId,
        title: update.title,
        toolKind: update.toolKind,
      };
    case 'resumed':
      return {
        type: 'task.progress',
        sessionId,
        kind: 'resumed',
        acpSessionId: update.acpSessionId,
        toolCallId: update.toolCallId,
        permissionOutcome: update.outcome,
      };
    case 'finished':
      return {
        type: 'task.progress',
        sessionId,
        kind: 'finished',
        acpSessionId: update.acpSessionId,
        status: update.status,
        step: update.steps,
        durationMs: update.durationMs,
        filesChangedCount: update.filesChangedCount,
      };
  }
}

function runGitReadOnly(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile('git', [...args], { cwd, timeout: 2_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        const trimmed = stdout.trim();
        resolve(trimmed === '' ? undefined : trimmed);
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function readGitHandoffInfo(
  cwd: string,
): Promise<{ readonly gitBranch?: string; readonly headSha?: string }> {
  const [branch, sha] = await Promise.all([
    runGitReadOnly(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGitReadOnly(cwd, ['rev-parse', '--short', 'HEAD']),
  ]);
  return {
    ...(branch === undefined || branch === 'HEAD' ? {} : { gitBranch: branch }),
    ...(sha === undefined || sha.length < 7 ? {} : { headSha: sha }),
  };
}

/**
 * Outbound WebSocket client for `crewaid-connect`.
 *
 * Maintains a single outbound socket to `/ws/connectors` authenticated by
 * `Authorization: Bearer crw_conn_…`, enforces one active task at a time,
 * runs local confirmation + local-only ACP permissions, drains harness stderr
 * unconditionally so chatty harnesses never freeze, and cancels active local
 * sessions if connectivity drops longer than `disconnectGraceMs`.
 */
export class ConnectorClient {
  private readonly hostName: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly log: (line: string) => void;

  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private stopped = false;
  private activeTask: ActiveLocalTask | null = null;
  private resolveDone: ((exitCode: number) => void) | undefined;
  readonly done: Promise<number>;

  constructor(private readonly options: ConnectorClientOptions) {
    this.hostName = options.hostName ?? os.hostname();
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15_000;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  start(): void {
    if (this.stopped) return;
    this.connect();
  }

  stop(exitCode = 0): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.activeTask !== null) {
      clearTimeout(this.activeTask.graceTimer);
      this.activeTask.abortController.abort();
    }
    const ws = this.socket;
    this.socket = undefined;
    if (ws !== undefined) {
      try {
        ws.close(1000, 'Connector stopped');
      } catch {
        // Ignore close errors during shutdown.
      }
    }
    this.resolveDone?.(exitCode);
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.options.wsUrl, {
      headers: {
        authorization: `Bearer ${this.options.token}`,
      },
    });
    this.socket = ws;

    ws.on('open', () => {
      if (this.socket !== ws || this.stopped) {
        ws.close(1000);
        return;
      }
      const hello: ConnectorClientFrame = {
        type: 'connector.hello',
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        cliVersion: this.options.cliVersion,
        workspaceName: this.options.workspaceName,
        hostName: this.hostName,
        harnesses: [...this.options.harnesses],
        defaultHarness: this.options.defaultHarness,
        reportMode: this.options.reportMode,
        ...(this.activeTask === null ? {} : { activeSessionId: this.activeTask.sessionId }),
      };
      this.send(hello);
    });

    ws.on('message', (raw: RawData) => {
      if (this.socket !== ws) return;
      this.handleRawMessage(raw);
    });

    ws.on('unexpected-response', (_req, res) => {
      if (this.socket !== ws) return;
      const status = res.statusCode ?? 0;
      if (status === 401 || status === 403) {
        this.log(
          `Authentication failed (HTTP ${String(status)}). Check your connector token or rotate it in Crewaid Settings → Local harnesses.`,
        );
        this.stop(1);
      } else {
        this.log(`Server rejected WebSocket upgrade (HTTP ${String(status)}); retrying…`);
      }
    });

    ws.on('error', (error: Error) => {
      if (this.stopped) return;
      this.log(`Connection error: ${error.message}`);
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      if (this.socket === ws) {
        this.socket = undefined;
      }
      if (this.stopped) return;
      const reason = reasonBuf.toString('utf8');
      if (PERMANENT_CLOSE_CODES.has(code)) {
        const guidance =
          code === 4003
            ? 'Please update crewaid-connect to the latest version (npx crewaid-connect@latest).'
            : 'Token was rotated or connector was revoked in Crewaid Settings.';
        this.log(
          `Disconnected permanently (${String(code)}${reason ? `: ${reason}` : ''}). ${guidance}`,
        );
        this.stop(1);
        return;
      }

      this.log(`Disconnected (${String(code)}${reason ? `: ${reason}` : ''}). Reconnecting…`);
      this.armDisconnectGraceIfBusy();
      this.scheduleReconnect();
    });
  }

  private armDisconnectGraceIfBusy(): void {
    const task = this.activeTask;
    if (task === null || task.graceTimer !== undefined) return;
    task.graceTimer = setTimeout(() => {
      if (this.activeTask !== task) return;
      if (this.socket !== undefined && this.socket.readyState === WS_OPEN) return;
      this.log(
        `Could not reconnect within ${String(Math.round(this.options.disconnectGraceMs / 1000))}s; cancelling active local task ${task.sessionId}.`,
      );
      task.abortController.abort();
    }, this.options.disconnectGraceMs);
    task.graceTimer.unref();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private send(frame: ConnectorClientFrame): boolean {
    const ws = this.socket;
    if (ws === undefined || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private handleRawMessage(raw: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToText(raw));
    } catch {
      this.log('Received malformed JSON frame from server.');
      return;
    }
    const validated = ConnectorServerFrameSchema.safeParse(parsed);
    if (!validated.success) {
      this.log(
        `Ignored unrecognized server frame: ${validated.error.issues[0]?.message ?? 'invalid'}`,
      );
      return;
    }
    const frame = validated.data;
    switch (frame.type) {
      case 'connector.welcome': {
        this.reconnectAttempt = 0;
        this.captureConnectorId(frame.connectorId);
        this.log(
          `Connected as "${frame.name}" (${this.options.workspaceName}, reportMode=${this.options.reportMode}, harnesses=${this.options.harnesses.join(', ')}).`,
        );
        const task = this.activeTask;
        if (task !== null) {
          if (frame.resumeAccepted === true) {
            clearTimeout(task.graceTimer);
            task.graceTimer = undefined;
            if (task.pendingResult !== undefined) {
              if (this.send(task.pendingResult)) {
                this.activeTask = null;
              }
            }
          } else if (frame.resumeAccepted === false) {
            clearTimeout(task.graceTimer);
            task.graceTimer = undefined;
            this.log(`Server expired session ${task.sessionId}; cancelling local harness.`);
            task.abortController.abort();
          }
        }
        return;
      }
      case 'connector.error': {
        this.log(`Server error (${frame.code}): ${frame.message}`);
        if (frame.code === 'CLI_OUTDATED' || frame.code === 'UNAUTHORIZED') {
          this.stop(1);
        }
        return;
      }
      case 'task.cancel': {
        const task = this.activeTask;
        if (task !== null && task.sessionId === frame.sessionId) {
          this.log(
            `Cancelling local task ${frame.sessionId}${frame.reason ? ` (${frame.reason})` : ''}.`,
          );
          task.abortController.abort();
        }
        return;
      }
      case 'task.dispatch': {
        void this.handleDispatch(frame);
        return;
      }
    }
  }

  private sendOrQueueResult(task: ActiveLocalTask, result: ConnectorTaskResultFrame): void {
    if (this.send(result)) {
      if (this.activeTask === task) {
        clearTimeout(task.graceTimer);
        this.activeTask = null;
      }
      return;
    }
    // If the socket is momentarily reconnecting within the grace window, hold
    // the result until connector.welcome(resumeAccepted: true) arrives.
    if (this.activeTask === task && !this.stopped) {
      task.pendingResult = result;
    }
  }

  private async handleDispatch(frame: ConnectorTaskDispatchFrame): Promise<void> {
    const startedAt = Date.now();
    const failImmediately = (code: string, message: string) => {
      this.send({
        type: 'task.result',
        sessionId: frame.sessionId,
        status: 'failed',
        acpSessionId: null,
        reportMode: this.options.reportMode,
        summary: message,
        filesChanged: [],
        commandsRun: [],
        steps: 0,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: { code, message },
      });
    };

    if (this.activeTask !== null) {
      failImmediately('CONNECTOR_BUSY', 'This local connector is already running another task.');
      return;
    }

    if (!this.options.harnesses.includes(frame.harness)) {
      failImmediately(
        'HARNESS_UNAVAILABLE',
        `Harness "${frame.harness}" is not enabled on this connector.`,
      );
      return;
    }

    let confined: { readonly normalizedRelative: string; readonly absoluteCwd: string };
    try {
      confined = resolveConfinedCwd(this.options.workspaceRoot, frame.relativeCwd);
    } catch (error: unknown) {
      failImmediately(
        'INVALID_CWD',
        error instanceof Error ? error.message : 'Requested directory is outside workspace.',
      );
      return;
    }

    const task: ActiveLocalTask = {
      sessionId: frame.sessionId,
      abortController: new AbortController(),
      graceTimer: undefined,
      pendingResult: undefined,
    };
    this.activeTask = task;

    try {
      // Integrity check catching serialization/routing bugs between server and CLI.
      // Note: this does NOT defend against a compromised server (local confirmation does).
      if (this.lastConnectorId !== undefined) {
        const computed = computeLocalTaskPayloadHash({
          botId: frame.botId,
          connectorId: this.lastConnectorId,
          relativeCwd: confined.normalizedRelative,
          harness: frame.harness,
          prompt: frame.prompt,
          ...(frame.verifyCommand === undefined ? {} : { verifyCommand: frame.verifyCommand }),
        });
        if (computed !== frame.payloadHash) {
          this.sendOrQueueResult(task, {
            type: 'task.result',
            sessionId: frame.sessionId,
            status: 'failed',
            acpSessionId: null,
            reportMode: this.options.reportMode,
            summary: 'Task payload hash mismatch between orchestrator and connector CLI.',
            filesChanged: [],
            commandsRun: [],
            steps: 0,
            durationMs: Math.max(0, Date.now() - startedAt),
            error: {
              code: 'PAYLOAD_HASH_MISMATCH',
              message: 'Dispatched task payload hash did not match computed local hash.',
            },
          });
          return;
        }
      }

      if (!this.options.trustServerApprovals) {
        const confirmed = await this.options.confirmTask(
          {
            botName: frame.botName,
            workspaceName: this.options.workspaceName,
            relativeCwd: confined.normalizedRelative,
            harness: frame.harness,
            reportMode: this.options.reportMode,
            prompt: frame.prompt,
            ...(frame.verifyCommand === undefined ? {} : { verifyCommand: frame.verifyCommand }),
          },
          task.abortController.signal,
        );
        if (!confirmed) {
          this.sendOrQueueResult(task, {
            type: 'task.result',
            sessionId: frame.sessionId,
            status: task.abortController.signal.aborted ? 'cancelled' : 'failed',
            acpSessionId: null,
            reportMode: this.options.reportMode,
            summary: task.abortController.signal.aborted
              ? 'Local task was cancelled before launch.'
              : 'Task was declined in the local terminal.',
            filesChanged: [],
            commandsRun: [],
            steps: 0,
            durationMs: Math.max(0, Date.now() - startedAt),
            ...(task.abortController.signal.aborted
              ? {}
              : {
                  error: {
                    code: 'LOCAL_TASK_DECLINED',
                    message: 'Operator declined this task in the local terminal.',
                  },
                }),
          });
          return;
        }
      }

      let resolvedCmd: ResolvedHarnessCommand;
      try {
        resolvedCmd =
          this.options.resolveHarness !== undefined
            ? this.options.resolveHarness(frame.harness)
            : resolveHarnessCommand(frame.harness, this.options.customCommand);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.sendOrQueueResult(task, {
          type: 'task.result',
          sessionId: frame.sessionId,
          status: 'failed',
          acpSessionId: null,
          reportMode: this.options.reportMode,
          summary: message,
          filesChanged: [],
          commandsRun: [],
          steps: 0,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: { code: 'HARNESS_UNAVAILABLE', message },
        });
        return;
      }

      const child = spawn(resolvedCmd.command, [...resolvedCmd.args], {
        cwd: confined.absoluteCwd,
        env: harnessEnvironment(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });

      // Unconditionally drain harness stderr so a chatty harness can never fill
      // the OS pipe buffer and deadlock. Stream to terminal under `--verbose`
      // and keep a bounded tail for failure diagnostics.
      let stderrTail = '';
      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        this.options.onHarnessStderr?.(text);
        if (this.options.verbose === true) {
          process.stderr.write(text);
        }
        stderrTail = `${stderrTail}${text}`.slice(-MAX_STDERR_TAIL_BYTES);
      });

      let spawnError: Error | undefined;
      child.once('error', (err) => {
        spawnError = err;
      });

      const deadlineTimer = setTimeout(() => {
        task.abortController.abort();
      }, frame.maxDurationMs);
      deadlineTimer.unref();

      const promptWithVerify =
        frame.verifyCommand === undefined || frame.verifyCommand.trim() === ''
          ? frame.prompt
          : `${frame.prompt}\n\nVerification command to run before finishing: ${frame.verifyCommand}`;

      let output;
      try {
        const transport = createChildProcessTransport(child);
        output = await runAcpSession({
          transport,
          cwd: confined.absoluteCwd,
          prompt: promptWithVerify,
          harnessId: frame.harness,
          reportMode: this.options.reportMode,
          clientInfo: { name: 'crewaid-connect', version: this.options.cliVersion },
          abortSignal: task.abortController.signal,
          onProgress: (update) => {
            this.send(mapProgressUpdate(frame.sessionId, update));
          },
          onPermissionRequest: (req, signal) => this.options.requestPermission(req, signal),
        });
      } finally {
        clearTimeout(deadlineTimer);
      }

      const git = await readGitHandoffInfo(confined.absoluteCwd);
      const errorDetail =
        output.error !== undefined
          ? {
              code: output.error.code,
              message:
                spawnError !== undefined
                  ? `Failed to launch "${resolvedCmd.command}": ${spawnError.message}`
                  : stderrTail.trim() !== '' && output.status === 'failed'
                    ? `${output.error.message} (${stderrTail.trim().slice(-300)})`
                    : output.error.message,
            }
          : undefined;

      this.sendOrQueueResult(task, {
        type: 'task.result',
        sessionId: frame.sessionId,
        status: output.status,
        acpSessionId: output.acpSessionId,
        ...(output.agentName === undefined ? {} : { agentName: output.agentName }),
        reportMode: output.reportMode,
        summary: output.summary,
        filesChanged: [...output.filesChanged],
        commandsRun: output.commandsRun.map((c) => ({ command: c.command, status: c.status })),
        steps: output.steps,
        durationMs: output.durationMs,
        ...git,
        ...(output.transcriptExcerpt === undefined
          ? {}
          : { transcriptExcerpt: output.transcriptExcerpt }),
        ...(output.diffExcerpt === undefined ? {} : { diffExcerpt: output.diffExcerpt }),
        ...(errorDetail === undefined ? {} : { error: errorDetail }),
      });
    } finally {
      if (this.activeTask === task && task.pendingResult === undefined) {
        clearTimeout(task.graceTimer);
        this.activeTask = null;
      }
    }
  }

  private lastConnectorId: string | undefined;

  /** Updated on welcome so `computeLocalTaskPayloadHash` binds the exact connectorId. */
  private captureConnectorId(id: string): void {
    this.lastConnectorId = id;
  }
}
