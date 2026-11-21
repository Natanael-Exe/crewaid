BEGIN;

-- D-046 / M5-BE-17: a computer is shared by the bots attached to it.
--
-- `Sandbox` stops being keyed 1:1 on a bot and becomes keyed on the user who
-- owns the machine; `Bot` gains the reference to the machine it works on.
--
-- The one thing this migration must not do is orphan storage. The durable
-- workspace is a Docker volume named `crewaid-workspace-<key>` carrying the label
-- `crewaid.botId=<key>`, where the key is today the bot's id (D-039 §2), and the
-- provider refuses to mount a volume whose label does not match the key it was
-- asked for. So every migrated machine takes the id of the bot that used to
-- own it: the key is unchanged, and not one volume is renamed, relabelled or
-- re-inspected. A machine created after this migration gets a fresh cuid and
-- its own volume, which is the only case where the two ever differ.
--
-- Rewriting a primary key is safe here and nowhere else: nothing references
-- `Sandbox.id` yet. `Bot.sandboxId`, added below, is the first thing that ever
-- will, and it is populated from the rewritten value.

-- 1. New columns, nullable while they are being filled.
ALTER TABLE "Sandbox" ADD COLUMN "userId" TEXT;
ALTER TABLE "Bot" ADD COLUMN "sandboxId" TEXT;

-- 2. The machine belongs to the bot's owner. R7 scoping reads this column, so
--    a row that failed to resolve one would become invisible rather than
--    unowned — hence the NOT NULL in step 5 and the guard in step 4.
UPDATE "Sandbox" s SET "userId" = b."userId" FROM "Bot" b WHERE b.id = s."botId";

-- 3. Take the departing owner's id as the machine's own. This is what
--    preserves `crewaid-workspace-<key>` and `crewaid.botId=<key>` for every volume
--    an operator already has.
UPDATE "Sandbox" SET id = "botId";

-- 4. Attach each bot to the machine it already had. A bot with no Sandbox row
--    stays detached, which is the honest state for one that never started
--    (D-041/§15: never-started is evidence, not "no container").
UPDATE "Bot" b SET "sandboxId" = s.id FROM "Sandbox" s WHERE s."botId" = b.id;

-- 5. A machine with no owner is unreachable through every R7-scoped query, so
--    it must not be representable. Any row that survived step 2 unfilled had
--    no bot at all and cannot be attributed to a user; deleting it here would
--    silently discard a workspace, so fail the migration instead and let an
--    operator decide.
DO $$
DECLARE orphans INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphans FROM "Sandbox" WHERE "userId" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'D-046 migration: % Sandbox row(s) have no owning Bot and cannot be attributed to a user. '
      'Their workspace volumes still exist and are untouched; resolve each one by hand before rerunning.',
      orphans;
  END IF;
END $$;

ALTER TABLE "Sandbox" ALTER COLUMN "userId" SET NOT NULL;

-- 6. The old 1:1 goes away. The unique index is dropped with the column.
ALTER TABLE "Sandbox" DROP CONSTRAINT IF EXISTS "Sandbox_botId_fkey";
DROP INDEX IF EXISTS "Sandbox_botId_key";
ALTER TABLE "Sandbox" DROP COLUMN "botId";

-- 7. The new edges. `Bot.sandboxId` is ON DELETE SET NULL, never CASCADE:
--    deleting a machine detaches its tenants, and must never delete a bot.
ALTER TABLE "Sandbox" ADD CONSTRAINT "Sandbox_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_sandboxId_fkey"
  FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Sandbox_userId_idx" ON "Sandbox"("userId");

CREATE INDEX "Bot_sandboxId_idx" ON "Bot"("sandboxId");

COMMIT;
