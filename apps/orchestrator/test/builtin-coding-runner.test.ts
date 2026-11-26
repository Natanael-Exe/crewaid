import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTO_REVIEW_RULES, type ApprovalMode, type AutoReviewRule } from '@crewaid/shared';
import type { ToolSandboxSession } from '@crewaid/sandbox-core';
import type { CodingProgressEvent } from '../src/agent/coding/coding-runner.port.js';
import { BuiltInCodingRunner } from '../src/agent/execution/builtin-coding-runner.js';
import type { PolicyState } from '../src/agent/policy/runtime.js';
import { MACHINE_HOME } from '../src/agent/workspace-paths.js';
import type { AiTelemetryEvent } from '../src/telemetry/ai-telemetry.js';
import {
  MockLanguageModelV4,
  resolvedTextModelOf,
  simulateReadableStream,
  type ScriptCall,
  type ScriptPart,
} from './model-resolution-fake.js';

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const REPO = `${MACHINE_HOME}/agents/${BOT}/repo`;

function makePolicyState(
  mode: ApprovalMode,
  rules: readonly AutoReviewRule[] = DEFAULT_AUTO_REVIEW_RULES,
): PolicyState {
  return {
    snapshot: {
      mode,
      rules,
      grantRevision: '0'.repeat(64),
      grantValid: true,
      seat: null,
      resourceRevision: null,
    },
    validate: undefined,
  };
}

function scriptedModel(
  steps: ReadonlyArray<ReadonlyArray<ScriptPart>>,
  onCall?: (index: number, call: ScriptCall) => void,
): MockLanguageModelV4 {
  let stepIndex = 0;
  return new MockLanguageModelV4({
    doStream: (call) => {
      const idx = stepIndex++;
      onCall?.(idx, call);
      const parts = steps[idx] ?? [
        { type: 'text-delta', id: `t-${idx}`, delta: 'No more scripted steps.' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
      ];
      return { stream: simulateReadableStream({ chunks: parts }) };
    },
  });
}

function makeFakeSession(
  options: {
    files?: Record<string, string>;
    gitPorcelainBefore?: string;
    gitPorcelainAfter?: string;
    onRun?: (command: string, cwd?: string) => { exitCode: number; stdout: string; stderr: string };
  } = {},
): {
  session: ToolSandboxSession;
  files: Map<string, string>;
  ranCommands: Array<{
    command: string;
    workingDirectory?: string | undefined;
    env?: Record<string, string> | undefined;
  }>;
} {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const ranCommands: Array<{
    command: string;
    workingDirectory?: string | undefined;
    env?: Record<string, string> | undefined;
  }> = [];
  let gitCalls = 0;

  const session = {
    run: async (req: {
      command: string;
      workingDirectory?: string | undefined;
      env?: Record<string, string> | undefined;
    }) => {
      ranCommands.push({
        command: req.command,
        workingDirectory: req.workingDirectory,
        env: req.env,
      });
      if (req.command.includes('status --porcelain')) {
        gitCalls += 1;
        const stdout =
          gitCalls === 1
            ? (options.gitPorcelainBefore ?? '')
            : (options.gitPorcelainAfter ?? options.gitPorcelainBefore ?? '');
        return { exitCode: 0, stdout, stderr: '' };
      }
      if (req.command.includes('stat -c %s')) {
        const match = /stat -c %s '([^']+)'/.exec(req.command);
        const target = match?.[1];
        const content = target === undefined ? undefined : files.get(target);
        return content === undefined
          ? { exitCode: 1, stdout: '', stderr: 'no such file' }
          : { exitCode: 0, stdout: String(Buffer.byteLength(content, 'utf8')), stderr: '' };
      }
      return (
        options.onRun?.(req.command, req.workingDirectory) ?? {
          exitCode: 0,
          stdout: 'ok\n',
          stderr: '',
        }
      );
    },
    readTextFile: async ({ path }: { path: string }) => files.get(path) ?? null,
    writeTextFile: async ({ path, content }: { path: string; content: string }) => {
      files.set(path, content);
    },
  } as unknown as ToolSandboxSession;

  return { session, files, ranCommands };
}

