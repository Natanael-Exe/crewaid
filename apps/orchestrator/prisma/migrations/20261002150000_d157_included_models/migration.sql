-- D-157: the models a hosted plan includes — a CREWAID connection per account,
-- and one ModelCharge row per call, itemising UsageLedger's model total.

-- AlterEnum
ALTER TYPE "ProviderKind" ADD VALUE 'CREWAID';

-- CreateTable
CREATE TABLE "ModelCharge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "upstreamModelId" TEXT NOT NULL,
    "costMicroUsd" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelCharge_userId_createdAt_idx" ON "ModelCharge"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ModelCharge" ADD CONSTRAINT "ModelCharge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

