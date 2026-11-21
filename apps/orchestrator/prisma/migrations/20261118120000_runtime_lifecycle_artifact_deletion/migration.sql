ALTER TABLE "Sandbox"
  ADD COLUMN "workspacePending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pausePending" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ArtifactDeletion" (
  "storageKey" TEXT PRIMARY KEY,
  "retryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ArtifactDeletion_retryAt_idx" ON "ArtifactDeletion"("retryAt");

CREATE FUNCTION queue_attachment_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ArtifactDeletion" ("storageKey") VALUES (OLD."storageKey")
    ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;
CREATE TRIGGER attachment_deletion AFTER DELETE ON "Attachment"
  FOR EACH ROW EXECUTE FUNCTION queue_attachment_deletion();
