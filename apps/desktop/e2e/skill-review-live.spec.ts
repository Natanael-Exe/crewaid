import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';
import { launchDesktop } from './launchDesktop';

/**
 * M3-FE-02's live integration leg: the review surface against the REAL
 * M3-BE-09 wire.
 *
 * `skill-review.spec.ts` proves the surface's logic against a stubbed
 * orchestrator — every answer is a fixture the spec invents. This one boots
 * the real orchestrator (the same isolated-schema `e2e-server` the chat spec
 * uses), points the real built app at it, and asserts the flow the reviewer's
 * concern is actually about: view → edit → save → approve → reopen, with
 * every `/skills` call answered by the real controller, the real service and
 * real rows — including the two facts no stub can establish: a save really
 * mints a NEW version row, and the surface really follows the id that row
 * carries.
 *
 * What is seeded, and why not driven for real: the review surface opens from
 * the recording card's ready state, and reaching that through the product
 * needs a live sandbox — `teach a task` wakes the computer and attaches the
 * tee. The e2e harness deliberately owns no desktop (see e2e-server-app: a
 * future spec that needs a real container must fail on a missing member, not
 * read a fake as a running one), so the probe seeds what a completed teach
 * session leaves behind — a RUNNING computer, a READY recording, and the
 * DRAFT skill compiled from it — exactly the rows the server itself writes.
 * ONE request is stubbed: the recording-start tap, which needs the sandbox
 * above; everything after it — the stop that the SEEDED row answers with a
 * real 409, the D-042 re-read that settles the card, the bots list, the
 * socket, every skill route — is the real wire against real rows. The
 * recording-start half of the contract was M3-BE-01's and is proven by the
 * M3-FE-01 suite; the skills half is what this spec exists to join.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps/orchestrator/scripts/e2e-server.mjs');
const ORCHESTRATOR_ROOT = path.join(REPO_ROOT, 'apps/orchestrator');
const TOKEN = 'm3-fe-02-live-token';
const BOT_NAME = 'QA-05 Bot';

// Fixed ids, unique to this spec's schema — the seeded recording and the
// first version of the skill. The id of the version a save creates is NOT
// known up front on purpose: that id is the thing under test.
const RECORDING_ID = 'cnfe02recording000000000001';
const SKILL_ID = 'cnfe02skillv1000000000000001';
const SKILL_NAME = 'open_example_site';
const DESCRIPTION_V1 = 'Opens example.com and clicks once.';
// D-098's summary column: seeded so the live leg asserts the summary the
// review opens on, not only the source behind the developer view. Written as
// the compiler writes it — plain sentences, one per action.
const STEPS_V1 = ['Open Chrome.', 'Go to example.com.', 'Click once.'];
const SCRIPT_V1 = 'export default async function run(ctx) {\n  await ctx.click(10, 20);\n}';
const SCRIPT_V2 =
  'export default async function run(ctx) {\n  await ctx.navigate("https://example.com");\n}';

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
 * Seed what a completed teach session leaves behind, into the server's own
 * isolated schema: the computer running, the recording settled READY, and the
 * DRAFT skill compiled from it (linked through `sourceRecordingId`, which is
 * how `GET /recordings/:id` finds the skill id it reports).
 *
 * Runs through `prisma db execute` rather than a database client of its own:
 * the desktop package owns no Postgres dependency, and the schema name comes
 * from the server's own READY line, so the two processes cannot disagree
 * about where the rows live.
 */