function makeRunner(options: {
  model: MockLanguageModelV4;
  mode?: ApprovalMode;
  rules?: readonly AutoReviewRule[];
  toolsSupported?: boolean;
  telemetry?: AiTelemetryEvent[];
  stopRun?: (botId: string, runId: string) => Promise<unknown>;
}) {
  const resolved = {
    ...resolvedTextModelOf(options.model),
    label: 'Coder Model',
    capabilities: {
      tools: options.toolsSupported ?? true,
      vision: true,
      reasoning: false,
    },
  };
  const telemetry = options.telemetry;
  return new BuiltInCodingRunner({
    resolveModel: async () => resolved,
    machines: { ensureSeatFor: async () => undefined },
    processes: {
      start: async () => ({
        id: 'proc-1',
        status: 'running',
        pid: 100,
        command: '',
        startedAt: '',
        maxDurationSec: 600,
      }),
      list: async () => [],
      readOutput: async () => ({
        id: 'proc-1',
        status: 'running',
        exitCode: null,
        output: '',
        droppedBytes: 0,
      }),
      stop: async () => ({ id: 'proc-1', status: 'stopped', exitCode: 0 }),
      ...(options.stopRun === undefined ? {} : { stopRun: options.stopRun }),
    },
    policyState: {
      read: async () => makePolicyState(options.mode ?? 'AUTO', options.rules),
    },
    logger: { warn: vi.fn(), info: vi.fn() },
    ...(telemetry === undefined
      ? {}
      : { telemetry: { record: (event: AiTelemetryEvent) => void telemetry.push(event) } }),
  });
}

