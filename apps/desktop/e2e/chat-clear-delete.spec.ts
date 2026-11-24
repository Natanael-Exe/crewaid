import { expect, test, type ElectronApplication, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './launchDesktop';
import { chatMessage, routeChat, routeSocket, type StubSocket } from './stubChat';
import { startStubAuthServer, type StubAuthServer } from './stubAuthServer';
import type { CrewaidBridge, TokenStoreWriteResult } from '../src/preload.js';

/**
 * D-147's surfaces, driven in a real window: the row menu's "Clear chat", the
 * message menu's "Delete message", the confirmation that asks about memory,
 * and `/new` with its divider. The menus and the dialog are portals, which
 * `renderToStaticMarkup` does not render, so this is the only place the
 * wiring from a click to a request is exercised.
 *
 * ── WHAT D-192 CHANGED HERE ─────────────────────────────────────────────────
 *
 * The transcript is hydrated from `GET /bots/:id/chat?threadId=` rather than
 * paged from `GET /bots/:id/messages`, so the two-message history is a fixture
 * of §3.4 `UIMessage`s now. D-147's own routes did not move: the deletions
 * this test records are still `DELETE /bots/:id/messages[/:messageId]`, which
 * serves both engines.
 *
 * The second change is why this file now stands up a socket. A row used to
 * leave the transcript because `useChat` dispatched its own removal beside the
 * request; under D-192 the chat client owns the messages and the §4.2
 * `message.deleted` frame is the ONLY thing that takes one out. So the stub
 * emits that frame when it answers a successful deletion — which is what the
 * orchestrator does — and the disappearance this test asserts is the product's
 * reaction to the frame rather than to its own click.
 */
const BOT_ID = 'bot_d147_01';
const THREAD = 'clxd147thread000000000001';
const USER_MSG = 'clxd147user00000000000001';
const BOT_MSG = 'clxd147reply0000000000001';
const BOUNDARY = 'clxd147topic0000000000001';

const BOT = {
  id: BOT_ID,
  userId: 'usr_crewaid_singleton_v1',
  name: 'Paul',
  role: 'CTO',
  avatarColor: '#2f7d6d',
  avatarShape: null,
  avatarUrl: null,
  systemPrompt: '',
  modelId: 'default',
  status: 'IDLE',
  sortOrder: 0,
  pinned: false,
  hiddenFromSidebar: false,
  autoReviewRules: [],
  createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  sandboxId: null,
  sandbox: null,
  thread: { id: THREAD, preview: null },
};

/** A §4.1 row, for the one route that still answers with one: `POST /topics`. */
function storedRow(id: string, author: 'USER' | 'BOT' | 'SYSTEM', content: string, minute: number) {
  return {
    id,
    conversationId: THREAD,
    author,
    fromBotId: author === 'BOT' ? BOT_ID : null,
    content,
    parts: null,
    stopReason: author === 'BOT' ? 'stop' : null,
    chainId: null,
    hopCount: 0,
    taskId: null,
    routineId: null,
    startsTopic: author === 'SYSTEM',
    createdAt: new Date(Date.UTC(2026, 8, 29, 9, minute)).toISOString(),
    attachments: [],
  };
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 9, minute)).toISOString();

/** A transcript bubble; the sidebar preview repeats the newest text. */
const bubble = (page: Page, text: string) =>
  page.locator('[data-message-bubble]', { hasText: text });

type Deletion = { readonly path: string; readonly forget: string | null };

/**
 * Serves one bot with a two-message history, records every deletion, and
 * answers them with `deleteStatus` — announcing a successful one on the socket
 * exactly as the orchestrator does.
 */
async function setUp(
  page: Page,
  deleteStatus = 200,
): Promise<{ deletions: Deletion[]; socket: StubSocket }> {
  const deletions: Deletion[] = [];
  const socket = await routeSocket(page);
  await page.route('**/api/v1/bots', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([BOT]) }),
  );
  await routeChat(page, {
    threads: {
      [THREAD]: [
        chatMessage({
          id: USER_MSG,
          text: 'How do we isolate tenants?',
          createdAt: at(0),
          crewaid: { author: 'USER' },
        }),
        chatMessage({
          id: BOT_MSG,
          text: 'Use row-level security.',
          createdAt: at(1),
          crewaid: { author: 'BOT', fromBotId: BOT_ID, stopReason: 'stop' },
        }),
      ],
    },
  });
  const onMessages = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    // The transcript no longer reads this route; only D-147's deletions do, so
    // anything else arriving here is a renderer that went back to the §4.1
    // path and should fail rather than be served.
    if (request.method() !== 'DELETE') return route.fulfill({ status: 405, body: '' });
    const messageId = url.pathname.split('/messages/')[1] ?? null;
    deletions.push({ path: url.pathname, forget: url.searchParams.get('forget') });
    if (deleteStatus === 200)
      socket.send({
        id: randomUUID(),
        type: 'message.deleted',
        botId: BOT_ID,
        ts: Date.now(),
        payload: {
          botId: BOT_ID,
          ...(messageId === null
            ? { messageIds: [], cleared: true as const }
            : { messageIds: [messageId] }),
        },
      });
    return route.fulfill({
      status: deleteStatus,
      contentType: 'application/json',
      body: JSON.stringify(
        deleteStatus === 200 ? { deletedCount: 1, forgottenCount: 0 } : { message: 'busy' },
      ),
    });
  };
  await page.route('**/api/v1/bots/*/messages', onMessages);
  await page.route('**/api/v1/bots/*/messages?*', onMessages);
  await page.route('**/api/v1/bots/*/messages/*', onMessages);
  await page.route('**/api/v1/bots/*/topics', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(storedRow(BOUNDARY, 'SYSTEM', 'New topic', 2)),
    }),
  );

  const saved = await page.evaluate<TokenStoreWriteResult, string>(
    (baseUrl) =>
      (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'd147-token',
      }),
    stubAuth.baseUrl,
  );
  expect(saved.status).toBe('saved');
  await page.reload();
  await expect(bubble(page, 'Use row-level security.')).toBeVisible();
  return { deletions, socket };
}

