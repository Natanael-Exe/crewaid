import { describe, expect, it, vi } from 'vitest';
import { computeLocalTaskPayloadHash } from '@crewaid/acp-core';
import type { Json, LocalConnectorView } from '@crewaid/shared';

import { CODING_PROGRESS_EVENT } from '../src/agent/code-task-tool.js';
import type { CodingRunStore } from '../src/agent/coding/coding-run-store.service.js';
import { assessPolicy, policyHash, type PolicySnapshot } from '../src/agent/policy/policy.js';
import type {
  PolicyProposal,
  PolicyProposalStore,
  PolicyResolution,
} from '../src/agent/policy/proposal-store.js';
import { createPolicyRuntime, type PolicyState } from '../src/agent/policy/runtime.js';
import {
  LOCAL_CONNECTOR_BUILTIN,
  ToolRegistry,
  type ToolContext,
} from '../src/agent/tool-registry.js';
import {
  buildLocalTaskPrompt,
  localConnectorTools,
  type LocalConnectorTaskRunner,
  type LocalConnectorToolsStore,
} from '../src/connectors/local-coding-tools.js';

const USER_ID = 'cluser000000000000000001';
const BOT_ID = 'clbot0000000000000000001';
const CONNECTOR_ID = 'clconn000000000000000001';

