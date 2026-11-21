/*
  D-021: Attachment.ownerId (no default in the schema — ownership from
  creation) + createdAt (J3 TTL fence / M8-BE-07 reaper input). §3's
  Attachment had no timestamp; the fence is specified, so the column must
  exist (D-005/D-009 class).

  The column is added nullable, backfilled, then locked to NOT NULL — the
  three-step dance any required column with pre-existing rows needs. On a
  virgin database (CI) the backfill touches zero rows and this reduces to
  the plain add.
*/
ALTER TABLE "Attachment" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "ownerId" TEXT;

-- Backfill pre-D-021 rows (dev databases only; zero rows on a fresh DB).
-- v1 has exactly one operator (R7): every pre-existing upload is theirs.
UPDATE "Attachment"
SET "ownerId" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1)
WHERE "ownerId" IS NULL;

ALTER TABLE "Attachment" ALTER COLUMN "ownerId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Attachment_ownerId_idx" ON "Attachment"("ownerId");

-- CreateIndex
CREATE INDEX "Attachment_createdAt_idx" ON "Attachment"("createdAt");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
