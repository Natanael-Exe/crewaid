-- AlterTable
ALTER TABLE "Bot" ADD COLUMN "codingModelId" TEXT;

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN "codingModelId" TEXT;

-- CreateIndex
CREATE INDEX "UserSettings_codingModelId_idx" ON "UserSettings"("codingModelId");

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_codingModelId_fkey" FOREIGN KEY ("codingModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
