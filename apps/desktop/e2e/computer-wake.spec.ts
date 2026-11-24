import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SANDBOX_CAPACITY_CODE } from '@crewaid/shared';
import { launchDesktop } from './launchDesktop';
import { routeChat } from './stubChat';
import { startStubAuthServer, type StubAuthServer } from './stubAuthServer';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';

/**
 * CC-16 — the computer wakes because someone asked for it (D-039 §16).
 *
 * A real window, because the two claims that matter most are about requests
 * that must NOT happen, and absence is only meaningful when everything else is
 * real: the rail card mounts for whichever bot is selected, the sidebar keeps
 * its thumbnails, and the shell issues its own §4.1 traffic throughout. A unit
 * test can assert that a function was not called; only this can assert that
 * clicking through a bot list starts no containers.
 *
 * The orchestrator is stubbed at the network boundary rather than run, so the
 * capacity refusal is exact (D-039 §7's body) without needing a full host.
 *
 * D-192: the conversation is served
 * from `GET /bots/:id/chat`. This test is about the rail card beside the
 * transcript, and the card only mounts for a bot whose conversation the window
 * opened — a thread the renderer cannot read replaces the whole centre pane
 * and takes the rail's reason to exist with it.
 */
function bot(index: number, sandboxState: string | null): Record<string, unknown> {
  const suffix = String(index).padStart(2, '0');
  return {
    id: `bot_wake_${suffix}`,
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
    // D-046: the bot's side of the attachment. Required by BotSchema, and a
    // fixture that omits it fails the parse — see the note in
    // `bot-sidebar-virtualization.spec.ts` for what that looks like from the UI.
    sandboxId: sandboxState === null ? null : `sbx_wake_${suffix}`,
    // Post-M3-BE-10 every bot owns a provisioned, stopped computer from the
    // moment it is created — which is exactly the row this feature wakes.
    sandbox:
      sandboxState === null
        ? null
        : {
            id: `sbx_wake_${suffix}`,
            // D-046: a machine is owned by a user and shared by its tenants.
            userId: 'usr_crewaid_singleton_v1',
            sessionId: null,
            containerId: null,
            state: sandboxState,
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
    // D-191: every row names its thread, and a row without one fails the
    // `GET /bots` parse — the sidebar is then empty and nothing can be clicked.
    thread: { id: `cuid-thread-${suffix}`, preview: null },
  };
}

function statusBody(botId: string, state: string): string {
  return JSON.stringify({ botId, state, widthPx: 1280, heightPx: 800, lastError: null });
}

/** D-039 §7's refusal, byte for byte — the shape the renderer has to recognise. */
function capacityBody(): string {
  return JSON.stringify({
    statusCode: 503,
    code: SANDBOX_CAPACITY_CODE,
    message: 'This host is already running 6 of 6 sandboxes. Stop one before starting another.',
    detail: { running: 6, limit: 6 },
  });
}

async function setUp(page: Page, bots: readonly Record<string, unknown>[]): Promise<void> {
  await page.route('**/api/v1/bots', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bots) }),
  );
  await routeChat(page);

  const saved = await page.evaluate<TokenStoreWriteResult, string>(
    (baseUrl) =>
      (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'computer-wake-token',
      }),
    stubAuth.baseUrl,
  );
  expect(saved.status).toBe('saved');
  await page.reload();
  // The centre pane is a transcript rather than `ThreadNotice`; the rail this
  // test drives sits beside it.
  await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
  // A bot whose computer is stopped opens with the rail tucked away. This suite
  // drives the computer card, so it brings the rail out; the choice is kept
  // across bot switches, which is what the selection test walks through.
  await page.getByRole('button', { name: 'Expand panel' }).click();
}

/** Count every start the window issues, whoever issued it. */
function countStarts(page: Page): { readonly urls: string[] } {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/sandbox/start')) urls.push(request.url());
  });
  return { urls };
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

