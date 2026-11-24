import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './launchDesktop';
import { chatMessage, routeChat, routeSocket } from './stubChat';
import { startStubAuthServer } from './stubAuthServer';
import type { CrewaidBridge } from '../src/preload.js';

test('earlier history shows progress, retries a failed page and preserves the reading position', async () => {
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-history-'));
  let app: ElectronApplication | undefined;
  let releaseOlder = () => {};
  const olderReady = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  try {
    app = await launchDesktop(profile);
    const page = await app.firstWindow();
    const botId = 'bot_history';
    const threadId = 'thread_history';
    await page.route('**/api/v1/bots', (route) =>
      route.fulfill({
        json: [
          {
            id: botId,
            userId: 'usr_crewaid_singleton_v1',
            name: 'John',
            role: 'CMO',
            avatarColor: '#2FA59A',
            avatarShape: null,
            avatarUrl: null,
            systemPrompt: '',
            modelId: 'default',
            status: 'IDLE',
            sortOrder: 0,
            pinned: false,
            hiddenFromSidebar: false,
            autoReviewRules: [],
            sandboxId: null,
            sandbox: null,
            createdAt: '2026-10-01T12:00:00Z',
            updatedAt: '2026-10-01T12:00:00Z',
            thread: { id: threadId, preview: null },
          },
        ],
      }),
    );
    for (const endpoint of ['routines', 'bot-groups', 'goals', 'tasks']) {
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    }
    await routeSocket(page);
    await routeChat(page);
    const message = (index: number) =>
      chatMessage({
        id: `history-${index}`,
        createdAt: '2026-10-07T12:00:00Z',
        text: Array.from({ length: 8 }, (_, line) => `Message ${index}, line ${line + 1}.`).join(
          '\n',
        ),
        crewaid: { author: index % 2 === 0 ? 'USER' : 'BOT' },
      });
    let olderReads = 0;
    await page.route('**/api/v1/bots/*/chat*', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.searchParams.has('runId'))
        return route.fallback();
      if (url.searchParams.has('before')) {
        olderReads += 1;
        if (olderReads === 1) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
        await olderReady;
        return route.fulfill({
          json: {
            messages: Array.from({ length: 15 }, (_, index) => message(index)),
            activeRun: null,
            interrupts: null,
            page: { truncated: false },
          },
        });
      }
      return route.fulfill({
        json: {
          messages: Array.from({ length: 15 }, (_, index) => message(index + 15)),
          activeRun: null,
          interrupts: null,
          page: { truncated: true, cursor: 'history-before-15' },
        },
      });
    });
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'history-test-token',
      });
      localStorage.setItem('crewaid.appearance.theme', 'light');
    }, auth.baseUrl);
    await page.reload();
    const transcript = page.getByRole('region', { name: 'Transcript' });
    const scroller = page.locator('[data-transcript-scroll]');
    await expect(transcript.locator('[data-motion-message]')).toHaveCount(15);
    await expect(transcript).toHaveAttribute('aria-busy', 'false');
    expect(olderReads).toBe(0);
    await scroller.evaluate((el) => {
      el.scrollTop = el.clientHeight * 1.5;
    });
    await expect(
      transcript.getByText('Earlier messages could not load.', { exact: true }),
    ).toBeVisible();
    await expect(transcript.locator('[data-motion-message]')).toHaveCount(15);
    const anchor = transcript.locator('[data-motion-message="history-15"]');
    const before = (await anchor.boundingBox())!.y;
    await transcript.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(transcript.getByText('Loading earlier messages…', { exact: true })).toBeVisible();
    await expect(transcript).toHaveAttribute('aria-busy', 'true');
    expect(olderReads).toBe(2);
    await page.screenshot({ path: test.info().outputPath('earlier-history-loading.png') });
    await expect
      .poll(async () => Math.abs((await anchor.boundingBox())!.y - before))
      .toBeLessThan(2);
    // Keep scrolling during a slow request: the anchor must follow the reader.
    // Wait for the browser's async scroll event to flush so `useTranscriptScroll`
    // records the updated anchor before the stubbed older page resolves.
    await scroller.evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          el.addEventListener('scroll', () => resolve(), { once: true });
          el.scrollTop -= 90;
        }),
    );
    const readingId = await scroller.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      return [...el.querySelectorAll<HTMLElement>('[data-motion-message]')].find(
        (node) => node.getBoundingClientRect().bottom > top,
      )!.dataset.motionMessage!;
    });
    const reading = transcript.locator(`[data-motion-message="${readingId}"]`);
    const readingTop = (await reading.boundingBox())!.y;
    releaseOlder();
    await expect(transcript.locator('[data-motion-message]')).toHaveCount(30);
    await expect(transcript.locator('[data-history-loading]')).toBeHidden();
    await expect(transcript).toHaveAttribute('aria-busy', 'false');
    await expect
      .poll(async () => Math.abs((await reading.boundingBox())!.y - readingTop))
      .toBeLessThan(2);
    await expect(transcript.locator('[data-message-enter]')).toHaveCount(0);
    // Older history is available by continuing upward, and the end stops paging.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(transcript.getByText('Message 0, line 1.', { exact: false })).toBeVisible();
    expect(olderReads).toBe(2);
  } finally {
    releaseOlder();
    await app?.close().catch(() => undefined);
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
