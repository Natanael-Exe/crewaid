import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './launchDesktop';
import { chatMessage, routeChat, routeSocket } from './stubChat';
import { startStubAuthServer } from './stubAuthServer';
import type { CrewaidBridge } from '../src/preload.js';

test('switching paints a cached preview while refreshing and an empty server response clears it', async () => {
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-switching-'));
  let app: ElectronApplication | undefined;
  let release = () => {};
  const refreshReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    app = await launchDesktop(profile);
    const page = await app.firstWindow();
    const bots = ['John', 'Mary'].map((name, index) => ({
      id: `bot_${name}`,
      userId: 'usr_crewaid_singleton_v1',
      name,
      role: 'Writer',
      avatarColor: '#2FA59A',
      avatarShape: null,
      avatarUrl: null,
      systemPrompt: '',
      modelId: 'default',
      status: 'IDLE',
      sortOrder: index,
      pinned: false,
      hiddenFromSidebar: false,
      autoReviewRules: [],
      sandboxId: null,
      sandbox: null,
      createdAt: '2026-10-01T12:00:00Z',
      updatedAt: '2026-10-01T12:00:00Z',
      thread: { id: `thread_${name}`, preview: null },
    }));
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: bots }));
    for (const endpoint of ['routines', 'bot-groups', 'goals', 'tasks'])
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    await routeSocket(page);
    await routeChat(page);
    let johnReads = 0;
    const badRequests: string[] = [];
    await page.route('**/api/v1/bots/*/chat*', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.searchParams.has('runId'))
        return route.fallback();
      const name = url.pathname.includes('bot_John') ? 'John' : 'Mary';
      if (url.searchParams.get('threadId') !== `thread_${name}`) badRequests.push(url.href);
      expect(url.searchParams.get('limit')).toBe('150');
      const empty = name === 'John' && ++johnReads > 1;
      if (empty) await refreshReady;
      return route.fulfill({
        json: {
          messages: empty
            ? []
            : [
                chatMessage({
                  id: `message_${name}`,
                  text: `${name}'s conversation`,
                  createdAt: '2026-10-07T12:00:00Z',
                  crewaid: { author: 'BOT' },
                }),
              ],
          activeRun: null,
          interrupts: null,
          page: { truncated: false },
        },
      });
    });
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'switching-test-token',
      });
    }, auth.baseUrl);
    await page.reload();
    const transcript = page.getByRole('region', { name: 'Transcript' });
    await expect(transcript.getByText("John's conversation", { exact: true })).toBeVisible();
    await page.getByRole('option', { name: /Mary/ }).click();
    await expect(transcript.getByRole('heading', { name: 'Mary', exact: true })).toBeVisible();
    await expect(transcript.getByText("Mary's conversation", { exact: true })).toBeVisible();
    await expect(transcript.getByText("John's conversation", { exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: /John/ }).click();
    await expect.poll(() => johnReads).toBe(2);
    await expect(transcript.getByText("John's conversation", { exact: true })).toBeVisible();
    await expect(transcript.getByText('Loading conversation…', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('cached-preview-during-refresh.png') });
    release();
    await expect(transcript.getByText("John's conversation", { exact: true })).toHaveCount(0);
    await expect(transcript.getByText('What should John work on?', { exact: true })).toBeVisible();
    expect(badRequests).toEqual([]);
  } finally {
    release();
    await app?.close().catch(() => undefined);
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
