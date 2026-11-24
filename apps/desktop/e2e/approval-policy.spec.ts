import { MemoryResponseSchema } from '@crewaid/shared';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';
import { launchDesktop } from './launchDesktop';
import { tokenColor } from './themeTokens';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps/orchestrator/scripts/e2e-server.mjs');
const TOKEN = 'approval-policy-local-e2e-token';
const BOT_NAME = 'QA-05 Bot';
/** The operator's wording, which the model never proposed. */
const EDITED_FACT = 'The staging site is staging-edited.example.test';

type Ready = {
  baseUrl: string;
  botId: string;
  databaseSchema: string;
  approvalFact?: string;
  approvalReply?: string;
};

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
      // The bot answers with a `remember` call and is set to "Ask for
      // approval", so the prompt below is the server policy's decision.
      CREWAID_E2E_APPROVAL_TOOL: '1',
      ARTIFACT_DIR: artifactDir,
      LOG_LEVEL: 'warn',
      // Required at module scope by `better-auth.ts` and D-152; without them
      // the child dies on import and this reads as a startup timeout.
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
      startupTimeout = new Error(`Timed out starting the approval server.\n${stderr}\n${stdout}`);
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
          new Error(`The approval server exited early (${code}).\n${stderr}\n${stdout}`),
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
      `The approval server did not cleanly stop (code ${child.exitCode ?? 'none'}, signal ${child.signalCode ?? 'none'})`,
    );
  }
}

/** What the server remembers for this bot, read the way the desktop's Memory view reads it. */
async function rememberedTexts(baseUrl: string, botId: string): Promise<string[]> {
  const url = new URL('/api/v1/memory', baseUrl);
  url.searchParams.set('botId', botId);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(response.status).toBe(200);
  return MemoryResponseSchema.parse(await response.json()).rows.map((row) => row.text);
}

/**
 * An approval on a real orchestrator and a TanStack thread: the operator edits
 * what the bot asked to do, approves it, and the edit is what runs — and a
 * second window open on the same bot stops asking once the first has answered.
 *
 * D-192 made an approval one of the chat client's bound `crewaid.tool-approval`
 * interrupts: it arrives in the run's own stream (or a hydrate's `interrupts`)
 * and is answered with `resolveInterrupt`, which resumes the run over
 * `POST /bots/:id/chat`. Nothing here is stubbed but the model — the
 * deterministic adapter calls `remember`, the bot's "Ask for approval" mode is
 * what turns that into a prompt, and `remember` writes to the orchestrator's
 * own database, so its effect is observable without a computer. A fixtured
 * interrupt would test the fixture: the wire record carries binding hashes the
 * engine mints from the definition's schemas, and the renderer narrows on them.
 *
 * The identity-scoped variant of the prompt (a named login's warning, and no
 * edit option) needs a seat on a running computer, which this harness does not
 * own; `test/approvalPrompt.test.tsx` covers how it renders.
 */
