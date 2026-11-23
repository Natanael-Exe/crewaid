import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { launchDesktop } from './launchDesktop';
import { tokenColor } from './themeTokens';
import { chatMessage, routeChat, routeScreenStream, routeSocket } from './stubChat';
import { startStubAuthServer, type StubAuthServer } from './stubAuthServer';
import type { CrewaidBridge } from '../src/preload.js';
import { contrastRatio } from '../src/renderer/styles/botAccent';

let auth: StubAuthServer;
test.beforeAll(async () => {
  auth = await startStubAuthServer(0);
});
test.afterAll(async () => {
  await auth.close();
});
const palette = [
  ['Quill', '#7B5CE0'],
  ['Scout', '#2FA59A'],
  ['Ava', '#3563E9'],
  ['Beacon', '#F2B233'],
  ['Exe', '#4c6ef5'],
  ['Twin', '#7B5CE0'],
] as const;
const bots = palette.map(([name, color], index) => ({
  id: `bot_room_${index}`,
  userId: 'usr_crewaid_singleton_v1',
  name,
  role: index === 0 ? 'Writer' : 'Researcher',
  avatarColor: color,
  avatarShape: null,
  avatarUrl: null,
  systemPrompt: '',
  modelId: 'default',
  status: 'IDLE',
  sortOrder: index,
  pinned: false,
  hiddenFromSidebar: false,
  autoReviewRules: [],
  createdAt: '2026-10-01T12:00:00Z',
  updatedAt: '2026-10-01T12:00:00Z',
  sandboxId: null,
  sandbox: null,
  thread: { id: `room-thread-${index}`, preview: null },
}));

