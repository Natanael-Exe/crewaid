-- D-241 Step 3: durable CodingRun record for delegated `code_task` runs
-- and accurate per-model `/usage` rollup alongside AgentTurn rows.

CREATE TABLE "CodingRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "parentRunId" TEXT,
    "runnerKind" TEXT NOT NULL DEFAULT 'builtin',
    "runnerId" TEXT NOT NULL DEFAULT 'builtin',
    "modelId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "cwd" TEXT NOT NULL,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "workingMs" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "filesChanged" JSONB NOT NULL DEFAULT '[]',
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "CodingRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CodingRun_userId_startedAt_idx" ON "CodingRun"("userId", "startedAt");
CREATE INDEX "CodingRun_botId_startedAt_idx" ON "CodingRun"("botId", "startedAt");
CREATE INDEX "CodingRun_parentRunId_idx" ON "CodingRun"("parentRunId");

ALTER TABLE "CodingRun"
ADD CONSTRAINT "CodingRun_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodingRun"
ADD CONSTRAINT "CodingRun_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "Bot"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
