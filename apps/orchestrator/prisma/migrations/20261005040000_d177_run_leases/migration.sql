ALTER TABLE "AgentTurn"
  ADD COLUMN "workerId" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "AgentTurn_status_leaseExpiresAt_idx"
  ON "AgentTurn"("status", "leaseExpiresAt");