async function seedCompiledDraft(ready: Ready): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required to seed the live spec');

  const schema = ready.databaseSchema;
  if (!/^[a-z0-9_]+$/.test(schema)) {
    throw new Error(`refusing to seed an unexpected schema name: ${schema}`);
  }
  const isolated = new URL(databaseUrl);
  isolated.searchParams.set('schema', schema);

  const s = `"${schema}"`;
  const sql = [
    // D-046: a machine is owned by a user and reached through the bot
    // attached to it, so seeding one is three statements rather than two.
    // The bot usually HAS a machine already — `BotsService.create` attaches
    // one — and this only adds the row when it does not, which is why the
    // insert is guarded on the bot's own attachment rather than on a bot
    // column that no longer exists.
    `INSERT INTO ${s}."Sandbox" (id, "userId", state, "widthPx", "heightPx", "lastStartedAt", "lastActiveAt") ` +
      `SELECT 'cnfe02sandbox0000000000001', b."userId", 'RUNNING', 1280, 800, now(), now() ` +
      `FROM ${s}."Bot" b WHERE b.id = '${ready.botId}' AND b."sandboxId" IS NULL;`,
    `UPDATE ${s}."Bot" SET "sandboxId" = 'cnfe02sandbox0000000000001' ` +
      `WHERE id = '${ready.botId}' AND "sandboxId" IS NULL;`,
    `UPDATE ${s}."Sandbox" SET state = 'RUNNING', "lastStartedAt" = COALESCE("lastStartedAt", now()), "lastActiveAt" = now() ` +
      `WHERE id = (SELECT "sandboxId" FROM ${s}."Bot" WHERE id = '${ready.botId}');`,
    `INSERT INTO ${s}."Recording" (id, "botId", state, "cdpAvailable", warning, error, "startedAt", "endedAt") ` +
      `VALUES ('${RECORDING_ID}', '${ready.botId}', 'READY', false, NULL, NULL, now() - interval '10 minutes', now() - interval '9 minutes');`,
    `INSERT INTO ${s}."Skill" (id, "botId", name, description, "paramsSchema", steps, script, version, status, "sourceRecordingId", "createdAt") ` +
      `VALUES ('${SKILL_ID}', '${ready.botId}', '${SKILL_NAME}', '${DESCRIPTION_V1}', '{"type":"object","properties":{}}'::jsonb, '${JSON.stringify(STEPS_V1)}'::jsonb, $script$${SCRIPT_V1}$script$, 1, 'DRAFT', '${RECORDING_ID}', now());`,
  ].join('\n');

  await new Promise<void>((resolve, reject) => {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const child = spawn(pnpm, ['exec', 'prisma', 'db', 'execute', '--stdin'], {
      cwd: ORCHESTRATOR_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: isolated.toString(),
        MIGRATION_DATABASE_URL: isolated.toString(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seeding the schema failed (exit ${code ?? 'none'}):\n${stderr}`));
    });
    child.stdin.end(sql);
  });
}

/** Assert an answer of the REAL wire, from outside the app. */
async function apiGet<T>(baseUrl: string, route: string): Promise<T> {
  const response = await fetch(`${baseUrl}/api/v1${route}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status, `GET ${route} must answer 2xx`).toBe(200);
  return (await response.json()) as T;
}

async function setUpApp(page: Page, ready: Ready): Promise<void> {
  const saved = await page.evaluate<TokenStoreWriteResult, { baseUrl: string; token: string }>(
    ({ baseUrl, token }) =>
      (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: token,
      }),
    { baseUrl: ready.baseUrl, token: TOKEN },
  );
  expect(saved).toEqual({ status: 'saved' });
  await page.reload();
  await expect(page.locator('[data-connection-status="connected"]')).toBeVisible();
  // The server's bot is `pinned`, so it renders as the pinned card rather
  // than a listbox option — and the app selects it on load (the same fact
  // chat-persistence.spec.ts leans on).
  await expect(page.getByRole('heading', { name: BOT_NAME, exact: true })).toBeVisible();
}

test('view, edit, save, approve and reopen ride the real skills wire end to end', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'crewaid-m3-fe-02-live-'));
  const profileDir = path.join(runDir, 'profile');
  const artifactDir = path.join(runDir, 'artifacts');
  await mkdir(artifactDir, { recursive: true });

  let server: ChildProcessWithoutNullStreams | undefined;
  let app: ElectronApplication | undefined;

  try {
    const started = await startServer(artifactDir);
    server = started.child;
    const { ready } = started;
    await seedCompiledDraft(ready);

    // The seed is a precondition of every assertion below; check it against
    // the wire rather than assuming the SQL landed.
    type BotRow = { id: string; sandbox: { state: string } | null };
    const bots = await apiGet<BotRow[]>(ready.baseUrl, '/bots');
    expect(bots.find((bot) => bot.id === ready.botId)?.sandbox?.state).toBe('RUNNING');

    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();

    // Every /api/v1 call the window makes, recorded for the close-out
    // assertions: these are facts about the REAL wire, not about a stub.
    const wire: Array<{ method: string; path: string; status: number }> = [];
    const patches: Array<{ path: string; body: unknown }> = [];
    let savedId: string | null = null;
    page.on('response', (response) => {
      const { pathname } = new URL(response.url());
      if (!pathname.startsWith('/api/v1/')) return;
      const method = response.request().method();
      wire.push({ method, path: pathname, status: response.status() });
      if (method === 'PATCH' && pathname.startsWith('/api/v1/skills/')) {
        patches.push({ path: pathname, body: JSON.parse(response.request().postData() ?? '{}') });
        void response
          .json()
          .then((body: unknown) => {
            if (typeof body === 'object' && body !== null) {
              const id = (body as { id?: unknown }).id;
              if (typeof id === 'string') savedId = id;
            }
          })
          .catch(() => undefined);
      }
    });

    await setUpApp(page, ready);

    // The recording-start tap is the one stubbed request (see the header):
    // it stands in for the sandbox this harness does not own.
    await page.route('**/api/v1/bots/*/recordings', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ recordingId: RECORDING_ID }),
      }),
    );

    await page.getByRole('button', { name: 'Open QA-05 Bot' }).click();
    await page.getByRole('button', { name: 'View full screen' }).click();
    await page.locator('[data-recording-action="teach"]').click();
    await expect(page.locator('[data-recording-action="stop"]')).toBeVisible();

    // The stop goes to the REAL server, which refuses it — the seeded row is
    // READY, not RECORDING — and the renderer's D-042 re-read settles the
    // card from the real row instead of guessing which side won.
    await page.locator('[data-recording-action="stop"]').click();
    await expect(page.locator('[data-recording-phase="ready"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-recording-message]')).toContainText('Draft skill is ready.');

    // ── View: the draft the seeded server row describes ─────────────────────
    await page.locator('[data-recording-action="review"]').click();
    const dialog = page.getByRole('dialog', { name: 'Review skill' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-skill-status="DRAFT"]')).toBeVisible();
    await expect(page.locator('[data-skill-version="1"]')).toBeVisible();
    // D-098: the row's `steps` are what the review opens on, read over the
    // real wire — the summary, not the script.
    await expect(page.locator('[data-skill-steps]')).toContainText('Go to example.com.');
    await expect(page.locator('[data-skill-source]')).toContainText('ctx.click(10, 20)');

    // ── Edit + save: the wire's answer is a NEW row, and the surface adopts it
    await page.locator('[data-skill-action="edit"]').click();
    // The raw editor is the developer path (D-098): the surface's primary edit
    // is a sentence, and getting at the source means opening the disclosure —
    // which is also the gesture a person makes.
    await page.locator('[data-skill-developer] summary').click();
    await page.locator('[data-skill-script-editor]').fill(SCRIPT_V2);
    await page.locator('[data-skill-action="save"]').click();
    await expect(page.locator('[data-skill-version="2"]')).toBeVisible();
    await expect(page.getByText('Saved as v2.')).toBeVisible();
    await expect(page.locator('[data-skill-status="DRAFT"]')).toBeVisible();

    // ── Approve: posted to the id the save ANSWERED with, never the opened one
    await page.locator('[data-skill-action="approve"]').click();
    await expect(page.locator('[data-skill-status="APPROVED"]')).toBeVisible();
    await expect(page.getByText('Skill approved.')).toBeVisible();
    await expect(page.locator('[data-skill-action="approve"]')).toHaveCount(0);

    // ── Reopen: the card followed the new row, so the review loads it ───────
    await page.locator('[data-skill-action="close"]').click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'View full screen' }).click();
    await page.locator('[data-recording-action="review"]').click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-skill-version="2"]')).toBeVisible();
    await expect(page.locator('[data-skill-status="APPROVED"]')).toBeVisible();
    await expect(page.locator('[data-skill-source]')).toContainText('ctx.navigate');
    await expect(page.locator('[data-skill-source]')).not.toContainText('ctx.click');

    // ── The wire, as it actually happened ────────────────────────────────────
    expect(wire).toContainEqual({
      method: 'POST',
      path: `/api/v1/recordings/${RECORDING_ID}/stop`,
      status: 409,
    });
    expect(wire).toContainEqual({
      method: 'GET',
      path: `/api/v1/recordings/${RECORDING_ID}`,
      status: 200,
    });
    // The edit went to the version that was open, and carried only the field
    // that changed — nothing was sent for the untouched description.
    expect(patches).toEqual([{ path: `/api/v1/skills/${SKILL_ID}`, body: { script: SCRIPT_V2 } }]);
    expect(wire).toContainEqual({
      method: 'PATCH',
      path: `/api/v1/skills/${SKILL_ID}`,
      status: 200,
    });

    await expect.poll(() => savedId).not.toBeNull();
    if (savedId === null) throw new Error('the save never answered with its new row');
    const v2Id: string = savedId;
    expect(v2Id).not.toBe(SKILL_ID);
    expect(patches[0]?.path).toBe(`/api/v1/skills/${SKILL_ID}`);
    expect(wire).toContainEqual({
      method: 'POST',
      path: `/api/v1/skills/${v2Id}/approve`,
      status: 200,
    });
    // Exactly two reads: the version opened, and the version reopened.
    expect(
      wire.filter((call) => call.method === 'GET' && call.path.startsWith('/api/v1/skills/')),
    ).toEqual([
      { method: 'GET', path: `/api/v1/skills/${SKILL_ID}`, status: 200 },
      { method: 'GET', path: `/api/v1/skills/${v2Id}`, status: 200 },
    ]);

    // ── Standalone reads of the real rows: the state the UI left behind ─────
    type SkillRow = {
      id: string;
      version: number;
      status: string;
      script: string;
      description: string;
    };
    const v1 = await apiGet<SkillRow>(ready.baseUrl, `/skills/${SKILL_ID}`);
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('DRAFT');
    expect(v1.script).toBe(SCRIPT_V1);

    const v2 = await apiGet<SkillRow>(ready.baseUrl, `/skills/${v2Id}`);
    expect(v2.id).toBe(v2Id);
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('APPROVED');
    expect(v2.script).toBe(SCRIPT_V2);
    // The un-edited field was carried from the version the save started on.
    expect(v2.description).toBe(DESCRIPTION_V1);
  } finally {
    if (app !== undefined) await app.close();
    try {
      await stopServer(server);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }
});
