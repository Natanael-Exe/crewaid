import { Inject, Injectable } from '@nestjs/common';
import type {
  ConnectorTaskProgressFrame,
  ConnectorTaskResultFrame,
  LocalConnectorHarnessId,
  LocalConnectorReportMode,
} from '@crewaid/shared';

import type {
  CodingCommandRecord,
  CodingProgressEvent,
  CodingResult,
  CodingRunnerKind,
  CodingTestReport,
} from '../agent/coding/coding-runner.port.js';
import { ConnectorWsHost } from './connector-ws.host.js';

export interface LocalTaskRunInput {
  readonly connectorId: string;
  readonly connectorName: string;
  readonly sessionId: string;
  readonly payloadHash: string;
  readonly botId: string;
  readonly botName: string;
  readonly relativeCwd: string;
  readonly harness: LocalConnectorHarnessId;
  readonly prompt: string;
  readonly verifyCommand?: string;
  readonly maxDurationMs: number;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (event: CodingProgressEvent) => void;
}

export interface LocalCodingResult extends CodingResult {
  readonly acpSessionId: string | null;
  readonly reportMode: LocalConnectorReportMode;
  readonly agentName?: string;
  readonly gitBranch?: string;
  readonly headSha?: string;
  readonly transcriptExcerpt?: string;
  readonly diffExcerpt?: string;
}

function mapProgressFrame(
  input: LocalTaskRunInput,
  runnerId: string,
  frame: ConnectorTaskProgressFrame,
): CodingProgressEvent {
  const modelLabel = frame.agentName ?? frame.harness ?? input.harness;
  switch (frame.kind) {
    case 'started':
      return {
        kind: 'started',
        sessionId: input.sessionId,
        runnerId,
        modelLabel,
        maxSteps: 0,
        cwd: input.relativeCwd,
      };
    case 'step':
      return {
        kind: 'step',
        sessionId: input.sessionId,
        runnerId,
        modelLabel,
        step: frame.step ?? 0,
        maxSteps: 0,
        toolName: frame.toolName ?? 'tool',
        action: frame.title ?? frame.toolKind ?? 'Working',
        ...(frame.target === undefined ? {} : { target: frame.target }),
        ...(frame.file === undefined ? {} : { file: frame.file }),
        filesChangedCount: frame.filesChangedCount ?? 0,
      };
    case 'waiting_local_permission':
      return {
        kind: 'waiting_local_permission',
        sessionId: input.sessionId,
        runnerId,
        connectorName: input.connectorName,
        toolCallId: frame.toolCallId ?? '',
        title: frame.title ?? 'Waiting for local approval',
        toolKind: frame.toolKind ?? 'other',
      };
    case 'resumed':
      return {
        kind: 'resumed',
        sessionId: input.sessionId,
        runnerId,
        connectorName: input.connectorName,
        toolCallId: frame.toolCallId ?? '',
        outcome: frame.permissionOutcome ?? 'selected',
      };
    case 'finished':
      return {
        kind: 'finished',
        sessionId: input.sessionId,
        runnerId,
        modelLabel,
        status: frame.status ?? 'completed',
        steps: frame.step ?? 0,
        maxSteps: 0,
        durationMs: frame.durationMs ?? 0,
        filesChangedCount: frame.filesChangedCount ?? 0,
      };
  }
}

function mapCommands(frame: ConnectorTaskResultFrame): CodingCommandRecord[] {
  return frame.commandsRun.map((record) => ({
    command: record.command,
    exitCode: record.status === 'completed' ? 0 : record.status === 'failed' ? 1 : null,
  }));
}

function deriveTestReport(
  verifyCommand: string | undefined,
  frame: ConnectorTaskResultFrame,
): CodingTestReport {
  if (verifyCommand === undefined || verifyCommand.trim() === '') {
    return { status: 'not_run' };
  }
  const normalized = verifyCommand.trim();
  const matched = [...frame.commandsRun]
    .reverse()
    .find((cmd) => cmd.command.includes(normalized) || normalized.includes(cmd.command));
  if (matched === undefined) {
    return { status: 'not_run', command: normalized };
  }
  if (matched.status === 'completed') {
    return { status: 'passed', command: normalized };
  }
  if (matched.status === 'failed') {
    return { status: 'failed', command: normalized };
  }
  return { status: 'not_run', command: normalized };
}

/**
 * Remote ACP-over-WebSocket coding runner (`runnerKind: 'acp_local'`).
 *
 * Dispatches approved tasks to the user's standalone `crewaid-connect` CLI via
 * `ConnectorWsHost` and translates wire frames into the shared `CodingResult`
 * and `CodingProgressEvent` contracts.
 */
@Injectable()
export class LocalConnectorCodingRunner {
  readonly id = 'acp:local';
  readonly kind: CodingRunnerKind = 'acp_local';

  constructor(@Inject(ConnectorWsHost) private readonly host: ConnectorWsHost) {}

  async runLocalTask(input: LocalTaskRunInput): Promise<LocalCodingResult> {
    const runnerId = `${this.id}:${input.harness}`;
    const resultFrame = await this.host.dispatchTask({
      connectorId: input.connectorId,
      sessionId: input.sessionId,
      payloadHash: input.payloadHash,
      botId: input.botId,
      botName: input.botName,
      relativeCwd: input.relativeCwd,
      harness: input.harness,
      prompt: input.prompt,
      ...(input.verifyCommand === undefined ? {} : { verifyCommand: input.verifyCommand }),
      maxDurationMs: input.maxDurationMs,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      onProgress: (frame) => {
        input.onProgress?.(mapProgressFrame(input, runnerId, frame));
      },
    });

    return {
      status: resultFrame.status,
      runnerKind: this.kind,
      runnerId,
      sessionId: input.sessionId,
      acpSessionId: resultFrame.acpSessionId,
      reportMode: resultFrame.reportMode,
      ...(resultFrame.agentName === undefined ? {} : { agentName: resultFrame.agentName }),
      summary: resultFrame.summary,
      filesChanged: resultFrame.filesChanged,
      tests: deriveTestReport(input.verifyCommand, resultFrame),
      commandsRun: mapCommands(resultFrame),
      blockedActions: [],
      steps: resultFrame.steps,
      durationMs: resultFrame.durationMs,
      ...(resultFrame.gitBranch === undefined ? {} : { gitBranch: resultFrame.gitBranch }),
      ...(resultFrame.headSha === undefined ? {} : { headSha: resultFrame.headSha }),
      ...(resultFrame.transcriptExcerpt === undefined
        ? {}
        : { transcriptExcerpt: resultFrame.transcriptExcerpt }),
      ...(resultFrame.diffExcerpt === undefined ? {} : { diffExcerpt: resultFrame.diffExcerpt }),
      ...(resultFrame.error === undefined ? {} : { error: resultFrame.error }),
    };
  }
}