test('Paper room follows bot colors, persists Night and preserves keyboard/chat/editor interactions', async () => {
  const testInfo = test.info();
  test.setTimeout(120_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-cc79-'));
  const capture = process.env['CC79_CAPTURE'] === '1';
  const evidence = path.resolve('../../.artifacts/cc79');
  const frames: { data: Buffer; timestamp: number }[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profile);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
    const page = await app.firstWindow();
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: bots }));
    for (const endpoint of ['routines', 'bot-groups', 'goals', 'tasks', 'deliverables']) {
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    }
    await page.route('**/api/v1/models', (route) =>
      route.fulfill({
        json: {
          models: [
            {
              id: 'cmodel000000000000000000001',
              connectionId: 'cconnection000000000000001',
              connectionName: 'Test',
              kind: 'anthropic',
              upstreamModelId: 'claude-sonnet-4',
              label: 'Claude Sonnet 4',
              contextWindow: 200000,
              capabilities: { tools: true, vision: true, reasoning: true },
              available: true,
              connectionState: 'ACTIVE',
            },
          ],
          defaultModelId: 'cmodel000000000000000000001',
        },
      }),
    );
    await page.route('**/api/v1/deliverables*', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }),
    );
    await routeSocket(page);
    const threads = Object.fromEntries(
      bots.map((bot, index) => [
        bot.thread.id,
        [
          chatMessage({
            id: `user-${index}`,
            text: `Draft a clear update for the team.${index === 0 ? ' @Twin' : ''}`,
            createdAt: '2026-10-07T12:00:00Z',
            crewaid: { author: 'USER' },
          }),
          chatMessage({
            id: `reply-${index}`,
            text: 'I can help shape the update. What would you like the team to know?',
            createdAt: '2026-10-07T12:00:01Z',
            crewaid: { author: 'BOT' },
          }),
          ...(index === 0
            ? Array.from({ length: 2 }, (_, round) => [
                ...Array.from({ length: 25 }, (_, step) => [
                  {
                    id: `thinking-${round}-${step}`,
                    role: 'reasoning',
                    content: 'Checking the task.',
                  },
                  chatMessage({
                    id: `work-${round}-${step}`,
                    text: '',
                    createdAt: '2026-10-07T12:00:00Z',
                    crewaid: { author: 'BOT' },
                  }),
                ]).flat(),
                chatMessage({
                  id: `continuation-${round}`,
                  text: `Paused after 25 steps of work. Still working — carrying on for ${round === 0 ? 'up to 2 more rounds' : 'one more round'}.`,
                  createdAt: '2026-10-07T12:00:00Z',
                  crewaid: { author: 'SYSTEM' },
                }),
              ]).flat()
            : []),
        ],
      ]),
    );
    await page.route('**/api/v1/providers/connections', (route) =>
      route.fulfill({
        json: {
          connections: [
            {
              id: 'cconnection000000000000001',
              userId: 'usr_crewaid_singleton_v1',
              kind: 'anthropic',
              name: 'Work Anthropic',
              endpoint: null,
              authKind: 'api_key',
              state: 'ACTIVE',
              hasCredential: true,
              credentialSetAt: '2026-10-01T12:00:00Z',
              createdAt: '2026-10-01T12:00:00Z',
              updatedAt: '2026-10-01T12:00:00Z',
              models: [
                {
                  id: 'cmodel000000000000000000001',
                  connectionId: 'cconnection000000000000001',
                  upstreamModelId: 'claude-sonnet-4',
                  label: 'Claude Sonnet 4',
                  contextWindow: 200000,
                  capabilities: { tools: true, vision: true, reasoning: true },
                  createdAt: '2026-10-01T12:00:00Z',
                },
              ],
            },
          ],
        },
      }),
    );
    await routeChat(page, { threads, reply: ['Here is ', 'your update.'] });
    let firstHistory = true;
    let releaseHistory = () => {};
    const historyReady = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let releaseOlder = () => {};
    const olderReady = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    let olderReads = 0;
    await page.route('**/api/v1/bots/*/chat*', async (route) => {
      const url = new URL(route.request().url());
      if (
        firstHistory &&
        route.request().method() === 'GET' &&
        !new URL(route.request().url()).searchParams.has('runId')
      ) {
        firstHistory = false;
        await historyReady;
      }
      if (
        route.request().method() === 'GET' &&
        !url.searchParams.has('runId') &&
        url.searchParams.get('threadId') === 'room-thread-0'
      ) {
        const older = url.searchParams.has('before');
        if (older) {
          olderReads += 1;
          await olderReady;
        }
        const history = threads['room-thread-0']!;
        await route.fulfill({
          json: {
            messages: older ? history.slice(0, 4) : history.slice(4),
            activeRun: null,
            interrupts: null,
            page: older ? { truncated: false } : { truncated: true, cursor: 'room-before-4' },
          },
        });
        return;
      }
      await route.fallback();
    });
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'room-test-token',
      });
      localStorage.setItem('crewaid.appearance.theme', 'light');
    }, auth.baseUrl);
    await page.reload();
    const transcript = page.getByRole('region', { name: 'Transcript' });
    const expectReadableMention = async () => {
      const mention = transcript.locator(
        '[data-message-bubble="user"] [data-bot-mention="bot_room_5"]',
      );
      await expect(mention).toBeVisible();
      const [ink, fill] = await mention.evaluate((node) => {
        const style = getComputedStyle(node);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        return [style.color, style.backgroundColor].map((color) => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return (
            '#' +
            [...context.getImageData(0, 0, 1, 1).data]
              .slice(0, 3)
              .map((channel) => channel.toString(16).padStart(2, '0'))
              .join('')
          );
        });
      });
      expect(contrastRatio(ink!, fill!)).toBeGreaterThanOrEqual(4.5);
    };
    await expect(transcript).toBeVisible();
    await expect(transcript.locator('[data-transcript-loading]')).toBeVisible();
    await expect(transcript).toHaveAttribute('aria-busy', 'true');
    if (capture) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, 'conversation-loading.png') });
    }
    releaseHistory();
    await expect(transcript.locator('[data-transcript-loading]')).toBeHidden();
    // Fifty latest rows contain only work and continuation notices. The
    // viewport must fetch the speech before them without waiting for a scroll.
    await expect(transcript.getByText('Loading earlier messages…', { exact: true })).toBeVisible();
    expect(olderReads).toBe(1);
    await expect(transcript).toHaveAttribute('aria-busy', 'true');
    if (capture)
      await page.screenshot({ path: path.join(evidence, 'earlier-history-loading.png') });
    releaseOlder();
    await expect(transcript.locator('[data-history-loading]')).toBeHidden();
    await expect(transcript).toHaveAttribute('aria-busy', 'false');
    await expect(transcript.locator('[data-motion-message]')).toHaveCount(2);
    await expect(transcript.getByText(/Paused after 25 steps/)).toHaveCount(0);
    await expect(
      page.locator('[data-screen-surface="rail"] > [data-screen-slot="controls"]'),
    ).toBeHidden();
    await expect(page.locator('button[aria-label="Record a voice message"]')).toHaveCSS(
      'color',
      'rgb(255, 255, 255)',
    );
    await expect(
      transcript.getByText('Draft a clear update for the team.', { exact: false }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const screenshot = async (name: string) => {
      // Compare settled surfaces while the screencast retains the transition.
      await page.evaluate(async () => {
        const finite = document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
        await Promise.allSettled(finite.map((animation) => animation.finished));
      });
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
      await testInfo.attach(name, {
        path: testInfo.outputPath(`${name}.png`),
        contentType: 'image/png',
      });
      if (capture) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: path.join(evidence, `${name}.png`) });
      }
    };
    const cdp = await page.context().newCDPSession(page);
    if (capture) {
      cdp.on('Page.screencastFrame', (event) => {
        frames.push({
          data: Buffer.from(event.data, 'base64'),
          timestamp: event.metadata.timestamp ?? Date.now() / 1000,
        });
        void cdp
          .send('Page.screencastFrameAck', { sessionId: event.sessionId })
          .catch(() => undefined);
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 80,
        maxWidth: 1440,
        maxHeight: 900,
        everyNthFrame: 1,
      });
    }
    await screenshot('room-light');
    await page.route('**/api/v1/bots', (route) =>
      route.fulfill({
        json: bots.map((bot, index) => ({ ...bot, pinned: index < 2 })),
      }),
    );
    await page.reload();
    const pinned = page.getByRole('region', { name: 'Pinned bots' });
    await expect(pinned.getByRole('button', { name: 'Open Quill' })).toBeVisible();
    await expect(pinned.getByRole('button', { name: 'Open Scout' })).toBeVisible();
    expect(
      await pinned
        .locator('div')
        .nth(1)
        .evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
    const pinnedScout = pinned.getByRole('button', { name: 'Open Scout' });
    await pinnedScout.hover();
    await expect(pinnedScout).toHaveCSS('background-color', await tokenColor(page, '--crew-hover'));
    const pinnedQuill = pinned.getByRole('button', { name: 'Open Quill' });
    await pinnedQuill.hover();
    await expect(pinnedQuill).toHaveCSS(
      'background-color',
      await tokenColor(page, '--crew-selected'),
    );
    await page.mouse.move(700, 90);
    await screenshot('pinned-bots-light');
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: bots }));
    await page.reload();
    await expect(transcript).toBeVisible();
    const scoutRow = page.getByRole('option', { name: /Scout/ });
    await scoutRow.hover();
    await expect(scoutRow).toHaveCSS('background-color', await tokenColor(page, '--crew-hover'));
    await page.mouse.move(700, 90);
    const sidebarSash = page.getByRole('separator', { name: 'Resize sidebar' });
    await sidebarSash.press('Home');
    await expect(sidebarSash).toHaveAttribute('aria-valuenow', '72');
    const quillRow = page.getByRole('option', { name: /Quill/ });
    await expect(quillRow).toBeVisible();
    await expect(quillRow.locator('.crewaid-bot-row-copy')).toBeHidden();
    await expect(quillRow.getByRole('img', { name: 'Idle', exact: true })).toBeVisible();
    await screenshot('sidebar-icons-light');
    for (let i = 0; i < 8; i++) await sidebarSash.press('ArrowRight');
    await expect(page.getByRole('heading', { name: 'Crew', exact: true })).toBeVisible();
    await screenshot('sidebar-compact-light');
    await sidebarSash.press('End');
    await expect(page.getByRole('heading', { name: 'Your crew', exact: true })).toBeVisible();
    const sashBounds = await sidebarSash.boundingBox();
    expect(sashBounds).not.toBeNull();
    const sashX = sashBounds!.x + sashBounds!.width / 2;
    const sashY = sashBounds!.y + sashBounds!.height / 2;
    await page.mouse.move(sashX, sashY);
    await page.mouse.down();
    await page.mouse.move(sashX - 104, sashY);
    await page.mouse.up();
    await expect(sidebarSash).toHaveAttribute('aria-valuenow', '256');
    await page.locator('button[data-approval-mode]').click();
    await expect(page.getByText('Full access', { exact: true })).toBeVisible();
    await expect(page.locator('button[data-approval-mode]')).toHaveCSS(
      'color',
      await tokenColor(page, '--muted', 'color'),
    );
    await screenshot('approval-menu-light');
    await page.keyboard.press('Escape');
    await quillRow.click({ button: 'right' });
    const botMenu = page.getByRole('menu', { name: 'Actions for Quill' });
    await expect(botMenu).toBeVisible();
    expect(
      await botMenu.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const point = document.elementFromPoint(bounds.right - 10, bounds.bottom - 10);
        // Rendered in the overlay layer, outside the sidebar that would clip it.
        const sidebar = document.querySelector('[data-pane="sidebar"]');
        return node.contains(point) && sidebar !== null && !sidebar.contains(node);
      }),
    ).toBe(true);
    await screenshot('bot-menu-light');
    await page.keyboard.press('Escape');
    await page.locator('button[aria-label="New bot"]').click();
    const newBot = page.getByRole('dialog', { name: 'New Bot' });
    await expect(newBot.getByRole('button', { name: 'Create', exact: true })).toHaveCSS(
      'color',
      await tokenColor(page, '--app-accent-foreground', 'color'),
    );
    await expect(newBot.getByRole('button', { name: 'Create', exact: true })).toHaveCSS(
      'background-color',
      'rgb(0, 0, 0)',
    );
    await screenshot('new-bot-selected-light');
    await newBot.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Bot settings', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Bot profile' })).toBeVisible();
    await screenshot('bot-profile-light');
    await page.getByRole('button', { name: 'Back to details' }).click();
    for (const [name, color] of palette.slice(0, 5)) {
      await page
        .getByRole('listbox', { name: 'Bots' })
        .getByRole('option', { name: new RegExp(name) })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.style.getPropertyValue('--bot-accent')),
        )
        .toBe(color);
      await expect(transcript.locator('[data-message-bubble="user"]')).toHaveCSS(
        'background-color',
        await tokenColor(page, '--message-user'),
      );
    }
    await expect(transcript.locator('[data-message-bubble="user"]')).toHaveCSS(
      'color',
      await tokenColor(page, '--message-user-foreground', 'color'),
    );
    await transcript.getByRole('textbox', { name: 'Message Exe' }).fill('Check white send arrow.');
    await expect(transcript.locator('button[aria-label="Send message"]')).toHaveCSS(
      'color',
      'rgb(255, 255, 255)',
    );
    await screenshot('blue-chat-light');
    await transcript.getByRole('textbox', { name: 'Message Exe' }).fill('');

    await page
      .getByRole('listbox', { name: 'Bots' })
      .getByRole('option', { name: /Quill/ })
      .click();
    await expectReadableMention();
    await screenshot('room-quill-light');
    // Account lives in the top bar; appearance uses HeroUI's existing theme root.
    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.locator('.button--primary').first()).toHaveCSS(
      'background-color',
      'rgb(0, 0, 0)',
    );
    await expect(settings).toHaveCSS('border-radius', '28px');
    await expect(settings).toHaveCSS('width', '920px');
    await expect(settings).toHaveCSS('height', '640px');
    await expect(settings.getByRole('navigation', { name: 'Settings sections' })).toHaveCSS(
      'width',
      '212px',
    );
    await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    const showWork = settings.getByRole('switch', { name: 'Show thinking and actions' });
    await settings.locator('[data-show-bot-work] .switch__control').click();
    await expect(showWork).toBeChecked();
    await expect(transcript.locator('[data-motion-message]')).toHaveCount(52);
    await showWork.focus();
    await page.keyboard.press('Space');
    await expect(showWork).not.toBeChecked();
    await expect(transcript.locator('[data-motion-message]')).toHaveCount(2);
    await screenshot('settings-general-light');
    const settingsNav = settings.getByRole('navigation', { name: 'Settings sections' });
    await settingsNav.getByRole('button', { name: 'Models', exact: true }).click();
    await settings.getByRole('button', { name: 'Work Anthropic details' }).click();
    await expect(settings.getByText('Claude Sonnet 4', { exact: true })).toBeVisible();
    await screenshot('settings-models-light');
    await settingsNav.getByRole('button', { name: 'General', exact: true }).click();
    await settings.getByLabel('Night', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'crewaid-dark');
    await screenshot('settings-night');
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await scoutRow.hover();
    await expect(scoutRow).toHaveCSS('background-color', await tokenColor(page, '--crew-hover'));
    await page.mouse.move(700, 90);
    await expectReadableMention();
    await screenshot('room-night');
    for (const [name, color] of palette.slice(0, 5)) {
      await page
        .getByRole('listbox', { name: 'Bots' })
        .getByRole('option', { name: new RegExp(name) })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.style.getPropertyValue('--bot-accent')),
        )
        .toBe(color);
      await expect(transcript.locator('[data-message-bubble="bot"]')).toHaveCSS(
        'background-color',
        await tokenColor(page, '--message-bot'),
      );
      await expect(transcript.locator('[data-message-bubble="user"]')).toHaveCSS(
        'background-color',
        await tokenColor(page, '--message-user'),
      );
      await expect(transcript.locator('[data-message-bubble="user"]')).toHaveCSS(
        'color',
        await tokenColor(page, '--message-user-foreground', 'color'),
      );
    }
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'crewaid-dark');
    await page
      .getByRole('listbox', { name: 'Bots' })
      .getByRole('option', { name: /Quill/ })
      .click();
    // Opening and dismissing Search returns keyboard focus to the trigger.
    const search = page.getByRole('button', { name: 'Search', exact: true });
    await search.click();
    await expect(page.getByRole('searchbox', { name: 'Search everything' })).toBeFocused();
    await screenshot('search-night');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search everything' })).toBeHidden();
    await expect(search).toBeFocused();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await expect(page.getByRole('searchbox', { name: 'Search everything' })).toBeFocused();
      await page.keyboard.press('Escape');
    }
    const createRoutine = page.getByRole('button', { name: 'Create routine', exact: true });
    await createRoutine.click();
    await expect(page.getByRole('form', { name: 'New routine' })).toBeVisible();
    await screenshot('routine-night');
    await page
      .getByRole('form', { name: 'New routine' })
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(page.getByRole('form', { name: 'New routine' })).toBeHidden();
    await expect(createRoutine).toBeFocused();
    await page.evaluate(() => {
      const scope = window as unknown as { entranceIds: string[] };
      scope.entranceIds = [];
      document.addEventListener('animationstart', (event) => {
        if (event.animationName === 'crewaid-message-in') {
          const id = (event.target as HTMLElement).dataset['motionMessage'];
          if (id) scope.entranceIds.push(id);
        }
      });
    });
    let sends = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/chat$/.test(request.url())) sends++;
    });
    await transcript
      .getByRole('textbox', { name: 'Message Quill' })
      .fill('Send one careful update.');
    await transcript.locator('button[aria-label="Send message"]').click();
    await expect(transcript.getByText('Here is your update.', { exact: true })).toBeVisible();
    expect(sends).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { entranceIds: string[] }).entranceIds.length),
      )
      .toBeGreaterThanOrEqual(1);
    const entrances = await page.evaluate(
      () => (window as unknown as { entranceIds: string[] }).entranceIds,
    );
    expect(new Set(entrances).size).toBe(entrances.length);
    await screenshot('sent-night');
    await page.locator('button[aria-label="Collapse panel"]').click();
    await expect
      .poll(() =>
        page
          .locator('[data-pane-rail-state="collapsed"]')
          .evaluate((node) => node.getBoundingClientRect().height),
      )
      .toBeLessThanOrEqual(98);
    await screenshot('rail-collapsed');
    await page.getByRole('button', { name: 'Expand panel' }).click();
    for (const view of ['Tasks', 'Goals', 'Deliverables']) {
      await page
        .getByRole('navigation', { name: 'Work' })
        .getByRole('tab', { name: view, exact: true })
        .click();
      await expect(page.getByRole('region', { name: view, exact: true })).toBeVisible();
      expect(
        await page
          .getByRole('region', { name: view, exact: true })
          .evaluate((node) => getComputedStyle(node).getPropertyValue('--accent').trim()),
      ).toBe(
        // Work belongs to no bot, so it keeps the app's own accent.
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--app-accent').trim(),
        ),
      );
      await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
      await screenshot(`${view.toLowerCase()}-night`);
    }
    await page.getByRole('tab', { name: 'Crew', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(980, 760));
    await expect(createRoutine).toBeVisible();
    await expect
      .poll(() =>
        page.locator('[data-pane-shell]').evaluate((node) => node.scrollWidth - node.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    await screenshot('room-constrained');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await search.click();
    await expect(page.getByRole('searchbox', { name: 'Search everything' })).toBeFocused();
    expect(
      await page
        .locator('.crewaid-search-container')
        .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe('none');
    await page.keyboard.press('Escape');
    await expect(search).toBeFocused();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('html').evaluate((node) => node.setAttribute('data-reduce-motion', 'true'));
    await createRoutine.click();
    await expect(page.getByRole('form', { name: 'New routine' })).toBeVisible();
    expect(
      await page
        .locator('.modal__container')
        .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe('none');
    await page.keyboard.press('Escape');
    await expect(createRoutine).toBeFocused();
    await page.locator('html').evaluate((node) => node.removeAttribute('data-reduce-motion'));
    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await settings.getByLabel('System', { exact: true }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'crewaid');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'crewaid-dark');
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: [] }));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Create your first bot' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create a bot', exact: true })).toHaveCSS(
      'background-color',
      await tokenColor(page, '--app-accent'),
    );
    await screenshot('no-bots-night');
    await page.getByRole('button', { name: 'Create a bot', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New Bot' })).toBeVisible();
    await screenshot('new-bot-night');
    await page
      .getByRole('dialog', { name: 'New Bot' })
      .getByRole('button', { name: 'Cancel' })
      .click();
    await page.evaluate(() => localStorage.setItem('crewaid.appearance.theme', 'light'));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Create a bot', exact: true })).toHaveCSS(
      'background-color',
      'rgb(0, 0, 0)',
    );
    await screenshot('no-bots-light');
    if (capture) {
      await cdp.send('Page.stopScreencast');
      const directory = path.join(evidence, 'frames');
      await mkdir(directory, { recursive: true });
      const entries: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i]!;
        await writeFile(path.join(directory, `${i}.jpg`), frame.data);
        entries.push(
          `file '${i}.jpg'\nduration ${Math.max(0.016, (frames[i + 1]?.timestamp ?? frame.timestamp + 0.2) - frame.timestamp)}`,
        );
      }
      entries.push(`file '${frames.length - 1}.jpg'`);
      await writeFile(path.join(directory, 'frames.txt'), entries.join('\n'));
      const encoded = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          path.join(directory, 'frames.txt'),
          '-vf',
          'pad=ceil(iw/2)*2:ceil(ih/2)*2',
          '-vsync',
          'vfr',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          path.join(evidence, 'interactions.mp4'),
        ],
        { encoding: 'utf8' },
      );
      expect(encoded.status, encoded.stderr).toBe(0);
      await rm(directory, { recursive: true, force: true });
    }
    await cdp.detach();
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('expanded viewer requests the lease, waits, cancels and hands control back', async () => {
  const { stampWireVersion } = await import('@crewaid/shared');
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-cc79-control-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profile);
    const page = await app.firstWindow();
    const bot = {
      ...bots[0]!,
      id: 'cbot00000000000000000000a',
      sandboxId: 'csandbox00000000000000001',
      sandbox: {
        id: 'csandbox00000000000000001',
        userId: 'usr_crewaid_singleton_v1',
        sessionId: null,
        containerId: null,
        state: 'RUNNING',
        widthPx: 1280,
        heightPx: 800,
        vncPort: null,
        cdpPort: null,
        bridgePort: null,
        lastStartedAt: null,
        lastError: null,
        lastActiveAt: null,
        keepRunningUntil: null,
      },
    };
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: [bot] }));
    await routeChat(page);
    const requests: { action: string; epoch?: number }[] = [];
    let epoch = 0;
    let sendControl:
      ((mode: 'agent' | 'draining' | 'human', holder?: 'self' | 'other') => void) | undefined;
    await page.routeWebSocket('**/ws?*', (ws) => {
      sendControl = (mode, holder = 'self') =>
        ws.send(
          JSON.stringify(
            stampWireVersion({
              id: randomUUID(),
              botId: bot.id,
              type: 'screen.control.state',
              ts: Date.now(),
              payload:
                mode === 'agent'
                  ? { botId: bot.id, mode, epoch, holder: null, observationRequired: true }
                  : mode === 'draining'
                    ? {
                        botId: bot.id,
                        mode,
                        epoch,
                        holder,
                        drainDeadline: Date.now() + 20000,
                        observationRequired: false,
                      }
                    : {
                        botId: bot.id,
                        mode,
                        epoch,
                        holder,
                        leaseExpiresAt: Date.now() + 30000,
                        observationRequired: false,
                      },
            }),
          ),
        );
      ws.onMessage((data) => {
        if (typeof data !== 'string') return;
        const frame = JSON.parse(data) as {
          type: string;
          payload: { action: string; epoch?: number };
        };
        if (frame.type !== 'screen.control') return;
        requests.push(frame.payload);
        if (frame.payload.action === 'take') {
          epoch++;
          sendControl?.('draining');
        }
        if (frame.payload.action === 'release') {
          epoch++;
          sendControl?.('agent');
        }
      });
    });
    // One real Tight fill reaches noVNC on the bot's stream, so its canvas and
    // resize path are exercised instead of leaving the connecting overlay up.
    const picture = Buffer.alloc(20);
    picture.writeUInt16BE(1, 2);
    picture.writeUInt16BE(1280, 8);
    picture.writeUInt16BE(800, 10);
    picture.writeInt32BE(7, 12);
    picture[16] = 0x80;
    picture.set([90, 150, 210], 17);
    await routeScreenStream(page, picture);
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'takeover-test-token',
      });
    }, auth.baseUrl);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Transcript' }).getByText('Idle', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Connected', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Take over', exact: true })).toHaveCount(0);
    await expect(page.locator('[data-screen-loading]')).toHaveCount(0);
    const canvas = page.locator('[data-screen-state="live"] canvas');
    await expect(canvas).toBeVisible();
    const originalCanvas = await canvas.elementHandle();
    await expect(canvas.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const openScreen = page.getByRole('button', { name: 'View full screen', exact: true });
    await openScreen.click();
    expect(requests).toHaveLength(0);
    const takeover = page.getByRole('button', { name: 'Take control', exact: true });
    await canvas.click();
    await expect(takeover).toHaveAttribute('data-control-hint', 'true');
    await expect(page.locator('[data-screen-control-notice]')).toHaveText(
      'Click “Take control” above to interact with this computer.',
    );
    expect(requests).toHaveLength(0);
    await expect(page.getByText('The bot is using this computer', { exact: true })).toHaveCount(0);
    await takeover.click();
    await expect(page.locator('[data-seat-control="taking"]')).toBeVisible();
    const fullscreen = page.locator('[data-screen-surface="fullscreen"]');
    await expect
      .poll(() =>
        fullscreen.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
        }),
      )
      .toEqual(
        await page.evaluate(() => ({ left: 0, top: 0, width: innerWidth, height: innerHeight })),
      );
    expect(requests.filter((request) => request.action === 'take')).toHaveLength(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(980, 760));
    await expect
      .poll(() => fullscreen.evaluate((node) => node.scrollWidth - node.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect(page.locator('button[aria-label="Close full screen"]')).toBeInViewport();
    if (process.env['CC79_CAPTURE'] === '1') {
      await page.evaluate(async () => {
        const finite = document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
        await Promise.allSettled(finite.map((animation) => animation.finished));
      });
      await page.screenshot({
        path: path.resolve('../../.artifacts/cc79/fullscreen-control.png'),
      });
    }
    await page
      .locator('[data-seat-control]')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(page.locator('[data-seat-control="available"]')).toBeVisible();
    expect(requests.at(-1)).toMatchObject({ action: 'release', epoch: 1 });
    await page.locator('button[aria-label="Close full screen"]').click();
    await expect(canvas.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect(await canvas.evaluate((node, original) => node === original, originalCanvas)).toBe(true);
    await expect
      .poll(() =>
        canvas.evaluate((node) => {
          const picture = node.getBoundingClientRect();
          const viewport = node.parentElement!.getBoundingClientRect();
          return Math.min(
            Math.abs(picture.width - viewport.width),
            Math.abs(picture.height - viewport.height),
          );
        }),
      )
      .toBeLessThanOrEqual(1);
    const pictureFit = await canvas.evaluate((node) => {
      const picture = node.getBoundingClientRect();
      const viewport = node.parentElement!.getBoundingClientRect();
      return {
        overflow: Math.max(picture.width - viewport.width, picture.height - viewport.height),
        unusedAxis: Math.min(
          Math.abs(picture.width - viewport.width),
          Math.abs(picture.height - viewport.height),
        ),
        aspect: Math.abs(picture.width / picture.height - 1.6),
      };
    });
    expect(pictureFit.overflow).toBeLessThanOrEqual(1);
    expect(pictureFit.unusedAxis).toBeLessThanOrEqual(1);
    expect(pictureFit.aspect).toBeLessThanOrEqual(0.01);
    if (process.env['CC79_CAPTURE'] === '1') {
      await page.screenshot({
        path: path.resolve('../../.artifacts/cc79/screen-preview-restored.png'),
      });
    }
    await openScreen.click();
    await takeover.click();
    await expect(page.locator('[data-seat-control="taking"]')).toBeVisible();
    sendControl?.('human');
    await expect(page.locator('[data-seat-control="driving"]')).toBeVisible();
    await expect(page.locator('[data-screen-control-notice]')).toHaveText(
      'You are in control. Bot screen actions are paused. Background programs can keep running.',
    );
    await page.getByRole('button', { name: 'Hand back', exact: true }).click();
    await expect(page.locator('[data-seat-control="available"]')).toBeVisible();
    await expect(page.locator('[data-screen-control-notice]')).toHaveText(
      'The bot has control again. Background programs can keep running.',
    );
    expect(requests.at(-1)).toMatchObject({ action: 'release', epoch: 3 });
    sendControl?.('human', 'other');
    await expect(page.locator('[data-seat-control="taken"]')).toBeVisible();
    await expect(page.getByText('Someone else is in control', { exact: true })).toBeVisible();
    await page.locator('button[aria-label="Close full screen"]').click();
    await expect(takeover).toHaveCount(0);
    await openScreen.click();
    await expect(page.locator('[data-seat-control="taken"]')).toBeVisible();
    await expect(takeover).toHaveCount(0);
    expect(requests.filter((request) => request.action === 'take')).toHaveLength(2);
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
