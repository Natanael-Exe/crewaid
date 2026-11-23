import { expect, test, type ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TranscriptAttachment } from '@crewaid/shared';
import { launchDesktop } from './launchDesktop';
import { tokenColor } from './themeTokens';
import { chatMessage, routeChat, routeSocket } from './stubChat';
import { startStubAuthServer } from './stubAuthServer';
import type { CrewaidBridge } from '../src/preload.js';

test('voice messages disclose their text in the footer and keep a text fallback until audio arrives', async () => {
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-voice-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profile);
    const page = await app.firstWindow();
    const botId = 'clxbot000000000000000001';
    const threadId = 'thread_voice';
    await page.route('**/api/v1/bots', (route) =>
      route.fulfill({
        json: [
          {
            id: botId,
            userId: 'usr_crewaid_singleton_v1',
            name: 'Nathan',
            role: 'CEO',
            avatarColor: '#4C67FA',
            avatarShape: null,
            avatarUrl: null,
            systemPrompt: '',
            modelId: 'default',
            voiceId: null,
            status: 'IDLE',
            sortOrder: 0,
            pinned: false,
            hiddenFromSidebar: false,
            autoReviewRules: [],
            sandboxId: null,
            sandbox: null,
            createdAt: '2026-10-14T12:00:00Z',
            updatedAt: '2026-10-14T12:00:00Z',
            thread: { id: threadId, preview: null },
          },
        ],
      }),
    );
    for (const endpoint of ['routines', 'bot-groups', 'goals', 'tasks']) {
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    }
    const socket = await routeSocket(page);
    await page.route('**/api/v1/voice/status', (route) =>
      route.fulfill({ json: { configured: true } }),
    );
    const voiceNote: TranscriptAttachment = {
      id: 'clxvoice0000000000000001',
      filename: 'voice-note.wav',
      mimeType: 'audio/wav',
      sizeBytes: 16044,
      kind: 'VOICE_NOTE',
      durationMs: 1_000,
    };
    const spokenReply = { ...voiceNote, id: 'clxvoice0000000000000002' };
    const lateReply = { ...voiceNote, id: 'clxvoice0000000000000003' };
    const freshVoice = { ...voiceNote, id: 'clxvoice0000000000000004' };
    await page.route('**/api/v1/voice/notes', (route) =>
      route.fulfill({
        status: 201,
        json: {
          attachment: { ...freshVoice, storageKey: 'voice/fresh' },
          transcript: 'A brand new voice note.',
        },
      }),
    );
    const userId = 'clxmsg000000000000000001';
    const botReplyId = 'clxmsg000000000000000002';
    const fallbackId = 'clxmsg000000000000000003';
    const fileId = 'clxmsg000000000000000004';
    const userText = 'Hey, how are you?';
    const botText = "I'm doing **well**, thanks. What can I help you with today?";
    const fallbackText = 'The full reply includes this **important detail**.';
    const message = (
      id: string,
      author: 'USER' | 'BOT',
      text: string,
      attachments: readonly TranscriptAttachment[] = [],
    ) =>
      chatMessage({
        id,
        text,
        createdAt: '2026-10-14T14:28:00Z',
        crewaid: { author, attachments },
      });
    await routeChat(page, {
      threads: {
        [threadId]: [
          message(userId, 'USER', userText, [voiceNote]),
          message(botReplyId, 'BOT', botText, [spokenReply]),
          message(fallbackId, 'BOT', fallbackText),
          message(fileId, 'USER', 'Here is an audio file.', [
            { ...voiceNote, id: 'clxfile00000000000000001', kind: 'FILE' },
          ]),
        ],
      },
    });
    // A valid silent clip lets live autoplay exercise the player without sound.
    const clip = Buffer.alloc(160044);
    clip.write('RIFF', 0);
    clip.writeUInt32LE(clip.length - 8, 4);
    clip.write('WAVEfmt ', 8);
    clip.writeUInt32LE(16, 16);
    clip.writeUInt16LE(1, 20);
    clip.writeUInt16LE(1, 22);
    clip.writeUInt32LE(8000, 24);
    clip.writeUInt32LE(16000, 28);
    clip.writeUInt16LE(2, 32);
    clip.writeUInt16LE(16, 34);
    clip.write('data', 36);
    clip.writeUInt32LE(clip.length - 44, 40);
    let downloads = 0;
    await page.route('**/api/v1/attachments/*/download', (route) => {
      downloads += 1;
      return route.fulfill({ contentType: 'audio/wav', body: clip });
    });
    const roger = {
      id: 'CwhRBWXzGAHq8TQ4Fs17',
      name: 'Roger - Laid-Back, Casual, Resonant',
      previewUrl: 'https://voice-preview.test/roger.wav',
    };
    const charlie = {
      id: 'IKne3meq5aSn9XLyUdCD',
      name: 'Charlie - Deep, Confident, Energetic',
      previewUrl: 'https://voice-preview.test/charlie.wav',
    };
    await page.route('**/api/v1/voice/voices', (route) =>
      route.fulfill({
        json: {
          voices: [roger, charlie, { id: 'custom', name: 'Custom conversational voice' }],
          defaultVoiceId: roger.id,
        },
      }),
    );
    let previewDownloads = 0;
    let failPreview = false;
    await page.route('https://voice-preview.test/*', (route) => {
      previewDownloads += 1;
      expect(route.request().headers()['authorization']).toBeUndefined();
      return failPreview
        ? route.fulfill({ status: 503 })
        : route.fulfill({ contentType: 'audio/wav', body: clip });
    });
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'voice-test-token',
      });
      localStorage.setItem('crewaid.appearance.theme', 'light');
    }, auth.baseUrl);
    await page.reload();
    const user = page.locator(`[data-message="${userId}"]`);
    const bot = page.locator(`[data-message="${botReplyId}"]`);
    const fallback = page.locator(`[data-message="${fallbackId}"]`);
    const file = page.locator(`[data-message="${fileId}"]`);
    await expect(user.locator('[data-voice-note]')).toHaveCount(1);
    await expect(bot.locator('[data-voice-note]')).toHaveCount(1);
    await expect(user.locator('[data-message-bubble]:not([data-voice-note])')).toHaveCount(0);
    await expect(bot.locator('[data-message-bubble]:not([data-voice-note])')).toHaveCount(0);
    await expect(user.locator('[data-voice-note]')).toHaveAttribute('data-message-bubble', 'user');
    await expect(bot.locator('[data-voice-note]')).toHaveAttribute('data-message-bubble', 'bot');
    await expect(page.getByText(userText, { exact: true })).toHaveCount(0);
    await expect(fallback.locator('[data-message-bubble]')).toBeVisible();
    await expect(file.locator('[data-message-bubble]')).toBeVisible();
    await expect(file.locator('[data-voice-note]')).toHaveCount(0);
    // A voice note the person sent wears the same material as their text.
    await expect(file.locator('[data-audio-attachment] > .card')).toHaveCSS(
      'background-color',
      await tokenColor(page, '--message-user'),
    );
    expect(downloads).toBe(0);

    const track = user.locator('[data-voice-track]');
    const paint = await track.locator('[data-slot="progress-bar-track"]').evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      width: element.getBoundingClientRect().width,
    }));
    expect(paint.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(paint.width).toBeGreaterThan(80);
    await expect(track).toHaveAttribute('aria-valuenow', '0');
    await expect(user.locator('.crewaid-bubble-footer')).toHaveCSS('opacity', '0');
    await user.locator('[data-voice-note]').hover();
    await expect(user.locator('.crewaid-bubble-footer')).toHaveCSS('opacity', '1');
    await user.getByRole('button', { name: 'Show transcript', exact: true }).click();
    const transcript = page.getByRole('dialog', { name: 'Voice note transcript' });
    await expect(transcript).toHaveText(/TranscriptHey, how are you\?/);
    await page.screenshot({ path: test.info().outputPath('user-voice-transcript.png') });
    await page.keyboard.press('Escape');
    await expect(transcript).toBeHidden();

    // Focus reveals the same footer without moving the pointer over the note.
    await bot.getByRole('button', { name: 'Play voice note', exact: true }).focus();
    await expect(bot.locator('.crewaid-bubble-footer')).toHaveCSS('opacity', '1');
    const info = bot.getByRole('button', { name: 'Show transcript', exact: true });
    await info.focus();
    await info.press('Enter');
    await expect(transcript.locator('strong')).toHaveText('well');
    await expect(transcript).toContainText('What can I help you with today?');
    await expect(bot.locator('[data-message-menu]')).toBeAttached();
    await expect(bot.locator('[data-copy-message]')).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(transcript).toBeHidden();

    // The existing text fallback switches to a player when synthesis finishes.
    socket.send({
      id: randomUUID(),
      type: 'message.attachments',
      botId,
      ts: Date.now(),
      payload: {
        messageId: fallbackId,
        attachments: [{ ...lateReply, messageId: fallbackId, storageKey: 'voice/late-reply' }],
      },
    });
    await expect(fallback.locator('[data-voice-note]')).toHaveCount(1);
    await expect(fallback.locator('[data-message-bubble]:not([data-voice-note])')).toHaveCount(0);
    await fallback.locator('[data-voice-note]').hover();
    await fallback.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await expect(transcript.locator('strong')).toHaveText('important detail');
    await page.screenshot({ path: test.info().outputPath('bot-voice-transcript.png') });
    await page.keyboard.press('Escape');

    // Record with browser fakes so the real send flow needs no microphone prompt.
    await page.evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: () => Promise.resolve({ getTracks: () => [{ stop: () => undefined }] }),
      });
      Object.defineProperty(window, 'MediaRecorder', {
        value: class {
          static isTypeSupported() {
            return true;
          }
          mimeType = 'audio/webm';
          ondataavailable?: (event: { data: Blob }) => void;
          onstop?: () => void;
          start() {}
          stop() {
            queueMicrotask(() => {
              this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
              this.onstop?.();
            });
          }
        },
      });
    });
    await page.locator('button[aria-label="Record a voice message"]').click();
    await page.locator('button[aria-label="Send voice message"]').click();
    const newlySent = page
      .locator('[data-message]')
      .filter({ has: page.locator(`[data-voice-note="${freshVoice.id}"]`) });
    await expect(newlySent.locator('[data-voice-note]')).toBeVisible();
    await expect(newlySent.locator('[data-message-bubble]:not([data-voice-note])')).toHaveCount(0);
    await newlySent.locator('[data-voice-note]').hover();
    await newlySent.getByRole('button', { name: 'Show transcript', exact: true }).click();
    await expect(transcript).toContainText('A brand new voice note.');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Bot settings', exact: true }).click();
    const profilePane = page.getByRole('complementary', { name: 'Bot profile' });
    await profilePane.getByRole('button', { name: 'Voice: Default voice', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose voice', exact: true });
    await expect(picker).toContainText('Conversational voices');
    const rogerChoice = picker.getByRole('button', { name: `Choose ${roger.name}`, exact: true });
    await expect(rogerChoice.locator('[data-voice-tags]')).toHaveText(
      'Laid-Back, Casual, Resonant',
    );
    await expect(rogerChoice.locator('[data-voice-tags]')).toHaveCSS('font-size', '11px');
    const rogerPreview = picker.getByRole('button', { name: `Preview ${roger.name}`, exact: true });
    await expect(rogerPreview).toHaveCSS(
      'background-color',
      await tokenColor(page, '--app-accent'),
    );
    await expect(rogerPreview).toHaveCSS(
      'color',
      await tokenColor(page, '--app-accent-foreground', 'color'),
    );
    expect((await rogerPreview.boundingBox())!.x).toBeLessThan(
      (await rogerChoice.boundingBox())!.x,
    );
    await expect(
      picker.getByRole('button', { name: 'Preview Custom conversational voice', exact: true }),
    ).toBeDisabled();
    expect(previewDownloads).toBe(0);
    await picker.getByRole('button', { name: `Preview ${roger.name}`, exact: true }).click();
    await expect(
      picker.getByRole('button', { name: `Stop preview of ${roger.name}`, exact: true }),
    ).toBeVisible();
    await expect(profilePane.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await picker.getByRole('button', { name: `Preview ${charlie.name}`, exact: true }).click();
    await expect(
      picker.getByRole('button', { name: `Stop preview of ${charlie.name}`, exact: true }),
    ).toBeVisible();
    await expect(
      picker.getByRole('button', { name: `Preview ${roger.name}`, exact: true }),
    ).toBeVisible();
    expect(previewDownloads).toBe(2);
    await expect(profilePane.locator('audio')).toHaveJSProperty('paused', false);
    await page.screenshot({ path: test.info().outputPath('conversational-voice-picker.png') });
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(profilePane.locator('audio')).toHaveJSProperty('paused', true);
    expect(await profilePane.locator('audio').getAttribute('src')).toBeNull();

    await profilePane.getByRole('button', { name: 'Voice: Default voice', exact: true }).click();
    failPreview = true;
    await picker.getByRole('button', { name: `Preview ${charlie.name}`, exact: true }).click();
    await expect(profilePane.locator('[role="alert"]')).toHaveText(
      'This preview couldn’t play. Try again.',
    );
    await picker.getByRole('button', { name: `Choose ${charlie.name}`, exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(
      profilePane.getByRole('button', { name: `Voice: ${charlie.name}`, exact: true }),
    ).toBeVisible();
    await expect(profilePane.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  } finally {
    await app?.close().catch(() => undefined);
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
});
