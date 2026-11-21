ALTER TABLE "Bot" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_kind_check" CHECK ("kind" IN ('MAIN', 'STANDARD'));
CREATE UNIQUE INDEX "Bot_one_main_per_user" ON "Bot" ("userId") WHERE "kind" = 'MAIN';
CREATE TABLE "UserOnboarding" ("userId" TEXT NOT NULL PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE, "welcomeSeen" BOOLEAN NOT NULL DEFAULT false, "discovery" TEXT NOT NULL DEFAULT 'NEW', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE TABLE "TemplateInstallation" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE, "idempotencyKey" TEXT NOT NULL, "templateId" TEXT NOT NULL, "revision" TEXT NOT NULL, "configuration" TEXT NOT NULL, "groupId" TEXT, "botIds" TEXT[] NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "TemplateInstallation_userId_idempotencyKey_key" ON "TemplateInstallation"("userId", "idempotencyKey");
CREATE INDEX "TemplateInstallation_userId_createdAt_idx" ON "TemplateInstallation"("userId", "createdAt");
