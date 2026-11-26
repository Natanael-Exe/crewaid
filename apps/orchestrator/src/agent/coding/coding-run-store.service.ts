import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CodingRunnerKind, CodingTaskStatus } from './coding-runner.port.js';

export interface StartCodingRunInput {
  readonly id: string;
  readonly userId: string;
  readonly botId: string;
  readonly parentRunId: string | null;
  readonly runnerKind: CodingRunnerKind;
  readonly runnerId: string;
  readonly cwd: string;
  readonly connectorId?: string | null;
  readonly payloadHash?: string | null;
  readonly reportMode?: string | null;
}

export interface SettleCodingRunInput {
  readonly id: string;
  readonly userId: string;
  readonly botId: string;
  readonly modelId: string | null;
  readonly status: CodingTaskStatus;
  readonly steps: number;
  readonly workingMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly filesChanged: readonly string[];
  readonly errorCode: string | null;
  readonly acpSessionId?: string | null;
}

export interface CodingRunStore {
  start(input: StartCodingRunInput): Promise<void>;
  settle(input: SettleCodingRunInput): Promise<void>;
  reconcileAbandonedForRun(userId: string, botId: string, parentRunId: string): Promise<number>;
}

/**
 * Owner-scoped persistence for delegated `code_task` runs.
 *
 * Every query is scoped directly by `userId` (R7), and records each coding
 * run's own `modelId` billing identity so `/usage` prices separate coding
 * models accurately alongside `AgentTurn` rows.
 */
@Injectable()
export class CodingRunStoreService implements CodingRunStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async start(input: StartCodingRunInput): Promise<void> {
    const prisma = this.prisma;
    await prisma.codingRun.create({
      data: {
        id: input.id,
        userId: input.userId,
        botId: input.botId,
        parentRunId: input.parentRunId,
        runnerKind: input.runnerKind,
        runnerId: input.runnerId,
        cwd: input.cwd,
        ...(input.connectorId === undefined ? {} : { connectorId: input.connectorId }),
        ...(input.payloadHash === undefined ? {} : { payloadHash: input.payloadHash }),
        ...(input.reportMode === undefined ? {} : { reportMode: input.reportMode }),
        status: 'running',
      },
    });
  }

  async settle(input: SettleCodingRunInput): Promise<void> {
    const prisma = this.prisma;
    await prisma.codingRun.updateMany({
      where: {
        id: input.id,
        userId: input.userId,
        botId: input.botId,
      },
      data: {
        modelId: input.modelId,
        status: input.status,
        steps: Math.max(0, Math.round(input.steps)),
        workingMs: Math.max(0, Math.round(input.workingMs)),
        inputTokens: Math.max(0, Math.round(input.inputTokens)),
        outputTokens: Math.max(0, Math.round(input.outputTokens)),
        cachedInputTokens: Math.max(0, Math.round(input.cachedInputTokens)),
        cacheCreationTokens: Math.max(0, Math.round(input.cacheCreationTokens)),
        filesChanged: [...input.filesChanged],
        errorCode: input.errorCode,
        ...(input.acpSessionId === undefined ? {} : { acpSessionId: input.acpSessionId }),
        endedAt: new Date(),
      },
    });
  }

  async reconcileAbandonedForRun(
    userId: string,
    botId: string,
    parentRunId: string,
  ): Promise<number> {
    const prisma = this.prisma;
    const res = await prisma.codingRun.updateMany({
      where: {
        userId,
        botId,
        parentRunId,
        status: 'running',
      },
      data: {
        status: 'failed',
        errorCode: 'WORKER_LOST',
        endedAt: new Date(),
      },
    });
    return res.count;
  }
}
