-- D-233: every person brings their own bot. A link to the retired shared bot has no token
-- to carry over, so existing links and pending codes are cleared (D-158: pre-launch).
DELETE FROM "TelegramConnection";
DELETE FROM "TelegramLinkTicket";

-- DropIndex
DROP INDEX "TelegramConnection_telegramUserId_key";

-- DropIndex
DROP INDEX "TelegramConnection_chatId_key";

-- AlterTable
ALTER TABLE "TelegramConnection" ADD COLUMN     "botUsername" TEXT NOT NULL,
ADD COLUMN     "commandsDigest" TEXT,
ADD COLUMN     "managed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "telegramBotId" TEXT NOT NULL,
ADD COLUMN     "tokenCiphertext" TEXT NOT NULL,
ADD COLUMN     "webhookSecretHash" TEXT NOT NULL,
ADD COLUMN     "webhookUrl" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "TelegramPendingBot" (
    "telegramBotId" TEXT NOT NULL,
    "botUsername" TEXT NOT NULL,
    "managed" BOOLEAN NOT NULL,
    "ownerTelegramUserId" TEXT,
    "userId" TEXT,
    "tokenCiphertext" TEXT NOT NULL,
    "webhookSecretHash" TEXT NOT NULL,
    "webhookUrl" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "claimTelegramUserId" TEXT,
    "claimChatId" TEXT,
    "claimDisplayName" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramPendingBot_pkey" PRIMARY KEY ("telegramBotId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramPendingBot_userId_key" ON "TelegramPendingBot"("userId");

-- CreateIndex
CREATE INDEX "TelegramPendingBot_ownerTelegramUserId_idx" ON "TelegramPendingBot"("ownerTelegramUserId");

-- CreateIndex
CREATE INDEX "TelegramPendingBot_expiresAt_idx" ON "TelegramPendingBot"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConnection_telegramBotId_key" ON "TelegramConnection"("telegramBotId");

-- AddForeignKey
ALTER TABLE "TelegramPendingBot" ADD CONSTRAINT "TelegramPendingBot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

