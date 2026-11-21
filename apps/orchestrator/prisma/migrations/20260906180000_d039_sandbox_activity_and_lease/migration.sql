-- D-039 §10 — the two clocks idle stop needs.
--
-- Both nullable, and both must stay nullable: every Sandbox row that predates
-- this migration has no activity history, and inventing one (a NOT NULL
-- DEFAULT now()) would tell the idle sweep that every sandbox on the host was
-- busy at deploy time. A NULL here means "no evidence", which the sweep reads
-- as "fall back to lastStartedAt" rather than as "idle since the epoch".
ALTER TABLE "Sandbox" ADD COLUMN "lastActiveAt" TIMESTAMP(3);

ALTER TABLE "Sandbox" ADD COLUMN "keepRunningUntil" TIMESTAMP(3);
