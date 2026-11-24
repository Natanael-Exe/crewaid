import { decodeScreenInputFrame, stampWireVersion, ServerFrameSchema } from '@crewaid/shared';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './launchDesktop';
import { tokenColor } from './themeTokens';
import { routeChat, routeScreenStream } from './stubChat';
import { startStubAuthServer, type StubAuthServer } from './stubAuthServer';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';

/**
 * M3-FE-02 — reviewing the draft a recording compiled: view the source, edit
 * it, approve it.
 *
 * Driven through the REAL built app, with only the orchestrator stubbed at the
 * network boundary (the same trade `computer-wake.spec.ts` makes): every claim
 * here is about what the window does with an answer — a version badge that
 * reads the save's response rather than predicting it, a save whose answer (a
 * NEW version row) every later action and the recording card follow, a draft
 * that says it cannot run, an approval that flips the standing — and a unit
 * test cannot stand in for those because the review surface only exists as a
 * mounted portal. The WebSocket is deliberately not stubbed: nothing in this
 * flow needs it, which is itself the thing to prove.
 *
 * D-192: the conversation comes from
 * `GET /bots/:id/chat`. The review opens from the rail and the full-screen
 * viewer, both of which belong to a bot whose conversation is on screen — a
 * thread the renderer cannot read takes the centre pane and the rail with it.
 */

const BOT_ID = 'bot_review_01';
const RECORDING_ID = 'rec_review_01';
const SKILL_ID = 'skl_review_01';

function bot(): Record<string, unknown> {
  return {
    id: BOT_ID,
    userId: 'usr_crewaid_singleton_v1',
    name: 'Quill',
    role: 'Researcher',
    avatarColor: '#4c6ef5',
    avatarShape: null,
    avatarUrl: null,
    systemPrompt: 'You research things.',
    modelId: 'default',
    status: 'IDLE',
    sortOrder: 0,
    pinned: false,
    hiddenFromSidebar: false,
    autoReviewRules: [],
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    // D-046: the bot's side of the attachment, required by BotSchema.
    sandboxId: 'sbx_review_01',
    // Post-M3-BE-10 every bot owns a provisioned computer; RUNNING makes the
    // full-screen viewer — where the teaching cluster lives — expandable.
    sandbox: {
      id: 'sbx_review_01',
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
    // D-191: every row names its thread, and a row without one fails the
    // `GET /bots` parse — the sidebar is then empty and nothing can be clicked.
    thread: { id: 'cuid-thread-1', preview: null },
  };
}

function skill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SKILL_ID,
    botId: BOT_ID,
    name: 'open_example_site',
    description: 'Opens example.com and screenshots it.',
    paramsSchema: { type: 'object', properties: {} },
    // D-098: the summary the review opens on; the source is behind the
    // developer view now.
    steps: ['Open Chrome.', 'Go to example.com.', 'Take a screenshot.'],
    script: 'export default async function run(ctx) { await ctx.click(10, 20); }',
    version: 1,
    status: 'DRAFT',
    sourceRecordingId: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  };
}

function recordingStatus(state: string, skillId: string | null): Record<string, unknown> {
  return {
    id: RECORDING_ID,
    state,
    intent: null,
    cdpAvailable: false,
    warning: null,
    error: null,
    counts: { x11: 9, cdp: 0, atspi: 0 },
    skillId,
  };
}

/**
 * @param picture What the bot's screen stream shows; none holds the viewer in
 *   its connecting state, the interval a RUNNING row spends before its first
 *   picture.
 */
async function setUp(
  page: Page,
  picture: Uint8Array | null = null,
): Promise<{ readonly opened: () => number }> {
  await page.route('**/api/v1/bots', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([bot()]) }),
  );
  await routeChat(page);
  const streams = await routeScreenStream(page, picture);

  const saved = await page.evaluate<TokenStoreWriteResult, string>(
    (baseUrl) =>
      (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'skill-review-token',
      }),
    stubAuth.baseUrl,
  );
  expect(saved.status).toBe('saved');
  await page.reload();
  await expect(page.getByRole('option', { name: /Quill/ })).toBeVisible();
  // The conversation opened rather than `ThreadNotice`: the rail these tests
  // drive is mounted beside a transcript.
  await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
  return streams;
}

