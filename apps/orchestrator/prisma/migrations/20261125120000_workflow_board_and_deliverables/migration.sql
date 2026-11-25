-- Phase 2 & 3: durable FYI & idempotent delivery on Message, chain-scoped
-- workflow lifecycle state, durable managed board entries/revisions, and
-- deliverable review state / superseding snapshot chain.

-- CreateEnum
CREATE TYPE "DeliverableReviewState" AS ENUM ('READY', 'REVIEWED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkflowChainStatus" AS ENUM ('ACTIVE', 'WRAPPING_UP', 'STOPPED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BoardRevisionKind" AS ENUM ('INIT_SNAPSHOT', 'ADD', 'UPDATE', 'DELETE', 'RESTORE');

-- AlterTable: Message
ALTER TABLE "Message"
ADD COLUMN "expectReply" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "deliveryKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_deliveryKey_key" ON "Message"("deliveryKey");

-- AlterTable: Deliverable
ALTER TABLE "Deliverable"
ADD COLUMN "reviewState" "DeliverableReviewState" NOT NULL DEFAULT 'READY',
ADD COLUMN "supersededById" TEXT;

-- CreateIndex
CREATE INDEX "Deliverable_supersededById_idx" ON "Deliverable"("supersededById");

-- AddForeignKey
ALTER TABLE "Deliverable"
ADD CONSTRAINT "Deliverable_supersededById_fkey"
FOREIGN KEY ("supersededById") REFERENCES "Deliverable"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: WorkflowChainState
CREATE TABLE "WorkflowChainState" (
    "chainId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rootBotId" TEXT NOT NULL,
    "groupId" TEXT,
    "status" "WorkflowChainStatus" NOT NULL DEFAULT 'ACTIVE',
    "expectedOwners" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "respondedOwners" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "closeoutPublished" BOOLEAN NOT NULL DEFAULT false,
    "deadlineAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowChainState_pkey" PRIMARY KEY ("chainId")
);

-- CreateIndex
CREATE INDEX "WorkflowChainState_userId_status_idx" ON "WorkflowChainState"("userId", "status");
CREATE INDEX "WorkflowChainState_userId_rootBotId_idx" ON "WorkflowChainState"("userId", "rootBotId");

-- AddForeignKey
ALTER TABLE "WorkflowChainState"
ADD CONSTRAINT "WorkflowChainState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: BoardEntry
CREATE TABLE "BoardEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "ownerBotId" TEXT,
    "ownerName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoardEntry_userId_scopeKey_deleted_idx" ON "BoardEntry"("userId", "scopeKey", "deleted");
CREATE INDEX "BoardEntry_userId_scopeKey_ownerBotId_idx" ON "BoardEntry"("userId", "scopeKey", "ownerBotId");

-- AddForeignKey
ALTER TABLE "BoardEntry"
ADD CONSTRAINT "BoardEntry_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: BoardRevision
CREATE TABLE "BoardRevision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "entryId" TEXT,
    "ownerBotId" TEXT,
    "kind" "BoardRevisionKind" NOT NULL,
    "snapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoardRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoardRevision_userId_scopeKey_createdAt_idx" ON "BoardRevision"("userId", "scopeKey", "createdAt");

-- AddForeignKey
ALTER TABLE "BoardRevision"
ADD CONSTRAINT "BoardRevision_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
