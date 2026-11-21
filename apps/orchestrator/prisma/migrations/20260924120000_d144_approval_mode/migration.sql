-- D-144: how a bot's actions are approved. Every existing bot keeps the
-- behaviour it has today, which is AUTO.

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('ASK', 'AUTO', 'FULL');

-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "approvalMode" "ApprovalMode" NOT NULL DEFAULT 'AUTO';
