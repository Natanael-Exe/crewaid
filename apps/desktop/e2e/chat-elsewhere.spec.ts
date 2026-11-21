import { expect, test, type ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerFrame } from '@crewaid/shared';
import { launchDesktop } from './launchDesktop';
import { chatMessage, routeChat, routeSocket } from './stubChat';
import { startStubAuthServer } from './stubAuthServer';
import type { CrewaidBridge } from '../src/preload.js';

/**
 * A message the open window did not send: one written in Telegram, a
 * teammate's, a routine's prompt. A run's log carries only the bot's side, so
 * the row reaches the window as `message.created`, before the `run.started`
 * of the run that answers it, and the transcript shows both without a reload.
 */
const BOT_ID = 'bot_elsewhere_01';
const THREAD = 'clxelsewherethread0000001';

const BOT = {
  id: BOT_ID,
  userId: 'usr_crewaid_singleton_v1',
  name: 'John',
  role: 'CMO',
  avatarColor: '#2FA59A',
  avatarShape: null,
  avatarUrl: null,
  systemPrompt: '',
  modelId: 'default',
  status: 'IDLE',
  sortOrder: 0,
  pinned: false,
  hiddenFromSidebar: false,
  autoReviewRules: [],
  sandboxId: null,
  sandbox: null,
  createdAt: '2026-10-01T12:00:00Z',
  updatedAt: '2026-10-01T12:00:00Z',
  thread: { id: THREAD, preview: null },
};

/** A §4.2 `message.created` payload: the stored row with its attachments. */
function storedRow(id: string, author: 'USER' | 'BOT', content: string, fromBotId: string | null) {
  return {
    id,
    conversationId: THREAD,
    author,
    fromBotId,
    content,
    parts: null,
    stopReason: author === 'BOT' ? 'stop' : null,
    chainId: null,
    hopCount: 0,
    taskId: null,
    routineId: null,
    startsTopic: false,
    createdAt: new Date(),
    attachments: [],
  };
}

const created = (row: ReturnType<typeof storedRow>): ServerFrame => ({
  id: randomUUID(),
  type: 'message.created',
  botId: BOT_ID,
  ts: Date.now(),
  payload: row,
});

test('a message sent from elsewhere appears in the open chat, above the reply it starts', async () => {
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-elsewhere-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profile);
    const page = await app.firstWindow();
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: [BOT] }));
    for (const endpoint of ['routines', 'bot-groups', 'goals', 'tasks'])
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    const socket = await routeSocket(page);
    await routeChat(page, {
      threads: {
        [THREAD]: [
          chatMessage({
            id: 'clxelsewherehistory000001',
            text: 'Earlier reply.',
            createdAt: '2026-10-07T12:00:00Z',
            crewaid: { author: 'BOT', fromBotId: BOT_ID, stopReason: 'stop' },
          }),
        ],
      },
      reply: ['Got it ', 'from Telegram.'],
    });
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'elsewhere-test-token',
      });
    }, auth.baseUrl);
    await page.reload();
    const transcript = page.getByRole('region', { name: 'Transcript' });
    const bubble = (text: string) => transcript.locator('[data-message-bubble]', { hasText: text });
    await expect(bubble('Earlier reply.')).toBeVisible();

    // What the orchestrator sends for a message from Telegram: the row, then the run.
    const phone = created(storedRow('tg_elsewhere_phone_0001', 'USER', 'Sent from my phone', null));
    socket.send(phone);
    socket.send({ ...phone, id: randomUUID() });
    socket.send({
      id: randomUUID(),
      type: 'run.started',
      botId: BOT_ID,
      ts: Date.now(),
      payload: { botId: BOT_ID, threadId: THREAD, runId: 'run_elsewhere_phone' },
    });
    await expect(bubble('Got it from Telegram.')).toBeVisible();
    await expect(bubble('Sent from my phone')).toHaveCount(1);
    const texts = await transcript.locator('[data-message-bubble]').allTextContents();
    const asked = texts.findIndex((text) => text.includes('Sent from my phone'));
    const replied = texts.findIndex((text) => text.includes('Got it from Telegram.'));
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(replied);

    // The bot's own reply is its run's to stream, so a row of its own is left
    // out; a teammate's delivered message is not.
    socket.send(created(storedRow('clxelsewhereowndraft00001', 'BOT', 'Own draft', BOT_ID)));
    socket.send(created(storedRow('clxelsewhereteammate00001', 'BOT', 'From Bob', 'bot_bob')));
    await expect(bubble('From Bob')).toHaveCount(1);
    await expect(bubble('Own draft')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('message-from-elsewhere.png') });
  } finally {
    await app?.close().catch(() => undefined);
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
