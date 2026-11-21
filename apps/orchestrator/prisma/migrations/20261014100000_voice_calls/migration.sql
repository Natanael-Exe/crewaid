-- D-222: a call with a bot, and the minutes it took from the billing period.
-- CreateTable
CREATE TABLE "VoiceCall" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "conversationId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "reservedSeconds" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "VoiceCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceCall_conversationId_key" ON "VoiceCall"("conversationId");

-- CreateIndex
CREATE INDEX "VoiceCall_userId_periodStart_idx" ON "VoiceCall"("userId", "periodStart");

-- CreateIndex
CREATE INDEX "VoiceCall_botId_idx" ON "VoiceCall"("botId");

-- AddForeignKey
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

