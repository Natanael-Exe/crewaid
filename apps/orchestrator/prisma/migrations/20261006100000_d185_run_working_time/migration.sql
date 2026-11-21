-- D-185: a run's own working time, so a continuation's ceiling can sum its chain.
ALTER TABLE "AgentTurn" ADD COLUMN "workingMs" INTEGER NOT NULL DEFAULT 0;
