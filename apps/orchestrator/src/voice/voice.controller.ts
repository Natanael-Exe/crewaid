import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  PayloadTooLargeException,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {
  Principal,
  VoiceListResponse,
  VoiceNoteResponse,
  VoiceStatusResponse,
  VoiceTranscriptionResponse,
} from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { multerErrorToHttp, MULTIPART_TEXT_LIMITS } from '../attachments/d022-limits.js';
import { toUploadPayload } from '../attachments/upload-payload.js';
import { VOICE_MAX_BYTES, VoiceService } from './voice.service.js';
import { HOUSE_VOICE_ID } from '../models/voice/voice-engine.js';

/** One clip per request, bounded before it is buffered. */
const VOICE_UPLOAD = FileInterceptor('file', {
  limits: {
    fileSize: VOICE_MAX_BYTES,
    files: 1,
    ...MULTIPART_TEXT_LIMITS,
    parts: 1 + MULTIPART_TEXT_LIMITS.fields,
  },
});

/**
 * Dictation, voice messages, and the voices a bot can speak in.
 *
 * No route carries an id, so there is nothing for an ownership marker to
 * resolve: every answer is about the principal's own key and uploads.
 */
@Controller('voice')
export class VoiceController {
  constructor(@Inject(VoiceService) private readonly voice: VoiceService) {}

  @Get('status')
  async status(@CurrentUser() principal: Principal): Promise<VoiceStatusResponse> {
    return { configured: await this.voice.configured(principal.userId) };
  }

  @Get('voices')
  async voices(@CurrentUser() principal: Principal): Promise<VoiceListResponse> {
    return { voices: await this.voice.voices(principal.userId), defaultVoiceId: HOUSE_VOICE_ID };
  }

  @Post('transcriptions')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(VOICE_UPLOAD)
  async transcribe(
    @UploadedFile() file: unknown,
    @CurrentUser() principal: Principal,
  ): Promise<VoiceTranscriptionResponse> {
    return this.voice.transcribe(principal.userId, clipFrom(file));
  }

  @Post('notes')
  @UseInterceptors(VOICE_UPLOAD)
  async note(
    @UploadedFile() file: unknown,
    @CurrentUser() principal: Principal,
  ): Promise<VoiceNoteResponse> {
    return this.voice.storeNote(principal.userId, clipFrom(file));
  }
}

function clipFrom(file: unknown) {
  if (typeof file === 'object' && file !== null && !('buffer' in file) && 'code' in file) {
    // A Multer limit rejection arrives as the file; the size is this route's own.
    const mapped = multerErrorToHttp(file);
    throw mapped instanceof PayloadTooLargeException
      ? new PayloadTooLargeException(`Recording exceeds ${VOICE_MAX_BYTES} bytes`)
      : mapped;
  }
  return toUploadPayload(file);
}
