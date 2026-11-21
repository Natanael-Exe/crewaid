-- D-223: a voice allowance per plan, apart from the model allowance.
-- CreateEnum
CREATE TYPE "VoiceUsageKind" AS ENUM ('LISTEN', 'SPEAK');

-- AlterTable
ALTER TABLE "UsageLedger" ADD COLUMN     "listenSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "speakSeconds" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "VoiceCharge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "kind" "VoiceUsageKind" NOT NULL,
    "seconds" INTEGER NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoiceCharge_userId_createdAt_idx" ON "VoiceCharge"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "VoiceCharge" ADD CONSTRAINT "VoiceCharge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

