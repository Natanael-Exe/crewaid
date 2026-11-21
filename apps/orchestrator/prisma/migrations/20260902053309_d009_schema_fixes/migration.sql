-- DropIndex
DROP INDEX "Skill_sourceRecordingId_key";

-- AlterTable
ALTER TABLE "AgentTurn" ADD COLUMN     "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cachedInputTokens" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "stopReason" TEXT;
