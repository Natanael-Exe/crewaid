import type { Prisma } from '@prisma/client';
import type { DeliverableView } from '@crewaid/shared';

/**
 * Deliverables as the views show them: the file each one points at, and the
 * titles of the task and goal it is filed under, so a chip needs no second
 * request. Newest first, with the id as the tiebreak the cursor relies on.
 */
export async function deliverableViews(
  tx: Prisma.TransactionClient,
  userId: string,
  where: Prisma.DeliverableWhereInput,
  take: number,
): Promise<DeliverableView[]> {
  const rows = await tx.deliverable.findMany({
    where: { ...where, userId },
    include: {
      attachment: true,
      bot: { select: { name: true } },
      task: { select: { id: true, title: true } },
      goal: { select: { id: true, title: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  });
  return rows.map(({ searchText: _searchText, attachment, bot, ...row }) => ({
    ...row,
    publisherName: bot?.name ?? null,
    // A deliverable's file is claimed by the reply it came with, or held by
    // the deliverable alone once that reply was deleted — reported
    // with a null message, so it still downloads but opens no conversation.
    attachment:
      attachment === null
        ? null
        : {
            id: attachment.id,
            messageId: attachment.messageId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            storageKey: attachment.storageKey,
            kind: attachment.kind,
            durationMs: attachment.durationMs,
          },
  }));
}
