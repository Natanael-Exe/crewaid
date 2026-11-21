import {
  Controller,
  Delete,
  Inject,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Principal } from '@crewaid/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { OwnedResource } from '../ownership/owned-resource.decorator.js';
import { AttachmentsService, UNCLAIMED_TTL_MS } from './attachments.service.js';
import { toUploadPayload } from './upload-payload.js';
import { D022_MULTER_LIMITS, multerErrorToHttp } from './d022-limits.js';

export { UNCLAIMED_TTL_MS } from './attachments.service.js';

/**
 * Attachment routes.
 *
 * POST /attachments — multipart upload (`file` field), returns
 * `{id, filename, mimeType, sizeBytes, storageKey}`. The row is unclaimed
 * until a message send references it.
 * GET /attachments/:id/download — streams the file from the artifact store
 * (REST, D-220), so R2 bytes never land on this host's disk. Response headers
 * ride on StreamableFile's options, so this module needs no @types/express.
 * Ownership is resolved through message → conversation → bot → userId.
 */
@Controller('attachments')
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Post()
  // Limits are deliberate config, not Multer defaults. The error
  // mapper below turns Multer's limit rejections into the ratified 413.
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { ...D022_MULTER_LIMITS },
    }),
  )
  async upload(
    @UploadedFile() file: unknown,
    @CurrentUser() principal: Principal,
  ): Promise<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
  }> {
    if (
      typeof file === 'object' &&
      file !== null &&
      'originalname' in file === false &&
      'buffer' in file === false &&
      'code' in file
    ) {
      // Multer limit rejection surfaces as req.file = { code, fieldname? }.
      throw multerErrorToHttp(file);
    }
    // Ownership binds at creation — the uploading principal is the owner.
    const payload = toUploadPayload(file);
    const stored = await this.attachments.store(principal, payload);
    return {
      id: stored.id,
      filename: stored.filename,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      storageKey: stored.storageKey,
    };
  }

  /**
   * J3 / D-020 addendum: manual fallback for UNCLAIMED uploads only.
   * 404 foreign/unknown · 409 claimed · 410 past the interim TTL.
   */
  @Delete(':id')
  @OwnedResource('attachment')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.attachments.removeUnclaimed(principal.userId, id, UNCLAIMED_TTL_MS);
  }

  @Get(':id/download')
  @OwnedResource('attachment')
  async download(
    @Param('id') id: string,
    @CurrentUser() principal: Principal,
  ): Promise<StreamableFile> {
    const { attachment, stream } = await this.attachments.openForDownload(principal.userId, id);
    return new StreamableFile(stream, {
      type: attachment.mimeType,
      disposition: `attachment; filename="${attachment.filename}"`,
    });
  }
}
