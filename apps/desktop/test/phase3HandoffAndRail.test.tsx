import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@novnc/novnc', () => ({ default: class {} }));

import type { BotGroup, BotWithSandbox, DeliverableView, VisualHandoffBlock } from '@crewaid/shared';
import {
  HandoffBlock,
  extractLatestHandoff,
} from '../src/renderer/components/visuals/HandoffBlock';
import { RightRailHandoffSection } from '../src/renderer/components/visuals/RightRailHandoffSection';
import { applyComposerSeed } from '../src/renderer/components/composer/composerState';
import { ScreenCard } from '../src/renderer/screen/ScreenCard';
import { sidebarSections } from '../src/renderer/state/sidebarSections';
import type { BotRowView, TranscriptMessage } from '../src/renderer/state/viewTypes';
import { DeliverablePane } from '../src/renderer/work/DeliverablePane';
import type { ApiClient } from '../src/renderer/api/apiClient';

function sampleHandoff(overrides?: Partial<VisualHandoffBlock>): VisualHandoffBlock {
  return {
    kind: 'handoff',
    revision: 2,
    outcome: 'Gate 1 research and ad packet finished. Ready for your call on landing page scope.',
    readyToReview: [
      {
        label: 'launch-packet.md',
        deliverableId: 'deliv_latest',
        owner: 'Gideon',
        status: 'published',
        version: 2,
        note: 'Includes revised C4 scoring and ad copy',
      },
      {
        label: 'launch-packet.md (earlier)',
        deliverableId: 'deliv_old',
        owner: 'Gideon',
        status: 'superseded',
        version: 1,
      },
      {
        label: '/home/bot/groups/cmww0x/00-research/raw-notes.md',
        owner: 'Diana',
        status: 'unpublished',
        note: 'Workspace draft only',
      },
    ],
    stillOpen: [
      {
        item: 'Confirm daily traffic on /get',
        owner: 'Kira',
        blocker: 'Needs analytics export',
      },
    ],
    waitingOnYou: [
      {
        id: 'd4-scope',
        question: 'Approve Option A (4-part build) or Option B (ship ads without split test)?',
        recommendation: 'Option B ships tomorrow while measurement is built separately.',
        options: [
          {
            label: 'Approve Option B',
            replyText: 'Approve Option B: ship ads now and track measurement separately.',
          },
          {
            label: 'Hold for Option A',
            replyText: 'Hold launch until Option A split test is implemented.',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeBot(overrides?: Partial<BotWithSandbox>): BotWithSandbox {
  return {
    id: 'clx1a2b3c4d5e6f7g8h9i0j1',
    userId: 'usr_1',
    name: 'Gideon',
    role: 'Marketing PM',
    kind: 'STANDARD',
    groupId: 'grp_marketing',
    avatarColor: '#7B5CE0',
    avatarShape: null,
    avatarUrl: null,
    systemPrompt: '',
    modelId: 'default',
    approvalMode: 'ASK',
    status: 'IDLE',
    sortOrder: 0,
    pinned: false,
    hiddenFromSidebar: false,
    autoReviewRules: [],
    createdAt: new Date('2026-11-25T10:00:00Z'),
    updatedAt: new Date('2026-11-25T10:00:00Z'),
    sandboxId: 'sbx_1',
    sandbox: {
      id: 'sbx_1',
      state: 'STOPPED',
      lastActiveAt: new Date('2026-11-25T11:00:00Z'),
    },
    thread: { id: 'thr_1', preview: null },
    ...overrides,
  };
}

describe('Phase 3 — Handoff card, composer draft preservation, snapshots & right rail', () => {
  it('renders HandoffBlock in strict section order with filed counts, status pills, and Review then send decisions', () => {
    const html = renderToStaticMarkup(<HandoffBlock block={sampleHandoff()} />);

    const outcomeIdx = html.indexOf('data-handoff-section="outcome"');
    const readyIdx = html.indexOf('data-handoff-section="ready-to-review"');
    const openIdx = html.indexOf('data-handoff-section="still-open"');
    const waitingIdx = html.indexOf('data-handoff-section="waiting-on-you"');

    expect(outcomeIdx).toBeGreaterThan(-1);
    expect(readyIdx).toBeGreaterThan(outcomeIdx);
    expect(openIdx).toBeGreaterThan(readyIdx);
    expect(waitingIdx).toBeGreaterThan(openIdx);

    // 1 active published file out of 3 listed records
    expect(html).toContain('1 of 3 published');
    expect(html).toContain('data-handoff-open');
    expect(html).toContain('Superseded');
    expect(html).toContain('Unpublished');
    expect(html).toContain('Workspace only');
    // Internal sandbox path is masked
    expect(html).not.toContain('/home/bot/groups/cmww0x');
    expect(html).toContain('Select an option to draft — review before sending');
    expect(html).toContain('Approve Option B');
  });

  it('extracts the latest handoff revision from transcript messages while preserving revision count', () => {
    const makeVisualMsg = (id: string, revision: number, outcome: string): TranscriptMessage => ({
      id,
      author: 'BOT',
      fromBotId: null,
      createdAt: '2026-11-25T11:40:00Z',
      parts: [
        {
          type: 'tool-call',
          toolCallId: `tc_${id}`,
          toolName: 'present_visual',
          state: 'output-available',
          input: {
            title: `Launch handoff v${revision}`,
            blocks: [sampleHandoff({ revision, outcome })],
          },
          output: {
            title: `Launch handoff v${revision}`,
            blocks: [sampleHandoff({ revision, outcome })],
          },
        },
      ],
    });

    const makeGroupedVisualMsg = (id: string, revision: number, outcome: string): TranscriptMessage => ({
      id,
      author: 'BOT',
      fromBotId: null,
      createdAt: '2026-11-25T11:41:00Z',
      parts: [
        {
          type: 'tool-activity',
          calls: [
            {
              type: 'tool-call',
              toolCallId: `tc_${id}`,
              toolName: 'present_visual',
              status: 'ok',
              input: {
                title: `Launch handoff v${revision}`,
                blocks: [sampleHandoff({ revision, outcome })],
              },
              output: {
                title: `Launch handoff v${revision}`,
                blocks: [sampleHandoff({ revision, outcome })],
              },
            },
          ],
        },
      ],
    });

    const latest = extractLatestHandoff([
      makeVisualMsg('m1', 1, 'First draft ready'),
      makeGroupedVisualMsg('m2', 2, 'Revised final packet ready'),
    ]);

    expect(latest).not.toBeNull();
    expect(latest!.messageId).toBe('m2');
    expect(latest!.revisionCount).toBe(2);
    expect(latest!.block.revision).toBe(2);
    expect(latest!.block.outcome).toBe('Revised final packet ready');

    const railHtml = renderToStaticMarkup(
      <RightRailHandoffSection
        handoff={latest!}
        onJumpToHandoff={vi.fn()}
        actions={{ onOpenDeliverable: vi.fn(), onReviewDecision: vi.fn() }}
      />,
    );
    expect(railHtml).toContain('data-rail-handoff');
    expect(railHtml).toContain('Current handoff');
    expect(railHtml).toContain('data-rail-pending-decisions');
    expect(railHtml).toContain('Approve Option B');
  });

  it('preserves existing composer draft text when applying append-mode decision seeds', () => {
    const existing = { mode: 'idle' as const, draft: 'Also ask Diana about pricing.' };
    const appended = applyComposerSeed(existing, {
      text: 'Approve Option B: ship ads now.',
      mode: 'append',
    });
    expect(appended.draft).toBe('Also ask Diana about pricing.\n\nApprove Option B: ship ads now.');
    expect(appended.mode).toBe('idle');

    const replaced = applyComposerSeed(existing, {
      text: 'Fresh prompt',
      mode: 'replace',
    });
    expect(replaced.draft).toBe('Fresh prompt');

    const onEmpty = applyComposerSeed(
      { mode: 'idle', draft: '   ' },
      { text: 'Approve Option B', mode: 'append' },
    );
    expect(onEmpty.draft).toBe('Approve Option B');
  });

  it('renders compact Sleeping computer card when sandbox is STOPPED', () => {
    const html = renderToStaticMarkup(
      <ScreenCard
        bot={makeBot()}
        expanded={false}
        onExpandedChange={vi.fn()}
        watchScreen={() => () => undefined}
        sendScreenInput={() => false}
        openScreenStream={vi.fn()}
        wake={undefined}
        onWake={vi.fn()}
        recording={undefined}
        onTeachTask={vi.fn()}
        onStopRecording={vi.fn()}
        onDiscardRecording={vi.fn()}
        onReviewSkill={vi.fn()}
        seatControl={undefined}
        controlScreen={vi.fn()}
      />,
    );

    expect(html).toContain('data-computer-compact="sleeping"');
    expect(html).toContain('data-screen-state="stopped"');
    expect(html).toContain('Sleeping');
    // The same single action the full card offers when asleep.
    expect(html).toContain('Open computer');
  });

  it('renders publisher, review state, masked source path, and superseded banner with Open latest in DeliverablePane', () => {
    const deliverable: DeliverableView = {
      id: 'deliv_v1',
      kind: 'FILE',
      title: 'launch-packet.md',
      summary: 'Earlier Gate 1 draft',
      botId: 'clx1a2b3c4d5e6f7g8h9i0j1',
      publisherName: 'Gideon',
      attachmentId: 'att_1',
      attachment: {
        id: 'att_1',
        messageId: 'msg_1',
        filename: 'launch-packet.md',
        mimeType: 'text/markdown',
        sizeBytes: 2048,
      },
      url: null,
      messageId: 'msg_1',
      taskId: null,
      goalId: null,
      projectId: null,
      task: null,
      goal: null,
      project: null,
      sourcePath: '/home/bot/groups/cmww0x/launch-packet.md',
      reviewState: 'READY',
      supersededById: 'deliv_v2',
      createdAt: new Date('2026-11-25T11:35:00Z'),
    };
    const stubClient = {} as unknown as ApiClient;
    const html = renderToStaticMarkup(
      <DeliverablePane
        client={stubClient}
        deliverable={deliverable}
        bots={[makeBot()]}
        projects={[]}
        onClose={vi.fn()}
        onOpenConversation={vi.fn()}
        onOpenTask={vi.fn()}
        onOpenDeliverableById={vi.fn()}
      />,
    );

    expect(html).toContain('data-deliverable-publisher');
    expect(html).toContain('Gideon');
    expect(html).toContain('data-deliverable-superseded="deliv_v2"');
    expect(html).toContain('data-open-latest-deliverable');
    expect(html).toContain('Open latest');
    expect(html).not.toContain('/home/bot/groups/cmww0x');
    expect(html).toMatch(/data-deliverable-source[^>]*>launch-packet\.md</);
  });

  it('populates approvalBots separately from unread counts in sidebarSections', () => {
    const group: BotGroup = {
      id: 'grp_marketing',
      name: 'Marketing & Launches',
      sortOrder: 0,
      collapsed: false,
      createdAt: new Date('2026-11-25T09:00:00Z'),
      updatedAt: new Date('2026-11-25T09:00:00Z'),
    };
    const row = (id: string, name: string, status: BotWithSandbox['status']): BotRowView => ({
      bot: makeBot({ id, name, status }),
      preview: 'Ready',
      unread: 0,
    });
    const sections = sidebarSections(
      [
        row('bot_diana', 'Diana', 'AWAITING_APPROVAL'),
        row('bot_kira', 'Kira', 'AWAITING_APPROVAL'),
        row('bot_gideon', 'Gideon', 'IDLE'),
      ],
      [group],
      { bot_diana: 2, bot_kira: 1, bot_gideon: 4 },
    );

    expect(sections).not.toBeNull();
    expect(sections![0]!.unread).toBe(7);
    expect(sections![0]!.needsApproval).toBe(true);
    expect(sections![0]!.approvalBots.map((r) => r.bot.name)).toEqual(['Diana', 'Kira']);
  });
});
