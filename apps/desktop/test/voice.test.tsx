import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { Message } from '@ag-ui/core';
import {
  RecorderError,
  VoiceRecorder,
  formatClipTime,
  type MediaRecorderLike,
  type RecorderDeps,
} from '../src/renderer/voice/recorder';
import {
  voiceErrorCopy,
  type VoiceCapture,
} from '../src/renderer/components/composer/useVoiceCapture';
import {
  DictationButton,
  VoiceMessageButton,
  VoiceMessageStrip,
} from '../src/renderer/components/composer/VoiceControls';
import { VoiceNoteBubble } from '../src/renderer/components/attachments/VoiceNoteBubble';
import { withAttachments } from '../src/renderer/chat/ChatThread';
import { toTranscriptMessage } from '../src/renderer/chat/uiMessage';
import { ApiRequestError } from '../src/renderer/api';

/** A microphone and recorder that do exactly what the test says, when it says. */
function fakeMedia(options: { readonly refuse?: string } = {}) {
  let clock = 1_000;
  const stoppedTracks: number[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let handlers: Parameters<MediaRecorderLike['listen']>[0] | null = null;
  const recorder: MediaRecorderLike = {
    mimeType: 'audio/webm;codecs=opus',
    start: () => undefined,
    // The browser delivers the last chunk, then `stop`, after `stop()` returns.
    stop: () => {
      queueMicrotask(() => {
        handlers?.data(new Blob(['voice'], { type: 'audio/webm' }));
        handlers?.stop();
      });
    },
    listen: (next) => {
      handlers = next;
    },
  };
  const deps: RecorderDeps = {
    getUserMedia: async () => {
      if (options.refuse !== undefined)
        throw Object.assign(new Error('refused'), { name: options.refuse });
      return { getTracks: () => [{ stop: () => stoppedTracks.push(1) }] };
    },
    createRecorder: () => recorder,
    isTypeSupported: (type) => type === 'audio/webm;codecs=opus',
    now: () => clock,
    setTimeoutFn: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return {
    deps,
    stoppedTracks,
    timers,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('D-221 — the recorder', () => {
  it('records, then hands back the clip with its length and lets go of the microphone', async () => {
    const media = fakeMedia();
    const recorder = new VoiceRecorder(media.deps, { maxDurationMs: 60_000 });
    await recorder.start();
    expect(recorder.state).toBe('recording');
    media.advance(4_200);
    expect(recorder.elapsedMs()).toBe(4_200);

    const clip = await recorder.stop();
    expect(clip?.durationMs).toBe(4_200);
    expect(clip?.blob.type).toBe('audio/webm;codecs=opus');
    expect(recorder.state).toBe('idle');
    expect(media.stoppedTracks).toHaveLength(1);
    expect(media.timers[0]?.cleared).toBe(true);
  });

  it('gives nothing back for a cancelled recording', async () => {
    const media = fakeMedia();
    const recorder = new VoiceRecorder(media.deps, { maxDurationMs: 60_000 });
    await recorder.start();
    const waiting = recorder.stop();
    recorder.cancel();
    expect(await waiting).toBeNull();
    expect(media.stoppedTracks).toHaveLength(1);
  });

  it('stops itself at the cap and says so, so a forgotten recording cannot run on', async () => {
    const media = fakeMedia();
    let limited = false;
    const recorder = new VoiceRecorder(media.deps, {
      maxDurationMs: 120_000,
      onLimit: () => {
        limited = true;
      },
    });
    await recorder.start();
    expect(media.timers[0]?.ms).toBe(120_000);
    media.timers[0]?.fn();
    expect(limited).toBe(true);
    expect(recorder.state).toBe('stopping');
  });

  it('names a refused microphone apart from a missing one', async () => {
    for (const [name, code] of [
      ['NotAllowedError', 'PERMISSION_DENIED'],
      ['NotFoundError', 'NO_MICROPHONE'],
      ['AbortError', 'FAILED'],
    ] as const) {
      const recorder = new VoiceRecorder(fakeMedia({ refuse: name }).deps, {
        maxDurationMs: 1_000,
      });
      await expect(recorder.start()).rejects.toMatchObject({ code });
      expect(recorder.state).toBe('idle');
    }
  });

  it('formats a clip’s length as m:ss', () => {
    expect(formatClipTime(0)).toBe('0:00');
    expect(formatClipTime(65_400)).toBe('1:05');
  });
});

describe('D-221 — what a voice failure tells the person', () => {
  const api = (code: ConstructorParameters<typeof ApiRequestError>[0]['code']) =>
    new ApiRequestError({ code, message: 'server text' });

  it('points a missing key at Settings, and never repeats the server’s words otherwise', () => {
    expect(voiceErrorCopy(api('CONFLICT'))).toContain('Settings → Models');
    expect(voiceErrorCopy(api('INVALID_REQUEST'))).toBe('Nothing was heard in that recording.');
    expect(voiceErrorCopy(api('UNKNOWN'))).not.toContain('server text');
  });

  it('passes the plan’s own sentence through when the allowance is spent', () => {
    expect(voiceErrorCopy(api('PLAN_REQUIRED'))).toBe('server text');
  });

  it('tells a blocked microphone apart from a failed send', () => {
    expect(voiceErrorCopy(new RecorderError('PERMISSION_DENIED'))).toContain('privacy settings');
    expect(voiceErrorCopy(new Error('boom'))).toBe('The recording couldn’t be sent. Try again.');
  });
});

function capture(overrides: Partial<VoiceCapture> = {}): VoiceCapture {
  return {
    purpose: null,
    stage: 'idle',
    elapsedMs: 0,
    error: null,
    start: () => undefined,
    finish: () => undefined,
    cancel: () => undefined,
    dismissError: () => undefined,
    ...overrides,
  };
}

const voice = {
  configured: true,
  transcribe: async () => '',
  sendVoiceNote: async () => undefined,
};

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

describe('D-221 — the composer’s voice controls', () => {
  it('offers dictation and a voice message when a key is configured', () => {
    expect(render(<DictationButton voice={voice} capture={capture()} />)).toContain(
      'aria-label="Dictate"',
    );
    const message = render(<VoiceMessageButton voice={voice} capture={capture()} />);
    expect(message).toContain('aria-label="Record a voice message"');
    expect(message).not.toContain('disabled=""');
  });

  it('disables both and says where the key goes when there is none', () => {
    const off = { ...voice, configured: false };
    const dictation = render(<DictationButton voice={off} capture={capture()} />);
    expect(dictation).toContain('Add an ElevenLabs key');
    expect(dictation).toContain('disabled=""');
    expect(render(<VoiceMessageButton voice={off} capture={capture()} />)).toContain('disabled=""');
  });

  it('shows no dictation button at all without voice, so nothing dead is offered', () => {
    expect(render(<DictationButton voice={undefined} capture={capture()} />)).toBe('');
  });

  it('turns the slot into Send, and the draft into a timer, while a message records', () => {
    const recording = capture({ purpose: 'message', stage: 'recording', elapsedMs: 7_000 });
    expect(render(<VoiceMessageButton voice={voice} capture={recording} />)).toContain(
      'aria-label="Send voice message"',
    );
    const strip = render(<VoiceMessageStrip capture={recording} />);
    expect(strip).toContain('0:07');
    expect(strip).toContain('aria-label="Discard voice message"');
    expect(render(<VoiceMessageStrip capture={capture()} />)).toBe('');
  });
});

describe('D-221 — a voice note in the transcript', () => {
  const note = {
    id: 'clxvoice0000000000000001',
    filename: 'spoken-reply.mp3',
    mimeType: 'audio/mpeg',
    sizeBytes: 4096,
    kind: 'VOICE_NOTE' as const,
    durationMs: 12_000,
  };

  it('is a player with its length, fetched on press rather than linked', () => {
    const html = render(<VoiceNoteBubble attachment={note} align="start" />);
    expect(html).toContain('aria-label="Play voice note"');
    expect(html).toContain('0:12');
    expect(html).toContain('preload="none"');
    // D-025: an `<audio src>` on the route would go without the bearer.
    expect(html).not.toContain('src=');
  });
});

describe('D-221 — a spoken reply arriving after its run', () => {
  const reply: Message = {
    id: 'clxmsg000000000000000001',
    role: 'assistant',
    content: 'Done.',
    metadata: { crewaid: { author: 'BOT', attachments: [] } },
  } as Message;
  const payload = {
    messageId: reply.id,
    attachments: [
      {
        id: 'clxvoice0000000000000001',
        messageId: reply.id,
        filename: 'spoken-reply.mp3',
        mimeType: 'audio/mpeg',
        sizeBytes: 4096,
        storageKey: 'voice/key',
        kind: 'VOICE_NOTE' as const,
        durationMs: 3_000,
      },
    ],
  } as Parameters<typeof withAttachments>[1];

  it('joins the message it belongs to, without the storage key', () => {
    const merged = withAttachments([reply], payload);
    const crewaid = (merged?.[0] as { metadata: { crewaid: { attachments: unknown[] } } }).metadata
      .crewaid;
    expect(crewaid.attachments).toEqual([
      {
        id: 'clxvoice0000000000000001',
        filename: 'spoken-reply.mp3',
        mimeType: 'audio/mpeg',
        sizeBytes: 4096,
        kind: 'VOICE_NOTE',
        durationMs: 3_000,
      },
    ]);
  });

  it('lands on a reply streamed in this window, which carries no metadata yet', () => {
    const live = { id: reply.id, role: 'assistant', content: 'Done.' } as Message;
    const merged = withAttachments([live], payload)?.[0];
    if (merged === undefined) throw new Error('the reply was not found');
    // Read back through the same projection the transcript uses.
    const row = toTranscriptMessage(merged, 'clxbot000000000000000001');
    expect(row.author).toBe('BOT');
    expect(row.attachments?.map((a) => a.kind)).toEqual(['VOICE_NOTE']);
  });

  it('changes nothing for a message this window does not hold, or a file it already shows', () => {
    expect(withAttachments([], payload)).toBeNull();
    const once = withAttachments([reply], payload);
    expect(once).not.toBeNull();
    expect(withAttachments(once ?? [], payload)).toBeNull();
  });
});
