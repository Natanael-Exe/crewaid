-- D-199: the AI SDK engine is deleted, so a thread no longer records which
-- engine wrote it, and a reply is linked to its run by `runId` alone.

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_agentTurnId_fkey";

-- DropIndex
DROP INDEX "Message_agentTurnId_key";

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "engine";

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "agentTurnId";

-- DropEnum
DROP TYPE "TranscriptEngine";

