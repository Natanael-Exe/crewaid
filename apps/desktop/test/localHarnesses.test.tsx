import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { LocalConnectorView } from '@crewaid/shared';

import {
  CODING_PROGRESS_EVENT,
  parseCodingProgress,
} from '../src/renderer/chat/codingProgress';
import { ApprovalPrompt } from '../src/renderer/components/tools/ApprovalPrompt';
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

    // Launch command MUST NOT include the token
    const launch = buildConnectorLaunchCommand('https://crewaid.example.test/');
    expect(launch).toBe('npx crewaid-connect /path/to/repo --url https://crewaid.example.test');
    expect(launch).not.toContain('crw_conn_');
    expect(html).toContain(launch);
    // Secret is masked by default (raw secret never dumped in plain text before reveal)
    expect(html).toContain('data-connector-secret-box');
    expect(html).not.toContain(SAMPLE_SECRET);
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
