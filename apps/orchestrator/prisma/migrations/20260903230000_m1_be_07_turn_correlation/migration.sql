ALTER TABLE "AgentTurn" ADD COLUMN "activeKey" TEXT;

ALTER TABLE "Message" ADD COLUMN "agentTurnId" TEXT;

CREATE UNIQUE INDEX "AgentTurn_activeKey_key" ON "AgentTurn"("activeKey");

CREATE UNIQUE INDEX "Message_agentTurnId_key" ON "Message"("agentTurnId");

ALTER TABLE "Message" ADD CONSTRAINT "Message_agentTurnId_fkey"
  FOREIGN KEY ("agentTurnId") REFERENCES "AgentTurn"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
