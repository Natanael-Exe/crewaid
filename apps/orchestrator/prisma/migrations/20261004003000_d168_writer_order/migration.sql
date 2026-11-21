ALTER TABLE "AgentTurn" ADD COLUMN "sequence" SERIAL NOT NULL;
CREATE UNIQUE INDEX "AgentTurn_sequence_key" ON "AgentTurn"("sequence");
