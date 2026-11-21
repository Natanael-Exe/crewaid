-- Capacity admission counts occupied lifecycle states on every start. Keep
-- that host-wide count indexed as the number of stopped historical rows grows.
CREATE INDEX "Sandbox_state_idx" ON "Sandbox"("state");
