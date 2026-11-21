import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  VOICE_ALLOWANCE_EXHAUSTED_CODE,
  type VoiceNoteResponse,
  type VoiceOption,
  type VoiceTranscriptionResponse,
} from '@crewaid/shared';
import {
  AttachmentsService,
  VOICE_MIME_TYPES,
  baseMimeType,
} from '../attachments/attachments.service.js';
import { CredentialService } from '../credentials/credential.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import {
  HOSTED_VOICE,
  type HostedVoice,
  VoiceAllowanceExhaustedError,
  type VoiceUsage,
} from '../models/voice/hosted-voice.port.js';
import {
  HOUSE_VOICE_ID,
  VOICE_ENGINE_FACTORY,
  estimatedSeconds,
  estimatedSpokenSeconds,
  spokenDurationMs,
  type Transcript,
  type VoiceEngine,
  type VoiceEngineFactory,
} from '../models/voice/voice-engine.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The largest clip either route takes. Five minutes of opus is near 1.2 MB;
 * the slack is for recorders that pick a higher bitrate, and the bound is what
 * keeps a dropped Stop button from becoming an hour of metered transcription.
 */
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;

type UploadedClip = {
  readonly originalname?: string;
  readonly mimetype?: string;
  readonly buffer?: Buffer;
};

type Access = {
  readonly engine: VoiceEngine;
  /** Runs one provider call, counted against a plan when the key is Crewaid's. */
  meter<T>(
    usage: VoiceUsage,
    estimateSeconds: number,
    run: () => Promise<{ readonly value: T; readonly seconds: number }>,
  ): Promise<T>;
};

/**
 * Listening and speaking for one person.
 *
 * Whose key does the work is decided here and nowhere else: Crewaid's, when
 * this server carries the hosted key (a cloud server, metered against the
 * plan), otherwise the person's own ElevenLabs connection. Nothing a caller
 * sends can choose between them.
 */
