-- Selection is explicit and starts private on fresh development setup.
ALTER TABLE "Bot" ADD COLUMN "activeIdentityId" TEXT;
ALTER TABLE "Bot" ADD COLUMN "identityRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_activeIdentityId_fkey" FOREIGN KEY ("activeIdentityId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
