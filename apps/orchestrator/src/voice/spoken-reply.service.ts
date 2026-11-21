import { Inject, Injectable } from '@nestjs/common';
import { speakable } from '@crewaid/shared';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { spokenDurationMs } from '../models/voice/voice-engine.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VoiceService } from './voice.service.js';

/** The run a spoken reply answers, as the producer that settled it knows it. */
export type SpokenRun = {
  readonly userId: string;
  readonly botId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly triggerMessageId: string;
};

/**
 * A voice message is answered aloud.
 *
 * When a run that a person's voice message started completes, its last
 * written reply is rewritten for the ear (`speakable`), read in the bot's
 * voice, and attached to that reply as a `VOICE_NOTE`. The written reply is
 * already on screen and stays the record; the clip follows it.
 *
 * Observational, like every announcement: a clip that cannot be made is
 * logged and the conversation goes on. It never fails, reopens or delays the
 * run — the producer hands off to the next trigger without waiting for it.
 */
@Injectable()
export class SpokenReplyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VoiceService) private readonly voice: VoiceService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  /** Start the clip and return at once. */
  replyAloud(run: SpokenRun): void {
    void this.speakReply(run).catch((error: unknown) => {
      this.logger.warn('voice.reply.failed', {
        botId: run.botId,
        runId: run.runId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  }

  /** The clip's attachment id, or null when this run is not answered aloud. */
  async speakReply(run: SpokenRun): Promise<string | null> {
    const spoken = await this.prisma.attachment.count({
      where: {
        messageId: run.triggerMessageId,
        kind: 'VOICE_NOTE',
        message: {
          author: 'USER',
          conversation: { botId: run.botId, bot: { userId: run.userId } },
        },
      },
    });
    if (spoken === 0) return null;

    const reply = await this.prisma.message.findFirst({
      where: {
        conversationId: run.threadId,
        runId: run.runId,
        author: 'BOT',
        content: { not: '' },
        conversation: { botId: run.botId, bot: { userId: run.userId } },
      },
      orderBy: { sequence: 'desc' },
      select: { id: true, content: true },
    });
    if (reply === null) return null;
    const text = speakable(reply.content);
    if (text === '') return null;

    const bot = await this.prisma.bot.findFirst({
      where: { id: run.botId, userId: run.userId },
      select: { voiceId: true },
    });
    const audio = await this.voice.speak(run.userId, text, bot?.voiceId ?? null);

    const stored = await this.attachments.store(
      { userId: run.userId },
      {
        originalname: 'spoken-reply.mp3',
        mimetype: 'audio/mpeg',
        size: audio.length,
        buffer: Buffer.from(audio),
      },
      { kind: 'VOICE_NOTE', durationMs: spokenDurationMs(audio.length) },
    );
    await this.attachments.claimForMessage(run.userId, stored.id, reply.id);
    this.events.emitMessageAttachments(run.botId, reply.id, [
      {
        id: stored.id,
        messageId: reply.id,
        filename: stored.filename,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        kind: stored.kind,
        durationMs: stored.durationMs,
      },
    ]);
    return stored.id;
  }
}
