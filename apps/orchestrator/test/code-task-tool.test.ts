import { describe, expect, it, vi } from 'vitest';
import { MODEL_REF_DEFAULT } from '@crewaid/shared';
import {
  CODING_PROGRESS_EVENT,
  codeTaskTool,
} from '../src/agent/code-task-tool.js';
import type { CodingRunStore } from '../src/agent/coding/coding-run-store.service.js';
import type {
  CodingInvocation,
  CodingResult,
  CodingRunner,
  CodingTask,
} from '../src/agent/coding/coding-runner.port.js';
import type { ToolDefinition } from '../src/agent/tool-contract.js';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { MACHINE_HOME } from '../src/agent/workspace-paths.js';

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const OWN = `${MACHINE_HOME}/agents/${BOT}`;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'user-1',
    botId: BOT,
    runId: 'run-parent-1',
    groupId: null,
    botModelId: 'pm_parent_model',
    codingModelId: null,
    language: 'en',
    trigger: { id: 'trig-1', chainId: null, hopCount: 0 },
    attachmentHost: () => Promise.resolve('msg-1'),
    browser: () => Promise.reject(new Error('unused')),
    session: () => Promise.reject(new Error('unused')),
    ...overrides,
  } as unknown as ToolContext;
}

function completedResult(overrides: Partial<CodingResult> = {}): CodingResult {
  return {
    status: 'completed',
    runnerKind: 'builtin',
    runnerId: 'builtin',
    sessionId: 'code_session',
    summary: 'Fixed token refresh and updated tests.',
    filesChanged: ['src/auth.ts', 'test/auth.test.ts'],
    tests: { status: 'passed', command: 'pnpm test', detail: '12 passed' },
    commandsRun: [{ command: 'pnpm test', exitCode: 0 }],
    blockedActions: [],
    steps: 4,
    durationMs: 12_400,
    usage: {
      modelKey: 'openai:gpt-5.2',
      modelLabel: 'GPT-5.2',
      inputTokens: 15_000,
      outputTokens: 1_200,
      cachedInputTokens: 3_000,
      cacheCreationTokens: 0,
      calls: 4,
      estimatedCostUsd: 0.04,
    },
    ...overrides,
  };
}