test('selecting bots never wakes one', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc16-select-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    const starts = countStarts(page);
    await setUp(page, [bot(1, 'STOPPED'), bot(2, 'STOPPED'), bot(3, null)]);

    // The claim §16 makes and the reason it makes it: the rail card mounts for
    // whichever bot is selected, so a wake on selection would start a
    // container for every bot the operator clicked past — on a host whose
    // ceiling is six. Clicking through the whole list must cost nothing.
    for (const name of [/bot-02/, /bot-03/, /bot-01/, /bot-02/]) {
      await page.getByRole('option', { name }).click();
      await expect(page.locator('[data-screen-state="stopped"]')).toBeVisible();
    }

    expect(starts.urls).toEqual([]);
    // And the card says so plainly rather than looking broken.
    await expect(page.getByRole('button', { name: 'Open computer' })).toBeVisible();
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('opening the computer wakes exactly one, and shows it waking while it does', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc16-open-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    const starts = countStarts(page);
    await setUp(page, [bot(1, 'STOPPED')]);

    let release: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/bots/*/sandbox/start', async (route) => {
      await answered;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: statusBody('bot_wake_01', 'RUNNING'),
      });
    });

    await page.getByRole('button', { name: 'Open computer' }).click();

    // The state that only exists because the request and the row disagree: the
    // row still reads STOPPED until the orchestrator answers (D-028 — start
    // does not return until the desktop is usable), so without this the click
    // would be answered with "this computer is asleep".
    await expect(page.locator('[data-screen-state="starting"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open computer' })).toHaveCount(0);
    // No second press while one is out; the host is already answering.
    await expect(page.locator('[data-screen-action]')).toHaveCount(0);

    release?.();
    await expect(page.locator('[data-screen-state="live"]')).toBeVisible();
    expect(starts.urls).toHaveLength(1);
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('a full host reads as a full host, and the retry asks again', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc16-capacity-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    const starts = countStarts(page);
    await setUp(page, [bot(1, 'STOPPED')]);

    let attempts = 0;
    await page.route('**/api/v1/bots/*/sandbox/start', (route) => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({ status: 503, contentType: 'application/json', body: capacityBody() })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: statusBody('bot_wake_01', 'RUNNING'),
          });
    });

    await page.getByRole('button', { name: 'Open computer' }).click();

    // D-039 §16.1: shown separately from a runtime failure, because the bot is
    // not broken and the identical request succeeds once a slot frees. 503
    // alone cannot carry that — workspace readiness answers 503 too.
    await expect(page.locator('[data-screen-state="capacity"]')).toBeVisible();
    await expect(page.locator('[data-screen-state="failed"]')).toHaveCount(0);
    // Our own copy, not the server's sentence: the renderer never puts a
    // response body on screen (the D-006 principle applied to our REST layer),
    // so what the operator reads is normalized here and the numbers stay in
    // `detail` for logs.
    await expect(page.getByText(/as many computers as it can/)).toBeVisible();

    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(page.locator('[data-screen-state="live"]')).toBeVisible();
    expect(starts.urls).toHaveLength(2);
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('switching away leaves the wake running and its answer waiting', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc16-switch-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    const starts = countStarts(page);
    await setUp(page, [bot(1, 'STOPPED'), bot(2, 'STOPPED')]);

    let release: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/bots/*/sandbox/start', async (route) => {
      await answered;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: statusBody('bot_wake_01', 'RUNNING'),
      });
    });

    await page.getByRole('button', { name: 'Open computer' }).click();
    await expect(page.locator('[data-screen-state="starting"]')).toBeVisible();

    // D-041: switching bots detaches the viewer, it does not cancel work. The
    // second bot must show its OWN state — a wake held for "the selected bot"
    // rather than for the bot that asked would follow the operator here.
    await page.getByRole('option', { name: /bot-02/ }).click();
    await expect(page.locator('[data-screen-state="stopped"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open computer' })).toBeVisible();

    // The answer lands while the operator is looking at a different bot, which
    // is the late response CC-16 asks to cover.
    release?.();
    await page.getByRole('option', { name: /bot-01/ }).click();

    await expect(page.locator('[data-screen-state="live"]')).toBeVisible();
    // One start, for one bot. Switching started nothing.
    expect(starts.urls).toHaveLength(1);
    expect(starts.urls[0]).toContain('bot_wake_01');
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});
