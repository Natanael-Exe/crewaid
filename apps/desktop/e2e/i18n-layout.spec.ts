import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CrewaidBridge } from '../src/preload.js';
import ar from '../src/renderer/i18n/locales/ar.json' with { type: 'json' };
import { launchDesktop } from './launchDesktop';
import { chatMessage, routeChat, routeSocket } from './stubChat';
import { startStubAuthServer } from './stubAuthServer';

const stamp = '2026-10-01T12:00:00Z';
const bot = {
  id: 'ci18n000000000000000000001',
  userId: 'usr_crewaid_singleton_v1',
  kind: 'STANDARD',
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
  createdAt: stamp,
  updatedAt: stamp,
  sandboxId: null,
  sandbox: null,
  thread: { id: 'i18n-thread', preview: null },
};

test('Arabic mirrors menus while drafts, inline code and terminal output keep their own direction', async () => {
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-i18n-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profile);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
    const page = await app.firstWindow();
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: [bot] }));
    for (const endpoint of ['routines', 'bot-groups', 'goals', 'tasks']) {
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    }
    await page.route('**/api/v1/settings', (route) =>
      route.fulfill({
        json: {
          settings: {
            userId: 'cuser0000000000000000000001',
            defaultModelId: null,
            language: 'ar',
            timezone: null,
            systemLanguage: 'en',
            systemTimezone: 'UTC',
            updatedAt: stamp,
          },
        },
      }),
    );
    await page.route('**/api/v1/models', (route) =>
      route.fulfill({ json: { models: [], defaultModelId: null } }),
    );
    await page.route('**/api/v1/deliverables*', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }),
    );
    await routeSocket(page);
    await routeChat(page, {
      threads: {
        'i18n-thread': [
          { id: 'thought', role: 'reasoning', content: 'نفحص الأمر قبل تشغيله.' },
          {
            id: 'shell-call',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'shell-1',
                type: 'function',
                function: { name: 'shell', arguments: '{"command":"git status"}' },
              },
            ],
          },
          {
            id: 'shell-result',
            role: 'tool',
            toolCallId: 'shell-1',
            content: 'exit 0\nOn branch main\nملف: example.txt',
          },
          chatMessage({
            id: 'answer',
            text: 'نفّذ `git status --short` للفحص.\n\n```sh\ngit status --short\n```',
            createdAt: stamp,
            crewaid: { author: 'BOT' },
          }),
        ],
      },
    });
    await page.evaluate(async (baseUrl) => {
      localStorage.setItem('crewaid.appearance.language', 'ar');
      localStorage.setItem('crewaid.transcript.showBotWork', 'true');
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'i18n-token',
      });
    }, auth.baseUrl);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const row = page.getByRole('option', { name: /Quill/ });
    await row.click();
    const transcript = page.getByRole('region', { name: ar['transcript.label'] });
    await expect(transcript.locator('[data-markdown-renderer] code').first()).toBeVisible();
    await expect(transcript.locator('[data-markdown-renderer] code').first()).toHaveCSS(
      'direction',
      'ltr',
    );
    const draft = transcript.locator('textarea[data-composer-slot="text"]');
    await draft.fill('English first, even in an Arabic app.');
    await expect(draft).toHaveCSS('direction', 'ltr');
    await draft.fill('رسالة بالعربية');
    await expect(draft).toHaveCSS('direction', 'rtl');

    // Disclosures open with a downward chevron, which reads the same in
    // either direction, so what matters in Arabic is that each one opens.
    const reasoning = transcript
      .locator('[data-reasoning]')
      .locator('[data-slot="chain-of-thought-trigger"]');
    await reasoning.click();
    await expect(reasoning).toHaveAttribute('aria-expanded', 'true');
    // A single routine action renders as its own line, with no group around it.
    const terminal = transcript.locator('[data-tool-call="shell"]');
    await terminal.locator('[data-slot="disclosure-trigger"]').click();
    await expect(terminal.locator('pre').first()).toHaveCSS('direction', 'ltr');
    await expect(terminal.locator('pre').nth(1)).toHaveCSS('unicode-bidi', 'isolate');

    await row.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: ar['bots.actionsFor'].replace('{name}', 'Quill') });
    await menu.getByRole('menuitem', { name: ar['bots.menu.move'], exact: true }).hover();
    // A submenu is named by the item that opens it.
    const flyout = page.getByRole('menu', { name: ar['bots.menu.move'], exact: true });
    await expect(flyout).toBeVisible();
    const bounds = await menu.boundingBox();
    const flyoutBounds = await flyout.boundingBox();
    expect(bounds).not.toBeNull();
    expect(flyoutBounds).not.toBeNull();
    expect(flyoutBounds!.x).toBeLessThan(bounds!.x);
  } finally {
    await app?.close();
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
