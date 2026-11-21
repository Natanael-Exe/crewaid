import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchDesktop } from './launchDesktop';
import { routeChat } from './stubChat';
import { startStubAuthServer, type StubAuthServer } from './stubAuthServer';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';

/**
 * D-192: the conversation comes from
 * `GET /bots/:id/chat`. The routine form is in the right rail, which needs a
 * selected bot — and a bot the renderer cannot open is a bot whose rail the
 * window never gets to.
 */
let stubAuth: StubAuthServer;
test.beforeAll(async () => {
  stubAuth = await startStubAuthServer(0);
});
test.afterAll(async () => {
  await stubAuth?.close();
});

test('routine form chooses a schedule, timezone and end date without cron input', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-routine-form-'));
  let app: ElectronApplication | undefined;
  try {
    // A new routine starts in the operator's own timezone (D-126). Pinned, so
    // the label this test clicks exists on a UTC runner as well as locally.
    app = await launchDesktop(profileDir, { TZ: 'America/Port-au-Prince' });
    const page = await app.firstWindow();
    const bot = {
      id: 'cbot00000000000000000000a',
      userId: 'usr_crewaid_singleton_v1',
      name: 'bot-01',
      role: 'Researcher',
      avatarColor: '#4c6ef5',
      avatarShape: null,
      avatarUrl: null,
      systemPrompt: 'You research things.',
      modelId: 'default',
      status: 'IDLE',
      sortOrder: 0,
      pinned: false,
      hiddenFromSidebar: false,
      autoReviewRules: [],
      createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      sandboxId: null,
      sandbox: null,
      thread: { id: 'cuid-thread-1', preview: null },
    };
    await page.route('**/api/v1/bots', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([bot]) }),
    );
    await routeChat(page);
    await page.route('**/api/v1/routines', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
        : route.fulfill({ status: 400, contentType: 'application/json', body: '{}' }),
    );
    const saved = await page.evaluate<TokenStoreWriteResult, string>(
      (baseUrl) =>
        (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
          orchestratorBaseUrl: baseUrl,
          orchestratorToken: 'routine-form-token',
        }),
      stubAuth.baseUrl,
    );
    expect(saved.status).toBe('saved');
    await page.reload();

    // The centre pane is a transcript, not `ThreadNotice`: everything below is
    // about the rail beside it.
    await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Routine' })).toBeVisible();
    await page.getByRole('button', { name: 'Create Routine' }).click();
    const form = page.getByRole('form', { name: 'New routine' });
    await expect(form.getByText('Schedule (cron)')).toHaveCount(0);

    // A new routine starts on "Add schedule"; the menu offers the repeats.
    await form.getByRole('button', { name: 'Add schedule' }).click();
    const menu = page.getByRole('menu');
    for (const label of ['Every hour', 'Every day', 'Every weekday', 'Every week', 'Every month']) {
      await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible();
    }
    await menu.getByRole('menuitem', { name: 'Every week', exact: true }).click();
    await form.getByRole('button', { name: 'Tuesday' }).click();
    await expect(form.getByRole('button', { name: 'Tuesday' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await form.getByText('America/Port-au-Prince', { exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search timezones' }).fill('Paris');
    await page.getByRole('option', { name: /Europe\/Paris/ }).click();

    // Custom Repeat: the stepper only stops on even intervals, and a custom
    // schedule can be opened again to edit it.
    await form.getByRole('button', { name: 'Change schedule' }).click();
    await page.getByRole('menuitem', { name: 'Custom…' }).click();
    const custom = page.getByRole('dialog', { name: 'Custom repeat' });
    await expect(custom.getByText('Repetition frequency')).toBeVisible();
    await expect(custom.getByRole('button', { name: 'Confirm' })).toHaveCSS(
      'color',
      'rgb(255, 255, 255)',
    );
    expect(
      await custom
        .locator('.radio[data-selected] .radio__indicator')
        .first()
        .evaluate((node) => getComputedStyle(node, '::before').backgroundColor),
    ).toBe('rgb(255, 255, 255)');
    if (process.env['CC79_CAPTURE'] === '1') {
      await page.evaluate(async () => {
        const finite = document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
        await Promise.allSettled(finite.map((animation) => animation.finished));
      });
      await page.screenshot({
        path: path.resolve('../../.artifacts/cc79/routine-controls-light.png'),
      });
    }
    await custom.getByRole('button', { name: 'Repeat unit' }).click();
    await page.getByRole('option', { name: 'hours' }).click();
    const increase = custom.getByRole('button', { name: 'Increase Repeat every' });
    await increase.click();
    await increase.click();
    await increase.click();
    await expect(custom.getByRole('textbox', { name: 'Repeat every' })).toHaveValue('4');
    await increase.click();
    await expect(custom.getByRole('textbox', { name: 'Repeat every' })).toHaveValue('6');
    await custom.getByRole('button', { name: 'Confirm' }).click();
    await expect(form.getByText('Every 6 hours')).toBeVisible();
    await form.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(custom.getByRole('textbox', { name: 'Repeat every' })).toHaveValue('6');
    await custom.getByRole('button', { name: 'Cancel' }).click();
    await expect(form.getByText('Every 6 hours')).toBeVisible();

    await form.getByRole('button', { name: 'Change schedule' }).click();
    await page.getByRole('menuitem', { name: 'Every week', exact: true }).click();
    await form.getByRole('button', { name: 'Tuesday' }).click();

    await form.getByText('Never ends', { exact: true }).click();
    await expect(form.getByRole('switch', { name: 'End on a date' })).toBeChecked();
    const end = form.getByRole('group', { name: 'End date' });
    await end.getByRole('spinbutton').first().click();
    await page.keyboard.type('09222099');

    await form.getByLabel('Name').fill('Morning digest');
    await form.getByLabel('What should the bot do?').fill('Summarise the inbox.');
    const sent = page.waitForRequest(
      (request) => request.url().endsWith('/api/v1/routines') && request.method() === 'POST',
    );
    await form.getByRole('button', { name: 'Create' }).click();
    expect((await sent).postDataJSON()).toMatchObject({
      botId: bot.id,
      name: 'Morning digest',
      cron: '0 9 * * 1,2',
      timezone: 'Europe/Paris',
      endsOn: '2099-09-22',
      prompt: 'Summarise the inbox.',
    });
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});
