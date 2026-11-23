import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';
import { launchDesktop } from './launchDesktop';
import { tokenColor } from './themeTokens';

/**
 * M10 — Work, end to end in the real app against a real orchestrator
 * (PRD-WORK §10 "E2E"): create a task, assign and start it, see its card move
 * when the bot's side updates it, and preview a deliverable.
 *
 * The model is the deterministic e2e provider, so "the bot updates it" is
 * played by this test through the same route a bot's `task_update` ends in;
 * what is under test is that the open board follows a change it did not make,
 * through `task.changed` alone.
 *
 * D-192: the two transcript assertions here — the task brief that a Start
 * delivers, and the bot reply the message menu files as a deliverable — now
 * come from `GET /bots/:id/chat?threadId=`, the operator-view hydrate, rather
 * than from `GET /bots/:id/messages`. Nothing in the spec says so, because
 * nothing in the spec names the route: it reads the brief card and the bubble
 * the way an operator does. What did have to change is the harness's seed,
 * which wrote the reply with `content` and no `parts` — the AI SDK row shape,
 * which the operator hydrate refuses.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps/orchestrator/scripts/e2e-server.mjs');
const TOKEN = 'm10-work-local-e2e-token';
const BOT_NAME = 'QA-05 Bot';

type Ready = { baseUrl: string; botId: string };

function startServer(
  artifactDir: string,
): Promise<{ child: ChildProcessWithoutNullStreams; ready: Ready }> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for pnpm test:e2e');
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CREWAID_E2E_SESSION_TOKEN: TOKEN,
      CREWAID_E2E_SEED_WORK: '1',
      ARTIFACT_DIR: artifactDir,
      LOG_LEVEL: 'warn',
      // D-152: also required at module scope; the hosted sign-in these drive.
      CREWAID_EDITION: 'cloud',
      BETTER_AUTH_SECRET: 'm10-work-e2e-better-auth-secret-00000000000',
      BETTER_AUTH_URL: 'http://127.0.0.1:0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out starting the Work e2e server.\n${stderr}\n${stdout}`));
    }, 30_000);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout
        .split(/\r?\n/)
        .find((candidate) => candidate.startsWith('M1_QA_05_READY '));
      if (!line) return;
      clearTimeout(timer);
      resolve({ child, ready: JSON.parse(line.slice('M1_QA_05_READY '.length)) as Ready });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Work e2e server exited early (${code}).\n${stderr}\n${stdout}`));
    });
  });
}

async function stopServer(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function api(ready: Ready, method: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${ready.baseUrl}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`${method} ${route} → ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

const column = (page: Page, name: string) => page.getByRole('list', { name, exact: true });

test('a task is created, assigned, started, moved by the bot’s side, and its deliverable previews', async () => {
  test.setTimeout(120_000);
  const runDir = await mkdtemp(path.join(tmpdir(), 'crewaid-m10-work-'));
  const artifactDir = path.join(runDir, 'artifacts');
  await mkdir(artifactDir, { recursive: true });
  let server: ChildProcessWithoutNullStreams | undefined;
  let app: ElectronApplication | undefined;

  try {
    const started = await startServer(artifactDir);
    server = started.child;
    app = await launchDesktop(path.join(runDir, 'profile'));
    const page = await app.firstWindow();
    const saved = await page.evaluate<TokenStoreWriteResult, { baseUrl: string; token: string }>(
      ({ baseUrl, token }) =>
        (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
          orchestratorBaseUrl: baseUrl,
          orchestratorToken: token,
        }),
      { baseUrl: started.ready.baseUrl, token: TOKEN },
    );
    expect(saved).toEqual({ status: 'saved' });
    await page.reload();
    await expect(page.locator('[data-connection-status="connected"]')).toBeVisible();

    // The Work rows sit at the foot of the sidebar, quiet: no badge yet.
    const work = page.getByRole('navigation', { name: 'Work' });
    await expect(work.getByRole('tab', { name: /Tasks/ })).toBeVisible();
    await expect(work.getByLabel(/waiting on review/)).toHaveCount(0);

    // Create: the empty state, then quick add at the top of To do.
    await work.getByRole('tab', { name: /Tasks/ }).click();
    await expect(page.getByText('No tasks yet')).toBeVisible();
    // With nothing opened, a Work view has no rail: the bot's computer
    // belongs to its conversation, not beside a board.
    const rail = page.locator('[data-pane="rail"], [data-pane="rail-collapsed"]');
    await expect(rail).toHaveCount(0);
    await page.getByRole('button', { name: 'Add a task' }).click();
    await page.getByLabel('Title').fill('API auth');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(column(page, 'To do').getByRole('button', { name: /API auth/ })).toBeVisible();

    // Assign in the details rail, then Start: one brief, and the card moves.
    await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible();
    const details = page.getByRole('complementary', { name: 'Task details' });
    const selectedCard = column(page, 'To do').getByRole('button', { name: /API auth/ });
    const selectedFill = await tokenColor(page, '--crew-selected');
    await expect(selectedCard).toHaveCSS('background-color', selectedFill);
    await selectedCard.hover();
    await expect(selectedCard).toHaveCSS('background-color', selectedFill);
    await expect(details).toHaveCSS('border-radius', '24px');
    await expect(details).toHaveCSS('backdrop-filter', 'blur(24px) saturate(1.65)');
    if (process.env['CC79_CAPTURE'] === '1') {
      const evidence = path.join(REPO_ROOT, '.artifacts/cc79');
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, 'task-board-details.png') });
      await page.getByLabel('List', { exact: true }).click();
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.locator('.crewaid-task-row[aria-selected="true"]')).toHaveCSS(
        'background-color',
        selectedFill,
      );
      await page.screenshot({ path: path.join(evidence, 'task-list-details.png') });
      await page.getByLabel('Board', { exact: true }).click();
    }
    await details.getByRole('button', { name: /Assignee/ }).click();
    await page.getByRole('option', { name: BOT_NAME }).click();
    // The picker's popover has to be gone first: a press while it is closing
    // lands on its dismiss layer, not on the button under it.
    await expect(page.getByRole('listbox', { name: 'Assignee' })).toHaveCount(0);
    await expect(details.getByRole('button', { name: /Assignee/ })).toContainText(BOT_NAME);
    await details.getByRole('button', { name: 'Start' }).click();
    await expect(
      column(page, 'In progress').getByRole('button', { name: /API auth/ }),
    ).toBeVisible();

    // One filter menu: a Status choice is a draft until Apply, the button
    // counts it, and Reset brings every card back.
    const card = column(page, 'In progress').getByRole('button', { name: /API auth/ });
    const filter = page.locator('[data-filter-menu]');
    await filter.click();
    const menu = page.getByRole('dialog', { name: 'Filter' });
    // By its own label: the group-by trigger's name also reads "Status".
    await menu.locator('[aria-label="Status"]').click();
    await page.getByRole('option', { name: 'Done' }).click();
    await expect(page.getByRole('listbox', { name: 'Status' })).toHaveCount(0);
    await expect(card).toBeVisible();
    await menu.getByRole('button', { name: 'Apply' }).click();
    await expect(menu).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await expect(filter).toHaveAccessibleName('Filter, 1 active');
    await filter.click();
    await page
      .getByRole('dialog', { name: 'Filter' })
      .getByRole('button', { name: 'Reset' })
      .click();
    await expect(card).toBeVisible();
    await expect(filter).toHaveAccessibleName('Filter');

    // Esc puts the open task away and the board takes the width back;
    // opening the card brings the details back.
    // The menu's own overlay takes an Esc while it is still closing.
    await expect(page.getByRole('dialog', { name: 'Filter' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(rail).toHaveCount(0);
    // Search within the view: an icon that opens into a field, narrowing
    // as you type; a miss says so in the middle of the pane; Esc clears the
    // query, and a second Esc folds the field away.
    await page.getByRole('button', { name: 'Search tasks' }).click();
    const search = page.getByRole('searchbox', { name: 'Search tasks' });
    await search.fill('auth');
    await expect(card).toBeVisible();
    // Each view has its own search: an open field does not follow you.
    await work.getByRole('tab', { name: /Goals/ }).click();
    await expect(page.getByRole('button', { name: 'Search goals' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search goals' })).toHaveCount(0);
    await work.getByRole('tab', { name: /Tasks/ }).click();
    await page.getByRole('button', { name: 'Search tasks' }).click();
    await search.fill('auth');
    await expect(card).toBeVisible();
    await search.fill('zzqx');
    await expect(page.getByText('Nothing matches “zzqx”')).toBeVisible();
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(card).toBeVisible();
    await search.press('Escape');
    await expect(search).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Search tasks' })).toBeVisible();

    await card.click();
    await expect(details).toBeVisible();

    const tasks = (await api(started.ready, 'GET', '/tasks?status=IN_PROGRESS')) as Array<{
      id: string;
      title: string;
    }>;
    const task = tasks.find((row) => row.title === 'API auth');
    expect(task).toBeDefined();

    // The bot's side moves it to Review; the open board follows the frame.
    await api(started.ready, 'PATCH', `/tasks/${task!.id}`, { status: 'IN_REVIEW' });
    await expect(column(page, 'Review').getByRole('button', { name: /API auth/ })).toBeVisible();
    await expect(work.getByLabel('1 waiting on review or unblocking')).toBeVisible();

    // The brief reached the assignee's conversation as the task's card.
    await details.getByRole('button', { name: 'Open conversation' }).click();
    await expect(page.locator('[data-task-brief]').getByText('API auth')).toBeVisible();
    // The jump marks the brief, and the mark fades by itself.
    const marked = page.locator('[data-message][data-focused="true"]');
    await expect(marked).toHaveCount(1);
    await expect(marked).toHaveCount(0, { timeout: 6_000 });
    // Choosing the bot in the sidebar puts the task away.
    await expect(details).toBeVisible();
    await page.getByRole('button', { name: `Open ${BOT_NAME}` }).click();
    await expect(details).toHaveCount(0);

    // The message menu: a bot's reply saved as a deliverable, from its hover row.
    const reply = page.locator('[data-message-bubble="bot"]', { hasText: 'Here is the PRD.' });
    await reply.hover();
    await page.locator('.group\\/bubble', { has: reply }).locator('[data-message-menu]').click();
    await page.getByRole('menuitem', { name: 'Save as deliverable' }).click();
    const save = page.getByRole('dialog', { name: 'Save as deliverable' });
    await save.getByLabel('Title').fill('PRD summary');
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(save.getByRole('status')).toContainText('Saved “PRD summary” to Deliverables');
    await save.getByRole('button', { name: 'Open in Deliverables' }).click();
    await expect(
      page.getByRole('complementary', { name: 'Deliverable' }).getByText('PRD summary'),
    ).toBeVisible();

    // Deliverables: the seeded file, previewed through the authenticated fetch.
    await work.getByRole('tab', { name: /Deliverables/ }).click();
    await page.getByRole('button', { name: /PRD\.md/ }).click();
    const preview = page.getByRole('complementary', { name: 'Deliverable' });
    await expect(preview).toHaveCSS('border-radius', '24px');
    await expect(preview).toHaveCSS('backdrop-filter', 'blur(24px) saturate(1.65)');
    await expect(
      preview.getByRole('region', { name: 'Preview' }).getByText('Acme PRD'),
    ).toBeVisible();
    await expect(preview.getByText('/home/bot/shared/PRD.md')).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await stopServer(server);
    await rm(runDir, { recursive: true, force: true });
  }
});