function onlineConnector(overrides: Partial<LocalConnectorView> = {}): LocalConnectorView {
  const now = new Date();
  return {
    id: CONNECTOR_ID,
    name: 'MacBook Pro',
    status: 'ONLINE',
    busy: false,
    tokenPrefix: 'crw_conn_abcd123',
    reportMode: 'summary',
    workspaceName: 'crewaid-public',
    hostName: 'nat-macbook',
    harnesses: ['claude-code', 'codex'],
    defaultHarness: 'claude-code',
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProposalStore(): PolicyProposalStore {
  const proposals = new Map<string, PolicyProposal>();
  const resolutions = new Map<string, PolicyResolution>();
  const dispatched = new Set<string>();

  return {
    assertLive: async () => true,
    staged: async () => [],
    rebind: async () => false,
    claimDispatch: async (id) => {
      if (dispatched.has(id)) return false;
      dispatched.add(id);
      return true;
    },
    recordOutcome: vi.fn(async () => undefined),
    create: vi.fn(async (proposal) => {
      const id = `prop-${String(proposals.size)}`;
      proposals.set(id, proposal);
      return id;
    }),
    read: async (id) => (resolutions.has(id) ? null : (proposals.get(id) ?? null)),
    resolve: async (id, resolution) => {
      if (!proposals.has(id) || resolutions.has(id)) return false;
      resolutions.set(id, resolution);
      return true;
    },
    cancel: async (id) => {
      proposals.delete(id);
    },
    memory: async () =>
      [...resolutions].flatMap(([id, result]) => {
        const proposal = proposals.get(id);
        return result.approved && result.source !== 'policy' && proposal !== undefined
          ? [
              {
                binding: result.binding,
                mode: proposal.mode,
                authority: proposal.authority,
                dispatched: dispatched.has(id),
              },
            ]
          : [];
      }),
    openIdentityWindow: vi.fn(),
  };
}

function makeContext(): ToolContext {
  return {
    userId: USER_ID,
    botId: BOT_ID,
    botName: 'Atlas',
    runId: 'run-1',
    trigger: { id: 'msg-1', chainId: null, hopCount: 0 },
    attachmentHost: async () => 'msg-res-1',
    browser: () => Promise.reject(new Error('unused')),
    session: () => Promise.reject(new Error('unused')),
    useIdentity: () => Promise.reject(new Error('unused')),
  };
}

describe('alwaysAsk approval policy for local_code_task', () => {
  const snapshot = (mode: 'ASK' | 'AUTO' | 'FULL'): PolicySnapshot => ({
    mode,
    rules: [{ toolPattern: '*', decision: 'allow' }],
    grantRevision: policyHash(['grant-1']),
    grantValid: true,
    seat: null,
    resourceRevision: null,
  });

  it.each(['ASK', 'AUTO', 'FULL'] as const)(
    'always asks in %s mode even with wildcard allow rules and ignores dispatched or generic memory',
    (mode) => {
      const first = assessPolicy({
        name: 'local_code_task',
        args: { connectorId: CONNECTOR_ID, goal: 'Fix bug' },
        behavior: LOCAL_CONNECTOR_BUILTIN,
        snapshot: snapshot(mode),
        memory: [],
      });
      expect(first.decision).toBe('ask');
      expect(first.binding).not.toBeNull();

      // Generic memory entry (without dispatched: false) must NOT auto-approve
      const withGenericMemory = assessPolicy({
        name: 'local_code_task',
        args: { connectorId: CONNECTOR_ID, goal: 'Fix bug' },
        behavior: LOCAL_CONNECTOR_BUILTIN,
        snapshot: snapshot(mode),
        memory: [{ binding: first.binding!, mode, authority: true }],
      });
      expect(withGenericMemory.decision).toBe('ask');

      // Already-dispatched approval memory must NOT auto-approve a second call
      const withDispatchedMemory = assessPolicy({
        name: 'local_code_task',
        args: { connectorId: CONNECTOR_ID, goal: 'Fix bug' },
        behavior: LOCAL_CONNECTOR_BUILTIN,
        snapshot: snapshot(mode),
        memory: [{ binding: first.binding!, mode, authority: true, dispatched: true }],
      });
      expect(withDispatchedMemory.decision).toBe('ask');

      // Only the freshly resolved, still-undispatched approval passes the pre-dispatch fence
      const withFreshApproval = assessPolicy({
        name: 'local_code_task',
        args: { connectorId: CONNECTOR_ID, goal: 'Fix bug' },
        behavior: LOCAL_CONNECTOR_BUILTIN,
        snapshot: snapshot(mode),
        memory: [{ binding: first.binding!, mode, authority: true, dispatched: false }],
      });
      expect(withFreshApproval.decision).toBe('allow');
      expect(withFreshApproval.source).toBe('memory');
    },
  );

  it('still honors explicit deny rules and revoked grants', () => {
    const denied = assessPolicy({
      name: 'local_code_task',
      args: { connectorId: CONNECTOR_ID, goal: 'Fix bug' },
      behavior: LOCAL_CONNECTOR_BUILTIN,
      snapshot: {
        ...snapshot('FULL'),
        rules: [{ toolPattern: 'local_code_task', decision: 'deny' }],
      },
      memory: [],
    });
    expect(denied.decision).toBe('deny');

    const revoked = assessPolicy({
      name: 'local_code_task',
      args: { connectorId: CONNECTOR_ID, goal: 'Fix bug' },
      behavior: LOCAL_CONNECTOR_BUILTIN,
      snapshot: { ...snapshot('FULL'), grantValid: false },
      memory: [],
    });
    expect(revoked.decision).toBe('deny');
    expect(revoked.code).toBe('GRANT_REVOKED');
  });
});

describe('localConnectorTools + PolicyRuntime end-to-end', () => {
  it('binds exact payloadHash via CommitAdapter, runs once approved, and asks again on identical second call even in FULL mode', async () => {
    const connector = onlineConnector();
    const connectors: LocalConnectorToolsStore = {
      list: vi.fn(async () => ({ connectors: [connector] })),
      resolveForDispatch: vi.fn(async () => ({ ok: true as const, connector })),
    };
    const runner: LocalConnectorTaskRunner = {
      runLocalTask: vi.fn(async (input) => {
        input.onProgress?.({
          kind: 'waiting_local_permission',
          sessionId: input.sessionId,
          runnerId: 'acp:local:claude-code',
          connectorName: connector.name,
          toolCallId: 'acp_tc_1',
          title: 'Run pnpm test',
          toolKind: 'execute',
        });
        input.onProgress?.({
          kind: 'resumed',
          sessionId: input.sessionId,
          runnerId: 'acp:local:claude-code',
          connectorName: connector.name,
          toolCallId: 'acp_tc_1',
          outcome: 'selected',
        });
        return {
          status: 'completed',
          runnerKind: 'acp_local',
          runnerId: 'acp:local:claude-code',
          sessionId: input.sessionId,
          acpSessionId: 'acp_sess_42',
          reportMode: 'summary',
          agentName: 'Claude Code',
          summary: 'Updated auth middleware and verified tests.',
          filesChanged: ['src/auth.ts'],
          tests: { status: 'passed', command: 'pnpm test' },
          commandsRun: [{ command: 'pnpm test', exitCode: 0 }],
          blockedActions: [],
          steps: 4,
          durationMs: 2500,
          gitBranch: 'feat/auth-fix',
          headSha: '1234abc',
        };
      }),
    };
    const runs: CodingRunStore = {
      start: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      reconcileAbandonedForRun: vi.fn(async () => 0),
    };

    const registry = new ToolRegistry();
    const extras = localConnectorTools({
      userId: USER_ID,
      botId: BOT_ID,
      botName: 'Atlas',
      connectors,
      runner,
      runs,
    });
    const store = makeProposalStore();
    const state: PolicyState = {
      snapshot: {
        mode: 'FULL',
        rules: [{ toolPattern: '*', decision: 'allow' }],
        grantRevision: policyHash(['grant-1']),
        grantValid: true,
        seat: null,
        resourceRevision: null,
      },
    };
    const resolved = registry.resolveFor(makeContext(), extras);
    const policy = createPolicyRuntime({
      project: (name, args) => resolved.projectCall(name, args),
      read: async () => state,
      store,
    });

    // list_local_connectors is read-only and allowed without asking
    expect(
      await policy.decide({
        toolCall: { toolCallId: 'tc-list', toolName: 'list_local_connectors', input: {} },
      }),
    ).toBe('not-applicable');

    const input: Json = {
      connectorId: CONNECTOR_ID,
      goal: 'Fix token refresh race',
      relativeCwd: 'apps/orchestrator',
      context: 'See auth.ts',
      verifyCommand: 'pnpm test',
    };

    // First local_code_task call MUST ask even in FULL mode
    expect(
      await policy.decide({
        toolCall: { toolCallId: 'tc-1', toolName: 'local_code_task', input },
      }),
    ).toBe('user-approval');

    const prompt = policy.prompt({
      approvalId: 'apr-1',
      toolCallId: 'tc-1',
      toolName: 'local_code_task',
      args: input,
    });

    const expectedHash = computeLocalTaskPayloadHash({
      botId: BOT_ID,
      connectorId: CONNECTOR_ID,
      relativeCwd: 'apps/orchestrator',
      harness: 'claude-code',
      prompt: buildLocalTaskPrompt('Fix token refresh race', 'See auth.ts'),
      verifyCommand: 'pnpm test',
    });
    expect(prompt.binding.commit).toEqual({
      account: 'MacBook Pro (crewaid-public)',
      destinations: [`${CONNECTOR_ID}:apps/orchestrator`],
      contentRevision: expectedHash,
    });

    // Operator approves proposal 1
    expect(await policy.answer(prompt.toolCallId, { approved: true })).toEqual({ approved: true });

    const emitted: Array<{ name: string; data: unknown }> = [];
    const executeFn = resolved.toolSet['local_code_task']!.execute!;
    const wrappedOutput = (await policy.execute(
      'local_code_task',
      input,
      'tc-1',
      async (finalArgs) =>
        executeFn(finalArgs, {
          toolCallId: 'tc-1',
          emit: (name, data) => emitted.push({ name, data }),
        }),
    )) as { outcome: { status: string; reference?: string }; output: { text: string } };

    expect(wrappedOutput.outcome).toMatchObject({ status: 'committed' });
    expect(wrappedOutput.output.text).toContain('branch=feat/auth-fix head=1234abc');
    expect(wrappedOutput.output.text).toContain('Updated auth middleware');
    expect(runner.runLocalTask).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: CONNECTOR_ID,
        payloadHash: expectedHash,
        relativeCwd: 'apps/orchestrator',
        harness: 'claude-code',
      }),
    );
    expect(runs.start).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerKind: 'acp_local',
        runnerId: 'acp:local:claude-code',
        connectorId: CONNECTOR_ID,
        payloadHash: expectedHash,
        reportMode: 'summary',
      }),
    );
    expect(runs.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        acpSessionId: 'acp_sess_42',
        filesChanged: ['src/auth.ts'],
      }),
    );
    expect(emitted.map((e) => [e.name, (e.data as { kind: string }).kind])).toEqual([
      [CODING_PROGRESS_EVENT, 'waiting_local_permission'],
      [CODING_PROGRESS_EVENT, 'resumed'],
    ]);

    // Second IDENTICAL call in the SAME run (still in FULL mode!) MUST ask again
    expect(
      await policy.decide({
        toolCall: { toolCallId: 'tc-2', toolName: 'local_code_task', input },
      }),
    ).toBe('user-approval');
  });

  it('omits duplicate workspace name in approval binding when connector name matches workspaceName', async () => {
    const connector = onlineConnector({ name: 'crewaid-public', workspaceName: 'crewaid-public' });
    const connectors: LocalConnectorToolsStore = {
      list: vi.fn(async () => ({ connectors: [connector] })),
      resolveForDispatch: vi.fn(async () => ({ ok: true as const, connector })),
    };
    const runner: LocalConnectorTaskRunner = { runLocalTask: vi.fn() };
    const registry = new ToolRegistry();
    const resolved = registry.resolveFor(
      makeContext(),
      localConnectorTools({
        userId: USER_ID,
        botId: BOT_ID,
        botName: 'Atlas',
        connectors,
        runner,
      }),
    );
    const policy = createPolicyRuntime({
      project: (name, args) => resolved.projectCall(name, args),
      read: async () => ({
        snapshot: {
          mode: 'ASK',
          rules: [],
          grantRevision: policyHash(['g']),
          grantValid: true,
          seat: null,
          resourceRevision: null,
        },
      }),
      store: makeProposalStore(),
    });
    const input: Json = { connectorId: CONNECTOR_ID, goal: 'Inspect README' };
    expect(
      await policy.decide({ toolCall: { toolCallId: 'tc-dup', toolName: 'local_code_task', input } }),
    ).toBe('user-approval');
    const prompt = policy.prompt({
      approvalId: 'apr-dup',
      toolCallId: 'tc-dup',
      toolName: 'local_code_task',
      args: input,
    });
    expect(prompt.binding.commit?.account).toBe('crewaid-public');
    expect(prompt.binding.commit?.destinations).toEqual([`${CONNECTOR_ID}:.`]);
  });

  it('refuses CONNECTOR_ON_OTHER_INSTANCE, busy, unavailable harness, and traversal paths before asking approval', async () => {
    const connector = onlineConnector({ harnesses: ['claude-code'], defaultHarness: 'claude-code' });
    const resolveForDispatch = vi.fn();
    const connectors: LocalConnectorToolsStore = {
      list: vi.fn(async () => ({ connectors: [connector] })),
      resolveForDispatch,
    };
    const runner: LocalConnectorTaskRunner = {
      runLocalTask: vi.fn(),
    };

    const registry = new ToolRegistry();
    const resolved = registry.resolveFor(
      makeContext(),
      localConnectorTools({
        userId: USER_ID,
        botId: BOT_ID,
        botName: 'Atlas',
        connectors,
        runner,
      }),
    );
    const policy = createPolicyRuntime({
      project: (name, args) => resolved.projectCall(name, args),
      read: async () => ({
        snapshot: {
          mode: 'FULL',
          rules: [],
          grantRevision: policyHash(['g']),
          grantValid: true,
          seat: null,
          resourceRevision: null,
        },
      }),
      store: makeProposalStore(),
    });

    // Multi-replica refusal
    resolveForDispatch.mockResolvedValueOnce({
      ok: false,
      code: 'CONNECTOR_ON_OTHER_INSTANCE',
      message: 'Connected to another orchestrator instance.',
    });
    expect(
      await policy.decide({
        toolCall: {
          toolCallId: 'tc-other',
          toolName: 'local_code_task',
          input: { connectorId: CONNECTOR_ID, goal: 'Test' },
        },
      }),
    ).toMatchObject({ type: 'denied', reason: expect.stringContaining('CONNECTOR_ON_OTHER_INSTANCE') });

    // Unavailable harness refusal
    resolveForDispatch.mockResolvedValueOnce({ ok: true, connector });
    expect(
      await policy.decide({
        toolCall: {
          toolCallId: 'tc-harness',
          toolName: 'local_code_task',
          input: { connectorId: CONNECTOR_ID, goal: 'Test', harness: 'codex' },
        },
      }),
    ).toMatchObject({ type: 'denied', reason: expect.stringContaining('HARNESS_UNAVAILABLE') });

    // Path traversal refusal
    resolveForDispatch.mockResolvedValueOnce({ ok: true, connector });
    expect(
      await policy.decide({
        toolCall: {
          toolCallId: 'tc-traversal',
          toolName: 'local_code_task',
          input: { connectorId: CONNECTOR_ID, goal: 'Test', relativeCwd: '../outside' },
        },
      }),
    ).toMatchObject({ type: 'denied', reason: expect.stringContaining('INVALID_ARGUMENTS') });
  });
});
