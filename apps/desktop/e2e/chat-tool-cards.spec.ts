import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './launchDesktop';
import { chatMessage, routeChat, routeSocket } from './stubChat';
import { startStubAuthServer } from './stubAuthServer';
import type { CrewaidBridge } from '../src/preload.js';

const bot = {
  id: 'bot_cards',
  userId: 'usr_crewaid_singleton_v1',
  name: 'Quill',
  role: 'Writer',
  avatarColor: '#7B5CE0',
  avatarShape: null,
  avatarUrl: null,
  systemPrompt: '',
  modelId: 'default',
  status: 'IDLE',
  sortOrder: 0,
  pinned: false,
  hiddenFromSidebar: false,
  autoReviewRules: [],
  createdAt: '2026-10-01T12:00:00Z',
  updatedAt: '2026-10-01T12:00:00Z',
  sandboxId: null,
  sandbox: null,
  thread: { id: 'cards-thread', preview: null },
};
function actions(
  id: string,
  calls: Array<{ name: string; input: unknown; output: unknown }>,
): Record<string, unknown>[] {
  return [
    {
      ...chatMessage({
        id,
        text: '',
        createdAt: '2026-10-12T12:00:01Z',
        crewaid: { author: 'BOT' },
      }),
      toolCalls: calls.map((call, index) => ({
        id: `${id}-${index}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input),
        },
      })),
    },
    ...calls.map((call, index) => ({
      id: `${id}-result-${index}`,
      role: 'tool',
      toolCallId: `${id}-${index}`,
      content: typeof call.output === 'string' ? call.output : JSON.stringify(call.output),
    })),
  ];
}

// Native stored calls/results exercise projection + card selection after reload, without provider access.
test('chat output cards retain their identity, safe previews and existing actions in Light and Night', async () => {
  test.setTimeout(90_000);
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-cc80-'));
  let app: ElectronApplication | undefined;
  let downloads = 0;
  let sends = 0;
  const file = {
    id: 'attachment_cards',
    messageId: 'shared-file',
    filename: 'Launch tracker.csv',
    mimeType: 'text/csv',
    sizeBytes: 128,
    storageKey: 'fixture',
  };
  const history = [
    chatMessage({
      id: 'request',
      text: 'Preview an email about a custom hosting solution.',
      createdAt: '2026-10-12T12:00:00Z',
      crewaid: { author: 'USER' },
    }),
    ...actions('preview', [
      {
        name: 'preview_email',
        input: {
          to: 'Alex <alex@example.test>',
          subject: 'Custom hosting inquiry',
          body: 'Hi Alex,\n\nWe are planning a fleet of 1,000 computers. Could we discuss a custom plan?\n\nThanks,\nThe team',
        },
        output: 'Email preview shown in chat. Not saved or sent.',
      },
    ]),
    ...actions('workspace', [
      {
        name: 'use_plugin_tool',
        input: { tool: 'docs__GOOGLEDOCS_CREATE_DOCUMENT', arguments: { title: 'Session notes' } },
        output: {
          title: 'Session notes',
          documentUrl: 'https://docs.google.com/document/d/fixture/edit',
        },
      },
      {
        name: 'use_plugin_tool',
        input: {
          tool: 'sheets__GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
          arguments: { title: 'Launch tracker' },
        },
        output: {
          properties: { title: 'Launch tracker' },
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/fixture/edit',
        },
      },
      {
        name: 'use_plugin_tool',
        input: {
          tool: 'slides__GOOGLESLIDES_CREATE_PRESENTATION',
          arguments: { title: 'Jam session recap' },
        },
        output: { title: 'Jam session recap', slides: [{}, {}, {}] },
      },
    ]),
    ...actions('computer', [
      {
        name: 'browser_navigate',
        input: { url: 'https://example.test' },
        output: 'navigated to https://example.test',
      },
      {
        name: 'shell',
        input: { command: 'ls missing-file' },
        output: 'exit 1\nstderr:\nNo such file',
      },
    ]),
    ...actions('shared-file', [
      {
        name: 'attach_file',
        input: { path: '/home/bot/Launch tracker.csv' },
        output: 'attached Launch tracker.csv (128 bytes)',
      },
    ]),
    chatMessage({
      id: 'reply',
      text: 'The email is ready for you to review. The project files are ready too.',
      createdAt: '2026-10-12T12:00:04Z',
      crewaid: { author: 'BOT' },
    }),
  ];
  const attachmentHost = history.find((message) => message['id'] === 'shared-file')!;
  const metadata = attachmentHost['metadata'] as { crewaid: { attachments: unknown[] } };
  metadata.crewaid.attachments = [file];
  try {
    app = await launchDesktop(profile);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000),
    );
    const page = await app.firstWindow();
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: [bot] }));
    for (const endpoint of ['routines', 'bot-groups', 'goals', 'tasks', 'tools', 'projects'])
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/deliverables*', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }),
    );
    await page.route('**/api/v1/models', (route) =>
      route.fulfill({ json: { models: [], defaultModelId: null } }),
    );
    await routeSocket(page);
    await routeChat(page, { threads: { 'cards-thread': history } });
    await page.route('**/api/v1/bots/*/chat*', async (route) => {
      if (route.request().method() === 'POST') sends += 1;
      await route.fallback();
    });
    await page.route('**/api/v1/attachments/*/download', (route) => {
      downloads += 1;
      expect(route.request().headers()['authorization']).toBe('Bearer cards-test-token');
      return route.fulfill({
        contentType: 'text/csv',
        body: 'name,next step\nLaunch,Review draft',
      });
    });
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'cards-test-token',
      });
      // Useful outputs must be visible with routine bot work hidden, the app's default.
      localStorage.setItem('crewaid.transcript.showBotWork', 'false');
    }, auth.baseUrl);
    for (const theme of ['light', 'night']) {
      await page.evaluate(
        (value) => localStorage.setItem('crewaid.appearance.theme', value),
        theme,
      );
      await page.reload();
      const transcript = page.getByRole('region', { name: 'Transcript' });
      const email = transcript.locator('[data-tool-card="email"]');
      await expect(email).toBeVisible();
      await expect(email.getByRole('heading', { name: 'Custom hosting inquiry' })).toBeVisible();
      await expect(email.getByText('Alex <alex@example.test>', { exact: true })).toBeVisible();
      await expect(email.locator('[data-resource-receipt]')).toHaveText(
        'Preview only · Not saved or sent',
      );
      await expect(transcript.locator('[data-tool-card="document"]')).toHaveCount(1);
      await expect(transcript.locator('[data-tool-card="spreadsheet"]')).toHaveCount(1);
      await expect(transcript.locator('[data-tool-card="slides"]')).toHaveCount(1);
      // Routine work — a navigation, a failed command — is hidden by default.
      // It comes back one disclosure away when "Show thinking and actions"
      // is on, asserted after the theme loop below.
      await expect(transcript.locator('[data-tool-call="browser_navigate"]')).toHaveCount(0);
      await expect(transcript.locator('[data-tool-call="shell"]')).toHaveCount(0);
      const details = email.getByRole('button', { name: 'Details', exact: true });
      await details.focus();
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('aria-expanded', 'false');
      await email.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: test.info().outputPath(`email-preview-${theme}.png`) });
      const attachment = page.locator('[data-attachment-card="attachment_cards"]');
      await expect(attachment.getByText('Spreadsheet', { exact: false })).toBeVisible();
      await attachment.getByRole('button', { name: 'Preview Launch tracker.csv' }).click();
      const preview = page.getByRole('dialog', { name: 'Preview of Launch tracker.csv' });
      await expect(preview.getByText(/Launch,Review draft/)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(preview).toHaveCount(0);
    }
    // "Show thinking and actions" on: the routine steps return as one
    // collapsed log per turn, and a failure states itself in words there.
    await page.evaluate(() => localStorage.setItem('crewaid.transcript.showBotWork', 'true'));
    await page.reload();
    const shown = page.getByRole('region', { name: 'Transcript' });
    const log = shown.getByText('2 actions', { exact: true });
    await expect(log).toBeVisible();
    await log.click();
    await expect(shown.locator('[data-tool-card="email"]')).toHaveCount(1);
    const failed = shown.locator('[data-tool-call="shell"]');
    await expect(failed).toHaveAttribute('data-tool-status', 'error');
    await expect(failed.getByText('Failed', { exact: true })).toBeVisible();
    await failed.getByRole('button', { name: 'View computer' }).click();
    await expect(page.locator('[data-screen-surface="fullscreen"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-screen-surface="fullscreen"]')).toHaveCount(0);

    expect(downloads).toBe(2);
    expect(sends).toBe(0);
  } finally {
    await app?.close();
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
