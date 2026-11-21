import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './launchDesktop';
import { welcomeCopy } from '@crewaid/shared';
import { chatMessage, routeChat } from './stubChat';
import { startStubAuthServer, STUB_USER } from './stubAuthServer';
import type { CrewaidBridge } from '../src/preload';

const WELCOME_COPY = welcomeCopy('en');

/**
 * D-232: the welcome is a conversation. Crewaid's greeting is in its thread;
 * "Show me around" is answered with the guide and leaves the welcome open;
 * "I have a task" is answered with Crewaid's question, closes the welcome and
 * focuses the composer; a starting point only fills it. Nothing is sent to a
 * model in the person's name.
 */
async function verifyWelcomeCompletion(finish: 'reply' | 'message') {
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-d232-'));
  const app = await launchDesktop(profile);
  try {
    const page = await app.firstWindow();
    const now = new Date().toISOString();
    const main = {
      id: 'd232-main',
      userId: STUB_USER.id,
      kind: 'MAIN',
      name: 'Crewaid',
      role: 'Main assistant',
      avatarColor: '#4c6ef5',
      avatarShape: 'egg',
      avatarUrl: null,
      systemPrompt: '',
      modelId: 'default',
      status: 'IDLE',
      sortOrder: 0,
      pinned: true,
      hiddenFromSidebar: false,
      autoReviewRules: [],
      sandboxId: null,
      sandbox: null,
      thread: { id: 'd232-main-thread', preview: null },
      createdAt: now,
      updatedAt: now,
    };
    let state = {
      userId: STUB_USER.id,
      welcomeSeen: false,
      discovery: 'NEW',
      createdAt: now,
      updatedAt: now,
    };
    const updates: unknown[] = [];
    const sent: string[] = [];
    // Read per request by the stub, so rows the server writes appear on re-read.
    const thread: Record<string, unknown>[] = [];
    let clock = Date.parse('2026-10-21T09:00:00Z');
    const say = (author: 'USER' | 'BOT', text: string) =>
      thread.push(
        chatMessage({
          id: `d232-${thread.length}`,
          text,
          createdAt: new Date((clock += 1000)).toISOString(),
          crewaid: author === 'BOT' ? { author, fromBotId: main.id } : { author },
        }),
      );
    // What bootstrap stores for a new account.
    for (const line of WELCOME_COPY.greeting('E2E')) say('BOT', line);
    await page.route('**/api/v1/onboarding/bootstrap', (route) =>
      route.fulfill({ json: { bot: main, onboarding: state, isNewAccount: true } }),
    );
    await page.route('**/api/v1/onboarding', async (route) => {
      const body = route.request().postDataJSON() as {
        reply?: 'TASK' | 'TOUR';
        welcomeSeen?: boolean;
        discovery?: string;
      };
      updates.push(body);
      if (body.reply === 'TOUR' && !state.welcomeSeen) {
        say('USER', WELCOME_COPY.replies.TOUR);
        say('BOT', WELCOME_COPY.guide);
        say('BOT', WELCOME_COPY.afterGuide);
      } else if (body.reply === 'TASK' && !state.welcomeSeen) {
        say('USER', WELCOME_COPY.replies.TASK);
        say('BOT', WELCOME_COPY.taskQuestion);
        state = { ...state, welcomeSeen: true };
      }
      state = {
        ...state,
        welcomeSeen: body.welcomeSeen ?? state.welcomeSeen,
        discovery: body.discovery ?? state.discovery,
      };
      await route.fulfill({ json: state });
    });
    await page.route('**/api/v1/bots', (route) => route.fulfill({ json: [main] }));
    await page.route('**/api/v1/groups', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/mcp/directory', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/mcp/servers', (route) => route.fulfill({ json: [] }));
    await routeChat(page, { threads: { [main.thread.id]: thread }, reply: ['On it.'] });
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/bots\/[^/]+\/chat/.test(request.url()))
        sent.push(request.postData() ?? '');
    });
    const saved = await page.evaluate(
      async (baseUrl) =>
        (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
          orchestratorBaseUrl: baseUrl,
          orchestratorToken: 'd232-test',
        }),
      auth.baseUrl,
    );
    expect(saved.status).toBe('saved');
    await page.reload();

    const replies = page.getByRole('group', { name: 'Replies' });
    const transcript = page.getByRole('region', { name: 'Transcript' });
    await expect(transcript.locator('[data-welcome-opening]')).toContainText('Welcome');
    await expect(transcript.getByText('Hi E2E, I’m Crewaid.', { exact: true })).toBeVisible();
    await expect(replies.getByRole('button')).toHaveText([
      WELCOME_COPY.replies.TASK,
      WELCOME_COPY.replies.CREW,
      WELCOME_COPY.replies.TOUR,
    ]);
    await page.screenshot({ path: test.info().outputPath('welcome.png') });

    if (finish === 'message') {
      const composer = page.getByRole('textbox', { name: 'Message Crewaid', exact: true });
      await composer.fill('Plan my week');
      await composer.press('Enter');
      await expect.poll(() => sent.length).toBe(1);
      await expect(transcript.getByText('On it.', { exact: true })).toBeVisible();
      await expect(transcript.locator('[data-welcome-opening]')).toHaveCount(0);
      expect(updates).toEqual([{ welcomeSeen: true, discovery: 'LEARNING' }]);
      await page.reload();
      await expect(transcript.getByText('Hi E2E, I’m Crewaid.', { exact: true })).toBeVisible();
      await expect(transcript.locator('[data-welcome-opening]')).toHaveCount(0);
      return;
    }

    await replies.getByRole('button', { name: WELCOME_COPY.replies.TOUR }).click();
    await expect(transcript.getByText('Bring in specialists when they help.')).toBeVisible();
    await expect(transcript.getByText(WELCOME_COPY.afterGuide, { exact: true })).toBeVisible();
    // The tour is given; what is left to tap is the task and the crew.
    await expect(replies.getByRole('button')).toHaveText([
      WELCOME_COPY.replies.TASK,
      WELCOME_COPY.replies.CREW,
    ]);
    await expect(transcript.locator('[data-welcome-opening]')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('toured.png') });

    await replies.getByRole('button', { name: WELCOME_COPY.replies.TASK }).click();
    await expect(transcript.getByText(WELCOME_COPY.taskQuestion, { exact: true })).toBeVisible();
    await expect(replies).toHaveCount(0);
    await expect(transcript.locator('[data-welcome-opening]')).toHaveCount(0);
    const composer = page.getByRole('textbox', { name: 'Message Crewaid', exact: true });
    await expect(composer).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('asked.png') });
    await page
      .getByRole('group', { name: 'Starting points' })
      .getByRole('button', { name: 'Turn my rough notes into a client update' })
      .click();
    await expect(composer).toHaveValue('Turn my rough notes into a client update');

    expect(updates).toEqual([{ reply: 'TOUR' }, { reply: 'TASK' }]);
    expect(sent).toHaveLength(0);

    await composer.press('Enter');
    await expect.poll(() => sent.length).toBe(1);
    await expect(transcript.getByText('On it.', { exact: true })).toBeVisible();
    await expect(transcript.locator('[data-welcome-opening]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('onboarding-complete.png') });
    await page.reload();
    await expect(transcript.getByText(WELCOME_COPY.taskQuestion, { exact: true })).toBeVisible();
    await expect(transcript.locator('[data-welcome-opening]')).toHaveCount(0);
  } finally {
    await app.close();
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
}

for (const finish of ['reply', 'message'] as const) {
  test(`Crewaid’s welcome completes with a ${finish} and stays dismissed`, async () => {
    await verifyWelcomeCompletion(finish);
  });
}
