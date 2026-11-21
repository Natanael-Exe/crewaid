-- D-197: the dispatch ledger.
CREATE TYPE "DispatchStatus" AS ENUM ('DISPATCHED', 'COMMITTED', 'REFUSED', 'UNCERTAIN');

CREATE TABLE "ToolDispatch" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "argsDigest" TEXT NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'DISPATCHED',
    "reference" TEXT,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "ToolDispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ToolDispatch_conversationId_toolCallId_key" ON "ToolDispatch"("conversationId", "toolCallId");
CREATE INDEX "ToolDispatch_runId_idx" ON "ToolDispatch"("runId");
CREATE INDEX "ToolDispatch_userId_idx" ON "ToolDispatch"("userId");

ALTER TABLE "ToolDispatch" ADD CONSTRAINT "ToolDispatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolDispatch" ADD CONSTRAINT "ToolDispatch_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolDispatch" ADD CONSTRAINT "ToolDispatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
