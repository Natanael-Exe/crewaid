-- AlterTable
ALTER TABLE "TelegramConnection" ADD COLUMN     "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "TelegramAttachmentDelivery" (
    "connectionId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,

    CONSTRAINT "TelegramAttachmentDelivery_pkey" PRIMARY KEY ("connectionId","attachmentId")
);

-- AddForeignKey
ALTER TABLE "TelegramAttachmentDelivery" ADD CONSTRAINT "TelegramAttachmentDelivery_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "TelegramConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramAttachmentDelivery" ADD CONSTRAINT "TelegramAttachmentDelivery_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
