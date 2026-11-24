import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CrewaidBridge } from '../src/preload.js';
import { launchDesktop } from './launchDesktop';
import { chatMessage, routeChat, routeSocket } from './stubChat';
import { startStubAuthServer } from './stubAuthServer';

type Microphone = {
  stopped: number;
  deferPermission: boolean;
  rejectPermission?: () => void;
};
type VoiceWindow = Window & { microphone: Microphone };

const botId = 'clxbot000000000000000001';
const note = {
  id: 'clxvoice0000000000000001',
  filename: 'recording.wav',
  mimeType: 'audio/wav',
  sizeBytes: 16044,
  kind: 'VOICE_NOTE' as const,
  durationMs: 1000,
};

function silentClip() {
  const bytes = Buffer.alloc(16044);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

async function withVoiceChat(run: (page: Page) => Promise<void>) {
  const auth = await startStubAuthServer(0);
  const profile = await mkdtemp(path.join(tmpdir(), 'crewaid-voice-capture-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(profile);
    const page = await app.firstWindow();
    const bot = (id: string, name: string) => ({
      id,
      name,
      userId: 'usr_crewaid_singleton_v1',
      role: 'CEO',
      avatarColor: id === botId ? '#4C67FA' : '#C34323',
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
      thread: { id: `thread_${id}`, preview: null },
    });
    await page.route('**/api/v1/bots', (route) =>
      route.fulfill({ json: [bot(botId, 'Nathan'), bot('clxbot000000000000000002', 'Ben')] }),
    );
    for (const endpoint of ['routines', 'bot-groups', 'goals', 'tasks'])
      await page.route(`**/api/v1/${endpoint}*`, (route) => route.fulfill({ json: [] }));
    await routeSocket(page);
    await routeChat(page, {
      threads: {
        [`thread_${botId}`]: [
          chatMessage({
            id: 'saved_note',
            text: 'Saved voice note.',
            createdAt: '2026-10-14T12:00:00Z',
            crewaid: { author: 'USER', attachments: [note] },
          }),
        ],
      },
    });
    await page.route('**/api/v1/voice/status', (route) =>
      route.fulfill({ json: { configured: true } }),
    );
    await page.route('**/api/v1/calls/allowance', (route) =>
      route.fulfill({
        json: {
          limitSeconds: 1800,
          usedSeconds: 0,
          periodStart: '2026-10-01T00:00:00Z',
          periodEnd: '2026-11-01T00:00:00Z',
        },
      }),
    );
    await page.evaluate(async (baseUrl) => {
      await (window as unknown as { crewaid: CrewaidBridge }).crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: 'voice-test-token',
      });
      localStorage.setItem('crewaid.appearance.theme', 'light');
    }, auth.baseUrl);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message Nathan', exact: true })).toBeVisible();
    await page.evaluate((base64) => {
      const state: Microphone = { stopped: 0, deferPermission: false };
      (window as unknown as VoiceWindow).microphone = state;
      const stream = { getTracks: () => [{ stop: () => state.stopped++ }] };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: () => {
          if (!state.deferPermission) return Promise.resolve(stream);
          state.deferPermission = false;
          return new Promise((_resolve, reject) => {
            state.rejectPermission = () =>
              reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' }));
          });
        },
      });
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      Object.defineProperty(window, 'MediaRecorder', {
        value: class {
          static isTypeSupported() {
            return true;
          }
          mimeType = 'audio/wav';
          ondataavailable?: (event: { data: Blob }) => void;
          onstop?: () => void;
          start() {}
          stop() {
            queueMicrotask(() => {
              this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
              this.onstop?.();
            });
          }
        },
      });
    }, silentClip().toString('base64'));
    await run(page);
  } finally {
    await app?.close().catch(() => undefined);
    await auth.close();
    await rm(profile, { recursive: true, force: true });
  }
}

