-- D-146: a shared login belongs to the user, not to one computer. Each
-- identity is its own volume now, mounted in the computer of whichever bot
-- is granted it, so the same name is the same session everywhere.

-- The owner, from the computer each identity was on.
ALTER TABLE "Identity" ADD COLUMN "userId" TEXT;
UPDATE "Identity" AS i SET "userId" = s."userId" FROM "Sandbox" AS s WHERE s."id" = i."sandboxId";

-- Two computers of one user may each have held an identity with the same
-- name. Keep the oldest, move the others' grants onto it, drop the others.
INSERT INTO "BotIdentity" ("botId", "identityId", "grantedAt")
SELECT b."botId", r."keep", b."grantedAt"
FROM "BotIdentity" AS b
JOIN (
  SELECT "id", first_value("id") OVER (PARTITION BY "userId", "name" ORDER BY "createdAt", "id") AS "keep"
  FROM "Identity"
) AS r ON r."id" = b."identityId"
WHERE r."id" <> r."keep"
ON CONFLICT ("botId", "identityId") DO NOTHING;

DELETE FROM "Identity" AS i
USING (
  SELECT "id", first_value("id") OVER (PARTITION BY "userId", "name" ORDER BY "createdAt", "id") AS "keep"
  FROM "Identity"
) AS r
WHERE r."id" = i."id" AND r."id" <> r."keep";

ALTER TABLE "Identity" ALTER COLUMN "userId" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "Identity" DROP CONSTRAINT "Identity_sandboxId_fkey";

-- DropIndex
DROP INDEX "Identity_sandboxId_name_key";

-- AlterTable
ALTER TABLE "Identity" DROP COLUMN "sandboxId";

-- CreateIndex
CREATE UNIQUE INDEX "Identity_userId_name_key" ON "Identity"("userId", "name");

-- AddForeignKey
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
