import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  HOUSE_VOICE_ID,
  VOICE_ENGINE_FACTORY,
  type VoiceEngine,
  type VoiceEngineFactory,
} from '../src/models/voice/voice-engine.js';
import { SpokenReplyService } from '../src/voice/spoken-reply.service.js';
import { SPOKEN_NOTE } from '../src/agent/execution/provider-context.js';
import { TurnEventBus } from '../src/agent/turn-event.bus.js';
import { signIn, signOutAndDelete } from './auth-fixture.js';

/**
 * D-221 — dictation, voice messages and spoken replies, against the real
 * routes and database with the speech provider faked at its one port.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const MP3 = Buffer.from('ID3 a spoken reply');
const CLIP = Buffer.from('webm opus clip bytes');

type Call =
  | { kind: 'transcribe'; key: string; mimeType: string }
  | { kind: 'speak'; key: string; text: string; voiceId: string }
  | { kind: 'voices'; key: string };

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')('D-221 voice', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let userId: string;
  const calls: Call[] = [];
  let heard = 'Check the leads sheet please';
  let failSpeech = false;

  const fakeFactory: VoiceEngineFactory = (key): VoiceEngine => ({
    async transcribe(audio) {
      calls.push({ kind: 'transcribe', key, mimeType: audio.mimeType });
      return { text: heard, languageCode: 'en', durationSeconds: 4.2 };
    },
    async speak(text, voiceId) {
      calls.push({ kind: 'speak', key, text, voiceId });
      if (failSpeech) throw new Error('vendor says: quota exceeded for sk_live_secret');
      return new Uint8Array(MP3);
    },
    async listVoices() {
      calls.push({ kind: 'voices', key });
      return [{ id: 'voice-a', name: 'Ada' }];
    },
  });

  const previousKeyring = process.env['CREWAID_CREDENTIAL_KEYRING'];

  beforeAll(async () => {
    process.env['ARTIFACT_DIR'] ??= mkdtempSync(join(tmpdir(), 'crewaid-voice-'));
    // A saved ElevenLabs key goes through the same vault as a model key.
    process.env['CREWAID_CREDENTIAL_KEYRING'] = JSON.stringify({ 1: 'ab'.repeat(32) });
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { CrewaidWsAdapter } = await import('../src/ws/crewaid-ws.adapter.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(VOICE_ENGINE_FACTORY)
      .useValue(fakeFactory)
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CrewaidWsAdapter(app));
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    ({ token, userId } = await signIn(prisma, { label: 'voice' }));
  });

  afterAll(async () => {
    if (prisma !== undefined && userId !== undefined) await signOutAndDelete(prisma, userId);
    await app?.close();
    if (previousKeyring === undefined) delete process.env['CREWAID_CREDENTIAL_KEYRING'];
    else process.env['CREWAID_CREDENTIAL_KEYRING'] = previousKeyring;
  });

  beforeEach(() => {
    calls.length = 0;
    heard = 'Check the leads sheet please';
    failSpeech = false;
  });

  const auth = (req: request.Test): request.Test => req.set('authorization', `Bearer ${token}`);
  const server = () => request(app.getHttpServer());
  const clip = (path: string, contentType = 'audio/webm;codecs=opus') =>
    auth(
      server()
        .post(`/api/v1/voice/${path}`)
        .attach('file', CLIP, { filename: 'clip.webm', contentType }),
    );

  async function connectKey(apiKey: string): Promise<void> {
    const res = await auth(server().post('/api/v1/providers/connections')).send({
      kind: 'elevenlabs',
      name: 'ElevenLabs',
      apiKey,
    });
    expect(res.status).toBe(201);
  }

  // Ordered: the first cases run before this account has a key.
  it('is not configured, and refuses 409, until the account has a key', async () => {
    const status = await auth(server().get('/api/v1/voice/status'));
    expect(status.body).toEqual({ configured: false });
    const refused = await clip('transcriptions');
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('ElevenLabs key');
    expect(calls).toEqual([]);
  });

  it('listens on the account’s own key once one is saved', async () => {
    await connectKey('sk_el_test_own');
    const status = await auth(server().get('/api/v1/voice/status'));
    expect(status.body).toEqual({ configured: true });

    const res = await clip('transcriptions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'Check the leads sheet please', languageCode: 'en' });
    // The codec parameter describes the encoding, not the type admitted.
    expect(calls).toEqual([{ kind: 'transcribe', key: 'sk_el_test_own', mimeType: 'audio/webm' }]);
  });

  it('keeps nothing from dictation', async () => {
    const before = await prisma.attachment.count({ where: { ownerId: userId } });
    await clip('transcriptions');
    expect(await prisma.attachment.count({ where: { ownerId: userId } })).toBe(before);
  });

  it('stores a voice message unclaimed, as a voice note with its length', async () => {
    const res = await clip('notes');
    expect(res.status).toBe(201);
    expect(res.body.transcript).toBe('Check the leads sheet please');
    expect(res.body.attachment).toMatchObject({
      mimeType: 'audio/webm',
      kind: 'VOICE_NOTE',
      durationMs: 4200,
      filename: 'voice-message.webm',
    });
    const row = await prisma.attachment.findFirst({
      where: { id: res.body.attachment.id, ownerId: userId },
    });
    expect(row).toMatchObject({ messageId: null, kind: 'VOICE_NOTE' });
  });

  it('keeps no clip nobody could make out', async () => {
    heard = '';
    const before = await prisma.attachment.count({ where: { ownerId: userId } });
    const res = await clip('notes');
    expect(res.status).toBe(400);
    expect(await prisma.attachment.count({ where: { ownerId: userId } })).toBe(before);
  });

  it('refuses a recording that is not audio before calling the provider', async () => {
    const res = await clip('notes', 'application/pdf');
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('lists the voices the account can speak in', async () => {
    const res = await auth(server().get('/api/v1/voice/voices'));
    expect(res.body).toEqual({
      voices: [{ id: 'voice-a', name: 'Ada' }],
      defaultVoiceId: HOUSE_VOICE_ID,
    });
  });

  it('refuses a model on a speech key', async () => {
    const list = await auth(server().get('/api/v1/providers/connections'));
    const connection = (list.body.connections as Array<{ id: string; kind: string }>).find(
      (row) => row.kind === 'elevenlabs',
    );
    expect(connection).toBeDefined();
    const res = await auth(
      server().post(`/api/v1/providers/connections/${connection!.id}/models`),
    ).send({
      upstreamModelId: 'gpt-4o',
      label: 'GPT-4o',
      contextWindow: 128000,
      capabilities: { tools: true, vision: false, reasoning: false },
    });
    expect(res.status).toBe(400);
  });

  describe('a spoken reply', () => {
    async function conversationWith(options: { readonly voiceNote: boolean }) {
      const bot = await prisma.bot.create({
        data: {
          userId,
          name: 'Pixel',
          role: 'Researcher',
          avatarColor: '#334455',
          systemPrompt: '',
          voiceId: 'voice-a',
        },
      });
      const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
      const trigger = await prisma.message.create({
        data: { conversationId: conversation.id, author: 'USER', content: heard },
      });
      await prisma.attachment.create({
        data: {
          ownerId: userId,
          messageId: trigger.id,
          filename: options.voiceNote ? 'voice-message.webm' : 'song.mp3',
          mimeType: options.voiceNote ? 'audio/webm' : 'audio/mpeg',
          sizeBytes: CLIP.length,
          storageKey: `voice-test/${trigger.id}`,
          kind: options.voiceNote ? 'VOICE_NOTE' : 'FILE',
        },
      });
      const run = await prisma.agentTurn.create({
        data: {
          botId: bot.id,
          conversationId: conversation.id,
          triggerMessageId: trigger.id,
          status: 'completed',
        },
      });
      // Two replies in one run: the spoken one is the last written.
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          author: 'BOT',
          fromBotId: bot.id,
          content: 'Looking now.',
          runId: run.id,
        },
      });
      const reply = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          author: 'BOT',
          fromBotId: bot.id,
          content: 'Three leads replied. See `sheets/leads.csv`.',
          runId: run.id,
        },
      });
      return {
        run: {
          userId,
          botId: bot.id,
          threadId: conversation.id,
          runId: run.id,
          triggerMessageId: trigger.id,
        },
        replyId: reply.id,
      };
    }

    it('reads the run’s last reply in the bot’s voice and attaches it to that reply', async () => {
      const { run, replyId } = await conversationWith({ voiceNote: true });
      const frames: unknown[] = [];
      const bus = app.get(TurnEventBus);
      const original = bus.emitMessageAttachments.bind(bus);
      bus.emitMessageAttachments = (botId, messageId, attachments) => {
        frames.push({ botId, messageId, attachments });
        original(botId, messageId, attachments);
      };
      try {
        const id = await app.get(SpokenReplyService).speakReply(run);
        expect(id).not.toBeNull();
        expect(calls).toEqual([
          {
            kind: 'speak',
            key: 'sk_el_test_own',
            text: 'Three leads replied. See leads.csv.',
            voiceId: 'voice-a',
          },
        ]);
        const clipRow = await prisma.attachment.findFirst({ where: { id: id!, ownerId: userId } });
        expect(clipRow).toMatchObject({
          messageId: replyId,
          kind: 'VOICE_NOTE',
          mimeType: 'audio/mpeg',
          // 128 kbit/s mp3: a length the player can show before it loads.
          durationMs: Math.round(MP3.length / 16),
        });
        expect(frames).toEqual([
          expect.objectContaining({
            botId: run.botId,
            messageId: replyId,
            attachments: [
              expect.objectContaining({
                id,
                kind: 'VOICE_NOTE',
                durationMs: Math.round(MP3.length / 16),
              }),
            ],
          }),
        ]);
      } finally {
        bus.emitMessageAttachments = original;
      }
    });

    it('falls back to the house voice for a bot without one', async () => {
      const { run } = await conversationWith({ voiceNote: true });
      await prisma.bot.updateMany({ where: { id: run.botId, userId }, data: { voiceId: null } });
      await app.get(SpokenReplyService).speakReply(run);
      expect(calls).toEqual([expect.objectContaining({ kind: 'speak', voiceId: HOUSE_VOICE_ID })]);
    });

    it('stays silent for a message that was not spoken, even with audio attached', async () => {
      const { run } = await conversationWith({ voiceNote: false });
      expect(await app.get(SpokenReplyService).speakReply(run)).toBeNull();
      expect(calls).toEqual([]);
    });

    it('never puts the provider’s words in front of anyone', async () => {
      const { run, replyId } = await conversationWith({ voiceNote: true });
      failSpeech = true;
      await expect(app.get(SpokenReplyService).speakReply(run)).rejects.toThrow(
        'The speech service could not be reached. Try again.',
      );
      expect(
        await prisma.attachment.count({ where: { messageId: replyId, kind: 'VOICE_NOTE' } }),
      ).toBe(0);
    });
  });

  it('tells the model how a spoken message arrived', () => {
    expect(SPOKEN_NOTE).toContain('voice message');
  });
});