/** The stubs every review test needs: a draft compiles at the end of a stop. */
async function stubRecording(page: Page): Promise<void> {
  await page.route('**/api/v1/bots/*/recordings', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ recordingId: RECORDING_ID }),
    }),
  );
  await page.route('**/api/v1/recordings/*/stop', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(recordingStatus('READY', SKILL_ID)),
    }),
  );
}

/** Teach a task, stop it, and open the review of the draft it compiled. */
async function compileAndOpenReview(page: Page): Promise<void> {
  // A RUNNING row arrives before its first RFB update in this harness, which
  // is the same interval a fast bot switch exposes in the product. Keep that
  // interval labelled, and make the whole thumbnail an obvious pointer target.
  await expect(page.locator('[data-screen-loading="true"]')).toContainText('Connecting to display');
  const open = page.getByRole('button', { name: 'View full screen' });
  await expect(open).toHaveCSS('cursor', 'pointer');
  const [overlayBounds, screenBounds] = await Promise.all([
    open.boundingBox(),
    open.locator('..').boundingBox(),
  ]);
  expect(overlayBounds).not.toBeNull();
  expect(screenBounds).not.toBeNull();
  expect(Math.abs(overlayBounds!.width - screenBounds!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(overlayBounds!.height - screenBounds!.height)).toBeLessThanOrEqual(1);
  await open.hover();
  const label = page.locator('[data-screen-open-label="true"]');
  await expect(label).toHaveCSS('opacity', '1');

  // Pressed, without letting go: the overlay must not change shape. It used to
  // be a HeroUI `Button`, whose base style answers a press with
  // `transform: scale(0.97)` — three percent of a whole screen, corners
  // included, and `getBoundingClientRect` reports it. The feedback is the
  // label's opacity instead, which moves no geometry.
  //
  // The first frame can settle the card under the pointer between hover
  // and press. Cancel a missed press before retrying, so this still checks
  // genuine active feedback without accidentally opening the viewer.
  let beforePressBounds = overlayBounds;
  await expect(async () => {
    await open.hover();
    beforePressBounds = await open.boundingBox();
    await page.mouse.down();
    try {
      await expect(label).toHaveCSS('opacity', '0.8', { timeout: 750 });
    } catch (error) {
      await page.mouse.move(0, 0);
      await page.mouse.up();
      throw error;
    }
  }).toPass({ timeout: 8_000 });
  const pressedBounds = await open.boundingBox();
  expect(pressedBounds).not.toBeNull();
  expect(beforePressBounds).not.toBeNull();
  expect(Math.abs(pressedBounds!.width - beforePressBounds!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(pressedBounds!.height - beforePressBounds!.height)).toBeLessThanOrEqual(1);
  await page.mouse.up();

  // The release is the click: the overlay is one big hit area, so pressing and
  // letting go has to have opened the full-screen view.
  await expect(page.locator('[data-screen-surface="fullscreen"]')).toBeVisible();
  await page.locator('[data-recording-action="teach"]').click();
  await page.locator('[data-recording-action="stop"]').click();
  await expect(page.locator('[data-recording-phase="ready"]')).toBeVisible();
  await expect(page.locator('[data-recording-message]')).toContainText('Draft skill is ready.');
  await page.locator('[data-recording-action="review"]').click();
  // The viewer collapses first — one overlay at a time.
  await expect(page.locator('[data-screen-surface="rail"]')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Review skill' })).toBeVisible();
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

test('a compiled draft is reviewed, edited, saved and approved — and a save switches to the new version row', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-fe02-review-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();

    const EDITED = 'export default async () => 2;';
    const SKILL_V2 = 'skl_review_02';
    let patched: unknown = null;
    let patchedPath = '';
    let approvePath = '';
    const readPaths: string[] = [];
    await setUp(page);
    await stubRecording(page);
    // The approve URL needs its own pattern — `skills/*` cannot reach a
    // second path segment — and it is where "the surface switched to the row
    // the save answered with" becomes observable.
    await page.route('**/api/v1/skills/*/approve', (route) => {
      approvePath = new URL(route.request().url()).pathname;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          skill({ id: SKILL_V2, version: 2, script: EDITED, status: 'APPROVED' }),
        ),
      });
    });
    await page.route('**/api/v1/skills/*', (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'PATCH') {
        patched = JSON.parse(request.postData() ?? '{}');
        patchedPath = path;
        // The contract's save answer: a NEW row — new id, bumped version,
        // back to DRAFT (approval never carries over).
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(skill({ id: SKILL_V2, version: 2, script: EDITED })),
        });
      }
      readPaths.push(path);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          path.endsWith(SKILL_V2)
            ? skill({ id: SKILL_V2, version: 2, script: EDITED, status: 'APPROVED' })
            : skill(),
        ),
      });
    });

    await compileAndOpenReview(page);

    // Viewing: what the skill does, the standing, and the version the server
    // sent — with the source behind the developer view (D-098).
    await expect(page.locator('[data-skill-status="DRAFT"]')).toBeVisible();
    await expect(page.locator('[data-skill-version="1"]')).toBeVisible();
    await expect(page.getByText('This draft cannot run until it is approved.')).toBeVisible();
    await expect(page.locator('[data-skill-steps]')).toContainText('Go to example.com.');
    await expect(page.locator('[data-skill-developer]')).toBeVisible();
    await expect(page.locator('[data-skill-source]')).toContainText('ctx.click(10, 20)');
    await expect(page.locator('[data-skill-action="save"]')).toHaveCount(0);

    // Editing: the raw source becomes an editor inside the developer view, and
    // saving lands a new version.
    await page.locator('[data-skill-action="edit"]').click();
    await page
      .locator('[data-skill-developer]')
      .getByRole('button', { name: 'Developer view', exact: true })
      .click();
    await page.locator('[data-skill-script-editor]').fill(EDITED);
    await page.locator('[data-skill-action="save"]').click();

    await expect(page.locator('[data-skill-version="2"]')).toBeVisible();
    await expect(page.getByText('Saved as v2.')).toBeVisible();
    expect(patched).toEqual({ script: EDITED });
    // The edit itself goes to the version that was open, never a predicted one.
    expect(patchedPath).toBe(`/api/v1/skills/${SKILL_ID}`);
    // A fresh version is a draft again — nothing carries the old approval.
    await expect(page.locator('[data-skill-status="DRAFT"]')).toBeVisible();

    // Approving: the standing flips, and the action went to the row the save
    // answered with — the id in that response, never the one we opened with.
    await page.locator('[data-skill-action="approve"]').click();
    await expect(page.locator('[data-skill-status="APPROVED"]')).toBeVisible();
    await expect(page.getByText('Approved — this skill can run.')).toBeVisible();
    await expect(page.getByText('Skill approved.')).toBeVisible();
    await expect(page.locator('[data-skill-action="approve"]')).toHaveCount(0);
    expect(approvePath).toBe(`/api/v1/skills/${SKILL_V2}/approve`);

    // Closing and reopening: the recording card followed the new row too, so
    // the review opens on the current version — not the superseded script.
    await page.locator('[data-skill-action="close"]').click();
    await expect(page.getByRole('dialog', { name: 'Review skill' })).toHaveCount(0);

    await page.getByRole('button', { name: 'View full screen' }).click();
    await page.locator('[data-recording-action="review"]').click();
    await expect(page.getByRole('dialog', { name: 'Review skill' })).toBeVisible();
    await expect(page.locator('[data-skill-version="2"]')).toBeVisible();
    await expect(page.locator('[data-skill-status="APPROVED"]')).toBeVisible();
    await expect(page.locator('[data-skill-source]')).toContainText('=> 2;');
    await expect(page.locator('[data-skill-source]')).not.toContainText('ctx.click(10, 20)');
    expect(readPaths).toEqual([`/api/v1/skills/${SKILL_ID}`, `/api/v1/skills/${SKILL_V2}`]);

    // Closing: the review leaves nothing behind.
    await page.locator('[data-skill-action="close"]').click();
    await expect(page.getByRole('dialog', { name: 'Review skill' })).toHaveCount(0);
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('a plain-language change is compiled into the next version (D-098)', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-d098-revise-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();

    const SKILL_V2 = 'skl_revise_02';
    const REVISED_STEPS = ['Open Firefox.', 'Go to example.com.'];
    let sent: unknown = null;
    let revisePath = '';
    let releaseRevision!: () => void;
    const revisionPending = new Promise<void>((resolve) => {
      releaseRevision = resolve;
    });
    await setUp(page);
    await stubRecording(page);
    // Registered before the generic skills route; Playwright checks the most
    // recent registration first, and `skills/*` cannot reach a second segment.
    await page.route('**/api/v1/skills/*/revise', async (route) => {
      revisePath = new URL(route.request().url()).pathname;
      sent = JSON.parse(route.request().postData() ?? '{}');
      await revisionPending;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          skill({
            id: SKILL_V2,
            version: 2,
            description: 'Opens example.com with Firefox.',
            steps: REVISED_STEPS,
          }),
        ),
      });
    });
    await page.route('**/api/v1/skills/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(skill()),
      }),
    );

    await compileAndOpenReview(page);

    // The default edit is a sentence, and the response — a new version row —
    // is what the surface adopts.
    await page.locator('[data-skill-action="edit"]').click();
    await page.locator('[data-skill-instruction]').fill('Use Firefox instead of Chrome.');
    await page.locator('[data-skill-action="revise"]').click();

    await expect(page.locator('[data-skill-action="revise"]')).toHaveText('Updating…');
    await expect(page.locator('[data-skill-action="cancel"]')).toBeDisabled();
    await expect(page.locator('[data-skill-action="close"]')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Review skill' })).toBeVisible();
    releaseRevision();

    await expect(page.locator('[data-skill-version="2"]')).toBeVisible();
    await expect(page.getByText('Updated as v2.')).toBeVisible();
    await expect(page.locator('[data-skill-steps]')).toContainText('Open Firefox.');

    // The wire: the sentence and nothing else, posted to the version that was
    // open — never a script, and never a predicted id.
    expect(sent).toEqual({ instruction: 'Use Firefox instead of Chrome.' });
    expect(revisePath).toBe(`/api/v1/skills/${SKILL_ID}/revise`);
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('a finished draft is thrown away atomically with its recording (D-098)', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-d098-discard-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();

    const calls: string[] = [];
    await setUp(page);
    await stubRecording(page);
    await page.route('**/api/v1/skills/*', (route) => {
      const method = route.request().method();
      calls.push(`${method} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(skill()),
      });
    });
    await page.route('**/api/v1/recordings/*/discard', (route) => {
      calls.push(`POST ${new URL(route.request().url()).pathname}`);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(recordingStatus('DISCARDED', null)),
      });
    });

    await compileAndOpenReview(page);

    // The press lives on the recording card, behind the review.
    await page.locator('[data-skill-action="close"]').click();
    await expect(page.getByRole('dialog', { name: 'Review skill' })).toHaveCount(0);
    await page.getByRole('button', { name: 'View full screen' }).click();
    await page.locator('[data-recording-action="discard"]').click();

    // The server owns both halves so a compile finishing at the same time
    // cannot leave a draft behind after the card disappears.
    await expect(page.locator('[data-recording-phase="ready"]')).toHaveCount(0);
    expect(calls).toEqual([
      `GET /api/v1/skills/${SKILL_ID}`,
      `POST /api/v1/recordings/${RECORDING_ID}/discard`,
    ]);
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('a review survives a missing skill and a refused approval', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-fe02-refusals-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();

    let reads = 0;
    await setUp(page);
    await stubRecording(page);
    await page.route('**/api/v1/skills/*/approve', (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: '{"code":"CONFLICT"}' }),
    );
    await page.route('**/api/v1/skills/*', (route) => {
      reads += 1;
      if (reads === 1) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(skill()),
      });
    });

    await compileAndOpenReview(page);

    // The read failed: normalized copy, never the wire body, and one retry.
    await expect(page.getByText('This skill no longer exists.')).toBeVisible();
    await page.locator('[data-skill-action="retry"]').click();
    await expect(page.locator('[data-skill-status="DRAFT"]')).toBeVisible();

    // The approval is refused as stale: the standing does NOT move and the
    // operator is told why rather than shown a success.
    await page.locator('[data-skill-action="approve"]').click();
    await expect(
      page.getByText('The skill changed on the server. Reopen it to see its current state.'),
    ).toBeVisible();
    await expect(page.locator('[data-skill-status="DRAFT"]')).toBeVisible();
    await expect(page.locator('[data-skill-action="approve"]')).toBeVisible();
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('teaching controls preserve the live canvas and mouse movement without a refocus click', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-teaching-focus-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    await app.evaluate(({ app }) => app.focus({ steal: true }));
    const inputs: Uint8Array[] = [];
    let subscriptions = 0;
    await page.routeWebSocket('**/ws?*', (ws) => {
      ws.onMessage((message) => {
        if (typeof message !== 'string') {
          const decoded = decodeScreenInputFrame(new Uint8Array(message));
          if (decoded.ok) inputs.push(decoded.frame.rfb);
          return;
        }
        const frame = JSON.parse(message) as { type: string; payload?: { action?: string } };
        if (frame.type === 'screen.control') {
          const held = frame.payload?.action !== 'release';
          ws.send(
            JSON.stringify(
              ServerFrameSchema.parse(
                stampWireVersion({
                  id: randomUUID(),
                  type: 'screen.control.state',
                  botId: BOT_ID,
                  ts: Date.now(),
                  payload: held
                    ? {
                        botId: BOT_ID,
                        mode: 'human',
                        holder: 'self',
                        epoch: 1,
                        observationRequired: true,
                        leaseExpiresAt: Date.now() + 30000,
                      }
                    : {
                        botId: BOT_ID,
                        mode: 'agent',
                        holder: null,
                        epoch: 2,
                        observationRequired: true,
                      },
                }),
              ),
            ),
          );
          return;
        }
        if (frame.type !== 'screen.subscribe') return;
        subscriptions += 1;
      });
    });
    // A whole-screen Tight fill on the bot's stream, decoded by real noVNC.
    // No browser mocks.
    const fill = Buffer.alloc(20);
    fill.writeUInt16BE(1, 2);
    fill.writeUInt16BE(1280, 8);
    fill.writeUInt16BE(800, 10);
    fill.writeInt32BE(7, 12);
    fill[16] = 0x8f;
    fill[17] = 120;
    fill[18] = 180;
    fill[19] = 220;
    await stubRecording(page);
    const streams = await setUp(page, fill);
    await expect(page.locator('[data-screen-loading]')).toHaveCount(0);
    await page.getByRole('button', { name: 'View full screen' }).click();
    const canvas = page.locator('[data-screen-state="live"] canvas');
    // Expanding is still observing; only an acknowledged control grant may drive.
    await page.mouse.move(150, 200);
    expect(inputs).toHaveLength(0);
    await page.getByRole('button', { name: 'Take control' }).click();
    await expect(page.getByRole('button', { name: 'Hand back' })).toBeVisible();
    await expect(canvas).toBeFocused();
    const original = await canvas.elementHandle();
    const beforeTeaching = subscriptions;
    const streamsBeforeTeaching = streams.opened();
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    const moveWithoutClick = async () => {
      const before = inputs.filter((input) => input[0] === 5).length;
      await page.mouse.move(bounds!.x + 90, bounds!.y + 100);
      await page.mouse.move(bounds!.x + 180, bounds!.y + 150, { steps: 3 });
      await expect
        .poll(() => inputs.filter((input) => input[0] === 5).length)
        .toBeGreaterThan(before);
    };
    // Taking control must leave the same canvas interactive without needing
    // another click to repair its blur/refocus cycle.
    await moveWithoutClick();
    await page.locator('[data-recording-action="teach"]').click();
    await expect(page.locator('[data-recording-phase="recording"]')).toBeVisible();
    await expect(
      page.locator('[data-recording-phase="recording"] span').filter({ hasText: 'Recording' }),
    ).toHaveCSS('color', await tokenColor(page, '--foreground', 'color'));
    await moveWithoutClick();
    await page.locator('[data-recording-action="stop"]').click();
    await expect(page.locator('[data-recording-phase="ready"]')).toBeVisible();
    await moveWithoutClick();
    expect(await canvas.evaluate((current, first) => current === first, original)).toBe(true);
    expect(subscriptions).toBe(beforeTeaching);
    // Teaching is a presentation change: the same stream, never a reconnect.
    expect(streams.opened()).toBe(streamsBeforeTeaching);

    const releaseLogin = page.getByRole('button', { name: 'Release shared login' });
    await expect(releaseLogin).toBeDisabled();
    await page.getByRole('button', { name: 'Hand back' }).click();
    await expect(releaseLogin).toBeEnabled();
    let releases = 0;
    await page.route('**/api/v1/bots/*/identity', (route) => {
      expect(route.request().method()).toBe('DELETE');
      expect(route.request().headers()['authorization']).toBe('Bearer skill-review-token');
      releases += 1;
      return route.fulfill(
        releases === 1
          ? { status: 409, contentType: 'application/json', body: '{"code":"CONFLICT"}' }
          : { status: 204 },
      );
    });
    await releaseLogin.click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Hand the screen back' }),
    ).toBeVisible();
    await releaseLogin.click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Shared login released' }),
    ).toBeVisible();
    expect(releases).toBe(2);
    expect(await canvas.evaluate((current, first) => current === first, original)).toBe(true);
  } finally {
    await app?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});
