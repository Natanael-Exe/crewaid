-- Keep canonical library usage and safe structured errors on the existing run.
ALTER TABLE "AgentTurn" ADD COLUMN "usage" JSONB;
ALTER TABLE "AgentTurn" ADD COLUMN "errorMessage" TEXT;
