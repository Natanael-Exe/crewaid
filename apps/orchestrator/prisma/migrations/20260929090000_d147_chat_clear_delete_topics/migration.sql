-- D-147: clearing a chat or deleting a message keeps what the bot produced,
-- and `/new` marks where a turn's history starts.

-- DropForeignKey
ALTER TABLE "Deliverable" DROP CONSTRAINT "Deliverable_messageId_fkey";

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "startsTopic" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
