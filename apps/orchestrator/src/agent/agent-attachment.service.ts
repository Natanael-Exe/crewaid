import { extname } from 'node:path';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { AttachmentsService } from '../attachments/attachments.service.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { recordFileDeliverable, type DeliverableFiling } from '../work/file-deliverable.js';
import { extractSearchText } from '../work/search-text.js';
import { TurnEventBus } from './turn-event.bus.js';

/**
 * `attach_file`'s side of the attachment contract.
 *
 * `AttachmentsService.store` is shaped for REST multipart upload: it takes
 * what multer produced, and it leaves `messageId` null because D-019 says an
 * upload happens BEFORE the message that claims it exists. A tool is the
 * other way round — the reply it belongs to is already open — so this claims
 * the draft in the same breath. Without that the file would land unclaimed
 * and the reaper would eventually delete a file the bot told the operator it
 * had attached.
 *
 * The mime type is inferred from the extension because a sandbox path carries
 * no `Content-Type`. Unknown extensions are left to `store`'s own allowlist
 * to refuse by name rather than being guessed into something permitted —
 * §7.3 makes the sandbox the untrusted side, and a tool that could rename its
 * way past the allowlist would be the hole.
 */
const MIME_BY_EXTENSION = new Map<string, string>([
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.zip', 'application/zip'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
]);

/**
 * How old a reservation this service just made may be when it removes it
 * after a failed filing. Generous: the row is milliseconds old, and the
 * bound only exists because `removeUnclaimed` refuses rows past a TTL.
 */
const RESERVATION_CLEANUP_MS = 60 * 60 * 1000;

@Injectable()
export class AgentAttachmentService {
  constructor(
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
    // @Global LoggingModule — injectable here without a module import.
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  async storeFromBot(input: {
    userId: string;
    messageId: string;
    filename: string;
    bytes: Buffer;
    /**
     * Where the file came from and what it is about, which makes it a
     * FILE deliverable. Absent only for a caller that predates Work.
     */
    filing?: DeliverableFiling;
  }): Promise<{ id: string; filename: string; sizeBytes: number }> {
    const extension = extname(input.filename).toLowerCase();
    const mimetype = MIME_BY_EXTENSION.get(extension);
    if (mimetype === undefined) {
      throw new Error(
        `${input.filename} has no attachable type (${extension === '' ? 'no extension' : extension})`,
      );
    }

    const stored = await this.attachments.store(
      { userId: input.userId },
      {
        originalname: input.filename,
        mimetype,
        size: input.bytes.length,
        buffer: input.bytes,
      },
    );

    // D-136 / PRD-WORK §8: the claim and the deliverable commit together or
    // not at all. A file a bot attached is therefore never missing from the
    // Deliverables index; and a filing that is refused (a foreign task, a
    // task and goal that disagree) leaves no chip on the reply either — the
    // tool reports the failure and the sandbox file is still there to retry.
    let recorded: { deliverableId: string; taskId: string | null } | null = null;
    if (input.filing === undefined) {
      await this.attachments.claimForMessage(input.userId, stored.id, input.messageId);
    } else {
      const { filing } = input;
      try {
        recorded = await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.attachment.updateMany({
            where: { id: stored.id, ownerId: input.userId, messageId: null },
            data: { messageId: input.messageId },
          });
          if (claimed.count !== 1) {
            throw new NotFoundException('Unknown, foreign, or already-attached attachment id');
          }
          return recordFileDeliverable(tx, {
            userId: input.userId,
            attachmentId: stored.id,
            replyId: input.messageId,
            title: stored.filename,
            filing,
            searchText: extractSearchText(stored.filename, input.bytes),
          });
        });
      } catch (error) {
        // The unclaimed reservation goes now; the reaper is the fallback if
        // this cleanup itself fails.
        await this.attachments
          .removeUnclaimed(input.userId, stored.id, RESERVATION_CLEANUP_MS)
          .catch(() => undefined);
        throw error;
      }
    }

    // The claim is announced the moment it lands, not at the next history
    // fetch. A bot says "I've attached the recording" while it is still
    // writing the sentence, and the card has to be there when the sentence is
    // read — `message.created` for the draft went out with an empty list by
    // construction, so this frame is the only live delivery a claim has.
    // Observational: an announcement that cannot be built must never fail the
    // tool call that produced the file.
    try {
      const claimed = await this.prisma.attachment.findUnique({
        where: { id: stored.id },
        select: {
          id: true,
          messageId: true,
          filename: true,
          mimeType: true,
          sizeBytes: true,
          storageKey: true,
        },
      });
      const owner = await this.prisma.message.findUnique({
        where: { id: input.messageId },
        select: { conversation: { select: { botId: true } } },
      });
      if (claimed !== null && claimed.messageId === input.messageId && owner !== null) {
        this.events.emitMessageAttachments(owner.conversation.botId, input.messageId, [claimed]);
      }
    } catch (error) {
      // Logged, never thrown — see above.
      this.logger.error('attachment.claim.announce.failed', {
        attachmentId: stored.id,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (recorded !== null) {
      try {
        this.events.emitWorkChanged(input.userId, 'deliverable.changed', {
          deliverableId: recorded.deliverableId,
        });
        if (recorded.taskId !== null) {
          this.events.emitWorkChanged(input.userId, 'task.changed', { taskId: recorded.taskId });
        }
      } catch (error) {
        this.logger.error('deliverable.announce.failed', {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { id: stored.id, filename: stored.filename, sizeBytes: stored.sizeBytes };
  }
}