describe('codeTaskTool', () => {
  it('registers as a contained built-in tool', () => {
    const entry = codeTaskTool({
      runner: {
        id: 'builtin',
        kind: 'builtin',
        run: () => Promise.resolve(completedResult()),
      },
    });
    expect(entry.name).toBe('code_task');
    expect(entry.behavior.effect).toBe('draft');
    expect(entry.behavior.origin).toEqual({ kind: 'builtin' });
  });

  it('refuses workspace escapes before starting a run or touching the runner', async () => {
    const runSpy = vi.fn();
    const startSpy = vi.fn();
    const entry = codeTaskTool({
      runner: { id: 'builtin', kind: 'builtin', run: runSpy },
      runs: { start: startSpy, settle: vi.fn() },
    });
    const built = entry.build(makeContext()) as ToolDefinition & {
      execute: (input: unknown, options: unknown) => Promise<string>;
    };

    const output = await built.execute(
      { goal: 'Inspect secrets', cwd: '/etc' },
      { toolCallId: 'tc-1' },
    );

    expect(output).toContain('code_task refused:');
    expect(output).toContain(`outside ${MACHINE_HOME}`);
    expect(runSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('runs the delegated CodingRunner, persists lifecycle, emits live progress, and formats a compact report', async () => {
    const captured: { task?: CodingTask; invocation?: CodingInvocation } = {};
    const emitted: Array<{ name: string; value: Record<string, unknown> }> = [];
    const start = vi.fn<CodingRunStore['start']>().mockResolvedValue(undefined);
    const settle = vi.fn<CodingRunStore['settle']>().mockResolvedValue(undefined);

    const runner: CodingRunner = {
      id: 'builtin',
      kind: 'builtin',
      async run(task, invocation) {
        captured.task = task;
        captured.invocation = invocation;
        invocation.onProgress?.({
          kind: 'started',
          sessionId: invocation.sessionId,
          runnerId: 'builtin',
          modelLabel: 'GPT-5.2',
          maxSteps: invocation.maxSteps,
          cwd: task.cwd,
        });
        invocation.onProgress?.({
          kind: 'step',
          sessionId: invocation.sessionId,
          runnerId: 'builtin',
          modelLabel: 'GPT-5.2',
          step: 2,
          maxSteps: invocation.maxSteps,
          toolName: 'fs_edit',
          action: 'Editing auth.ts',
          file: 'auth.ts',
          filesChangedCount: 1,
        });
        invocation.onProgress?.({
          kind: 'finished',
          sessionId: invocation.sessionId,
          runnerId: 'builtin',
          modelLabel: 'GPT-5.2',
          status: 'completed',
          steps: 4,
          maxSteps: invocation.maxSteps,
          durationMs: 12_400,
          filesChangedCount: 2,
        });
        return completedResult({ sessionId: invocation.sessionId });
      },
    };

    const entry = codeTaskTool({
      runner,
      runs: { start, settle },
      maxSteps: () => 50,
      maxDurationMs: () => 600_000,
      maxTokens: () => 0,
    });
    const built = entry.build(
      makeContext({ codingModelId: 'pm_coding_model' }),
    ) as ToolDefinition & {
      execute: (input: unknown, options: unknown) => Promise<string>;
    };

    const output = await built.execute(
      {
        goal: 'Fix token refresh',
        cwd: 'repo',
        context: 'See auth.ts',
        verifyCommand: 'pnpm test',
      },
      {
        toolCallId: 'tc-code-1',
        emit: (name: string, value: Record<string, unknown>) => emitted.push({ name, value }),
      },
    );

    expect(captured.task).toEqual({
      goal: 'Fix token refresh',
      cwd: `${OWN}/repo`,
      context: 'See auth.ts',
      verifyCommand: 'pnpm test',
    });
    expect(captured.invocation?.parentModelRef).toBe('pm_parent_model');
    expect(captured.invocation?.codingModelRef).toBe('pm_coding_model');
    expect(captured.invocation?.maxSteps).toBe(50);

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        botId: BOT,
        parentRunId: 'run-parent-1',
        runnerKind: 'builtin',
        runnerId: 'builtin',
        cwd: `${OWN}/repo`,
      }),
    );
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        botId: BOT,
        modelId: 'openai:gpt-5.2',
        status: 'completed',
        steps: 4,
        workingMs: 12_400,
        inputTokens: 15_000,
        outputTokens: 1_200,
        cachedInputTokens: 3_000,
        cacheCreationTokens: 0,
        filesChanged: ['src/auth.ts', 'test/auth.test.ts'],
        errorCode: null,
      }),
    );

    expect(emitted).toHaveLength(3);
    expect(emitted[0]).toMatchObject({
      name: CODING_PROGRESS_EVENT,
      value: { toolCallId: 'tc-code-1', kind: 'started', step: 0, maxSteps: 50 },
    });
    expect(emitted[1]).toMatchObject({
      name: CODING_PROGRESS_EVENT,
      value: {
        toolCallId: 'tc-code-1',
        kind: 'step',
        step: 2,
        action: 'Editing auth.ts',
        file: 'auth.ts',
      },
    });
    expect(emitted[2]).toMatchObject({
      name: CODING_PROGRESS_EVENT,
      value: { toolCallId: 'tc-code-1', kind: 'finished', status: 'completed', filesChangedCount: 2 },
    });

    expect(output).toContain('code_task · completed (4 steps, 12s, GPT-5.2)');
    expect(output).toContain(`cwd: ${OWN}/repo`);
    expect(output).toContain('Fixed token refresh and updated tests.');
    expect(output).toContain('- src/auth.ts');
    expect(output).toContain('Verification: passed (`pnpm test`) — 12 passed');
    expect(output).toContain('- `pnpm test` (exit 0)');
  });

  it('settles the persisted CodingRun as failed when the runner throws and defaults parentModelRef', async () => {
    const start = vi.fn<CodingRunStore['start']>().mockResolvedValue(undefined);
    const settle = vi.fn<CodingRunStore['settle']>().mockResolvedValue(undefined);
    let seenModelRef: string | undefined;

    const entry = codeTaskTool({
      runner: {
        id: 'builtin',
        kind: 'builtin',
        run: async (_task, invocation) => {
          seenModelRef = invocation.parentModelRef;
          throw new Error('sandbox bridge dropped');
        },
      },
      runs: { start, settle },
    });

    const built = entry.build(makeContext({ botModelId: undefined })) as ToolDefinition & {
      execute: (input: unknown, options: unknown) => Promise<string>;
    };

    const output = await built.execute({ goal: 'Build widget' }, { toolCallId: 'tc-err' });

    expect(seenModelRef).toBe(MODEL_REF_DEFAULT);
    expect(output).toBe('code_task failed: sandbox bridge dropped');
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'UNKNOWN',
      }),
    );
  });
});
