-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "groupId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lastReadAt" TIMESTAMP(3);

-- D-131: history written before unread tracking existed was all seen in the
-- app that had no badge, so it starts read. A new conversation starts at null.
UPDATE "Conversation" SET "lastReadAt" = CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "BotGroup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "collapsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotGroup_userId_sortOrder_idx" ON "BotGroup"("userId", "sortOrder");

-- CreateIndex
CREATE INDEX "Bot_groupId_idx" ON "Bot"("groupId");

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BotGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotGroup" ADD CONSTRAINT "BotGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
