import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectPublicSpeech, type WorkflowChainSummary } from '@crewaid/shared';
import { launchDesktop } from './launchDesktop';
import { chatMessage, routeChat, routeSocket } from './stubChat';
import { startStubAuthServer } from './stubAuthServer';
import type { CrewaidBridge } from '../src/preload.js';

const GROUP_ID = 'grp_marketing_launches';
const GIDEON_ID = 'clxgideon0000000000000001';
const DIANA_ID = 'clxdiana00000000000000002';
const KIRA_ID = 'clxkira000000000000000003';
const JULIAN_ID = 'clxjulian0000000000000004';
const CHAIN_ID = 'chain_marketing_launch_1';

function makeBot(input: {
  id: string;
  name: string;
  role: string;
  color: string;
  status: 'IDLE' | 'RUNNING' | 'AWAITING_APPROVAL';
  threadId: string;
  preview: string;
  sortOrder: number;
  unreadCount?: number;
  sandboxState?: 'STOPPED' | 'RUNNING' | null;
}) {
  return {
    id: input.id,
    userId: 'usr_e2e_singleton',
    kind: 'STANDARD',
    groupId: GROUP_ID,
    name: input.name,
    role: input.role,
    avatarColor: input.color,
    avatarShape: null,
    avatarUrl: null,
    systemPrompt: '',
    modelId: 'default',
    approvalMode: 'ASK',
    status: input.status,
    sortOrder: input.sortOrder,
    pinned: false,
    hiddenFromSidebar: false,
    autoReviewRules: [],
    createdAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T11:40:00.000Z',
    sandboxId: input.sandboxState ? `sbx_${input.id}` : null,
    sandbox: input.sandboxState
      ? {
          id: `sbx_${input.id}`,
          userId: 'usr_e2e_singleton',
          sessionId: null,
          containerId: null,
          state: input.sandboxState,
          widthPx: 1280,
          heightPx: 800,
          vncPort: null,
          cdpPort: null,
          bridgePort: null,
          lastStartedAt: '2026-11-25T10:05:00.000Z',
          lastError: null,
          lastActiveAt: '2026-11-25T11:30:00.000Z',
          keepRunningUntil: null,
        }
      : null,
    thread: {
      id: input.threadId,
      preview: {
        text: projectPublicSpeech(input.preview),
        createdAt: '2026-11-25T11:40:00.000Z',
      },
    },
    unreadCount: input.unreadCount ?? 0,
  };
}

