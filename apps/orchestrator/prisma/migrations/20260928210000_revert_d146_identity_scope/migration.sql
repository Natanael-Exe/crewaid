-- Restore D-057's computer-scoped identities after the unapplied D-146
-- migration. Keep both migrations in history; never edit the earlier SQL.
--
-- A single identity cannot represent grants on multiple computers under the
-- restored schema. Refuse that state instead of silently moving a login to an
-- arbitrary computer. The checked local and production databases have no
-- Identity rows, so no account or grant needs reassignment there.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Identity" i
    JOIN "BotIdentity" bi ON bi."identityId" = i.id
    JOIN "Bot" b ON b.id = bi."botId"
    JOIN "Sandbox" s ON s.id = b."sandboxId"
    WHERE s."userId" <> i."userId"
  ) THEN
    RAISE EXCEPTION 'cannot restore Identity.sandboxId: a grant belongs to another user';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "BotIdentity" bi
    JOIN "Bot" b ON b.id = bi."botId"
    GROUP BY bi."identityId"
    HAVING COUNT(DISTINCT b."sandboxId") > 1
  ) THEN
    RAISE EXCEPTION 'cannot restore Identity.sandboxId: one login is granted on multiple computers';
  END IF;
END $$;

ALTER TABLE "Identity" ADD COLUMN "sandboxId" TEXT;

UPDATE "Identity" AS i
SET "sandboxId" = grants."sandboxId"
FROM (
  SELECT bi."identityId", MIN(b."sandboxId") AS "sandboxId"
  FROM "BotIdentity" bi
  JOIN "Bot" b ON b.id = bi."botId"
  GROUP BY bi."identityId"
) AS grants
WHERE grants."identityId" = i.id;

-- An identity with no grants can only be placed without guessing when its user
-- has exactly one computer.
UPDATE "Identity" AS i
SET "sandboxId" = only_computer.id
FROM (
  SELECT "userId", MIN(id) AS id
  FROM "Sandbox"
  GROUP BY "userId"
  HAVING COUNT(*) = 1
) AS only_computer
WHERE i."sandboxId" IS NULL AND i."userId" = only_computer."userId";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Identity" WHERE "sandboxId" IS NULL) THEN
    RAISE EXCEPTION 'cannot restore Identity.sandboxId: ungranted login has no unique computer';
  END IF;
END $$;

ALTER TABLE "Identity" ALTER COLUMN "sandboxId" SET NOT NULL;
CREATE UNIQUE INDEX "Identity_sandboxId_name_key" ON "Identity"("sandboxId", "name");
ALTER TABLE "Identity" DROP CONSTRAINT "Identity_userId_fkey";
DROP INDEX "Identity_userId_name_key";
ALTER TABLE "Identity" DROP COLUMN "userId";
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_sandboxId_fkey"
  FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
