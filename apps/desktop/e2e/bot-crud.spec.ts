import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './launchDesktop';
import { routeChat } from './stubChat';
import { startStubAuthServer, type StubAuthServer } from './stubAuthServer';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';

/**
 * CC-15's surfaces, driven in a real window.
 *
 * Two of the three cannot be asserted anywhere else. The row menu is a
 * pointer-anchored context menu opened from a virtualized ListBoxItem, and the
 * create dialog is a portal — `renderToStaticMarkup` renders neither, so the
 * unit suite can only check the pieces they are built from.
 *
 * D-192: the conversation is served
 * from `GET /bots/:id/chat`, not `GET /bots/:id/messages`. None of these tests
 * is about the transcript, but all of them need one on screen — a bot row the
 * renderer cannot open paints a notice in the centre pane instead, and the row
 * menu, the rail and the dialogs would then be asserted against a window in a
 * state no operator sees.
 */
function bot(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const suffix = String(index).padStart(2, '0');
  return {
    id: `bot_crud_${suffix}`,
    userId: 'usr_crewaid_singleton_v1',
    name: `bot-${suffix}`,
    role: 'Researcher',
    avatarColor: '#4c6ef5',
    avatarShape: null,
    avatarUrl: null,
    systemPrompt: 'You research things.',
    modelId: 'default',
    status: 'IDLE',
    sortOrder: index,
    pinned: false,
    hiddenFromSidebar: false,
    autoReviewRules: [],
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    // D-046: detached, matching the null computer below. Required by BotSchema.
    sandboxId: null,
    sandbox: null,
    thread: { id: `cuid-thread-${suffix}`, preview: null },
    ...overrides,
  };
}

async function setUp(
  page: Page,
  bots: readonly Record<string, unknown>[] = [bot(1), bot(2)],
): Promise<void> {
  await page.route('**/api/v1/bots', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(bots),
    }),
  );
  await routeChat(page);

  const saved = await page.evaluate<TokenStoreWriteResult, string>(
    (baseUrl) =>
      (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'bot-crud-token',
      }),
    stubAuth.baseUrl,
  );
  expect(saved.status).toBe('saved');
  await page.reload();
  await expectTranscriptOpen(page);
}

/**
 * The fence for every stub in this file: a bot whose thread the renderer
 * cannot open paints `ThreadNotice` in the centre pane, and a window in that
 * state still has a sidebar, a rail and working dialogs — so a spec about them
 * would go on passing while asserting against a window no operator sees.
 */
async function expectTranscriptOpen(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
}

/**
 * The sign-in gate (V1-18) resolves the account before the shell mounts, and it
 * asks the orchestrator who the stored token belongs to. That request is made by
 * the MAIN process, so `page.route` never sees it — without something listening
 * here the gate correctly reports an unreachable orchestrator and no shell ever
 * renders. Every renderer-level mock below is unchanged.
 */
let stubAuth: StubAuthServer;

test.beforeAll(async () => {
  stubAuth = await startStubAuthServer(0);
});

test.afterAll(async () => {
  await stubAuth?.close();
});