test('discard resets capture, ignores a late permission failure, and dictation sits transparently at the right', async () => {
  await withVoiceChat(async (page) => {
    let uploads = 0;
    await page.route('**/api/v1/voice/notes', (route) => {
      uploads++;
      return route.fulfill({ status: 500 });
    });
    const record = page.locator('button[aria-label="Record a voice message"]');
    const discard = page.locator('button[aria-label="Discard voice message"]');
    const dictate = page.locator('button[aria-label="Dictate"]');
    await expect(
      page.locator('[data-composer-slot="controls"] [data-voice-dictation]'),
    ).toHaveCount(1);
    await expect(dictate).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await record.click();
    await expect(page.locator('[data-voice-recording]')).toBeVisible();
    await discard.click();
    await expect(record).toBeEnabled();
    await expect(page.locator('[data-voice-recording]')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as VoiceWindow).microphone.stopped))
      .toBe(1);

    await page.evaluate(() => {
      (window as unknown as VoiceWindow).microphone.deferPermission = true;
    });
    await record.click();
    await discard.click();
    await record.click();
    await page.evaluate(() => (window as unknown as VoiceWindow).microphone.rejectPermission?.());
    await expect(page.locator('[data-voice-recording]')).toBeVisible();
    await expect(page.getByText(/privacy settings/)).toHaveCount(0);
    await discard.click();
    await expect(record).toBeEnabled();
    expect(uploads).toBe(0);

    await page.route('**/api/v1/voice/transcriptions', (route) =>
      route.fulfill({ json: { text: 'Dictated words.', languageCode: 'en' } }),
    );
    await dictate.click();
    await page.locator('button[aria-label="Stop dictating"]').click();
    await expect(page.getByRole('textbox', { name: 'Message Nathan', exact: true })).toHaveValue(
      'Dictated words.',
    );
  });
});

test('failed voice sends keep a playable local clip across bot switches and retry an uploaded note without uploading again', async () => {
  await withVoiceChat(async (page) => {
    let uploads = 0;
    let posts = 0;
    let releaseUpload: (() => void) | undefined;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    await page.route('**/api/v1/voice/notes', async (route) => {
      uploads++;
      expect(route.request().postDataBuffer()?.includes(silentClip())).toBe(true);
      if (uploads === 1) {
        await uploadGate;
        return route.fulfill({ status: 503 });
      }
      return route.fulfill({
        status: 201,
        json: {
          attachment: { ...note, id: 'clxvoice0000000000000002', storageKey: 'voice/retry' },
          transcript: 'Retry this recording.',
        },
      });
    });
    await page.route('**/api/v1/bots/*/chat*', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts++;
      if (posts === 1) return route.fulfill({ status: 503 });
      return route.fallback();
    });
    await page.locator('button[aria-label="Record a voice message"]').click();
    await page.locator('button[aria-label="Send voice message"]').click();
    const sending = page.locator('button[aria-label="Sending voice message"]');
    await expect(sending).toBeDisabled();
    await expect(sending.locator('.spinner')).toBeVisible();
    await expect(sending).toHaveCSS('opacity', '1');
    await expect(sending.locator('.spinner')).toHaveCSS(
      'color',
      await sending.evaluate((element) => getComputedStyle(element).color),
    );
    expect(
      await sending.locator('.spinner').evaluate((element) => getComputedStyle(element).color),
    ).not.toBe(await sending.evaluate((element) => getComputedStyle(element).backgroundColor));
    await page.screenshot({ path: test.info().outputPath('voice-sending.png') });
    releaseUpload?.();
    const pending = page.locator('[data-pending-voice-note]');
    await expect(pending).toHaveAttribute('data-voice-send-state', 'failed');
    await pending.getByRole('button', { name: 'Play voice note', exact: true }).click();
    await expect(pending.locator('audio')).toHaveAttribute('src', /^blob:/);
    await page.getByRole('option', { name: /^Ben,/ }).click();
    await expect(pending).toHaveCount(0);
    await page.getByRole('option', { name: /^Nathan,/ }).click();
    await expect(pending).toHaveAttribute('data-voice-send-state', 'failed');
    await pending.getByRole('button', { name: 'Retry voice message', exact: true }).click();
    await expect.poll(() => posts).toBe(1);
    await expect(pending).toHaveAttribute('data-voice-send-state', 'failed');
    await page.screenshot({ path: test.info().outputPath('voice-send-failed.png') });
    await pending.getByRole('button', { name: 'Retry voice message', exact: true }).click();
    await expect(pending).toHaveCount(0);
    await expect(page.locator('[data-voice-note="clxvoice0000000000000002"]')).toHaveCount(1);
    expect(uploads).toBe(2);
    expect(posts).toBe(2);
    expect(await page.evaluate(() => (window as unknown as VoiceWindow).microphone.stopped)).toBe(
      1,
    );
  });
});

