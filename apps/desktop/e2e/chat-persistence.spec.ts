import { expect, test, type ElectronApplication } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';
import { launchDesktop } from './launchDesktop';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps/orchestrator/scripts/e2e-server.mjs');
const TOKEN = 'm1-qa-05-local-e2e-token';
const BOT_NAME = 'QA-05 Bot';
const REPLY = 'Deterministic stream reply.';

type Ready = { baseUrl: string; botId: string; reply: string; databaseSchema: string };

function startServer(artifactDir: string): Promise<{
  child: ChildProcessWithoutNullStreams;
  ready: Ready;
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for pnpm test:e2e');
  }

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CREWAID_E2E_SESSION_TOKEN: TOKEN,
      ARTIFACT_DIR: artifactDir,
      LOG_LEVEL: 'warn',
      // V1-08: `better-auth.ts` requires both at module scope, so the server
      // entry fails to import without them — and it does so as an unhandled
      // rejection in a spawned child, which surfaces here as a startup
      // timeout rather than as the missing variable it is.
      // D-152: also required at module scope; the hosted sign-in these drive.
      CREWAID_EDITION: 'cloud',
      BETTER_AUTH_SECRET: 'm1-qa-05-e2e-better-auth-secret-0000000000',
      BETTER_AUTH_URL: 'http://127.0.0.1:0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let startupTimeout: Error | undefined;
    const timer = setTimeout(() => {
      startupTimeout = new Error(`Timed out starting M1-QA-05 server.\n${stderr}\n${stdout}`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5_000).unref();
    }, 30_000);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout
        .split(/\r?\n/)
        .find((candidate) => candidate.startsWith('M1_QA_05_READY '));
      if (!line || startupTimeout) return;
      clearTimeout(timer);
      resolve({ child, ready: JSON.parse(line.slice('M1_QA_05_READY '.length)) as Ready });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        startupTimeout ??
          new Error(`M1-QA-05 server exited early (${code}).\n${stderr}\n${stdout}`),
      );
    });
  });
}

async function stopServer(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child) return;
  if (child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }
  }
  if (child.exitCode !== 0) {
    throw new Error(
      `M1-QA-05 server did not cleanly stop (code ${child.exitCode ?? 'none'}, signal ${child.signalCode ?? 'none'})`,
    );
  }
}

/**
 * One reply, streamed into two real windows, and still there after a restart.
 *
 * D-192: the transcript this drives is the TanStack chat client's, so the
 * round trip under test is `POST /bots/:id/chat` and the run log its response
 * reads, with `GET /bots/:id/chat?threadId=` on the restart — not
 * `POST/GET /bots/:id/messages` and the §4.2 message frames. The second window
 * is the part that could only change: it no longer learns the reply from
 * `message.delta`, it joins the same run's durable log after `run.started`
 * announces it (D-188), which is what makes "a window shows a run it did not
 * start" a thing this spec proves rather than a thing the reducer was handed.
 */
test('two Electron windows stream one reply, and restart retains the conversation', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'crewaid-m1-qa-05-'));
  const profileDir = path.join(runDir, 'profile');
  const artifactDir = path.join(runDir, 'artifacts');
  await mkdir(artifactDir, { recursive: true });

  let server: ChildProcessWithoutNullStreams | undefined;
  let app: ElectronApplication | undefined;

  try {
    const started = await startServer(artifactDir);
    server = started.child;
    expect(started.ready.reply).toBe(REPLY);
    expect(started.ready.databaseSchema).toMatch(/^crewaid_e2e_/);

    app = await launchDesktop(profileDir);
    let page = await app.firstWindow();

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

    // Exercise the production File > New Window command. Calling its handler
    // through Electron's application menu keeps this deterministic under Xvfb
    // while still traversing createMainWindow, preload, encrypted credential
    // IPC, the renderer WsClient, and a chat client of its own in each window.
    const secondPagePromise = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('crewaid.new-window');
      if (item === undefined || item === null) throw new Error('New Window menu item is missing');
      Reflect.apply(item.click, item, []);
    });
    const secondPage = await secondPagePromise;
    await expect(secondPage.locator('[data-connection-status="connected"]')).toBeVisible();
    await expect(secondPage.getByRole('heading', { name: BOT_NAME, exact: true })).toBeVisible();

    const firstTranscript = page.getByRole('region', { name: 'Transcript' });
    const secondTranscript = secondPage.getByRole('region', { name: 'Transcript' });
    const userMessage = `Desktop E2E ${Date.now()}`;
    const composer = page.getByRole('textbox', { name: `Message ${BOT_NAME}` });
    await composer.fill(userMessage);
    await page.locator('button[aria-label="Send message"]').click();

    await expect(firstTranscript.getByText(userMessage, { exact: true })).toBeVisible();
    await expect(page.locator('button[aria-label="Stop generating"]')).toBeVisible();
    await expect(firstTranscript).toContainText('Deterministic ');
    await expect(secondTranscript).toContainText('Deterministic ');
    await expect(firstTranscript.getByText(REPLY, { exact: true })).toHaveCount(0);
    await expect(secondTranscript.getByText(REPLY, { exact: true })).toHaveCount(0);
    await expect(firstTranscript.getByText(REPLY, { exact: true })).toBeVisible();
    await expect(secondTranscript.getByText(REPLY, { exact: true })).toBeVisible();
    await expect(page.locator('button[aria-label="Stop generating"]')).toHaveCount(0);
    await expect(page.locator('button[aria-label="Record a voice message"]')).toBeVisible();

    await app.close();
    app = await launchDesktop(profileDir);
    page = await app.firstWindow();

    // No credential setup after restart: the same encrypted Electron profile
    // must reconnect and hydrate the conversation from Postgres by itself.
    await expect(page.locator('[data-connection-status="connected"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: BOT_NAME, exact: true })).toBeVisible();
    const restored = page.getByRole('region', { name: 'Transcript' });
    await expect(restored.getByText(userMessage, { exact: true })).toBeVisible();
    await expect(restored.getByText(REPLY, { exact: true })).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    try {
      await stopServer(server);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }
});
