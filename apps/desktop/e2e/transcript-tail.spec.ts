import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';
import { launchDesktop } from './launchDesktop';

/**
 * A transcript longer than its newest rows, in the real app: older rows
 * render lazily (`content-visibility: auto`) and settle to their real height
 * only when they come into view.
 *
 * Two things broke there and are held here. The view has to stay on the
 * newest message while rows settle — as replies land, and when a
 * conversation is opened again. And an older bubble's time-and-copy footer,
 * which hangs below the bubble, has to fit inside the box its row clips to.
 *
 * D-192: the five sends and the five replies travel over `POST /bots/:id/chat`
 * and that run's log, and reopening the conversation re-reads it from
 * `GET /bots/:id/chat?threadId=`. That is the point of keeping this one on a
 * real orchestrator: the rows this measures are the ones the chat client built
 * from a real stream, at the heights the real markup gives them.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps/orchestrator/scripts/e2e-server.mjs');
const TOKEN = 'transcript-tail-local-e2e-token';
const BOT_NAME = 'QA-05 Bot';
const REPLY = 'Deterministic stream reply.';
const SENDS = 5;

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
      ARTIFACT_DIR: artifactDir,
      LOG_LEVEL: 'warn',
      // D-152: also required at module scope; the hosted sign-in these drive.
      CREWAID_EDITION: 'cloud',
      BETTER_AUTH_SECRET: 'transcript-tail-e2e-better-auth-secret-000000',
      BETTER_AUTH_URL: 'http://127.0.0.1:0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out starting the transcript e2e server.\n${stderr}\n${stdout}`));
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
      reject(new Error(`Transcript e2e server exited early (${code}).\n${stderr}\n${stdout}`));
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

/** Pixels between the bottom of what is shown and the bottom of the transcript. */
const gapBelow = (scroller: Locator) =>
  scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

test('the transcript keeps to its newest message, and an older bubble’s footer is whole', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'crewaid-transcript-tail-'));
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
    await expect(page.getByRole('heading', { name: BOT_NAME, exact: true })).toBeVisible();

    // D-144: the approval control is one icon beside "+". Choosing a mode
    // saves it on the bot, so it is still there after a reload.
    const approvals = page.locator('[data-approval-mode]');
    await expect(approvals).toHaveAttribute('aria-label', 'Approvals: Approve for me');
    await approvals.click();
    await page.getByRole('menuitemradio', { name: /Full access/ }).click();
    await expect(approvals).toHaveAttribute('aria-label', 'Approvals: Full access');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-connection-status="connected"]')).toBeVisible();
    await expect(page.locator('[data-approval-mode]')).toHaveAttribute(
      'aria-label',
      'Approvals: Full access',
    );

    const transcript = page.getByRole('region', { name: 'Transcript' });
    const scroller = page.locator('[data-transcript-scroll]');
    const composer = page.getByRole('textbox', { name: `Message ${BOT_NAME}` });

    // Long enough messages that the history overflows the pane, and enough
    // of them that the oldest rows are the lazily rendered kind.
    for (let i = 1; i <= SENDS; i += 1) {
      const lines = Array.from({ length: 9 }, (_, n) => `Message ${i}, line ${n + 1}.`);
      await composer.fill(lines.join('\n'));
      await page.locator('button[aria-label="Send message"]').click();
      await expect(transcript.getByText(REPLY, { exact: true })).toHaveCount(i);
      await expect(page.locator('button[aria-label="Stop generating"]')).toHaveCount(0);
      // Following the tail: the newest reply is in view, at the bottom.
      await expect.poll(() => gapBelow(scroller)).toBeLessThan(2);
    }
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);

    // Leave the conversation and come back: it opens on its newest message.
    await page
      .getByRole('navigation', { name: 'Work' })
      .getByRole('tab', { name: /Tasks/ })
      .click();
    await expect(scroller).toHaveCount(0);
    await page
      .getByRole('navigation', { name: 'Work' })
      .getByRole('tab', { name: 'Crew', exact: true })
      .click();
    // The seeded bot is pinned, so it is the pinned card that opens it.
    await page.getByRole('button', { name: `Open ${BOT_NAME}` }).click();
    await expect(transcript.getByText(REPLY, { exact: true })).toHaveCount(SENDS);
    await expect.poll(() => gapBelow(scroller)).toBeLessThan(2);

    // Content that grows by itself, with nothing new in the conversation —
    // an attachment preview loading, an older row settling to its real
    // height — still leaves the newest message in view.
    const grow = () =>
      page.evaluate(() => {
        const rows = document.querySelectorAll('[data-transcript-content] [data-message]');
        const last = rows[rows.length - 1];
        const block = document.createElement('div');
        block.style.height = '300px';
        last?.appendChild(block);
      });
    await grow();
    await expect.poll(() => gapBelow(scroller)).toBeLessThan(2);

    // Scrolled up to read, the same growth leaves the reader where they are.
    await scroller.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(() => gapBelow(scroller)).toBeGreaterThan(400);
    const before = await gapBelow(scroller);
    await grow();
    await expect.poll(() => gapBelow(scroller)).toBeGreaterThan(before + 250);

    // The oldest bot bubble is a lazily rendered row; its hover footer must
    // sit inside the box that row clips its paint to.
    const oldest = transcript.locator('[data-message-bubble="bot"]').first();
    await oldest.scrollIntoViewIfNeeded();
    await oldest.hover();
    const fit = await oldest.evaluate((bubble) => {
      const row = bubble.closest<HTMLElement>('[class*="content-visibility"]');
      const footer = bubble.parentElement?.querySelector('[data-copy-message]')?.parentElement;
      if (!row || !footer) return { row: row !== null, footer: footer != null, overflow: NaN };
      return {
        row: true,
        footer: true,
        overflow: footer.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom,
      };
    });
    expect(fit.row).toBe(true);
    expect(fit.footer).toBe(true);
    expect(fit.overflow).toBeLessThanOrEqual(0.5);
  } finally {
    await app?.close().catch(() => undefined);
    await stopServer(server);
    await rm(runDir, { recursive: true, force: true });
  }
});
