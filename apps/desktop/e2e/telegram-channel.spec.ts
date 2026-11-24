import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CrewaidBridge } from '../src/preload.js';
import { launchDesktop } from './launchDesktop';
import { startStubAuthServer } from './stubAuthServer';

test('creates a Telegram bot from a QR code, confirms the sender and disconnects', async () => {
  const testInfo = test.info();
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-telegram-e2e-'));
  const auth = await startStubAuthServer(0);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profile);
    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { telegramOpenedUrls: string[] };
      state.telegramOpenedUrls = [];
      shell.openExternal = (url) => {
        state.telegramOpenedUrls.push(url);
        return Promise.resolve();
      };
    });
    const page = await app.firstWindow();
    const createUrl =
      'https://t.me/newbot/CrewaidBot/mobile_crew_ab12_bot?name=Mobile%E2%80%99s%20Crew';
    let state: 'idle' | 'claimed' | 'connected' = 'idle';
    const requests: string[] = [];
    const json = (body: unknown) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    await page.route('**/api/v1/channels/telegram**', async (route) => {
      const method = route.request().method();
      const { pathname } = new URL(route.request().url());
      if (method !== 'GET') requests.push(`${method} ${pathname}`);
      if (method === 'POST' && pathname.endsWith('/link'))
        await route.fulfill(
          json({
            code: 'K7M2Q9XF',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            createUrl,
          }),
        );
      else if (method === 'POST' && pathname.endsWith('/confirm')) {
        state = 'connected';
        await route.fulfill(json({ connected: true }));
      } else if (method === 'DELETE') {
        state = 'idle';
        await route.fulfill(json({ disconnected: true }));
      } else
        await route.fulfill(
          json({
            configured: true,
            canCreateBots: true,
            connection:
              state === 'connected'
                ? {
                    botUsername: 'mobile_crew_ab12_bot',
                    displayName: 'Mobile Operator',
                    selectedBotId: null,
                    connectedAt: new Date().toISOString(),
                  }
                : null,
            pending:
              state === 'claimed'
                ? {
                    botUsername: 'mobile_crew_ab12_bot',
                    telegramName: 'Mobile Operator',
                    expiresAt: new Date(Date.now() + 600000).toISOString(),
                  }
                : null,
          }),
        );
    });
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'telegram-e2e-session',
      });
    }, auth.baseUrl);
    await page.reload();
    await page.getByRole('button', { name: /account and settings/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Channels', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Connect Telegram' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Connect Telegram' }).click();
    await expect(
      dialog.getByRole('img', { name: 'QR code that creates your Telegram bot' }),
    ).toBeVisible();
    await expect(dialog.getByText('K7M2-Q9XF')).toBeVisible();
    expect(requests).toEqual(['POST /api/v1/channels/telegram/link']);
    await page.screenshot({ path: testInfo.outputPath('telegram-qr.png') });
    await dialog.getByRole('button', { name: 'Open on this computer' }).click();
    await expect
      .poll(() =>
        app!.evaluate(
          () =>
            (globalThis as typeof globalThis & { telegramOpenedUrls: string[] }).telegramOpenedUrls,
        ),
      )
      .toEqual([createUrl]);
    // The code arrived from Telegram: nothing is live until the person confirms it was them.
    state = 'claimed';
    await expect(
      dialog.getByText(
        /Telegram user Mobile Operator wants to connect through @mobile_crew_ab12_bot/,
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog.getByText('Connected to @mobile_crew_ab12_bot')).toBeVisible();
    await expect(dialog.getByText('Mobile Operator')).toBeVisible();
    expect(requests).toContain('POST /api/v1/channels/telegram/confirm');
    await page.screenshot({ path: testInfo.outputPath('telegram-connected.png') });
    await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Connect Telegram' })).toBeEnabled();
    await expect(dialog.getByText('Mobile Operator')).toHaveCount(0);
    expect(requests.at(-1)).toBe('DELETE /api/v1/channels/telegram');
  } finally {
    await app?.close();
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
