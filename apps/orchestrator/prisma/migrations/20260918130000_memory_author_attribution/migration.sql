-- WHOSE work a shared fact describes.
--
-- A workspace memory is injected into every bot's prompt on the team. Without
-- an author on the row, a fact Nathan established ("the Kreova report lives
-- at /home/bot/kreova-research/ as markdown and PDF") reaches Exe as an
-- unattributed claim, and a model fills that gap with itself — it answers
-- "I built the current Kreova competitive report" about work it never did.
-- The column carries the establishing bot, and the prompt renders its name.
--
-- SET NULL, not CASCADE: a deleted teammate's facts stay in the shared memory
-- as unattributed history rather than vanishing with the row that wrote them.

ALTER TABLE "Memory" ADD COLUMN "authorBotId" TEXT;

ALTER TABLE "Memory" ADD CONSTRAINT "Memory_authorBotId_fkey"
  FOREIGN KEY ("authorBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
