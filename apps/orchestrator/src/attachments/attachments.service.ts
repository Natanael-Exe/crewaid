import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Attachment, AttachmentKind } from '@prisma/client';
import { ATTACHMENT_MAX_BYTES, type Principal } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ARTIFACT_STORE, type ArtifactStore } from './artifact-store.js';
import { UNCLAIMED_TTL_MS } from './attachments.config.js';
import { DiskArtifactStore } from './disk-artifact-store.js';
import { AttachmentReaperService } from './reaper.service.js';

/** TTL fence; expired uploads are reaped, and M8 may move the scheduler. */
export { UNCLAIMED_TTL_MS };

export type ModelAttachment = {
  filename: string;
  mimeType: string;
  /** a voice note's words are the message itself, never its contents. */
  kind: AttachmentKind;
  /** Present only for images sent to a vision-capable model. */
  data?: Uint8Array;
};

/**
 * the audio a voice message records as, or a spoken reply is made in.
 * Shared with the voice routes so a clip is admitted by one list.
 */
export const VOICE_MIME_TYPES: readonly string[] = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
];

/**
 * A recorder labels its clip `audio/webm;codecs=opus`; the parameters say how
 * it was encoded, not what it is, so they are not part of the type admitted.
 */
export function baseMimeType(mimetype: string | undefined): string {
  const base = (mimetype ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return base === '' ? 'application/octet-stream' : base;
}

/**
 * Attachment storage (: `POST /attachments`, multipart).
 *
 * rows carry a `storageKey` — the object's key in the artifact store
 * (: R2, or ARTIFACT_DIR on a self-hosted server without it). Keys are a
 * per-day prefix plus a random name: a user-supplied filename never becomes a
 * key on its own, so `../../.env` style names cannot address anything. The
 * original filename lives in the DB row only.
 */
@Injectable()
export class AttachmentsService {
  /** Configurable like every §5/§7 budget; 25 MiB covers screenshots and CSVs. */
  static readonly MAX_BYTES = ATTACHMENT_MAX_BYTES;

  /** Anything an operator legitimately attaches to a bot conversation. */
  private static readonly ALLOWED_MIME = new Set([
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/json',
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/zip',
    // Screen-recording evidence arrives through attach_file as an mp4/webm;
    // both play in the desktop's inline preview, so there is no reason to
    // force an operator to download a file to watch it.
    'video/mp4',
    'video/webm',
    // voice messages and spoken replies, and audio a bot attaches.
    ...VOICE_MIME_TYPES,
  ]);

  private readonly logger = new Logger(AttachmentsService.name);

  // Explicit token: vitest/esbuild does not emit design:paramtypes, so
  // type-based DI resolution silently fails in the integration suite.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AttachmentReaperService) private readonly reaper: AttachmentReaperService,
    // Optional so a suite constructing the service directly keeps the disk
    // store it was written against; the module always provides one.
    @Optional()
    @Inject(ARTIFACT_STORE)
    private readonly artifacts: ArtifactStore = new DiskArtifactStore(),
  ) {}

  async store(
    owner: Pick<Principal, 'userId'>,
    file: {
      originalname?: string;
      mimetype?: string;
      size?: number;
      buffer?: Buffer;
    },
    /** a voice note, and how long it lasts when that is known. */
    options: { readonly kind?: AttachmentKind; readonly durationMs?: number | null } = {},
  ): Promise<Attachment> {
    if (file.buffer === undefined || file.buffer.length === 0) {
      throw new BadRequestException('Empty upload');
    }
    const buffer = file.buffer;
    if (buffer.length > AttachmentsService.MAX_BYTES) {
      throw new PayloadTooLargeException(
        `Attachment exceeds ${AttachmentsService.MAX_BYTES} bytes`,
      );
    }

    const mimeType = baseMimeType(file.mimetype);
    if (!AttachmentsService.ALLOWED_MIME.has(mimeType)) {
      throw new BadRequestException(`Unsupported media type: ${mimeType}`);
    }

    // Judge capacity against live data — reap expired
    // unclaimed uploads first, then refuse (507) if the cumulative quota or
    // the disk-pressure floor is breached. Claimed and unexpired files are
    // never evicted to make room; reaping is the only thing that frees space.
    await this.reaper.reapIfStale();
    const day = new Date().toISOString().slice(0, 10);
    const filename = sanitizeFilename(file.originalname);
    // Random storage name — the user filename never becomes a path segment.
    const storageKey = path.posix.join(day, `${randomUUID()}-${filename}`);

    const stored = await this.reaper.reserveUploadCapacity(owner.userId, buffer.length, (tx) =>
      tx.attachment.create({
        data: {
          // Unclaimed until a message send references it.
          messageId: null,
          // Ownership from creation, not from claiming.
          ownerId: owner.userId,
          filename,
          mimeType,
          sizeBytes: buffer.length,
          storageKey,
          kind: options.kind ?? 'FILE',
          durationMs: options.durationMs ?? null,
        },
      }),
    );

    try {
      await this.artifacts.put(storageKey, buffer, mimeType);
      return stored;
    } catch (error) {
      // The id is not exposed until this method returns, so a failed write's
      // fresh reservation cannot legitimately have been claimed. Keep the
      // delete fenced anyway so future call paths cannot turn that assumption
      // into a claimed row whose bytes are removed here.
      await this.prisma.attachment
        .deleteMany({ where: { id: stored.id, ownerId: owner.userId, messageId: null } })
        .catch((cleanupError: unknown) => {
          this.logger.error(
            `could not release failed upload reservation ${stored.id}: ${String(cleanupError)}`,
          );
        });
      await this.artifacts.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Bind an unclaimed upload to a message (the `attach_file`).
   *
   * The D-021 filter is the same one `MessagesService` applies when a USER
   * message claims its uploads, and for the same reason: the row must be
   * UNCLAIMED and owned by THIS principal. Without both, a bot could bind
   * somebody else's upload to its own reply and hand the operator a download
   * link to a file they never uploaded — the IDOR chain D-021 exists to
   * break, arriving through a tool instead of a request.
   *
   * `updateMany` rather than `update`: the filter IS the fence, and a
   * zero-count means the row did not match it rather than that it vanished.
   */
  async claimForMessage(userId: string, attachmentId: string, messageId: string): Promise<void> {
    const claimed = await this.prisma.attachment.updateMany({
      where: { id: attachmentId, ownerId: userId, messageId: null, deliverable: null },
      data: { messageId },
    });
    if (claimed.count !== 1) {
      throw new NotFoundException('Unknown, foreign, or already-attached attachment id');
    }
  }

  /**
   * `GET /attachments/:id/download` — opens the stored object or 404s.
   *
   * The two ownership arms, matching the two lifecycle states:
   *  - CLAIMED rows resolve through message → conversation → bot → userId
   *    (the message lifecycle owns them once bound).
   *  - UNCLAIMED rows resolve by ownerId directly — the uploader may fetch
   *    their own file back before claiming it. A foreign unclaimed row is a
   *    404 that does not leak existence.
   */
  async openForDownload(
    userId: string,
    attachmentId: string,
  ): Promise<{ attachment: Attachment; stream: Readable }> {
    const attachment = await this.findReadable(userId, attachmentId);
    const stream = await this.artifacts.open(attachment.storageKey);
    if (stream === null) throw this.vanished(attachment);
    return { attachment, stream };
  }

  /** The row a caller may read, after both D-021 arms and the D-020 expiry fence. */
  private async findReadable(userId: string, attachmentId: string): Promise<Attachment> {
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        OR: [
          // D-021 arm 2: uploader ownership authorizes only while unclaimed.
          { ownerId: userId, messageId: null },
          // D-021 arm 1: after claim, the message lifecycle owns access.
          { message: { conversation: { bot: { userId } } } },
        ],
      },
      include: { deliverable: { select: { id: true } } },
    });
    if (attachment === null) {
      throw new NotFoundException('Attachment not found');
    }

    // Expiry is a READ fence too. Check after ownership resolution so
    // foreign callers still receive the non-leaking 404, and before the store
    // is asked for anything so expired bytes are never touched. Claimed rows
    // belong to the message lifecycle and are not subject to the unclaimed
    // TTL, and neither is a file a deliverable holds after its message was
    // deleted.
    if (
      attachment.messageId === null &&
      attachment.deliverable === null &&
      Date.now() - attachment.createdAt.getTime() > UNCLAIMED_TTL_MS
    ) {
      throw expiredAttachment();
    }
    return attachment;
  }

  /**
   * A row whose bytes are gone is a server fault, not a 404: the row says the
   * file exists. Loud in the log, a plain 500 to the client.
   */
  private vanished(attachment: Pick<Attachment, 'id' | 'storageKey'>): Error {
    this.logger.error(
      `attachment ${attachment.id} has no stored object at ${attachment.storageKey}`,
    );
    return new InternalServerErrorException();
  }

  /** Read only files claimed by this message in this owner's bot conversation. */
  async forModel(
    userId: string,
    botId: string,
    messageId: string,
    includeImages: boolean,
  ): Promise<ModelAttachment[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { messageId, message: { conversation: { botId, bot: { userId } } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, filename: true, mimeType: true, kind: true },
    });

    return Promise.all(
      rows.map(async (row) => {
        if (!includeImages || !row.mimeType.startsWith('image/')) {
          return { filename: row.filename, mimeType: row.mimeType, kind: row.kind };
        }
        // Reuse the download path's ownership and expiry fences before loading
        // bytes. The upload limit already bounds each image to 25 MiB.
        const attachment = await this.findReadable(userId, row.id);
        const data = await this.artifacts.get(attachment.storageKey);
        if (data === null) throw this.vanished(attachment);
        return { filename: row.filename, mimeType: row.mimeType, kind: row.kind, data };
      }),
    );
  }

  /**
   * J3 / D-020 addendum: `DELETE /attachments/:id` — the manual fallback for
   * the UNCLAIMED case only. Claimed rows belong to the message lifecycle
   * (cascade via conversation delete), so they answer 409, never delete.
   * Also removes the stored object.
   */
  async removeUnclaimed(userId: string, attachmentId: string, ttlMs: number): Promise<void> {
    // createdAt is selected explicitly: Prisma 7's default payload omits it
    // (verified against the generated field list), and the J3 TTL fence
    // needs it.
    const attachment = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, ownerId: userId },
      select: {
        id: true,
        messageId: true,
        storageKey: true,
        createdAt: true,
        deliverable: { select: { id: true } },
      },
    });
    if (attachment === null) {
      // Foreign or unknown — same non-leaking 404 as every other route.
      throw new NotFoundException('Attachment not found');
    }
    if (attachment.messageId !== null || attachment.deliverable !== null) {
      // J3 fence: claimed rows are not deletable through this route, and a
      // file a deliverable holds is claimed by it.
      throw claimedAttachment();
    }
    // J3 fence (ratified interim): unclaimed rows older than the TTL answer
    // 410 Gone — they are scheduled for the M8 reaper, not user-recoverable
    // forever, and the 410 is semantically honest about that.
    if (Date.now() - attachment.createdAt.getTime() > ttlMs) {
      throw expiredAttachment();
    }

    const cutoff = new Date(Date.now() - ttlMs);
    const deletion = await this.prisma.attachment.deleteMany({
      where: {
        id: attachment.id,
        ownerId: userId,
        messageId: null,
        deliverable: null,
        createdAt: { gte: cutoff },
      },
    });
    if (deletion.count === 0) {
      // The row changed after the pre-check. Reclassify through the same
      // owner-scoped view: foreign/deleted stays 404, a concurrent claim is
      // 409, and a row that crossed the TTL boundary is 410. Never issue an
      // id-only delete to avoid a TOCTOU race across ownership/claim state.
      const current = await this.prisma.attachment.findFirst({
        where: { id: attachment.id, ownerId: userId },
        select: { messageId: true, createdAt: true, deliverable: { select: { id: true } } },
      });
      if (current === null) {
        throw new NotFoundException('Attachment not found');
      }
      if (current.messageId !== null || current.deliverable !== null) {
        throw claimedAttachment();
      }
      if (Date.now() - current.createdAt.getTime() > ttlMs) {
        throw expiredAttachment();
      }
      throw new ConflictException('Attachment changed concurrently; retry the request');
    }

    await this.removeStoredFiles([attachment.storageKey]);
  }

  /**
   * Removes the stored bytes of rows already deleted — the attachments of a
   * deleted bot's conversation, which went with it through the foreign keys
   * (PRD-WORK §8: deleting a bot deletes its deliverables and their files).
   *
   * Best effort by design: it runs after the deleting transaction commits, so
   * a failed attempt leaves its deletion record for the reaper.
   */
  async removeStoredFiles(storageKeys: readonly string[]): Promise<number> {
    let removed = 0;
    for (const key of storageKeys) {
      try {
        await this.artifacts.delete(key);
        await this.prisma.artifactDeletion.deleteMany({ where: { storageKey: key } });
        removed += 1;
      } catch (error: unknown) {
        this.logger.warn(`could not remove attachment object ${key}: ${String(error)}`);
      }
    }
    return removed;
  }
}

function claimedAttachment(): ConflictException {
  return new ConflictException('Attachment is claimed by a message and cannot be deleted');
}

function expiredAttachment(): GoneException {
  return new GoneException('Unclaimed attachment expired; it will be reaped by the server');
}

/**
 * D-019 upload lifecycle: uploads are unclaimed (`messageId: null`) until a
 * POST /bots/:id/messages with `attachmentIds` claims them (MessagesService
 * re-parents them in the send transaction). Expired unclaimed uploads are
 * physically reaped by `AttachmentReaperService`.
 */
function sanitizeFilename(name: string | undefined): string {
  const base = path.basename(name ?? 'attachment').replace(/[^A-Za-z0-9._-]/g, '_');
  return base.length > 0 ? base.slice(-128) : 'attachment';
}