let stubAuth: StubAuthServer;

test.beforeAll(async () => {
  stubAuth = await startStubAuthServer(0);
});

test.afterAll(async () => {
  await stubAuth?.close();
});

async function withApp(name: string, body: (page: Page) => Promise<void>): Promise<void> {
  const profileDir = await mkdtemp(path.join(tmpdir(), `crewaid-d147-${name}-`));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profileDir);
    await body(await app.firstWindow());
  } finally {
    if (app !== undefined) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

test('Delete message asks about memory and sends the answer', async () => {
  await withApp('delete', async (page) => {
    const { deletions } = await setUp(page);

    await bubble(page, 'Use row-level security.').hover();
    await page.getByRole('button', { name: 'More actions' }).last().click();
    await page.getByRole('menuitem', { name: 'Delete message' }).click();

    const dialog = page.getByRole('dialog', { name: 'Delete this message?' });
    await expect(dialog).toBeVisible();
    const forget = dialog.getByRole('checkbox', {
      name: /Also forget what Paul learned from this message/,
    });
    // Unticked on every opening: keeping memory is the default.
    await expect(forget).not.toBeChecked();
    // The input is react-aria's visually hidden one; a person clicks the label.
    await dialog.getByText('Also forget what Paul learned from this message').click();
    await expect(forget).toBeChecked();
    await expect(
      dialog.getByText('What Paul remembers from this message is erased.'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(dialog).toHaveCount(0);
    expect(deletions).toEqual([
      { path: `/api/v1/bots/${BOT_ID}/messages/${BOT_MSG}`, forget: 'true' },
    ]);
    await expect(bubble(page, 'Use row-level security.')).toHaveCount(0);
    await expect(bubble(page, 'How do we isolate tenants?')).toBeVisible();
  });
});

test('Clear chat from the row menu keeps memory unless asked', async () => {
  await withApp('clear', async (page) => {
    const { deletions } = await setUp(page);

    await page.getByRole('option', { name: /Paul/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Clear chat', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Clear your chat with Paul?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Clear chat', exact: true }).click();

    await expect(dialog).toHaveCount(0);
    expect(deletions).toEqual([{ path: `/api/v1/bots/${BOT_ID}/messages`, forget: 'false' }]);
    await expect(bubble(page, 'How do we isolate tenants?')).toHaveCount(0);
    await expect(bubble(page, 'Use row-level security.')).toHaveCount(0);
  });
});

test('a refused clear stays open and says what to do', async () => {
  await withApp('refused', async (page) => {
    await setUp(page, 409);

    await page.getByRole('option', { name: /Paul/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Clear chat', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Clear your chat with Paul?' });
    await dialog.getByRole('button', { name: 'Clear chat', exact: true }).click();

    await expect(dialog.getByRole('alert')).toHaveText(
      'Paul is working. Stop it or wait for the reply, then try again.',
    );
    await expect(bubble(page, 'Use row-level security.')).toBeVisible();
  });
});

/**
 * ── THIS TEST IS FAILING ON A PRODUCT DEFECT, NOT A STALE FIXTURE ───────────
 *
 * `sent` is 1. `ChatThread.appendStoredRow` puts the `/new` divider into the
 * transcript with `chat.append`, and `ChatClient.append` is "append a message
 * and stream the response": it ends in `streamResponse()`, so the divider is
 * POSTed to `/bots/:id/chat` as a new turn. D-147's claim is that `/new` sends
 * nothing, and D-192 §5 says the SYSTEM row is appended, not sent. On a real
 * orchestrator the POST is refused `NOTHING_TO_RUN` (the row is already stored
 * by `POST /topics`), which the window shows as "Something went wrong. Try
 * again." The non-sending way to put a row in the list is `setMessages`, which
 * the same file already uses for `message.deleted`.
 */
test('/new draws a divider without sending a message, and Undo removes it', async () => {
  await withApp('topic', async (page) => {
    const { deletions } = await setUp(page);
    let sent = 0;
    page.on('request', (request) => {
      // D-192: a send is a POST to the chat route now, so that — not
      // `/messages` — is what has to stay at zero for `/new`.
      if (request.method() === 'POST' && request.url().endsWith('/chat')) sent += 1;
    });

    const composer = page.getByRole('textbox', { name: 'Message Paul' });
    await composer.fill('/new');
    // The palette offers the command even with no tool directory served.
    await expect(page.locator('[data-command-row="new"]')).toBeVisible();
    await composer.press('Enter');

    const divider = page.locator('[data-topic-boundary]');
    await expect(divider).toBeVisible();
    await expect(composer).toHaveValue('');
    expect(sent).toBe(0);

    await divider.hover();
    await divider.getByRole('button', { name: 'Undo' }).click();
    await expect(divider).toHaveCount(0);
    expect(deletions).toEqual([
      { path: `/api/v1/bots/${BOT_ID}/messages/${BOUNDARY}`, forget: 'false' },
    ]);
  });
});