describe('BuiltInCodingRunner', () => {
  it('runs a multi-step read/edit/test/finish_task loop, diffs git status, emits progress, and records telemetry', async () => {
    const telemetry: AiTelemetryEvent[] = [];
    const progress: CodingProgressEvent[] = [];
    const { session, files, ranCommands } = makeFakeSession({
      files: {
        [`${REPO}/src/math.ts`]: 'export const add = (a: number, b: number) => a - b;\n',
      },
      // Pre-existing dirty file should NOT be reported in filesChanged; generated.ts created during shell SHOULD be.
      gitPorcelainBefore: ' M dirty-before.txt\n',
      gitPorcelainAfter: ' M dirty-before.txt\n M src/math.ts\n?? src/generated.ts\n',
      onRun: (command) => {
        if (command.includes('pnpm test')) {
          return { exitCode: 0, stdout: '1 passed\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const model = scriptedModel([
      [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'fs_read',
          input: { path: 'src/math.ts' },
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      ],
      [
        {
          type: 'tool-call',
          toolCallId: 'c2',
          toolName: 'fs_edit',
          input: {
            path: 'src/math.ts',
            oldText: 'a - b',
            newText: 'a + b',
          },
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 150, outputTokens: 25 },
        },
      ],
      [
        {
          type: 'tool-call',
          toolCallId: 'c3',
          toolName: 'shell',
          input: { command: 'pnpm test' },
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 200, outputTokens: 30 },
        },
      ],
      [
        {
          type: 'tool-call',
          toolCallId: 'c4',
          toolName: 'finish_task',
          input: {
            summary: 'Fixed addition bug in src/math.ts and verified tests pass.',
            tests: { status: 'passed', command: 'pnpm test', detail: '1 passed' },
          },
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 220, outputTokens: 40 },
        },
      ],
    ]);

    const runner = makeRunner({ model, mode: 'AUTO', telemetry });
    const result = await runner.run(
      { goal: 'Fix add() in src/math.ts', cwd: REPO, verifyCommand: 'pnpm test' },
      {
        sessionId: 'code_1',
        userId: 'user-1',
        botId: BOT,
        groupId: null,
        parentRunId: 'run-parent',
        parentModelRef: 'default',
        codingModelRef: null,
        maxSteps: 20,
        maxDurationMs: 60_000,
        maxTokens: 0,
        language: 'en',
        session: async () => session,
        onProgress: (ev) => progress.push(ev),
      },
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Fixed addition bug in src/math.ts and verified tests pass.');
    expect(files.get(`${REPO}/src/math.ts`)).toBe(
      'export const add = (a: number, b: number) => a + b;\n',
    );
    // Deduplicated relative path + indirect shell file, excluding pre-existing dirty file.
    expect(result.filesChanged).toEqual(['src/math.ts', 'src/generated.ts']);
    expect(result.commandsRun).toEqual([{ command: 'pnpm test', exitCode: 0 }]);
    expect(result.tests).toEqual({ status: 'passed', command: 'pnpm test', detail: '1 passed' });
    expect(result.blockedActions).toEqual([]);
    expect(result.steps).toBe(4);
    expect(result.usage).toMatchObject({
      modelKey: 'openai:fake-model',
      modelLabel: 'Coder Model',
      inputTokens: 670,
      outputTokens: 115,
      calls: 4,
    });
    expect(telemetry).toHaveLength(4);
    expect(telemetry.every((ev) => ev.outcome === 'success' && ev.runId === 'run-parent')).toBe(
      true,
    );

    // shell command cds into REPO inside its shell-quoted wrapper script
    // The runner's own git status runs with no approval, so it must not run a
    // command the repository configures (core.fsmonitor) or hold index.lock.
    const gitStatuses = ranCommands.filter((cmd) => cmd.command.includes('status --porcelain'));
    expect(gitStatuses.length).toBeGreaterThanOrEqual(2);
    for (const status of gitStatuses) {
      expect(status.command).toContain('-c core.fsmonitor=false');
      expect(status.env).toEqual({ GIT_OPTIONAL_LOCKS: '0' });
    }

    const testRun = ranCommands.find((cmd) => cmd.command.includes('pnpm test'));
    expect(testRun?.command).toContain(`cd '\\''${REPO}'\\''`);

    // Live progress emitted started -> step events -> finished
    expect(progress[0]).toMatchObject({ kind: 'started', modelLabel: 'Coder Model', cwd: REPO });
    expect(
      progress.some(
        (ev) => ev.kind === 'step' && ev.toolName === 'fs_edit' && ev.file === 'math.ts',
      ),
    ).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      kind: 'finished',
      status: 'completed',
      filesChangedCount: 2,
    });
  });

  it('enforces inner AUTO/ASK/FULL policy rules: blocks destructive shell & deny rules, allows approved edits/tests in ASK', async () => {
    const toolOutputs: string[] = [];
    const { session } = makeFakeSession({
      files: { [`${REPO}/a.ts`]: 'export const a = 1;\n' },
    });

    const rules: AutoReviewRule[] = [
      { toolPattern: 'shell', argMatch: 'curl', decision: 'deny' },
      ...DEFAULT_AUTO_REVIEW_RULES,
    ];

    const model = scriptedModel(
      [
        [
          {
            type: 'tool-call',
            toolCallId: 'p1',
            toolName: 'fs_edit',
            input: { path: 'a.ts', oldText: 'a = 1', newText: 'a = 2' },
          },
          {
            type: 'tool-call',
            toolCallId: 'p2',
            toolName: 'shell',
            input: { command: 'rm -rf ./tmp' },
          },
          {
            type: 'tool-call',
            toolCallId: 'p3',
            toolName: 'shell',
            input: { command: 'curl https://evil.test' },
          },
          { type: 'finish', finishReason: 'tool-calls' },
        ],
        [
          {
            type: 'tool-call',
            toolCallId: 'p4',
            toolName: 'finish_task',
            input: {
              summary: 'Edited a.ts; destructive and denied commands were blocked.',
              tests: { status: 'not_run' },
            },
          },
          { type: 'finish', finishReason: 'tool-calls' },
        ],
      ],
      (idx, call) => {
        if (idx === 1) {
          for (const msg of call.prompt) {
            if (msg.role === 'tool') {
              toolOutputs.push(JSON.stringify(msg.content));
            }
          }
        }
      },
    );

    // Run in ASK mode (outer code_task already approved): fs_edit allowed, rm -rf fails closed, curl denied.
    const runner = makeRunner({ model, mode: 'ASK', rules });
    const result = await runner.run(
      { goal: 'Update a.ts', cwd: REPO },
      {
        sessionId: 'code_policy',
        userId: 'user-1',
        botId: BOT,
        groupId: null,
        parentModelRef: 'default',
        codingModelRef: null,
        maxSteps: 10,
        maxDurationMs: 60_000,
        maxTokens: 0,
        language: 'en',
        session: async () => session,
      },
    );

    expect(result.status).toBe('completed');
    expect(result.filesChanged).toEqual(['a.ts']);
    expect(result.blockedActions).toEqual([
      { toolName: 'shell', detail: 'rm -rf ./tmp', reason: 'APPROVAL_REQUIRED' },
      { toolName: 'shell', detail: 'curl https://evil.test', reason: 'POLICY_DENIED' },
    ]);
    expect(toolOutputs.join('\n')).toContain('APPROVAL_REQUIRED');
    expect(toolOutputs.join('\n')).toContain('POLICY_DENIED');
  });

  it('returns status=incomplete with last assistant text when the model stops without finish_task', async () => {
    const { session } = makeFakeSession();
    const model = scriptedModel([
      [
        { type: 'text-delta', id: 't1', delta: 'Partial progress without calling finish_task.' },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);

    const runner = makeRunner({ model });
    const result = await runner.run(
      { goal: 'Investigate bug', cwd: REPO },
      {
        sessionId: 'code_inc',
        userId: 'user-1',
        botId: BOT,
        groupId: null,
        parentModelRef: 'default',
        codingModelRef: null,
        maxSteps: 10,
        maxDurationMs: 60_000,
        maxTokens: 0,
        language: 'en',
        session: async () => session,
      },
    );

    expect(result.status).toBe('incomplete');
    expect(result.summary).toBe('Partial progress without calling finish_task.');
  });

  it('injects wrap-up notice at 80% budget and ends with limit_reached when step budget expires', async () => {
    const seenPrompts: string[] = [];
    const { session } = makeFakeSession({
      files: {
        [`${REPO}/a.ts`]: 'a\n',
        [`${REPO}/b.ts`]: 'b\n',
        [`${REPO}/c.ts`]: 'c\n',
        [`${REPO}/d.ts`]: 'd\n',
        [`${REPO}/e.ts`]: 'e\n',
      },
    });

    const model = scriptedModel(
      ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((file, idx) => [
        {
          type: 'tool-call',
          toolCallId: `s${idx + 1}`,
          toolName: 'fs_read',
          input: { path: file },
        },
        { type: 'finish', finishReason: 'tool-calls' },
      ]),
      (_idx, call) => {
        seenPrompts.push(JSON.stringify(call.prompt));
      },
    );

    const runner = makeRunner({ model });
    const result = await runner.run(
      { goal: 'Read lots of files', cwd: REPO },
      {
        sessionId: 'code_limit',
        userId: 'user-1',
        botId: BOT,
        groupId: null,
        parentModelRef: 'default',
        codingModelRef: null,
        maxSteps: 5,
        maxDurationMs: 60_000,
        maxTokens: 0,
        language: 'en',
        session: async () => session,
      },
    );

    expect(result.status).toBe('limit_reached');
    expect(result.steps).toBe(5);
    // 80% of 5 -> ceil(4.0) = 4 steps done -> wrap-up notice injected before step 5.
    expect(seenPrompts[4]).toContain('Call finish_task');
  });

  it('redacts secrets through PrivacyVault before the model sees them and rehydrates them on write and summary', async () => {
    const secret = 'sk-ant-api03-1234567890abcdef1234567890abcdef';
    const promptSnapshots: string[] = [];
    const { session, files } = makeFakeSession({
      files: { [`${REPO}/.env.sample`]: `API_KEY=${secret}\n` },
    });

    let placeholderSeen = '';
    const model = new MockLanguageModelV4({
      doStream: (call) => {
        const serialized = JSON.stringify(call.prompt);
        promptSnapshots.push(serialized);
        const match = /\[\[SECRET_\d+(?::[^\]]+)?\]\]/.exec(serialized);
        if (match !== null) placeholderSeen = match[0];

        if (promptSnapshots.length === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 'v1',
                  toolName: 'fs_read',
                  input: { path: '.env.sample' },
                },
                { type: 'finish', finishReason: 'tool-calls' },
              ],
            }),
          };
        }
        if (promptSnapshots.length === 2) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 'v2',
                  toolName: 'fs_write',
                  input: { path: 'copy.txt', content: `TOKEN=${placeholderSeen}\n` },
                },
                { type: 'finish', finishReason: 'tool-calls' },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'v3',
                toolName: 'finish_task',
                input: {
                  summary: `Copied ${placeholderSeen} into copy.txt.`,
                  tests: { status: 'not_run' },
                },
              },
              { type: 'finish', finishReason: 'tool-calls' },
            ],
          }),
        };
      },
    });

    const runner = makeRunner({ model });
    const result = await runner.run(
      { goal: 'Copy token from .env.sample to copy.txt', cwd: REPO },
      {
        sessionId: 'code_vault',
        userId: 'user-1',
        botId: BOT,
        groupId: null,
        parentModelRef: 'default',
        codingModelRef: null,
        maxSteps: 10,
        maxDurationMs: 60_000,
        maxTokens: 0,
        language: 'en',
        session: async () => session,
      },
    );

    expect(result.status).toBe('completed');
    // The model NEVER saw the raw secret in any call.
    expect(promptSnapshots.join('\n')).not.toContain(secret);
    expect(placeholderSeen).not.toBe('');
    // Rehydrated on disk and in returned summary.
    expect(files.get(`${REPO}/copy.txt`)).toBe(`TOKEN=${secret}\n`);
    expect(result.summary).toBe(`Copied ${secret} into copy.txt.`);
  });

  it('cancels cleanly on abort signal and stops background processes for parentRunId', async () => {
    const abortController = new AbortController();
    const stopRun = vi.fn().mockResolvedValue(['proc-1']);
    const { session } = makeFakeSession();

    const model = new MockLanguageModelV4({
      doStream: () => {
        abortController.abort('USER_CANCEL');
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'tool-call', toolCallId: 'a1', toolName: 'fs_read', input: { path: 'x.ts' } },
              { type: 'finish', finishReason: 'tool-calls' },
            ],
          }),
        };
      },
    });

    const runner = makeRunner({ model, stopRun });
    const result = await runner.run(
      { goal: 'Long refactor', cwd: REPO },
      {
        sessionId: 'code_abort',
        userId: 'user-1',
        botId: BOT,
        groupId: null,
        parentRunId: 'run-to-cancel',
        parentModelRef: 'default',
        codingModelRef: null,
        maxSteps: 10,
        maxDurationMs: 60_000,
        maxTokens: 0,
        language: 'en',
        session: async () => session,
        abortSignal: abortController.signal,
      },
    );

    expect(result.status).toBe('cancelled');
    expect(stopRun).toHaveBeenCalledWith(BOT, 'run-to-cancel');
  });

  it('refuses cleanly when the resolved model does not support tool calling', async () => {
    const { session } = makeFakeSession();
    const model = scriptedModel([]);
    const runner = makeRunner({ model, toolsSupported: false });

    const result = await runner.run(
      { goal: 'Fix bug', cwd: REPO },
      {
        sessionId: 'code_no_tools',
        userId: 'user-1',
        botId: BOT,
        groupId: null,
        parentModelRef: 'default',
        codingModelRef: null,
        maxSteps: 10,
        maxDurationMs: 60_000,
        maxTokens: 0,
        language: 'en',
        session: async () => session,
      },
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INVALID_REQUEST');
    expect(result.summary).toContain('does not support tool calling');
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