@Injectable()
export class VoiceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CredentialService) private readonly credentials: CredentialService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(VOICE_ENGINE_FACTORY) private readonly engines: VoiceEngineFactory,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Optional() @Inject(HOSTED_VOICE) private readonly hosted?: HostedVoice,
  ) {}

  /** Whether this person can dictate, send voice messages and hear replies. */
  async configured(userId: string): Promise<boolean> {
    return this.hosted !== undefined || (await this.ownConnectionId(userId)) !== null;
  }

  /** Dictation: the words, and nothing kept. */
  async transcribe(userId: string, clip: UploadedClip): Promise<VoiceTranscriptionResponse> {
    const audio = admitClip(clip);
    const transcript = await this.listen(userId, audio);
    return { text: transcript.text, languageCode: transcript.languageCode };
  }

  /**
   * A voice message: transcribed first, so a clip nobody could make out
   * leaves nothing behind, then stored unclaimed like any upload.
   */
  async storeNote(userId: string, clip: UploadedClip): Promise<VoiceNoteResponse> {
    const audio = admitClip(clip);
    const transcript = await this.listen(userId, audio);
    if (transcript.text === '') {
      throw new BadRequestException('No speech was heard in that recording');
    }
    const stored = await this.attachments.store(
      { userId },
      {
        originalname: `voice-message.${extensionFor(audio.mimeType)}`,
        mimetype: audio.mimeType,
        size: audio.bytes.length,
        buffer: audio.bytes,
      },
      {
        kind: 'VOICE_NOTE',
        durationMs:
          transcript.durationSeconds === null
            ? null
            : Math.round(transcript.durationSeconds * 1000),
      },
    );
    return {
      attachment: {
        id: stored.id,
        filename: stored.filename,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        kind: stored.kind,
        durationMs: stored.durationMs,
      },
      transcript: transcript.text,
    };
  }

  async voices(userId: string): Promise<VoiceOption[]> {
    const access = await this.access(userId);
    try {
      return await access.engine.listVoices();
    } catch (error) {
      throw this.unreachable('voice.list.failed', error);
    }
  }

  /** One mp3 of `text`, for a spoken reply. Throws as the routes do. */
  async speak(userId: string, text: string, voiceId: string | null): Promise<Uint8Array> {
    const access = await this.access(userId);
    return access.meter('speak', estimatedSpokenSeconds(text), async () => {
      let value: Uint8Array;
      try {
        value = await access.engine.speak(text, voiceId ?? HOUSE_VOICE_ID);
      } catch (error) {
        throw this.unreachable('voice.speak.failed', error);
      }
      return { value, seconds: spokenDurationMs(value.length) / 1000 };
    });
  }

  private async listen(
    userId: string,
    audio: { readonly bytes: Buffer; readonly mimeType: string },
  ): Promise<Transcript> {
    const access = await this.access(userId);
    return access.meter('listen', estimatedSeconds(audio.bytes.length), async () => {
      let transcript: Transcript;
      try {
        transcript = await access.engine.transcribe(audio);
      } catch (error) {
        throw this.unreachable('voice.transcribe.failed', error);
      }
      return {
        value: transcript,
        seconds: transcript.durationSeconds ?? estimatedSeconds(audio.bytes.length),
      };
    });
  }

  private async access(userId: string): Promise<Access> {
    const hosted = this.hosted;
    if (hosted !== undefined) {
      return {
        engine: this.engines(hosted.apiKey),
        meter: async (usage, estimate, run) => {
          try {
            return await hosted.meter(userId, usage, estimate, run);
          } catch (error) {
            if (error instanceof VoiceAllowanceExhaustedError) {
              throw new HttpException(
                {
                  statusCode: 402,
                  code: VOICE_ALLOWANCE_EXHAUSTED_CODE,
                  usage: error.usage,
                  message:
                    error.usage === 'listen'
                      ? 'This period’s dictation and voice-message minutes are used up. They reset when your plan renews.'
                      : 'This period’s spoken-reply minutes are used up. They reset when your plan renews.',
                },
                HttpStatus.PAYMENT_REQUIRED,
              );
            }
            throw error;
          }
        },
      };
    }
    const connectionId = await this.ownConnectionId(userId);
    const key =
      connectionId === null ? null : await this.credentials.credentialFor(userId, connectionId);
    if (key === null) {
      throw new ConflictException('Voice needs an ElevenLabs key: add one under Settings → Models');
    }
    return {
      engine: this.engines(key),
      meter: async (_usage, _estimate, run) => (await run()).value,
    };
  }

  private async ownConnectionId(userId: string): Promise<string | null> {
    const row = await this.prisma.providerConnection.findFirst({
      where: { userId, kind: 'ELEVENLABS', state: 'ACTIVE' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * The rule for models holds for speech too: a vendor's error text never
   * reaches the person. The log keeps the class, never the message, because
   * a provider error can echo the request.
   */
  private unreachable(event: string, error: unknown): BadGatewayException {
    this.logger.warn(event, { errorName: error instanceof Error ? error.name : typeof error });
    return new BadGatewayException('The speech service could not be reached. Try again.');
  }
}

function admitClip(clip: UploadedClip): { bytes: Buffer; mimeType: string } {
  if (clip.buffer === undefined || clip.buffer.length === 0) {
    throw new BadRequestException('Empty recording');
  }
  if (clip.buffer.length > VOICE_MAX_BYTES) {
    throw new PayloadTooLargeException(`Recording exceeds ${VOICE_MAX_BYTES} bytes`);
  }
  const mimeType = baseMimeType(clip.mimetype);
  if (!VOICE_MIME_TYPES.includes(mimeType)) {
    throw new BadRequestException(`Unsupported recording type: ${mimeType}`);
  }
  return { bytes: clip.buffer, mimeType };
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    default:
      return 'webm';
  }
}