function toolMessages(
  id: string,
  createdAt: string,
  calls: Array<{ name: string; input: unknown; output: unknown }>,
  preToolText = '',
): Record<string, unknown>[] {
  return [
    {
      ...chatMessage({
        id,
        text: preToolText,
        createdAt,
        crewaid: { author: 'BOT' },
      }),
      toolCalls: calls.map((call, idx) => ({
        id: `${id}-call-${idx}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input),
        },
      })),
    },
    ...calls.map((call, idx) => ({
      id: `${id}-res-${idx}`,
      role: 'tool',
      toolCallId: `${id}-call-${idx}`,
      content: typeof call.output === 'string' ? call.output : JSON.stringify(call.output),
    })),
  ];
}

test('Agentic UX acceptance — Gideon Marketing & Launches end-to-end in Electron', async () => {
  test.setTimeout(120_000);
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-agentic-ux-'));
  const screenshotDir = process.env['AGENTIC_UX_SCREENSHOT_DIR'] ?? test.info().outputPath();
  await mkdir(screenshotDir, { recursive: true });
  let app: ElectronApplication | undefined;

  const group = {
    id: GROUP_ID,
    userId: 'usr_e2e_singleton',
    name: 'Marketing & Launches',
    instructions: '',
    sortOrder: 0,
    collapsed: false,
    createdAt: '2026-11-25T09:00:00.000Z',
    updatedAt: '2026-11-25T09:00:00.000Z',
  };

  const bots = [
    makeBot({
      id: GIDEON_ID,
      name: 'Gideon',
      role: 'Marketing Project Manager',
      color: '#8D6E63',
      status: 'IDLE',
      threadId: 'thr_gideon',
      preview:
        '<think>internal draft Emit. Go. Now. Ok.</think>Gate 1 launch packet is ready for review.',
      sortOrder: 0,
      sandboxState: 'STOPPED',
    }),
    makeBot({
      id: DIANA_ID,
      name: 'Diana',
      role: 'Competitive Research',
      color: '#15AABF',
      status: 'AWAITING_APPROVAL',
      threadId: 'thr_diana',
      preview: 'Waiting for approval to publish parity table.',
      sortOrder: 1,
      unreadCount: 2,
    }),
    makeBot({
      id: KIRA_ID,
      name: 'Kira',
      role: 'Growth Copywriter',
      color: '#FD7E14',
      status: 'AWAITING_APPROVAL',
      threadId: 'thr_kira',
      preview: 'Waiting for approval on AG3 ad copy.',
      sortOrder: 2,
      unreadCount: 1,
    }),
    makeBot({
      id: JULIAN_ID,
      name: 'Julian',
      role: 'Product Marketer',
      color: '#7950F2',
      status: 'IDLE',
      threadId: 'thr_julian',
      preview: 'Platform download detection verified.',
      sortOrder: 3,
    }),
  ];

  const deliverableV1 = {
    id: 'deliv_gate1_v1',
    userId: 'usr_e2e_singleton',
    kind: 'FILE',
    title: 'GATE-1-PACKET.md',
    summary: 'Initial Gate 1 launch packet before AG3 and C4 corrections.',
    botId: GIDEON_ID,
    publisherName: 'Gideon',
    attachmentId: 'att_gate1_v1',
    attachment: {
      id: 'att_gate1_v1',
      messageId: 'msg_handoff',
      filename: 'GATE-1-PACKET.md',
      mimeType: 'text/markdown',
      sizeBytes: 1420,
      storageKey: '2026-11-25/gate-1-v1.md',
      kind: 'FILE',
      durationMs: null,
    },
    url: null,
    messageId: 'msg_handoff',
    taskId: null,
    goalId: null,
    projectId: null,
    task: null,
    goal: null,
    sourcePath: '/home/bot/groups/cmww0x3x/GATE-1-PACKET.md',
    reviewState: 'READY',
    supersededById: 'deliv_gate1_v2',
    createdAt: '2026-11-25T11:34:00.000Z',
  };

  const deliverableV2 = {
    id: 'deliv_gate1_v2',
    userId: 'usr_e2e_singleton',
    kind: 'FILE',
    title: 'GATE-1-PACKET.md',
    summary: 'Final Gate 1 launch packet with AG3 update and verified platform check.',
    botId: GIDEON_ID,
    publisherName: 'Gideon',
    attachmentId: 'att_gate1_v2',
    attachment: {
      id: 'att_gate1_v2',
      messageId: 'msg_handoff',
      filename: 'GATE-1-PACKET.md',
      mimeType: 'text/markdown',
      sizeBytes: 2180,
      storageKey: '2026-11-25/gate-1-v2.md',
      kind: 'FILE',
      durationMs: null,
    },
    url: null,
    messageId: 'msg_handoff',
    taskId: null,
    goalId: null,
    projectId: null,
    task: null,
    goal: null,
    sourcePath: '/home/bot/groups/cmww0x3x/GATE-1-PACKET.md',
    reviewState: 'READY',
    supersededById: null,
    createdAt: '2026-11-25T11:40:00.000Z',
  };

  const handoffPayload = {
    title: 'Marketing & Launches — Gate 1 Closeout',
    subtitle: 'Compiled from /home/bot/groups/cmww0x3x/BOARD.md',
    blocks: [
      {
        kind: 'handoff',
        revision: 2,
        outcome:
          'Gate 1 research, revised ad copy, and landing audit finished. Ready for your call on Option A vs. Option B.',
        readyToReview: [
          {
            label: 'GATE-1-PACKET.md',
            deliverableId: 'deliv_gate1_v2',
            owner: 'Gideon',
            status: 'published',
            version: 2,
            note: 'Updated AG3 headline and verified macOS/Windows download routing',
          },
          {
            label: 'GATE-1-PACKET.md (earlier draft)',
            deliverableId: 'deliv_gate1_v1',
            owner: 'Gideon',
            status: 'superseded',
            version: 1,
            note: 'Replaced after Julian and Kira corrections',
          },
          {
            label: '/home/bot/groups/cmww0x3x/00-research/raw-captures.md',
            owner: 'Diana',
            status: 'unpublished',
            note: 'Scratch notes remain in workspace only',
          },
        ],
        stillOpen: [
          {
            item: 'Confirm daily traffic on /get before split-test sizing',
            owner: 'Kira',
            blocker: 'Needs one daily session count from analytics',
          },
        ],
        waitingOnYou: [
          {
            id: 'd4-scope',
            question: 'Ship paid search ads tomorrow or hold for the 4-part split-test build?',
            recommendation:
              'Approve Option B to ship ads now with revised AG3 copy while measurement is built separately.',
            consequence: 'Holding for Option A adds 4 engineering tasks across two hosts.',
            options: [
              {
                label: 'Approve Option B',
                replyText:
                  'Approve Option B: ship paid search ads with "It Pauses, Not Bills" and track split-test measurement separately.',
              },
              {
                label: 'Hold for Option A',
                replyText:
                  'Hold launch until Option A split-test middleware and worker logging are ready.',
              },
            ],
          },
        ],
      },
    ],
  };

  const longDianaMemo =
    'Competitor research is locked to draft and verified across all four homepages in /home/bot/groups/cmww0x3x/00-research/competitor-claims.md. ' +
    'No competitor demonstrates a completed multi-agent handoff with verifiable artifacts or cost-per-task telemetry. ' +
    'All homepage screenshots and innerText captures are stored in evidence and cross-checked against Julian and Kira findings so Gate 1 positioning stands without unverified claims.';

  const gideonHistory: Record<string, unknown>[] = [
    chatMessage({
      id: 'msg_user_wrap',
      text: 'Please wrap up Gate 1 and show me what is ready to review.',
      createdAt: '2026-11-25T11:32:00.000Z',
      crewaid: { author: 'USER' },
    }),
    // Pre-tool narration alongside a routine shell call — hidden when showBotWork is false.
    ...toolMessages(
      'msg_pretool',
      '2026-11-25T11:33:00.000Z',
      [
        {
          name: 'shell',
          input: { command: 'ls /home/bot/groups/cmww0x3x' },
          output: 'GATE-1-PACKET.md',
        },
      ],
      'Let me check the folder and inspect the files before summarizing.',
    ),
    // Long incoming peer handoff from Diana — collapses to 2-line preview with jump-back link.
    chatMessage({
      id: 'msg_diana_handoff',
      text: longDianaMemo,
      createdAt: '2026-11-25T11:35:00.000Z',
      crewaid: { author: 'BOT', fromBotId: DIANA_ID },
    }),
    // Consecutive successful delivery receipts fold into one expandable line; failure stays visible.
    chatMessage({
      id: 'msg_receipt_1',
      text: 'Your message to Julian was delivered to their conversation.',
      createdAt: '2026-11-25T11:35:10.000Z',
      crewaid: { author: 'SYSTEM' },
    }),
    chatMessage({
      id: 'msg_receipt_2',
      text: 'Your message to Kira was delivered to their conversation.',
      createdAt: '2026-11-25T11:35:12.000Z',
      crewaid: { author: 'SYSTEM' },
    }),
    chatMessage({
      id: 'msg_receipt_fail',
      text: 'Could not deliver message to Oscar: recipient thread is paused.',
      createdAt: '2026-11-25T11:35:15.000Z',
      crewaid: { author: 'SYSTEM' },
    }),
    // Message containing raw reasoning/budget leakage + legitimate Markdown code block.
    chatMessage({
      id: 'msg_safe_reply',
      text:
        '<think>Produce. Write. Emit. Go. Now. Ok. Internal draft leakage.</think>' +
        '<budget:token_budget>200000</budget:token_budget>' +
        'Platform detection is confirmed working. Example snippet preserved:\n\n```ts\nconst sampleTag = "<think>";\n```',
      createdAt: '2026-11-25T11:38:00.000Z',
      crewaid: { author: 'BOT' },
    }),
    // Structured Gate 1 handoff card.
    ...toolMessages('msg_handoff', '2026-11-25T11:40:00.000Z', [
      {
        name: 'present_visual',
        input: handoffPayload,
        output: handoffPayload,
      },
    ]),
  ];

  const dianaHistory: Record<string, unknown>[] = [
    chatMessage({
      id: 'msg_diana_sent',
      text: longDianaMemo,
      createdAt: '2026-11-25T11:35:00.000Z',
      crewaid: { author: 'BOT' },
    }),
  ];

  let activeWorkflows: WorkflowChainSummary[] = [
    {
      chainId: CHAIN_ID,
      status: 'ACTIVE',
      rootBotId: GIDEON_ID,
      groupId: GROUP_ID,
      participantBotIds: [GIDEON_ID, DIANA_ID, KIRA_ID],
      activeBotIds: [DIANA_ID, KIRA_ID],
      expectedOwners: [],
      respondedOwners: [],
      deadlineAt: null,
      startedAt: '2026-11-25T11:30:00.000Z',
    },
  ];
  let wrapUpCalls = 0;
  let stopWorkflowCalls = 0;
  const sentMessages: string[] = [];

  try {
    app = await launchDesktop(profile);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1440, 920),
    );
    const page = await app.firstWindow();

    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: bots }));
    await page.route('**/api/v1/groups*', (route) => route.fulfill({ json: [group] }));
    for (const endpoint of ['routines', 'goals', 'tasks', 'tools', 'projects']) {
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    }
    await page.route('**/api/v1/models', (route) =>
      route.fulfill({ json: { models: [], defaultModelId: null } }),
    );
    await page.route('**/api/v1/deliverables', (route) =>
      route.fulfill({ json: { items: [deliverableV2, deliverableV1], nextCursor: null, total: 2 } }),
    );
    await page.route('**/api/v1/deliverables?*', (route) =>
      route.fulfill({ json: { items: [deliverableV2, deliverableV1], nextCursor: null, total: 2 } }),
    );
    await page.route('**/api/v1/deliverables/deliv_gate1_v1', (route) =>
      route.fulfill({ json: deliverableV1 }),
    );
    await page.route('**/api/v1/deliverables/deliv_gate1_v2', (route) =>
      route.fulfill({ json: deliverableV2 }),
    );
    await page.route('**/api/v1/attachments/att_gate1_v1/download', (route) =>
      route.fulfill({
        contentType: 'text/markdown',
        body: '# Gate 1 Launch Packet — Revision 1\n\nSuperseded earlier draft.',
      }),
    );
    await page.route('**/api/v1/attachments/att_gate1_v2/download', (route) =>
      route.fulfill({
        contentType: 'text/markdown',
        body: '# Gate 1 Launch Packet — Revision 2\n\n- **AG3**: "It Pauses, Not Bills"\n- **Platform Check**: macOS / Windows / Linux routing verified.',
      }),
    );
    // Wildcard fallback registered FIRST so Gideon's specific handlers (registered later) take priority.
    await page.route('**/api/v1/bots/*/workflows', (route) =>
      route.fulfill({ json: { chains: [] } }),
    );
    await page.route(`**/api/v1/bots/${GIDEON_ID}/workflows`, (route) =>
      route.fulfill({ json: { chains: activeWorkflows } }),
    );
    await page.route(`**/api/v1/bots/${GIDEON_ID}/workflows/wrap-up`, (route) => {
      wrapUpCalls += 1;
      activeWorkflows = [
        {
          ...activeWorkflows[0]!,
          status: 'WRAPPING_UP',
          expectedOwners: [DIANA_ID, KIRA_ID],
          respondedOwners: [DIANA_ID],
          deadlineAt: '2026-11-25T11:42:00.000Z',
        },
      ];
      return route.fulfill({
        json: {
          chainId: CHAIN_ID,
          status: 'WRAPPING_UP',
          expectedOwners: [DIANA_ID, KIRA_ID],
          deadlineAt: '2026-11-25T11:42:00.000Z',
          acknowledgedMessageId: 'msg_wrap_ack',
        },
      });
    });
    await page.route(`**/api/v1/bots/${GIDEON_ID}/workflows/stop`, (route) => {
      stopWorkflowCalls += 1;
      activeWorkflows = [];
      return route.fulfill({
        json: {
          chainId: CHAIN_ID,
          status: 'STOPPED',
          stoppedBotIds: [DIANA_ID, KIRA_ID],
          cancelledRuns: 2,
        },
      });
    });

    await routeSocket(page);
    await routeChat(page, {
      threads: { thr_gideon: gideonHistory, thr_diana: dianaHistory },
      reply: ['Logged Option B. Moving forward with the revised ad set.'],
    });
    await page.route('**/api/v1/bots/*/chat*', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as {
          messages?: Array<{ content?: string }>;
        };
        const last = body.messages?.at(-1)?.content ?? '';
        sentMessages.push(last);
      }
      await route.fallback();
    });

    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'agentic-ux-e2e-token',
      });
      localStorage.setItem('crewaid.transcript.showBotWork', 'false');
      localStorage.setItem('crewaid.appearance.theme', 'light');
    }, auth.baseUrl);

    await page.reload();

    const transcript = page.getByRole('region', { name: 'Transcript' });
    await expect(transcript).toBeVisible();

    // 1. Output safety + calm transcript verification
    // Leaked thinking/budget/loop text is never shown in transcript or sidebar preview.
    await expect(transcript).not.toContainText('Produce. Write. Emit.');
    await expect(transcript).not.toContainText('budget:token_budget');
    await expect(page.locator('[data-pane="sidebar"]')).not.toContainText('Produce. Write.');
    // Legitimate fenced code snippet containing <think> IS preserved.
    await expect(transcript).toContainText('const sampleTag = "<think>";');
    // Pre-tool narration is hidden while showBotWork is off.
    await expect(transcript).not.toContainText('Let me check the folder and inspect the files');
    // Delivery receipts are folded into one activity toggle while failure stays visible.
    await expect(transcript.getByRole('button', { name: 'Delivered to 2 teammates' })).toBeVisible();
    await expect(transcript).toContainText('Could not deliver message to Oscar');
    // Long peer handoff from Diana is collapsed by default with masked path.
    const dianaCollapse = transcript.getByRole('button', { name: 'Show full message' }).first();
    await expect(dianaCollapse).toBeVisible();
    await expect(transcript).not.toContainText('/home/bot/groups/cmww0x3x');
    await dianaCollapse.click();
    await expect(transcript.getByRole('button', { name: 'Hide full message' }).first()).toBeVisible();

    // 2. Structured handoff card + compact Sleeping computer card + right rail Current handoff
    const handoff = transcript.locator('[data-handoff-card]');
    await expect(handoff).toBeVisible();
    await expect(handoff.locator('[data-handoff-section="outcome"]')).toBeVisible();
    await expect(handoff.locator('[data-handoff-section="ready-to-review"]')).toBeVisible();
    await expect(handoff.locator('[data-handoff-section="still-open"]')).toBeVisible();
    await expect(handoff.locator('[data-handoff-section="waiting-on-you"]')).toBeVisible();
    await expect(handoff.locator('[data-handoff-filed-count]')).toHaveText('1 of 3 published');
    await expect(handoff.locator('[data-artifact-status="unpublished"]')).toContainText(
      'Unpublished',
    );
    await expect(handoff.locator('[data-artifact-status="unpublished"]')).toContainText(
      'Workspace only',
    );

    // Open the right rail to verify compact Sleeping computer + Current handoff + Pending decisions.
    const expandRail = page.getByRole('button', { name: 'Expand panel' });
    if (await expandRail.isVisible()) {
      await expandRail.click();
      await page.mouse.move(10, 10);
    }
    const rail = page.locator('[data-pane="rail"]');
    await expect(rail.locator('[data-computer-compact="sleeping"]')).toBeVisible();
    await expect(rail.locator('[data-rail-handoff]')).toBeVisible();
    await expect(rail.locator('[data-rail-pending-decisions]')).toBeVisible();

    // Screenshot 1: Wide layout with handoff card, sleeping computer, current handoff & Needs you
    await handoff.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(screenshotDir, 'agentic-ux-handoff-wide.png') });

    // 3. Review-then-send decision preserves existing draft and never auto-sends
    const composer = page.getByRole('textbox');
    await composer.fill('Note: also verify EU pricing before publishing.');
    await handoff.locator('[data-decision-option="d4-scope:0"]').click();
    await expect(composer).toHaveValue(
      'Note: also verify EU pricing before publishing.\n\nApprove Option B: ship paid search ads with "It Pauses, Not Bills" and track split-test measurement separately.',
    );
    expect(sentMessages).toHaveLength(0);

    // Screenshot 2: Preserved draft + decision option ready to edit & send
    await page.screenshot({ path: path.join(screenshotDir, 'agentic-ux-decision-draft.png') });

    await composer.press('Enter');
    await expect.poll(() => sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('Note: also verify EU pricing before publishing.');
    expect(sentMessages[0]).toContain('Approve Option B');

    // 4. Exact artifact open + superseded v1 -> Open latest -> v2 in right rail
    await handoff
      .locator('[data-deliverable-id="deliv_gate1_v1"] [data-handoff-open]')
      .click();
    await expect(rail.locator('[data-deliverable-publisher]')).toContainText('Gideon');
    await expect(rail.locator('[data-deliverable-superseded="deliv_gate1_v2"]')).toBeVisible();
    await expect(rail).not.toContainText('/home/bot/groups/cmww0x3x');

    await rail.locator('[data-open-latest-deliverable]').click();
    await expect(rail.locator('[data-deliverable-superseded]')).toHaveCount(0);
    await expect(rail).toContainText('Gate 1 Launch Packet — Revision 2');

    // Screenshot 3: Opened v2 artifact right next to Gideon's handoff card
    await page.screenshot({ path: path.join(screenshotDir, 'agentic-ux-artifact-open.png') });

    // Open full-window Document Reader and verify the circular dropdown trigger centers its icon
    await rail.getByRole('button', { name: 'Open reader' }).click();
    const readerMore = page.locator('.crewaid-reader .dropdown__trigger');
    await expect(readerMore).toBeVisible();
    const triggerBox = await readerMore.boundingBox();
    const iconBox = await readerMore.locator('svg').boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(iconBox).not.toBeNull();
    expect(Math.abs(iconBox!.x + iconBox!.width / 2 - (triggerBox!.x + triggerBox!.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(iconBox!.y + iconBox!.height / 2 - (triggerBox!.y + triggerBox!.height / 2))).toBeLessThanOrEqual(1);
    await readerMore.click();
    await expect(page.getByRole('menuitem', { name: 'Copy Markdown' })).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDir, 'agentic-ux-reader-dropdown.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Copy Markdown' })).toHaveCount(0);
    await page.locator('.crewaid-reader').getByRole('button', { name: /Close/i }).click();
    await expect(page.locator('.crewaid-reader')).toHaveCount(0);

    // Close deliverable pane via Escape and open the same artifact from Deliverables tab
    await page.keyboard.press('Escape');
    await expect(rail.locator('[data-rail-handoff]')).toBeVisible();

    await page.getByRole('navigation', { name: 'Work' }).getByRole('tab', { name: /Deliverables/ }).click();
    await expect(page.getByRole('button', { name: /GATE-1-PACKET\.md/ }).first()).toBeVisible();
    await page.getByRole('button', { name: /GATE-1-PACKET\.md/ }).first().click();
    await expect(page.locator('[data-deliverable-publisher]')).toContainText('Gideon');
    await expect(page.getByRole('complementary', { name: 'Deliverable' })).toContainText(
      'Gate 1 Launch Packet — Revision 2',
    );

    // 5. Interactive Needs you popover jumps straight to Diana
    await page.getByRole('navigation', { name: 'Work' }).getByRole('tab', { name: /Crew/ }).click();
    const needsYou = page.locator('[data-needs-you]');
    await expect(needsYou).toBeVisible();
    await expect(needsYou).toHaveAttribute('data-needs-you-count', '2');
    await needsYou.click();
    await expect(page.locator(`[data-needs-you-bot="${DIANA_ID}"]`)).toBeVisible();
    await expect(page.locator(`[data-needs-you-bot="${KIRA_ID}"]`)).toBeVisible();
    await page.locator(`[data-needs-you-bot="${DIANA_ID}"]`).click();
    await expect(page.getByRole('region', { name: 'Transcript' })).toContainText(
      'Competitor research is locked to draft',
    );

    // Return to Gideon via sidebar, test peer sender jump-back & workflow Wrap up / Stop workflow
    await page.locator('[data-pane="sidebar"]').getByText('Gideon', { exact: true }).click();
    await expect(page.locator('[data-handoff-card]')).toBeVisible();

    // Jump from Diana's handoff attribution in Gideon's thread -> return via Back pill
    await page.locator(`[data-interbot-attribution="${DIANA_ID}"]`).first().click();
    const backPill = page.getByRole('button', { name: /Back to Gideon/i });
    await expect(backPill).toBeVisible();
    await backPill.click();
    await expect(page.locator('[data-handoff-card]')).toBeVisible();

    // Workflow controls: Wrap up -> wrapping badge -> Stop workflow
    const wrapBtn = page.locator('[data-wrap-up-workflow]');
    await expect(wrapBtn).toBeVisible();
    await wrapBtn.click();
    await expect.poll(() => wrapUpCalls).toBe(1);
    await expect(page.locator('[data-workflow-wrapping-badge]')).toContainText('Wrapping up (1/2)');

    await page.locator('[data-stop-workflow]').click();
    await expect.poll(() => stopWorkflowCalls).toBe(1);
    await expect(page.locator('[data-workflow-controls]')).toHaveCount(0);

    // 6. Compact viewport usability check (1040x720)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1040, 720),
    );
    await expect(page.locator('[data-handoff-card]')).toBeVisible();
    await page.locator('[data-handoff-card]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, 'agentic-ux-compact.png') });
  } finally {
    if (app) await app.close();
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
