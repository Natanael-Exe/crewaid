import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import type { Readable } from 'node:stream';

/**
 * D-019 upload shape, decoupled from Multer's global namespace augmentation
 * (the repo pins exact deps; a transitive @types/express bump must not be able
 * to change our controller signatures).
 */
export interface UploadedFilePayload {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
  stream?: Readable;
}

export function toUploadPayload(file: unknown): UploadedFilePayload {
  if (file === undefined || file === null || typeof file !== 'object') {
    throw new BadRequestException('Multipart field "file" is required');
  }
  const candidate = file as Partial<UploadedFilePayload>;
  if (candidate.buffer === undefined && candidate.stream === undefined) {
    throw new BadRequestException('Uploaded file had no content');
  }
  return candidate;
}
