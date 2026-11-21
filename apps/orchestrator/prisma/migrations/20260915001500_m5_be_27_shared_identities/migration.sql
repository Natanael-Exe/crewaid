-- CreateTable
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotIdentity" (
    "botId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotIdentity_pkey" PRIMARY KEY ("botId","identityId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Identity_sandboxId_name_key" ON "Identity"("sandboxId", "name");

-- AddForeignKey
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotIdentity" ADD CONSTRAINT "BotIdentity_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotIdentity" ADD CONSTRAINT "BotIdentity_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

