import { expect, test, type Locator } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { templateCatalog } from '../../orchestrator/src/experience/template-catalog.js';
import { launchDesktop } from './launchDesktop';
import { routeChat } from './stubChat';
import { startStubAuthServer, STUB_USER } from './stubAuthServer';
import type { CrewaidBridge } from '../src/preload';

/**
 * D-229 end to end: a new account meets Crewaid's welcome, browses
 * Templates with its search kept across pages, adds a crew through one failed
 * and one retried request (one key, so one crew), and sends exactly the first
 * task it shows. Nothing is sent before that button.
 */
test('main assistant, Templates discovery, setup retry and an explicit first task', async () => {
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-cc81-'));
  const app = await launchDesktop(profile);
  try {
    const page = await app.firstWindow();
    const now = new Date().toISOString();
    const main = {
      id: 'cc81-main',
      userId: STUB_USER.id,
      kind: 'MAIN',
      name: 'Crewaid',
      role: 'Main assistant',
      avatarColor: '#4c6ef5',
      avatarShape: 'egg',
      avatarUrl: null,
      systemPrompt: '',
      modelId: 'default',
      status: 'IDLE',
      sortOrder: 0,
      pinned: true,
      hiddenFromSidebar: false,
      autoReviewRules: [],
      sandboxId: null,
      sandbox: null,
      thread: { id: 'cc81-main-thread', preview: null },
      createdAt: now,
      updatedAt: now,
    };
    const roster: Record<string, unknown>[] = [main];
    let state = {
      userId: STUB_USER.id,
      welcomeSeen: false,
      discovery: 'NEW',
      createdAt: now,
      updatedAt: now,
    };
    const sent: string[] = [];
    const setupKeys: string[] = [];
    await page.route('**/api/v1/onboarding/bootstrap', (route) =>
      route.fulfill({ json: { bot: main, onboarding: state, isNewAccount: true } }),
    );
    await page.route('**/api/v1/onboarding', async (route) => {
      state = { ...state, ...(route.request().postDataJSON() as object) };
      await route.fulfill({ json: state });
    });
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: roster }));
    await page.route('**/api/v1/groups', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/templates', (route) =>
      route.fulfill({ json: templateCatalog('en') }),
    );
    await page.route('**/api/v1/mcp/directory', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/mcp/servers', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/template-installations', async (route) => {
      const body = route.request().postDataJSON() as { idempotencyKey: string };
      setupKeys.push(body.idempotencyKey);
      if (setupKeys.length === 1)
        return route.fulfill({ status: 503, json: { message: 'Temporary failure' } });
      roster.push({
        ...main,
        kind: 'STANDARD',
        name: 'Hannah',
        role: 'Demand Gen & Social Writer',
        id: 'cc81-writer',
        pinned: false,
        groupId: 'cc81-group',
        thread: { id: 'cc81-writer-thread', preview: null },
      });
      return route.fulfill({
        json: {
          id: 'cc81-install',
          templateId: 'content-publishing',
          revision: '2',
          groupId: 'cc81-group',
          botIds: ['cc81-writer'],
          createdAt: now,
        },
      });
    });
    await routeChat(page, { reply: ['On it.'] });
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/bots\/[^/]+\/chat/.test(request.url()))
        sent.push(request.postData() ?? '');
    });
    const saved = await page.evaluate(
      async (baseUrl) =>
        (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
          orchestratorBaseUrl: baseUrl,
          orchestratorToken: 'cc81-test',
        }),
      auth.baseUrl,
    );
    expect(saved.status).toBe('saved');
    await page.reload();

    // A new account lands on Crewaid's thread, which opens on its welcome.
    await expect(page.getByRole('button', { name: 'Open Crewaid', exact: true })).toBeVisible();
    await expect(page.locator('[data-welcome-opening]')).toContainText('Welcome');

    // The door sits outside the sidebar.
    const trigger = page.getByRole('button', { name: 'Templates', exact: true });
    await expect(trigger).toBeVisible();
    expect(
      await trigger.evaluate((element) => element.closest('[data-pane="sidebar"]')),
    ).toBeNull();

    // Templates and Plugins share the same modal material in both appearances.
    const materials = async (modal: Locator) => {
      const read = () =>
        modal.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            border: style.borderColor,
            radius: style.borderRadius,
            blur: style.backdropFilter,
          };
        });
      const result = [];
      for (const theme of ['crewaid', 'crewaid-dark']) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
          document.documentElement.setAttribute('data-reduce-motion', 'true');
        }, theme);
        result.push(await read());
      }
      return result;
    };
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    const plugins = page.getByRole('dialog', { name: 'Plugins', exact: true });
    await expect(plugins).toBeVisible();
    const pluginMaterials = await materials(plugins);
    await plugins.getByRole('button', { name: 'Close plugins' }).click();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Templates', exact: true });
    await expect(dialog).toBeVisible();
    expect(await materials(dialog)).toEqual(pluginMaterials);
    await page.screenshot({ path: test.info().outputPath('templates-modal.png') });

    // Search, a crew, one of its members, and back again with the search kept.
    await dialog.getByRole('textbox', { name: 'Search templates' }).fill('content');
    await dialog.getByRole('button', { name: /^Content & Publishing/ }).click();
    await expect(dialog.getByText('Illustrative example')).toBeVisible();
    await dialog.getByRole('button', { name: /^Hannah/ }).click();
    await expect(dialog.getByText('Not available on this server').first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Content & Publishing', exact: true }).click();
    await dialog.getByRole('button', { name: 'All templates', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Search templates' })).toHaveValue('content');

    // A single bot continues in the ordinary create form, prefilled.
    await dialog.getByRole('tab', { name: 'Bots', exact: true }).click();
    await dialog.getByRole('button', { name: /^Hannah/ }).click();
    await dialog.getByRole('button', { name: 'Add bot', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New Bot' });
    await expect(create.getByLabel('Name', { exact: true })).toHaveValue('Hannah');
    await page.keyboard.press('Escape');
    await expect(create).toHaveCount(0);

    // Setup: a failure keeps the draft, and the retry reuses its key.
    await trigger.click();
    await dialog.getByRole('button', { name: /^Content & Publishing/ }).click();
    await dialog.getByRole('button', { name: 'Add crew', exact: true }).click();
    const goal = dialog.getByLabel('What should this crew help you achieve?');
    await goal.fill('Publish three useful posts for indie founders.');
    await dialog.getByRole('button', { name: 'Add crew', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('We couldn’t add this crew.');
    await expect(goal).toHaveValue('Publish three useful posts for indie founders.');
    await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(dialog.getByText('Your Content & Publishing crew is ready.')).toBeVisible();
    expect(setupKeys).toHaveLength(2);
    expect(setupKeys[0]).toBe(setupKeys[1]);
    expect(sent).toHaveLength(0);

    // The first task goes to Crewaid exactly as written.
    const task = 'Ask the Content crew to draft three posts about onboarding for my SaaS.';
    await dialog.getByLabel('Give them a first task').fill(task);
    await dialog.getByRole('button', { name: 'Start first task', exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toContain(task);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-welcome-opening]')).toHaveCount(0);

    // The door is the crew's: the Work views leave it out.
    await page
      .getByRole('navigation', { name: 'Work' })
      .getByRole('tab', { name: 'Tasks', exact: true })
      .click();
    await expect(trigger).toHaveCount(0);
    await page.getByRole('tab', { name: 'Crew', exact: true }).click();
    await expect(trigger).toBeVisible();

    // A small window keeps the door, and Escape closes the library.
    await page.setViewportSize({ width: 1000, height: 720 });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
