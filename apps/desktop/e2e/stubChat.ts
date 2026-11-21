import type { Page, Route } from '@playwright/test';
import { stampWireVersion, type ServerFrame, type TranscriptAttachment } from '@crewaid/shared';

/**
 * The chat routes (D-188/D-190), stubbed for the specs that mock the
 * orchestrator in the renderer.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * D-192 moved the transcript off `GET/POST /bots/:id/messages` and onto
 * `GET/POST /bots/:id/chat`. A spec that stubs only the message routes paints
 * an empty or failed thread where it expects a conversation — and because that
 * renders without error, the spec keeps passing while asserting on a pane that
 * is no longer there. So every spec that fixtures a bot row routes its chat
 * endpoint through here.
 *
 * Shared rather than copied for the reason `launchDesktop` is: the hydrate's
 * body is a contract with the chat client (`messages`, `activeRun`,
 * `interrupts`, `page`), and six copies of it would drift one at a time.
 *
 * What a stub can and cannot carry: the hydrate is plain JSON and is modelled
 * faithfully here. A pending APPROVAL is not — it is the library's own
 * interrupt record, whose shape is the engine's to produce — so a spec about
 * approvals belongs against a real orchestrator.
 */

/** `metadata.crewaid`, the §3.4 projection the operator view puts on every message. */
export type CrewaidMeta = {
  readonly author: 'USER' | 'BOT' | 'SYSTEM' | 'TOOL';
  readonly fromBotId?: string | null;
  readonly stopReason?: string | null;
  readonly taskId?: string | null;
  readonly startsTopic?: boolean;
  readonly attachments?: readonly TranscriptAttachment[];
};

/**
 * One stored message as `GET /bots/:id/chat?threadId=` serves it.
 *
 * `role` is what the model saw and `metadata.crewaid.author` is who said it —
 * they are not the same question, which is why `uiMessage.ts` reads both. A
 * SYSTEM notice has no role of its own, so it travels as `assistant` exactly as
 * the server's operator view sends it.
 */
export function chatMessage(input: {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly crewaid: CrewaidMeta;
}): Record<string, unknown> {
  const { author } = input.crewaid;
  return {
    id: input.id,
    role: author === 'USER' ? 'user' : 'assistant',
    content: input.text,
    metadata: {
      tanstack: { createdAt: input.createdAt },
      crewaid: {
        author,
        fromBotId: input.crewaid.fromBotId ?? null,
        runId: null,
        sequence: 0,
        stopReason: input.crewaid.stopReason ?? null,
        taskId: input.crewaid.taskId ?? null,
        routineId: null,
        chainId: null,
        hopCount: 0,
        startsTopic: input.crewaid.startsTopic ?? false,
        attachments: input.crewaid.attachments ?? [],
      },
    },
  };
}

export type ChatStubOptions = {
  /**
   * The transcript each thread hydrates with, keyed by thread id. A thread with
   * no entry hydrates empty, which is what a fresh bot looks like.
   */
  readonly threads?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /** What a send streams back, word by word. Omitted means a run that only finishes. */
  readonly reply?: readonly string[];
};

/**
 * The AG-UI event names, spelled rather than imported.
 *
 * These are protocol names a stub server writes; the real route writes the
 * same strings into its SSE `data`. The stub exercises the public wire format
 * independently of the server SDK.
 */
const RUN_STARTED = 'RUN_STARTED';
const TEXT_MESSAGE_START = 'TEXT_MESSAGE_START';
const TEXT_MESSAGE_CONTENT = 'TEXT_MESSAGE_CONTENT';
const TEXT_MESSAGE_END = 'TEXT_MESSAGE_END';
const RUN_FINISHED = 'RUN_FINISHED';