test('the rail gear opens the BOT profile, not the app settings', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc15-gear-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    await setUp(page);

    await expect(page.getByRole('option', { name: /bot-01/ })).toBeVisible();
    await page.getByRole('button', { name: 'Bot settings' }).click();

    // The regression this guards: the gear used to open the orchestrator
    // connection form, which is the application's settings, not the bot's.
    const pane = page.getByRole('complementary', { name: 'Bot profile' });
    await expect(pane).toBeVisible();
    await expect(pane.getByLabel('Name')).toHaveValue('bot-01');
    await expect(pane.getByLabel('Label')).toHaveValue('Researcher');
    await expect(pane.getByLabel('Description')).toHaveValue('You research things.');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);

    // Save stays inert until something actually changes.
    await expect(pane.getByRole('button', { name: 'Save' })).toBeDisabled();
    await pane.getByLabel('Name').fill('renamed');
    await expect(pane.getByRole('button', { name: 'Save' })).toBeEnabled();

    await pane.getByRole('button', { name: 'Back to details' }).click();
    await expect(page.getByRole('complementary', { name: 'Details' })).toBeVisible();
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('a row menu opens from inside the virtualized list and offers the five backed actions', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc15-menu-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    await setUp(page);

    const row = page.getByRole('option', { name: /bot-02/ });
    await expect(row).toBeVisible();
    await page.getByRole('button', { name: 'Filter bots', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: 'Search bots' })).toBeVisible();
    const geometry = await page.evaluate(() => {
      // The field's visible box is its group; the input starts after the icon.
      const search = document
        .querySelector<HTMLInputElement>('input[aria-label="Search bots"]')
        ?.closest<HTMLElement>('[data-slot="search-field-group"]');
      const row = document.querySelector<HTMLElement>('[role="listbox"] [role="option"]');
      if (search === null || search === undefined || row === null) return null;
      const searchRect = search.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        search: { left: searchRect.left, right: searchRect.right },
        row: { left: rowRect.left, right: rowRect.right },
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry?.row.left).toBeGreaterThanOrEqual((geometry?.search.left ?? 0) - 1);
    expect(geometry?.row.right).toBeLessThanOrEqual((geometry?.search.right ?? 0) + 1);
    await row.click({ button: 'right' });

    const menu = page.getByRole('menu', { name: 'Actions for bot-02' });
    await expect(menu).toBeVisible();
    for (const label of ['Pin', 'Edit Profile', 'Duplicate', 'Hide from sidebar', 'Delete']) {
      await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible();
    }

    // Delete asks first — a bot takes its whole transcript with it.
    await menu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Delete bot-02' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete bot-02' })).toHaveCount(0);

    // bot-01 is selected. Editing bot-02 must select it and keep the profile
    // open; a selectedId effect used to immediately reset the rail to details.
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit Profile', exact: true }).click();
    const profile = page.getByRole('complementary', { name: 'Bot profile' });
    await expect(profile).toBeVisible();
    await expect(profile.getByLabel('Name')).toHaveValue('bot-02');
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('a failed row action is reported instead of disappearing with the menu', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc15-action-failure-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    await page.route('**/api/v1/bots/bot_crud_02', (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: '{}' }),
    );
    await setUp(page);

    const row = page.getByRole('option', { name: /bot-02/ });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();

    await expect(page.getByRole('alert')).toContainText(
      'That changed in the meantime. Open it again and retry.',
    );
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('a pinned bot keeps its menu and can be unpinned', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc15-unpin-'));
  let app: ElectronApplication | undefined;
  let patchBody: unknown;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    await page.route('**/api/v1/bots/bot_crud_01', async (route) => {
      patchBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(bot(1, { pinned: false })),
      });
    });
    await setUp(page, [bot(1, { pinned: true }), bot(2, { pinned: true })]);

    const pinnedCard = page.getByRole('button', { name: 'Open bot-01' });
    await expect(page.getByRole('region', { name: 'Pinned bots' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open bot-02' })).toBeVisible();
    await pinnedCard.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();

    await expect.poll(() => patchBody).toEqual({ pinned: false });
    await expect(page.getByRole('option', { name: /bot-01/ })).toBeVisible();
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('"+" opens a create dialog that refuses an empty draft', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc15-create-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    await setUp(page);

    // Tooltip.Trigger also reports role=button, so address the control by label.
    await page.getByLabel('New bot').click();
    const dialog = page.getByRole('dialog', { name: 'New Bot' });
    await expect(dialog).toBeVisible();

    // Nothing is said about the empty fields until the operator submits.
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Name is required.');

    await dialog.getByLabel('Name').fill('Quill');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Label is required.');
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('deleting a row above others does not blank the window', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc15-delete-'));
  let app: ElectronApplication | undefined;
  const crashes: string[] = [];

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => crashes.push(error.message));

    /**
     * The regression: a React Aria dynamic collection keys on the item
     * object's `id`. Without one it keys by position, so removing a row that
     * has rows after it hands a live item node a different id and the
     * collection throws "Cannot change the id of an item" mid-render — which
     * unmounts the whole tree, not just the list.
     *
     * Deleting the LAST row shifts nothing and cannot reproduce it, so this
     * deletes from the middle of a list long enough to be virtualized.
     */
    let all = Array.from({ length: 40 }, (_, i) => bot(i + 1));
    await page.route('**/api/v1/bots', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(all),
      }),
    );
    await routeChat(page);
    await page.route('**/api/v1/bots/bot_crud_03', (route) => {
      all = all.filter((row) => row['id'] !== 'bot_crud_03');
      return route.fulfill({ status: 204, body: '' });
    });

    const saved = await page.evaluate<TokenStoreWriteResult, string>(
      (baseUrl) =>
        (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
          orchestratorBaseUrl: baseUrl,
          orchestratorToken: 'bot-crud-token',
        }),
      stubAuth.baseUrl,
    );
    expect(saved.status).toBe('saved');
    await page.reload();
    await expectTranscriptOpen(page);

    await page.getByRole('option', { name: /bot-03/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();

    await expect(page.getByRole('option', { name: /bot-03/ })).toHaveCount(0);
    // The rest of the list, and the shell around it, survive.
    await expect(page.getByRole('option', { name: /bot-04/ })).toBeVisible();
    await expect(page.getByRole('listbox', { name: 'Bots' })).toBeVisible();
    expect(crashes).toEqual([]);
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('File New Bot opens the creation dialog, including after closing the last macOS window', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-menu-new-bot-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profileDir);
    let page = await app.firstWindow();
    await setUp(page);
    await expect(page.getByRole('button', { name: /account menu/i })).toBeVisible();
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById('crewaid.new-bot')!;
      (item.click as () => void)();
    });
    await expect(page.getByRole('dialog', { name: /new bot/i })).toBeVisible();
    if (process.platform === 'darwin') {
      await page.close();
      const nextWindow = app.waitForEvent('window');
      await app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()!.getMenuItemById('crewaid.new-bot')!;
        (item.click as () => void)();
      });
      page = await nextWindow;
      await expect(page.getByRole('dialog', { name: /new bot/i })).toBeVisible();
    }
  } finally {
    await app?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});
