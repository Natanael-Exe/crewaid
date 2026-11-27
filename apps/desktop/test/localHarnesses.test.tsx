import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { LocalConnectorView } from '@crewaid/shared';

import {
  CODING_PROGRESS_EVENT,
  parseCodingProgress,
} from '../src/renderer/chat/codingProgress';
import { ApprovalPrompt } from '../src/renderer/components/tools/ApprovalPrompt';
import { LocalConnectorPromptBody } from '../src/renderer/components/LocalConnectorPromptModal';
import { ToolCallPart } from '../src/renderer/components/tools/ToolCallPart';
import { liveWorkPhase } from '../src/renderer/components/WorkingIndicator';
import {
  buildConnectorLaunchCommand,
  LocalHarnessesView,
} from '../src/renderer/settings/LocalHarnessesPane';
import { chatReducer, initialChatState, type PendingApproval } from '../src/renderer/state/chatReducer';

const SAMPLE_SECRET = 'crw_conn_secret_token_0123456789abcdef01234567';

function sampleConnector(overrides: Partial<LocalConnectorView> = {}): LocalConnectorView {
  const now = new Date('2026-11-26T12:00:00.000Z');
  return {
    id: 'clconn000000000000000001',
    name: 'MacBook Pro',
    status: 'ONLINE',
    busy: false,
    tokenPrefix: 'crw_conn_secret_',
    reportMode: 'summary',
    workspaceName: 'crewaid-public',
    hostName: 'dev-macbook',
    harnesses: ['claude-code', 'codex'],
    defaultHarness: 'claude-code',
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('LocalHarnessesView (Settings → Local harnesses)', () => {
  it('renders loading skeleton before connectors load', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <LocalHarnessesView
          connectors={null}
          serverUrl={null}
          problem={null}
          issued={null}
          busyId={null}
          creating={false}
          onCreate={async () => true}
          onRotate={vi.fn()}
          onRemove={vi.fn()}
          onDismissIssued={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(html).toContain('aria-busy="true"');
  });

  it('renders connector status chips, summary copy naming command titles like pnpm test, and zero-token launch command', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <LocalHarnessesView
          connectors={[
            sampleConnector({ id: 'clconn000000000000000001', status: 'ONLINE', busy: false }),
            sampleConnector({
              id: 'clconn000000000000000002',
              name: 'Linux Box',
              status: 'ONLINE',
              busy: true,
              reportMode: 'full',
            }),
            sampleConnector({
              id: 'clconn000000000000000003',
              name: 'Home iMac',
              status: 'OFFLINE',
              busy: false,
              workspaceName: null,
              harnesses: [],
            }),
          ]}
          serverUrl="https://crewaid.example.test/"
          problem={null}
          issued={{
            connectorId: 'clconn000000000000000001',
            connectorName: 'MacBook Pro',
            secret: SAMPLE_SECRET,
          }}
          busyId={null}
          creating={false}
          onCreate={async () => true}
          onRotate={vi.fn()}
          onRemove={vi.fn()}
          onDismissIssued={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(html).toContain('MacBook Pro');
    expect(html).toContain('Online');
    expect(html).toContain('Busy');
    expect(html).toContain('Offline');
    expect(html).toContain('Summary only');
    expect(html).toContain('Full transcript');
    expect(html).toContain('claude-code, codex');
    // User note: Settings copy explicitly notes summary mode reports command titles such as pnpm test
    expect(html).toContain('pnpm test');

    // Launch command MUST NOT include the token (and defaults to current directory)
    const launch = buildConnectorLaunchCommand('https://crewaid.example.test/');
    expect(launch).toBe('npx crewaid-connect --url https://crewaid.example.test');
    expect(launch).not.toContain('crw_conn_');
    expect(html).toContain(launch);
    // Secret is masked by default (raw secret never dumped in plain text before reveal)
    expect(html).toContain('data-connector-secret-box');
    expect(html).not.toContain(SAMPLE_SECRET);
  });

  it('renders detected local harnesses, managed desktop folder controls, and CLI fallback option', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <LocalHarnessesView
          connectors={[sampleConnector({ id: 'clconn000000000000000001', status: 'OFFLINE' })]}
          managed={[
            {
              connectorId: 'clconn000000000000000001',
              name: 'MacBook Pro',
              directory: '/Users/dev/my-app',
              serverUrl: 'https://crewaid.example.test',
              reportMode: 'summary',
              confirmInApp: true,
              autoStart: false,
              state: 'paused',
              harnesses: ['claude-code'],
            },
          ]}
          detectedHarnesses={[
            {
              id: 'claude-code',
              label: 'Claude Code',
              command: 'claude-agent-acp',
              available: true,
              resolvedPath: '/opt/homebrew/bin/claude-agent-acp',
              installCommand: 'npm install -g @agentclientprotocol/claude-agent-acp',
              installHint: 'npm install -g @agentclientprotocol/claude-agent-acp',
            },
            {
              id: 'codex',
              label: 'Codex',
              command: 'codex-acp',
              available: false,
              resolvedPath: null,
              installCommand: 'npm install -g @agentclientprotocol/codex-acp',
              installHint: 'npm install -g @agentclientprotocol/codex-acp',
            },
            {
              id: 'antigravity',
              label: 'Antigravity',
              command: 'agy',
              available: false,
              resolvedPath: null,
              installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
              installHint: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
            },
          ]}
          desktopSupported
          serverUrl="https://crewaid.example.test"
          problem={null}
          issued={null}
          busyId={null}
          creating={false}
          onToggleManaged={vi.fn()}
          onCreate={async () => true}
          onRotate={vi.fn()}
          onRemove={vi.fn()}
          onDismissIssued={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Available on this computer');
    expect(html).toContain('Claude Code');
    expect(html).toContain('Ready');
    expect(html).toContain('Not installed');
    expect(html).toContain('Copy install');
    expect(html).toContain('curl -fsSL https://antigravity.google/cli/install.sh | bash');
    expect(html).toContain('This computer');
    expect(html).toContain('/Users/dev/my-app');
    expect(html).toContain('Paused');
    expect(html).toContain('Connect another machine (CLI)');
  });
});

describe('LocalConnectorPromptBody (in-app confirmation and ACP permission modal)', () => {
  it('renders full verbatim prompt for local task confirmation', () => {
    const marker = 'EXACT_TAIL_PROMPT_VERIFICATION_777';
    const html = renderToStaticMarkup(
      <I18nProvider>
        <LocalConnectorPromptBody
          prompt={{
            kind: 'confirm_task',
            requestId: 'req-1',
            connectorId: 'clconn000000000000000001',
            connectorName: 'my-app',
            botName: 'Atlas',
            workspaceName: 'my-app',
            relativeCwd: 'packages/api',
            harness: 'claude-code',
            reportMode: 'summary',
            prompt: `Refactor auth middleware\n${marker}`,
            verifyCommand: 'pnpm test',
          }}
          onRespond={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-local-connector-prompt="confirm_task"');
    expect(html).toContain('Atlas');
    expect(html).toContain('my-app/packages/api');
    expect(html).toContain('pnpm test');
    expect(html).toContain(marker);
    expect(html).toContain('Run locally');
    expect(html).toContain('Decline');
  });

  it('renders local ACP permission options and affected file locations', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <LocalConnectorPromptBody
          prompt={{
            kind: 'request_permission',
            requestId: 'req-2',
            connectorId: 'clconn000000000000000001',
            connectorName: 'my-app',
            title: 'Run pnpm test',
            toolKind: 'execute',
            locations: ['package.json'],
            options: [
              { optionId: 'allow_1', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject_1', name: 'Reject', kind: 'reject_once' },
            ],
          }}
          onRespond={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-local-connector-prompt="request_permission"');
    expect(html).toContain('Run pnpm test');
    expect(html).toContain('package.json');
    expect(html).toContain('Allow once');
    expect(html).toContain('Deny');
  });
});

describe('ApprovalPrompt for local_code_task', () => {
  it('renders bound target metadata and the full untruncated prompt', () => {
    const tailMarker = 'TAIL_MARKER_VERIFY_UNTRUNCATED_END_999';
    const longGoal = `Refactor authentication middleware.\n${'details '.repeat(350)}\n${tailMarker}`;
    const approval: PendingApproval = {
      turnId: 'turn-1',
      toolCallId: 'prop-1',
      toolName: 'local_code_task',
      args: {
        connectorId: 'clconn000000000000000001',
        goal: longGoal,
        relativeCwd: 'apps/orchestrator',
        harness: 'claude-code',
        verifyCommand: 'pnpm test',
      },
      binding: {
        toolName: 'local_code_task',
        effect: 'commit',
        scope: 'call',
        argsHash: 'a'.repeat(64),
        grantRevision: 'b'.repeat(64),
        resourceRevision: null,
        seat: null,
        commit: {
          account: 'MacBook Pro (crewaid-public)',
          destinations: ['clconn000000000000000001:apps/orchestrator'],
          contentRevision: 'deadbeef1234' + '0'.repeat(52),
        },
      },
    };

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ApprovalPrompt approval={approval} botName="Atlas" onRespond={vi.fn()} />
      </I18nProvider>,
    );

    expect(html).toContain('data-local-code-task-review');
    expect(html).toContain('MacBook Pro (crewaid-public)');
    expect(html).toContain('apps/orchestrator');
    expect(html).toContain('claude-code');
    expect(html).toContain('deadbeef1234');
    expect(html).toContain('pnpm test');
    expect(html).toContain(tailMarker);
  });
});

describe('local_code_task progress states and connector.status reducer', () => {
  it('parses waiting_local_permission and renders it in ToolCallPart and WorkingIndicator', () => {
    const parsed = parseCodingProgress(CODING_PROGRESS_EVENT, {
      toolCallId: 'tc-local-1',
      kind: 'waiting_local_permission',
      sessionId: 'lcode_1',
      runnerId: 'acp:local:claude-code',
      connectorName: 'MacBook Pro',
      permissionToolCallId: 'acp_tc_1',
      title: 'Run pnpm test',
      toolKind: 'execute',
      step: 0,
      maxSteps: 0,
      filesChangedCount: 0,
    });
    expect(parsed).toMatchObject({
      kind: 'waiting_local_permission',
      connectorName: 'MacBook Pro',
      title: 'Run pnpm test',
    });

    const progressMap = new Map([[parsed!.toolCallId, parsed!]]);
    const toolHtml = renderToStaticMarkup(
      <I18nProvider>
        <ToolCallPart
          part={{
            type: 'tool-call',
            toolCallId: 'tc-local-1',
            toolName: 'local_code_task',
            input: { connectorId: 'clconn000000000000000001', goal: 'Fix bug' },
            status: 'running',
          }}
          context={{ codingProgress: progressMap }}
        />
      </I18nProvider>,
    );
    expect(toolHtml).toContain('Waiting for local permission on MacBook Pro: Run pnpm test');

    const phase = liveWorkPhase(
      [
        {
          id: 'm1',
          author: 'BOT',
          createdAt: new Date().toISOString(),
          live: true,
          parts: [
            {
              type: 'tool-call',
              toolCallId: 'tc-local-1',
              toolName: 'local_code_task',
              input: {},
              status: 'running',
            },
          ],
          attachments: [],
        },
      ],
      'ACTING',
      undefined,
      progressMap,
    );
    expect(phase).toBe('Waiting for local permission on MacBook Pro');
  });

  it('increments connectorsVersion on connector.status WS frame', () => {
    const next = chatReducer(initialChatState, {
      type: 'ws/frame',
      frame: {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'connector.status',
        ts: Date.now(),
        payload: {
          connectorId: 'clconn000000000000000001',
          status: 'ONLINE',
          busy: false,
        },
      },
    });
    expect(next.connectorsVersion).toBe(1);
  });
});
