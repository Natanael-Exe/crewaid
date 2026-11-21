import { expect, test, type ElectronApplication } from '@playwright/test';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './launchDesktop';
import { startStubAuthServer, type StubAuthServer } from './stubAuthServer';

/**
 * CC-14 — the account menu opens Settings, and every pane renders.
 *
 * Deliberately runs with NO orchestrator. That is the state a first install is
 * in, it is the state this modal exists to leave, and it is the one the unit
 * tests cannot cover: they render the panes directly because React Aria mounts
 * a dialog through a portal, so nothing there proves the overlay itself opens.
 * A Modal wired wrong renders an empty string and passes every SSR assertion.
 */
/**
 * The sign-in gate (V1-18) resolves the account before the shell mounts, and it
 * asks the orchestrator who the stored token belongs to. That request is made by
 * the MAIN process, so `page.route` never sees it — without something listening
 * here the gate correctly reports an unreachable orchestrator and no shell ever
 * renders. Every renderer-level mock below is unchanged.
 */
let stubAuth: StubAuthServer;

test.beforeAll(async () => {
  stubAuth = await startStubAuthServer(59999);
});

test.afterAll(async () => {
  await stubAuth?.close();
});

test('the account menu opens Settings, and each pane renders its own body', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-cc-14-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();

    // Credentials first, because V1-18 put a gate in front of the shell: with
    // none stored the app opens on "Point this app at an orchestrator" and
    // there is no account menu to click. The stub above answers the gate's
    // one question, so this reaches the shell the way a signed-in install does.
    const saved = await page.evaluate<TokenStoreWriteResult>(() =>
      (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: 'http://127.0.0.1:59999',
        orchestratorToken: 'settings-modal-token',
      }),
    );
    expect(saved.status).toBe('saved');
    await page.reload();

    await expect(page.getByRole('button', { name: /account menu/i })).toBeVisible();

    await page.getByRole('button', { name: /account menu/i }).click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu).toBeVisible();
    // About is still a named destination the shell has not grown yet, so it
    // reads as disabled rather than being omitted. Log out is NOT: V1-11 gave
    // it a session to end, and it stayed greyed out for a whole milestone
    // after the only reason for that stopped being true.
    await expect(menu.getByRole('menuitem', { name: 'About' })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: 'Log out' })).toBeEnabled();

    await menu.getByRole('menuitem', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();

    // General: the address, which is the only credential an operator types.
    // The Session token field is gone (V1-18) — V1-08 made a Better Auth
    // session the only valid bearer, so it asked for a string nobody can
    // obtain while offering a way to paste a stale one over a live session.
    await expect(dialog.getByLabel('Address')).toBeVisible();
    await expect(dialog.getByLabel('Session token')).toHaveCount(0);

    // A local mistake is caught before any round trip, and says which field.
    await dialog.getByLabel('Address').fill('localhost:3000');
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await expect(dialog.getByText(/http:\/\//)).toBeVisible();

    // Nothing is listening, so this is the NETWORK path — the one an operator
    // with a typo'd port actually hits.
    await dialog.getByLabel('Address').fill('http://127.0.0.1:1');
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await expect(dialog.getByText(/Nothing answered at that address/)).toBeVisible();

    // Appearance folded into General and Model merged into this one (V1-19).
    for (const pane of ['Models', 'Computer']) {
      await dialog.getByRole('button', { name: pane, exact: true }).click();
      await expect(dialog.getByRole('heading', { name: pane })).toBeVisible();
    }

    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await app?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

/**
 * V1-12 — the key is write-only on the real screen, not just in a snapshot.
 *
 * The unit tests assert this against static markup, which is the right place
 * for it and is also the place where "no password input" could be true only
 * because an effect had not run yet. Here the overlay opens, the fetch
 * resolves, the card renders from a real response, and the assertion is that
 * there is still nothing on screen that could hold a key.
 *
 * Routed rather than served: what is under test is how the renderer presents
 * `GET /providers/connections`, not that an orchestrator can produce one.
 */
test('the Connections pane shows that a key is stored, and no field holding it', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-v1-12-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();

    await page.route('**/api/v1/providers/connections', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connections: [
            {
              id: 'cconnanthropic000000000001',
              userId: 'cuser0000000000000000000001',
              kind: 'anthropic',
              name: 'Work Anthropic',
              endpoint: null,
              authKind: 'api_key',
              state: 'ACTIVE',
              // D-083: the two things the server will say about a key, and
              // there is no third field it could arrive in.
              hasCredential: true,
              credentialSetAt: '2026-09-03T10:00:00.000Z',
              createdAt: '2026-09-01T12:00:00.000Z',
              updatedAt: '2026-09-03T10:00:00.000Z',
              models: [
                {
                  id: 'cmodelanthropic00000000001',
                  connectionId: 'cconnanthropic000000000001',
                  upstreamModelId: 'claude-opus-4-5',
                  label: 'Claude Opus 4.5',
                  contextWindow: 200_000,
                  capabilities: { tools: true, vision: true, reasoning: true },
                  createdAt: '2026-09-01T12:00:00.000Z',
                },
              ],
            },
            {
              id: 'cconnopenai00000000000001',
              userId: 'cuser0000000000000000000001',
              kind: 'openai',
              name: 'Personal OpenAI',
              endpoint: null,
              authKind: 'api_key',
              state: 'NEEDS_CREDENTIAL',
              hasCredential: false,
              credentialSetAt: null,
              createdAt: '2026-09-01T12:00:00.000Z',
              updatedAt: '2026-09-01T12:00:00.000Z',
              models: [],
            },
          ],
        }),
      }),
    );

    const saved = await page.evaluate<TokenStoreWriteResult>(() =>
      (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: 'http://127.0.0.1:59999',
        orchestratorToken: 'connections-pane-token',
      }),
    );
    expect(saved.status).toBe('saved');
    // Reload, because the gate (V1-18) resolves the account once on mount and
    // a later write to the store does not re-open it. Without this the test
    // races the first status call: it passed on a slow machine, where the
    // credentials landed before the gate had answered, and timed out on CI
    // where they did not.
    await page.reload();

    await page.getByRole('button', { name: /account menu/i }).click();
    await page
      .getByRole('menu', { name: 'Account' })
      .getByRole('menuitem', { name: 'Settings' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Models', exact: true }).click();

    // The connection an operator named, and its provider as a chip beside it.
    // It used to read provider + the environment variable that configured it —
    // D-083 removed the environment key entirely, so a pane still naming one
    // would be telling you to edit a file that resolves no model.
    await expect(dialog.getByText('Work Anthropic', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Anthropic', { exact: true })).toBeVisible();
    // Cards open collapsed to their header, so the key row and the models are
    // behind the disclosure — opened here as an operator would.
    await dialog.getByRole('button', { name: 'Work Anthropic details' }).click();
    await expect(dialog.getByText(/A key is stored/)).toBeVisible();

    // The models the connection serves, which is the half no static render can
    // reach: the list arrives in an effect. Merged here from the Model pane,
    // whose whole subject this pane now owns.
    await expect(dialog.getByText('Claude Opus 4.5')).toBeVisible();
    // The PROVIDER's id, not the row id: a cuid is not checkable against a
    // provider dashboard (D-082 keeps the three identities apart).
    await expect(dialog.getByText('claude-opus-4-5')).toBeVisible();
    await expect(dialog.getByText('200K context')).toBeVisible();
    await expect(dialog.getByText('Reasoning')).toHaveCount(1);

    // THE PROPERTY. Nothing on this screen holds the key, so there is no
    // password field to reveal and no masked value to mistake for one.
    await expect(dialog.getByRole('button', { name: 'Replace key' })).toBeVisible();
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);

    // The keyless connection reads as needing one rather than as broken, and
    // offers nothing to remove.
    await expect(dialog.getByText('Needs a key')).toBeVisible();
    await dialog.getByRole('button', { name: 'Personal OpenAI details' }).click();
    await expect(dialog.getByRole('button', { name: 'Set key' })).toBeVisible();

    // Pressing Replace opens an EMPTY field — the absence of a pre-filled
    // value is what the operator has to be able to see.
    await dialog.getByRole('button', { name: 'Replace key' }).click();
    const field = dialog.getByLabel('API key');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveValue('');
  } finally {
    await app?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

/**
 * V1-20 — the capability toggles are controls, and a provider card closes.
 *
 * ── TWO BUGS, ONE SCREEN ────────────────────────────────────────────────────
 *
 * HeroUI's `Switch` is React Aria's `SwitchField`: a field wrapper with no
 * control in it. The checkbox that carries `role="switch"` and `onChange` is
 * rendered by `Switch.Content`, and by nothing else — so every switch in this
 * app was a picture of one. It showed the state, honoured `isDisabled`, and no
 * press could change anything, which is why Vision could not be turned on for a
 * model everyone knew took images.
 *
 * The Models pane was also one long scroll: every connection showed its
 * endpoint, its key row and every model it serves, so finding the third
 * provider meant scrolling past the first two.
 *
 * Routed rather than served, and the route is STATEFUL: the capabilities the
 * PATCH writes are the ones the next `GET /providers/connections` returns. The
 * pane refetches after every write, so a screen that reported its own optimism
 * would pass a stateless fake and fail here.
 */
test('every switch on the Models pane is pressable, and a provider card collapses', async () => {
  type Capabilities = { tools: boolean; vision: boolean; reasoning: boolean };

  const MODEL_ID = 'cmodelanthropic00000000001';
  const CONNECTION_ID = 'cconnanthropic000000000001';
  const CAPABLED_MODEL = {
    id: MODEL_ID,
    connectionId: CONNECTION_ID,
    upstreamModelId: 'claude-opus-4-5',
    label: 'Claude Opus 4.5',
    contextWindow: 200_000,
    createdAt: '2026-09-01T12:00:00.000Z',
  };
  const CONNECTION = {
    id: CONNECTION_ID,
    userId: 'cuser0000000000000000000001',
    kind: 'anthropic',
    name: 'Work Anthropic',
    endpoint: null,
    authKind: 'api_key',
    hasCredential: true,
    credentialSetAt: '2026-09-03T10:00:00.000Z',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
  };

  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-v1-20-toggles-'));
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();

    // vision: false is the state the add form used to force on every model, and
    // the one the toggle existed to correct.
    let capabilities: Capabilities = { tools: true, vision: false, reasoning: false };
    let state = 'ACTIVE';
    const writes: Array<{ method: string; capabilities: Capabilities | undefined }> = [];
    const connectionWrites: Array<{ method: string; state: string | undefined }> = [];

    await page.route('**/api/v1/providers/models/*', async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { capabilities?: Capabilities };
      writes.push({ method: request.method(), capabilities: body.capabilities });
      if (body.capabilities !== undefined) capabilities = body.capabilities;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...CAPABLED_MODEL, capabilities }),
      });
    });

    // `/*` and not the bare path: turning a connection on or off is a PATCH to
    // the row, and the glob has to leave the list route to the handler below.
    await page.route('**/api/v1/providers/connections/*', async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { state?: string };
      connectionWrites.push({ method: request.method(), state: body.state });
      if (body.state !== undefined) state = body.state;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...CONNECTION, state }),
      });
    });

    await page.route('**/api/v1/providers/connections', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connections: [{ ...CONNECTION, state, models: [{ ...CAPABLED_MODEL, capabilities }] }],
        }),
      }),
    );

    const saved = await page.evaluate<TokenStoreWriteResult>(() =>
      (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: 'http://127.0.0.1:59999',
        orchestratorToken: 'vision-toggle-token',
      }),
    );
    expect(saved.status).toBe('saved');
    await page.reload();

    await page.getByRole('button', { name: /account menu/i }).click();
    await page
      .getByRole('menu', { name: 'Account' })
      .getByRole('menuitem', { name: 'Settings' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Models', exact: true }).click();

    const disclosure = dialog.getByRole('button', { name: 'Work Anthropic details' });
    // Cards open collapsed to their header: the body is behind the disclosure.
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.getByText('A key is stored')).toHaveCount(0);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(dialog.getByText('A key is stored')).toBeVisible();

    // Closing: the header keeps what an operator scans — which provider, on or
    // off, has it a key — and the body goes away.
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.getByText('A key is stored')).toHaveCount(0);
    await expect(dialog.getByText('Claude Opus 4.5')).toHaveCount(0);
    await expect(dialog.getByText('Work Anthropic', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Active', { exact: true })).toBeVisible();

    // And back, because a card that closes and does not reopen is a card that
    // lost the models it was the only way to reach.
    await disclosure.click();
    await expect(dialog.getByText('A key is stored')).toBeVisible();
    await expect(dialog.getByText('Claude Opus 4.5')).toBeVisible();

    // The same composition in the header, where a press has one more way to go
    // wrong: it has to reach a control inside a row that also holds a menu.
    const enabled = dialog.getByRole('switch', { name: 'Work Anthropic enabled' });
    await expect(enabled).toBeChecked();
    // Pressed on the switch's own label, which is where a person aims — the
    // checkbox itself is a 1px clip rectangle inside it, and aiming at that is
    // how a click test ends up proving something no user does.
    await enabled.locator('xpath=ancestor::label').click();
    await expect(enabled).not.toBeChecked();
    await expect.poll(() => connectionWrites.length).toBe(1);
    expect(connectionWrites[0]).toEqual({ method: 'PATCH', state: 'DISABLED' });
    // Read back from the server, so the state on screen is the one it stored.
    await expect(dialog.getByText('Disabled', { exact: true })).toBeVisible();

    // The press that used to do nothing. Clicked on the row, which is the
    // switch's own label — a person does not aim at a 1px checkbox.
    await dialog.getByRole('button', { name: 'Edit Claude Opus 4.5' }).click();
    const vision = dialog.getByRole('switch', { name: 'Vision' });
    await expect(vision).not.toBeChecked();
    await dialog.getByText('Vision', { exact: true }).click();
    await expect(vision).toBeChecked();
    // Toggling one leaves the others alone.
    await expect(dialog.getByRole('switch', { name: 'Tools' })).toBeChecked();
    await expect(dialog.getByRole('switch', { name: 'Reasoning' })).not.toBeChecked();

    await dialog.getByRole('button', { name: 'Save model' }).click();

    // What left the app: the whole draft, with vision on. `PATCH` accepts a
    // partial, so a body missing this field would look saved and change nothing.
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]?.method).toBe('PATCH');
    expect(writes[0]?.capabilities).toEqual({ tools: true, vision: true, reasoning: false });

    // And the round trip, through a refetch: the chip the picker shows is on
    // the row now, which is the thing an operator was trying to get.
    await expect(dialog.getByText('Vision', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Tools', { exact: true })).toBeVisible();
  } finally {
    await app?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

/**
 * D-234 — Language, Microphone and Timezone, through the real overlay.
 *
 * The pickers are popovers, which a static render never mounts, so this is
 * the only place the lists themselves are seen: every zone the runtime knows,
 * searched rather than scrolled, and a choice that reaches `PATCH /settings`.
 */
test('the timezone list holds every zone, and a choice is saved to the account', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'crewaid-d233-'));
  let app: ElectronApplication | undefined;
  let releaseSave: (() => void) | undefined;
  const saveFinished = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const capture = process.env['D233_CAPTURE'];

  try {
    app = await launchDesktop(profileDir);
    const page = await app.firstWindow();
    const patches: unknown[] = [];
    let settings = {
      userId: 'cuser0000000000000000000001',
      defaultModelId: null,
      language: null,
      timezone: null,
      systemLanguage: null,
      systemTimezone: null,
      updatedAt: '2026-10-22T12:00:00.000Z',
    };
    await page.route('**/api/v1/settings', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        patches.push(body);
        settings = { ...settings, ...body };
        if (body['timezone'] === 'Pacific/Wallis') await saveFinished;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ settings }),
      });
    });

    const saved = await page.evaluate<TokenStoreWriteResult>(() =>
      (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: 'http://127.0.0.1:59999',
        orchestratorToken: 'preferences-token',
      }),
    );
    expect(saved.status).toBe('saved');
    await page.reload();

    await page.getByRole('button', { name: /account menu/i }).click();
    await page
      .getByRole('menu', { name: 'Account' })
      .getByRole('menuitem', { name: 'Settings' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByText('Microphone', { exact: true })).toBeVisible();

    // The app reports its own computer once, so a bot on Auto-detect has a zone.
    const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(patches[0]).toMatchObject({ systemTimezone: zone });

    const timezone = dialog.locator('[data-search-select="Timezone"]');
    await timezone.scrollIntoViewIfNeeded();
    if (capture) await page.screenshot({ path: path.join(capture, 'd233-general.png') });
    await timezone.click();
    const search = page.getByPlaceholder('Search timezone');
    await expect(search).toBeVisible();
    await expect(page.getByRole('option', { name: /^Auto-detect/ })).toBeVisible();
    // After the popover's entrance animation, or the capture is half-transparent.
    await expect(page.locator('[data-entering="true"]')).toHaveCount(0);
    if (capture) await page.screenshot({ path: path.join(capture, 'd233-timezone.png') });

    // The far end of the alphabet is reachable by typing, which a short
    // curated list would not offer.
    await search.fill('wallis');
    await page.getByRole('option', { name: /Pacific\/Wallis/ }).click();
    await expect.poll(() => patches.at(-1)).toEqual({ timezone: 'Pacific/Wallis' });
    await expect(timezone).toHaveAttribute('data-disabled', 'true');
    await timezone.click({ force: true });
    await expect(page.getByPlaceholder('Search timezone')).toBeHidden();
    await expect(dialog.locator('[data-search-select="Language"]')).toHaveAttribute(
      'data-disabled',
      'true',
    );
    releaseSave?.();
    await expect(timezone).not.toHaveAttribute('data-disabled');
    await expect(timezone).toHaveText(/Pacific\/Wallis/);

    await dialog.locator('[data-search-select="Language"]').click();
    await expect(page.getByPlaceholder('Search language')).toBeVisible();
    await expect(page.getByRole('option', { name: /Follow system/ })).toBeVisible();
    await expect(page.locator('[data-entering="true"]')).toHaveCount(0);
    if (capture) await page.screenshot({ path: path.join(capture, 'd233-language.png') });
    await page.keyboard.press('Escape');
  } finally {
    releaseSave?.();
    await app?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});
