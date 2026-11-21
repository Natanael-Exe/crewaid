import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CrewaidBridge } from '../src/preload.js';
import { launchDesktop } from './launchDesktop';
import { routeChat, routeSocket } from './stubChat';
import { startStubAuthServer } from './stubAuthServer';

const botId = 'clxbot000000000000000001';

/**
 * D-222: a plan without call minutes still sees "Call <bot>" heading the rail.
 * Pressing it explains where calls come from instead of starting one.
 */
test('Call on a plan without minutes explains Pro and starts nothing', async () => {
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-call-offer-'));
  const app = await launchDesktop(profile);
  try {
    const page = await app.firstWindow();
    await page.route('**/api/v1/bots', (route) =>
      route.fulfill({
        json: [
          {
            id: botId,
            name: 'Nathan',
            userId: 'usr_crewaid_singleton_v1',
            role: 'CEO',
            avatarColor: '#4C67FA',
            avatarShape: null,
            avatarUrl: null,
            systemPrompt: '',
            modelId: 'default',
            voiceId: null,
            status: 'IDLE',
            sortOrder: 0,
            pinned: false,
            hiddenFromSidebar: false,
            autoReviewRules: [],
            sandboxId: null,
            sandbox: null,
            createdAt: '2026-10-14T12:00:00Z',
            updatedAt: '2026-10-14T12:00:00Z',
            thread: { id: `thread_${botId}`, preview: null },
          },
        ],
      }),
    );
    for (const endpoint of ['routines', 'bot-groups', 'goals', 'tasks'])
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    await routeSocket(page);
    await routeChat(page, { threads: { [`thread_${botId}`]: [] } });
    await page.route('**/api/v1/calls/allowance', (route) =>
      route.fulfill({
        json: {
          limitSeconds: 0,
          usedSeconds: 0,
          periodStart: '2026-10-01T00:00:00Z',
          periodEnd: '2026-11-01T00:00:00Z',
        },
      }),
    );
    const started: string[] = [];
    await page.route('**/api/v1/calls', (route) => {
      started.push(route.request().method());
      return route.fulfill({ status: 500, json: {} });
    });
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'call-offer-token',
      });
      localStorage.setItem('crewaid.appearance.theme', 'light');
    }, auth.baseUrl);
    await page.reload();

    const call = page.getByRole('button', { name: 'Call Nathan', exact: true });
    await expect(call).toBeVisible();
    await expect(call).toHaveAttribute('data-call-button', 'pro');
    await call.click();
    const offer = page.getByRole('dialog', { name: 'Calls are part of Pro' });
    await expect(offer).toBeVisible();
    await expect(offer).toContainText('Talk your work through with Nathan out loud.');
    await expect(offer.getByRole('button', { name: 'See plans' })).toBeVisible();
    // Settled, so the evidence shows the card rather than its fade-in.
    await expect(page.locator('.popover[data-entering]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('call-offer-pro.png') });
    await offer.getByRole('button', { name: 'Not now' }).click();
    await expect(offer).toBeHidden();
    expect(started).toEqual([]);
  } finally {
    await app.close();
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
