-- CreateEnum
CREATE TYPE "TranscriptEngine" AS ENUM ('AI_SDK', 'TANSTACK');

-- CreateEnum
CREATE TYPE "InterruptStatus" AS ENUM ('pending', 'resolved', 'cancelled');

-- AlterEnum
-- D-159 §3.5: the library's RunStatus. INTERRUPTED meant "the worker died",
-- which the library calls failed; its code moves to errorCode first, while the
-- old value can still be read.
ALTER TABLE "AgentTurn" ADD COLUMN "errorCode" TEXT;
UPDATE "AgentTurn" SET "errorCode" = 'WORKER_LOST' WHERE "status" = 'INTERRUPTED';
CREATE TYPE "TurnStatus_new" AS ENUM ('running', 'interrupted', 'completed', 'failed', 'aborted');
ALTER TABLE "AgentTurn" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "AgentTurn" ALTER COLUMN "status" TYPE "TurnStatus_new" USING (
  CASE "status"::text
    WHEN 'RUNNING' THEN 'running'
    WHEN 'AWAITING_APPROVAL' THEN 'interrupted'
    WHEN 'SUCCEEDED' THEN 'completed'
    WHEN 'FAILED' THEN 'failed'
    WHEN 'CANCELLED' THEN 'aborted'
    WHEN 'INTERRUPTED' THEN 'failed'
  END
)::"TurnStatus_new";
ALTER TYPE "TurnStatus" RENAME TO "TurnStatus_old";
ALTER TYPE "TurnStatus_new" RENAME TO "TurnStatus";
DROP TYPE "TurnStatus_old";
ALTER TABLE "AgentTurn" ALTER COLUMN "status" SET DEFAULT 'running';

-- AlterTable
ALTER TABLE "AgentTurn" ADD COLUMN     "cancelRequested" BOOLEAN,
ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "detachedSince" TIMESTAMP(3),
ADD COLUMN     "driverEpoch" INTEGER,
ADD COLUMN     "eventsClosedAt" TIMESTAMP(3),
ADD COLUMN     "resumesRunId" TEXT,
ADD COLUMN     "sandboxKey" TEXT;

-- Every bot is created with its one conversation, so a run's thread is its
-- bot's. A run whose bot somehow has none has no thread to belong to.
UPDATE "AgentTurn" AS t SET "conversationId" = c."id"
FROM "Conversation" AS c WHERE c."botId" = t."botId";
DELETE FROM "AgentTurn" WHERE "conversationId" IS NULL;
ALTER TABLE "AgentTurn" ALTER COLUMN "conversationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "engine" "TranscriptEngine" NOT NULL DEFAULT 'AI_SDK';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "runId" TEXT,
ADD COLUMN     "sequence" SERIAL NOT NULL;

-- SERIAL numbers existing rows in physical order. Renumber them in the
-- order the transcript has always used, then continue the sequence after them.
UPDATE "Message" AS m SET "sequence" = o."rn"
FROM (SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS "rn" FROM "Message") AS o
WHERE o."id" = m."id";
SELECT setval(
  pg_get_serial_sequence('"Message"', 'sequence'),
  COALESCE((SELECT MAX("sequence") FROM "Message"), 0) + 1,
  false
);

-- CreateTable
CREATE TABLE "RunInterrupt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "InterruptStatus" NOT NULL DEFAULT 'pending',
    "sequence" SERIAL NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "response" JSONB,

    CONSTRAINT "RunInterrupt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" BIGSERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chunk" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunInterrupt_sequence_key" ON "RunInterrupt"("sequence");

-- CreateIndex
CREATE INDEX "RunInterrupt_conversationId_status_sequence_idx" ON "RunInterrupt"("conversationId", "status", "sequence");

-- CreateIndex
CREATE INDEX "RunInterrupt_runId_status_sequence_idx" ON "RunInterrupt"("runId", "status", "sequence");

-- CreateIndex
CREATE INDEX "RunInterrupt_userId_idx" ON "RunInterrupt"("userId");

-- CreateIndex
CREATE INDEX "RunEvent_runId_id_idx" ON "RunEvent"("runId", "id");

-- CreateIndex
CREATE INDEX "RunEvent_conversationId_id_idx" ON "RunEvent"("conversationId", "id");

-- CreateIndex
CREATE INDEX "RunEvent_userId_idx" ON "RunEvent"("userId");

-- CreateIndex
CREATE INDEX "AgentTurn_conversationId_startedAt_idx" ON "AgentTurn"("conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentTurn_resumesRunId_idx" ON "AgentTurn"("resumesRunId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_sequence_key" ON "Message"("sequence");

-- CreateIndex
CREATE INDEX "Message_conversationId_sequence_idx" ON "Message"("conversationId", "sequence");

-- CreateIndex
CREATE INDEX "Message_runId_idx" ON "Message"("runId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentTurn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTurn" ADD CONSTRAINT "AgentTurn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTurn" ADD CONSTRAINT "AgentTurn_resumesRunId_fkey" FOREIGN KEY ("resumesRunId") REFERENCES "AgentTurn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunInterrupt" ADD CONSTRAINT "RunInterrupt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunInterrupt" ADD CONSTRAINT "RunInterrupt_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunInterrupt" ADD CONSTRAINT "RunInterrupt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

