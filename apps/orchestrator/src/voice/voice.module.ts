import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { TurnEventsModule } from '../agent/turn-events.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { elevenLabsVoiceEngine } from '../models/voice/elevenlabs-voice.js';
import { VOICE_ENGINE_FACTORY } from '../models/voice/voice-engine.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SpokenReplyService } from './spoken-reply.service.js';
import { VoiceController } from './voice.controller.js';
import { VoiceService } from './voice.service.js';

/**
 * Dictation, voice messages and spoken replies.
 *
 * Registered in both editions. The hosted key and its meter arrive through the
 * global `HOSTED_VOICE` token only where `BillingModule` provides it; without
 * it every account speaks on an ElevenLabs connection of its own.
 */
@Module({
  imports: [PrismaModule, LoggingModule, CredentialsModule, AttachmentsModule, TurnEventsModule],
  controllers: [VoiceController],
  providers: [
    { provide: VOICE_ENGINE_FACTORY, useValue: elevenLabsVoiceEngine },
    VoiceService,
    SpokenReplyService,
  ],
  exports: [VoiceService, SpokenReplyService],
})
export class VoiceModule {}
