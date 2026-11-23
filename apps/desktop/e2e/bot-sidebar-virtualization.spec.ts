import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './launchDesktop';
import { routeChat } from './stubChat';
import { startStubAuthServer, type StubAuthServer } from './stubAuthServer';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';

/**
 * The sidebar's row list is virtualized, and this is the only place that can
 * prove it. The unit suite renders with `renderToStaticMarkup`, where no
 * effect runs and nothing has a measured size — a virtualizer there reports
 * whatever it reports, and a regression that renders every row (or none)
 * looks identical. Only a real window has a viewport to virtualize against.
 *
 * D-192: the selected bot's chat
 * endpoint is stubbed. Nothing here asserts the transcript, but the first row
 * is selected on load, and a window whose centre pane cannot open leaves the
 * sidebar measuring itself beside a pane of a different height.
 */
const BOT_COUNT = 2000;

function botFixture(index: number): Record<string, unknown> {
  const suffix = String(index).padStart(4, '0');
  return {
    id: `bot_virtualization_${suffix}`,
    userId: 'usr_crewaid_singleton_v1',
    name: `bot-${suffix}`,
    role: 'Researcher',
    avatarColor: '#4c6ef5',
    avatarShape: null,
    avatarUrl: null,
    systemPrompt: '',
    modelId: 'default',
    status: 'IDLE',
    sortOrder: index,
    pinned: false,
    hiddenFromSidebar: false,
    autoReviewRules: [],
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    // Required by BotWithSandboxSchema. Omitting EITHER of these fails the
    // parse, the list falls back to its empty state, and — because React Aria
    // gives that placeholder `role="option"` too — a row-count assertion still
    // passes. D-046 added `sandboxId`, and it failed exactly this way in CI.
    sandboxId: null,
    sandbox: null,
    thread: { id: `cuid-thread-${index}`, preview: null },
  };
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

test('renders a 2000-bot sidebar without putting 2000 rows in the DOM', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-sidebar-virt-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();

    await page.route('**/api/v1/bots', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(Array.from({ length: BOT_COUNT }, (_, i) => botFixture(i))),
      }),
    );
    await routeChat(page);

    const saved = await page.evaluate<TokenStoreWriteResult, string>(
      (baseUrl) =>
        (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
          orchestratorBaseUrl: baseUrl,
          orchestratorToken: 'sidebar-virtualization-token',
        }),
      stubAuth.baseUrl,
    );
    expect(saved.status).toBe('saved');
    await page.reload();

    const list = page.getByRole('listbox', { name: 'Bots' });
    // Assert a real bot by name. `getByRole('option')` also matches the empty
    // state's placeholder, so "an option is visible" is true of a list that
    // loaded nothing — which is exactly how the first version of this test
    // passed against a fixture the contract rejected.
    await expect(list.getByRole('option', { name: /bot-0000/ })).toBeVisible();

    const rendered = await list.getByRole('option').count();
    expect(rendered).toBeGreaterThan(0);
    // A 900px-tall window fits ~14 rows at 56px. The ceiling is loose enough
    // to absorb overscan and a different window size, and still two orders of
    // magnitude below the un-virtualized count this guards against.
    expect(rendered).toBeLessThan(120);

    // Scrolling must yield different rows — otherwise the list is a fixed
    // window over the first page rather than a virtualized view of all 2000.
    const firstBefore = await list.getByRole('option').first().textContent();
    await list.evaluate((element) => element.scrollTo({ top: 20_000 }));
    await expect
      .poll(async () => list.getByRole('option').first().textContent())
      .not.toBe(firstBefore);
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});
