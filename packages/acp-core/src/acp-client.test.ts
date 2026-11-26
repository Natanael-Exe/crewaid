import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createChildProcessTransport, runAcpSession } from './client.js';
import type { AcpPermissionRequest, AcpProgressUpdate } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT = path.resolve(HERE, '../test/mock-acp-agent.mjs');

function spawnMockAgent(scenario: string) {
  const child = spawn(process.execPath, [MOCK_AGENT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MOCK_ACP_SCENARIO: scenario },
  });
  return createChildProcessTransport(child);
}

describe('runAcpSession (real stdio NDJSON against ACP v1 mock agent)', () => {
  it('keeps code the agent pastes into its final message out of a summary-only report', async () => {
    const summaryOnly = await runAcpSession({
      cwd: '/tmp/crewaid-acp-demo',
      prompt: 'Rotate the key',
      reportMode: 'summary',
      transport: spawnMockAgent('code-in-summary'),
    });
    expect(summaryOnly.status).toBe('completed');
    expect(summaryOnly.summary).toContain('Rotated the key.');
    expect(summaryOnly.summary).toContain('All tests pass.');
    expect(summaryOnly.summary).not.toContain('SUMMARY_CODE_SECRET');

    const full = await runAcpSession({
      cwd: '/tmp/crewaid-acp-demo',
      prompt: 'Rotate the key',
      reportMode: 'full',
      transport: spawnMockAgent('code-in-summary'),
    });
    expect(full.summary).toContain('SUMMARY_CODE_SECRET_9F2');
  });

  it('completes a full turn in summary mode without leaking raw file contents, diffs, or command output', async () => {
    const events: AcpProgressUpdate[] = [];
    const cwd = '/tmp/crewaid-acp-demo';
    const result = await runAcpSession({
      cwd,
      prompt: 'Fix the bug in src/app.ts',
      harnessId: 'claude-code',
      reportMode: 'summary',
      transport: spawnMockAgent('happy'),
      onProgress: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('end_turn');
    expect(result.acpSessionId).toBe('sess_mock_01');
    expect(result.agentName).toBe('mock-acp-agent');
    expect(result.reportMode).toBe('summary');
    expect(result.summary).toBe('Updated src/app.ts and verified tests pass.');
    expect(result.filesChanged).toEqual(['src/app.ts']);
    expect(result.commandsRun).toEqual([{ command: 'pnpm test', status: 'completed' }]);
    expect(result.steps).toBe(3);
    expect(result.transcriptExcerpt).toBeUndefined();
    expect(result.diffExcerpt).toBeUndefined();

    const serialized = JSON.stringify({ result, events });
    expect(serialized).not.toContain('RAW_FILE_BODY_SECRET_TOKEN_XYZ');
    expect(serialized).not.toContain('RAW_OLD_DIFF_CODE');
    expect(serialized).not.toContain('RAW_NEW_DIFF_CODE');
    expect(serialized).not.toContain('RAW_COMMAND_STDOUT_DETAIL');

    expect(events.map((e) => e.kind)).toEqual(['started', 'step', 'step', 'step', 'finished']);
  });

  it('includes bounded transcript and diff excerpts only when reportMode is full', async () => {
    const result = await runAcpSession({
      cwd: '/tmp/crewaid-acp-demo',
      prompt: 'Fix the bug in src/app.ts',
      harnessId: 'codex',
      reportMode: 'full',
      transport: spawnMockAgent('happy'),
    });

    expect(result.status).toBe('completed');
    expect(result.reportMode).toBe('full');
    expect(result.transcriptExcerpt).toContain('RAW_FILE_BODY_SECRET_TOKEN_XYZ');
    expect(result.transcriptExcerpt).toContain('RAW_COMMAND_STDOUT_DETAIL');
    expect(result.diffExcerpt).toContain('--- src/app.ts');
    expect(result.diffExcerpt).toContain('RAW_NEW_DIFF_CODE');
  });

  it('emits waiting_local_permission and resumed around local permission approval', async () => {
    const events: AcpProgressUpdate[] = [];
    const requests: AcpPermissionRequest[] = [];

    const result = await runAcpSession({
      cwd: '/tmp/crewaid-acp-demo',
      prompt: 'Run tests',
      harnessId: 'claude-code',
      transport: spawnMockAgent('permission'),
      onProgress: (event) => events.push(event),
      onPermissionRequest: (request) => {
        requests.push(request);
        const allow = request.options.find((opt) => opt.kind === 'allow_once');
        return Promise.resolve(
          allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' },
        );
      },
    });

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Permission approved; tests passed.');
    expect(result.commandsRun).toEqual([{ command: 'Run pnpm test', status: 'completed' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.locations).toEqual(['package.json']);
    expect(events.map((e) => e.kind)).toEqual([
      'started',
      'step',
      'waiting_local_permission',
      'resumed',
      'finished',
    ]);
    const resumed = events.find((e) => e.kind === 'resumed');
    expect(resumed?.kind === 'resumed' ? resumed.outcome : null).toBe('selected');
  });

  it('fails closed (cancelled) when no permission handler is supplied', async () => {
    const result = await runAcpSession({
      cwd: '/tmp/crewaid-acp-demo',
      prompt: 'Run tests',
      transport: spawnMockAgent('permission'),
    });

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Permission denied by operator.');
    expect(result.commandsRun).toEqual([{ command: 'Run pnpm test', status: 'failed' }]);
  });

  it('forwards AbortSignal as ACP session/cancel and settles cleanly as cancelled', async () => {
    const abort = new AbortController();
    const result = await runAcpSession({
      cwd: '/tmp/crewaid-acp-demo',
      prompt: 'Run long suite',
      transport: spawnMockAgent('cancel'),
      abortSignal: abort.signal,
      onProgress: (event) => {
        if (event.kind === 'step') {
          abort.abort();
        }
      },
    });

    expect(result.status).toBe('cancelled');
    expect(result.stopReason).toBe('cancelled');
  });

  it('closes transport after cancelGraceMs if the agent ignores session/cancel', async () => {
    const abort = new AbortController();
    const started = Date.now();
    const result = await runAcpSession({
      cwd: '/tmp/crewaid-acp-demo',
      prompt: 'Run stubborn suite',
      transport: spawnMockAgent('hang-on-cancel'),
      abortSignal: abort.signal,
      cancelGraceMs: 150,
      onProgress: (event) => {
        if (event.kind === 'step') {
          abort.abort();
        }
      },
    });

    expect(result.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('fails fast with ACP_SESSION_FAILED when the agent crashes mid-prompt', async () => {
    const result = await runAcpSession({
      cwd: '/tmp/crewaid-acp-demo',
      prompt: 'Crash now',
      transport: spawnMockAgent('crash'),
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('ACP_SESSION_FAILED');
  });
});