for (const reloadBeforeApproval of [false, true]) {
  test(`an edited reasoning approval runs after retry (reload: ${reloadBeforeApproval})`, async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'crewaid-approval-policy-'));
    const profileDir = path.join(runDir, 'profile');
    const artifactDir = path.join(runDir, 'artifacts');
    await mkdir(artifactDir, { recursive: true });

    let server: ChildProcessWithoutNullStreams | undefined;
    let app: ElectronApplication | undefined;

    try {
      const started = await startServer(artifactDir);
      server = started.child;
      const { baseUrl, botId, approvalFact, approvalReply } = started.ready;
      // The switch reached the server: without it the bot just replies, no
      // prompt ever appears, and every wait below would time out saying nothing.
      expect(approvalFact).toBeDefined();
      expect(approvalReply).toBeDefined();
      expect(approvalFact).not.toBe(EDITED_FACT);

      app = await launchDesktop(profileDir);
      const first = await app.firstWindow();
      const saved = await first.evaluate<TokenStoreWriteResult, { baseUrl: string; token: string }>(
        ({ baseUrl, token }) => {
          // The Settings switch "Show bot work", set before the reload reads it:
          // a tool row is the bot's work, hidden by default, and the last check
          // below reads one. Every window of this profile shares the setting.
          window.localStorage.setItem('crewaid.transcript.showBotWork', 'true');
          return (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
            orchestratorBaseUrl: baseUrl,
            orchestratorToken: token,
          });
        },
        { baseUrl, token: TOKEN },
      );
      expect(saved).toEqual({ status: 'saved' });
      await first.reload();
      await expect(first.locator('[data-connection-status="connected"]')).toBeVisible();
      await expect(first.getByRole('heading', { name: BOT_NAME, exact: true })).toBeVisible();

      // A second window through the production File > New Window command, with a
      // chat client of its own. It starts nothing: whatever it shows of this run
      // it learns from the server, which is the point of the second claim.
      const secondPromise = app.waitForEvent('window');
      await app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('crewaid.new-window');
        if (item === undefined || item === null) throw new Error('New Window menu item is missing');
        Reflect.apply(item.click, item, []);
      });
      const second = await secondPromise;
      await expect(second.locator('[data-connection-status="connected"]')).toBeVisible();
      await expect(second.getByRole('heading', { name: BOT_NAME, exact: true })).toBeVisible();

      // Nothing is remembered before anyone approves: an "ask" that ran the
      // call first and asked afterwards would pass every check after this one.
      expect(await rememberedTexts(baseUrl, botId)).toEqual([]);

      const composer = first.getByRole('textbox', { name: `Message ${BOT_NAME}` });
      await composer.fill('Please remember where staging lives.');
      await first.locator('button[aria-label="Send message"]').click();

      const prompt = (page: Page) => page.locator('[data-approval-prompt]');
      const approve = (page: Page) => page.getByRole('button', { name: 'Approve remember' });
      // Both windows ask. The second one asking is what makes "it stops asking"
      // below a claim rather than a window that never knew.
      await expect(prompt(first)).toHaveCount(1);
      await expect(prompt(second)).toHaveCount(1);
      await expect(approve(second)).toBeVisible();
      expect(await rememberedTexts(baseUrl, botId)).toEqual([]);

      await first.emulateMedia({ colorScheme: 'light' });
      await expect(first.locator('html')).toHaveAttribute('data-theme', 'crewaid');
      await expect(prompt(first)).toHaveCSS(
        'background-color',
        await tokenColor(first, '--approval-pending-background'),
      );
      const decline = first.getByRole('button', { name: 'Decline remember' });
      await expect(decline).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(approve(first)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(approve(first)).toHaveCSS('color', 'rgb(0, 0, 0)');
      if (process.env['CC79_CAPTURE'] === '1')
        await first.screenshot({
          path: path.resolve('../../.artifacts/cc79/pending-action-light.png'),
        });
      await first.emulateMedia({ colorScheme: 'dark' });
      await expect(first.locator('html')).toHaveAttribute('data-theme', 'crewaid-dark');
      await expect(prompt(first)).toHaveCSS(
        'background-color',
        await tokenColor(first, '--approval-pending-background'),
      );
      await expect(decline).toHaveCSS('color', 'rgb(255, 255, 255)');
      if (process.env['CC79_CAPTURE'] === '1')
        await first.screenshot({
          path: path.resolve('../../.artifacts/cc79/pending-action-night.png'),
        });
      await first.emulateMedia({ colorScheme: 'light' });

      if (reloadBeforeApproval) {
        await first.reload();
        await expect(prompt(first)).toHaveCount(1);
      }

      await prompt(first).getByRole('button', { name: 'Details', exact: true }).click();
      // The input is react-aria's visually hidden one; a person clicks the label.
      await prompt(first).getByText('Edit arguments before approving').click();
      await expect(
        prompt(first).getByRole('checkbox', { name: 'Edit arguments before approving' }),
      ).toBeChecked();
      const input = first.getByLabel('Approval arguments as JSON');
      // The editor opens on the arguments the policy reviewed, so what the
      // operator edits is what they were asked about.
      const proposed = JSON.parse(await input.inputValue()) as Record<string, unknown>;
      expect(proposed['fact']).toBe(approvalFact);

      // Malformed JSON cannot be approved: the alternative is approving the
      // model's arguments while the operator believes their edit went with it.
      await input.fill('{');
      await expect(approve(first)).toBeDisabled();
      await expect(first.getByRole('alert')).toContainText('Enter valid JSON');

      await input.fill(JSON.stringify({ ...proposed, fact: EDITED_FACT }, null, 2));
      // A rejected submission must settle the client and offer the same
      // decision again. The real approval remains pending on the server.
      await first.route('**/chat', async (route) => {
        if (route.request().method() === 'POST')
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: '{"code":"REJECTED_FOR_TEST"}',
          });
        else await route.continue();
      });
      await approve(first).click();
      await expect(prompt(first)).toHaveAttribute('data-approval-answered', 'no');
      await expect(
        first.getByText('Your answer could not be sent. Try again.', { exact: true }),
      ).toBeVisible();
      await expect(approve(first)).toBeVisible();
      expect(await rememberedTexts(baseUrl, botId)).toEqual([]);
      await first.unroute('**/chat');

      const resumed = first.waitForResponse(
        (response) => response.url().endsWith('/chat') && response.request().method() === 'POST',
      );
      await approve(first).click();
      const response = await resumed;
      expect(response.status(), response.status() === 200 ? '' : await response.text()).toBe(200);

      // The resumed run finishes with the bot's closing text, in both windows:
      // the second learns of the continuation from `run.started`, not from the
      // first window.
      const firstTranscript = first.getByRole('region', { name: 'Transcript' });
      const secondTranscript = second.getByRole('region', { name: 'Transcript' });
      await expect(firstTranscript.getByText(approvalReply!, { exact: true })).toBeVisible();
      await expect(secondTranscript.getByText(approvalReply!, { exact: true })).toBeVisible();

      // The answered question is gone from the window that answered it and from
      // the one that did not. A prompt left standing in the second window is an
      // invitation to answer a call that has already run.
      await expect(prompt(first)).toHaveCount(0);
      await expect(prompt(second)).toHaveCount(0);

      // The edit is what ran. The server holds the operator's wording and not
      // the model's — an approval that dropped `editedArgs` on the way would
      // remember the proposal and still show every sign of success above.
      expect(await rememberedTexts(baseUrl, botId)).toEqual([EDITED_FACT]);
      // And the transcript says so: the call's row reports the result the tool
      // returned for the arguments it was given. The row's own arguments are
      // the model's call as it was made, so the result is the honest place to
      // read what ran.
      const row = firstTranscript.locator('[data-tool-call="remember"]');
      await expect(row).toHaveAttribute('data-tool-status', 'ok');
      await expect(row).toContainText(`Remembered: ${EDITED_FACT}`);

      // A later turn with reasoning must also send normally. Declining its
      // new question must not resurrect the answered card or repeat the write.
      await composer.fill('Please remember another staging fact.');
      await first.locator('button[aria-label="Send message"]').click();
      await expect(prompt(first)).toHaveCount(1);
      await first.getByRole('button', { name: 'Decline remember' }).click();
      await expect(prompt(first)).toHaveCount(0);
      await expect(prompt(second)).toHaveCount(0);
      expect(await rememberedTexts(baseUrl, botId)).toEqual([EDITED_FACT]);
    } finally {
      await app?.close().catch(() => undefined);
      try {
        await stopServer(server);
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    }
  });
}