test('switching bots during upload keeps the unsent clip with its original conversation', async () => {
  await withVoiceChat(async (page) => {
    let uploads = 0;
    let posts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/voice/notes', async (route) => {
      uploads++;
      await gate;
      return route.fulfill({
        status: 201,
        json: {
          attachment: { ...note, id: 'clxvoice0000000000000002', storageKey: 'voice/original' },
          transcript: 'For Nathan.',
        },
      });
    });
    await page.route('**/api/v1/bots/*/chat*', (route) => {
      if (route.request().method() === 'POST') {
        posts++;
        expect(route.request().url()).toContain(`/bots/${botId}/chat`);
      }
      return route.fallback();
    });
    await page.locator('button[aria-label="Record a voice message"]').click();
    await page.locator('button[aria-label="Send voice message"]').click();
    await expect.poll(() => uploads).toBe(1);
    await page.getByRole('option', { name: /^Ben,/ }).click();
    release?.();
    await expect(page.getByRole('textbox', { name: 'Message Ben', exact: true })).toBeVisible();
    await expect(page.locator('[data-pending-voice-note]')).toHaveCount(0);
    await page.getByRole('option', { name: /^Nathan,/ }).click();
    const pending = page.locator('[data-pending-voice-note]');
    await expect(pending).toHaveAttribute('data-voice-send-state', 'failed');
    expect(posts).toBe(0);
    await pending.getByRole('button', { name: 'Retry voice message', exact: true }).click();
    await expect(pending).toHaveCount(0);
    expect(posts).toBe(1);
    expect(uploads).toBe(1);
  });
});

test('loading playback shows a contrasting spinner and Call has a visible label', async () => {
  await withVoiceChat(async (page) => {
    let releaseDownload: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    await page.route('**/api/v1/attachments/*/download', async (route) => {
      await gate;
      return route.fulfill({ contentType: 'audio/wav', body: silentClip() });
    });
    const player = page.locator(`[data-voice-note="${note.id}"]`);
    const corners = await player.evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomLeftRadius,
        style.borderBottomRightRadius,
      ];
    });
    expect(new Set(corners).size).toBe(1);
    await player.getByRole('button', { name: 'Play voice note', exact: true }).click();
    const loading = player.getByRole('button', { name: 'Loading voice note', exact: true });
    await expect(loading).toBeDisabled();
    await expect(loading).toHaveAttribute('data-pending', 'true');
    await expect(loading.locator('.spinner')).toBeVisible();
    await expect(loading).toHaveCSS('opacity', '1');
    expect(
      await loading.locator('.spinner').evaluate((element) => getComputedStyle(element).color),
    ).not.toBe(await loading.evaluate((element) => getComputedStyle(element).backgroundColor));
    // The rail starts tucked away for a bot with no computer; the labelled
    // Call button is the expanded rail's.
    await page.getByRole('button', { name: 'Expand panel' }).click();
    await expect(page.locator('button[aria-label="Call Nathan"]')).toHaveText('Call Nathan');
    // Both colours read together, each time: the record button's fill was
    // read once before, sometimes mid-transition, and one channel off for good.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const [call, record] = ['Call Nathan', 'Record a voice message'].map((label) => {
            const button = document.querySelector(`button[aria-label="${label}"]`);
            return button === null ? null : getComputedStyle(button).backgroundColor;
          });
          return call !== null && call === record ? 'same' : `${call} vs ${record}`;
        }),
      )
      .toBe('same');
    await page.screenshot({ path: test.info().outputPath('voice-loading-and-call.png') });
    releaseDownload?.();
    await expect(player).toHaveAttribute('data-voice-state', 'playing');
  });
});