/** One AG-UI event as the chat routes encode it: an SSE `id`/`data` pair. */
function sse(offset: number, event: Record<string, unknown>): string {
  return `id: ${offset}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * The run a send produces: its whole log, replayed from the start.
 *
 * The real route answers with a reader of the durable log rather than with the
 * live stream, so a complete body here is the same thing the client sees after
 * a disconnect — and it keeps the stub free of timing.
 */
function runLog(runId: string, threadId: string, words: readonly string[]): string {
  const messageId = `stub-${runId}`;
  const now = Date.now();
  const events: Record<string, unknown>[] = [
    { type: RUN_STARTED, runId, threadId, timestamp: now },
    { type: TEXT_MESSAGE_START, messageId, role: 'assistant', timestamp: now },
    ...words.map((delta) => ({ type: TEXT_MESSAGE_CONTENT, messageId, delta, timestamp: now })),
    { type: TEXT_MESSAGE_END, messageId, timestamp: now },
    {
      type: RUN_FINISHED,
      runId,
      threadId,
      outcome: { type: 'success' },
      timestamp: now,
    },
  ];
  return events.map((event, index) => sse(index + 1, event)).join('');
}

/**
 * Serve `GET`/`POST /bots/:id/chat` from fixtures.
 *
 * One route for both, as the server has one path for both: the method and the
 * query decide which read it is.
 */
export async function routeChat(page: Page, options: ChatStubOptions = {}): Promise<void> {
  const threads = options.threads ?? {};
  const reply = options.reply ?? [];
  await page.route('**/api/v1/bots/*/chat*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { threadId?: string; runId?: string };
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: runLog(body.runId ?? 'stub-run', body.threadId ?? 'stub-thread', reply),
      });
    }
    const runId = url.searchParams.get('runId');
    if (runId !== null) {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: runLog(runId, url.searchParams.get('threadId') ?? 'stub-thread', reply),
      });
    }
    const threadId = url.searchParams.get('threadId') ?? '';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: threads[threadId] ?? [],
        activeRun: null,
        interrupts: null,
        page: { truncated: false },
      }),
    });
  });
}

/** A live §4.2 socket a spec can push frames down. */
export type StubSocket = {
  /** Broadcasts a frame to every window that has connected. */
  readonly send: (frame: ServerFrame) => void;
};

/**
 * The §4.2 socket, held open so frames can be delivered.
 *
 * It is not decoration. D-192 made `message.deleted` the ONLY way a row leaves
 * the transcript — the optimistic local removal the reducer used to do went
 * with `messagesByBot` — so a spec that deletes a message and expects the
 * bubble to go needs the frame the server would have sent. Routed in the page
 * rather than served by a socket of its own: `WsClient` uses the window's
 * `WebSocket`, so Playwright's own route is enough and the suite gains no
 * dependency.
 */
export async function routeSocket(page: Page): Promise<StubSocket> {
  const open: Array<(data: string) => void> = [];
  await page.routeWebSocket('**/ws?*', (ws) => {
    open.push((data) => ws.send(data));
  });
  return {
    send: (frame) => {
      const text = JSON.stringify(stampWireVersion(frame));
      for (const send of open) send(text);
    },
  };
}

/**
 * A bot's screen as the orchestrator serves it: a grant for any bot, then a
 * stream socket that sends `picture` — one RFB message, no envelope — as soon
 * as it opens, or nothing at all when there is none, which holds the viewer in
 * its connecting state. Counts the streams opened, so a spec can assert that
 * something did NOT reconnect the screen.
 */
export async function routeScreenStream(
  page: Page,
  picture: Uint8Array | null,
): Promise<{ readonly opened: () => number }> {
  let opened = 0;
  await page.route('**/api/v1/bots/*/screen/grant', (route) =>
    route.fulfill({
      json: {
        endpoint: { kind: 'orchestrator' },
        ticket: 'e2e-screen-ticket',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  );
  await page.routeWebSocket('**/ws/screen?*', (ws) => {
    opened += 1;
    if (picture !== null) ws.send(Buffer.from(picture));
  });
  return { opened: () => opened };
}
