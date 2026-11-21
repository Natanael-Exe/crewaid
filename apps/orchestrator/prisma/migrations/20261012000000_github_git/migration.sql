-- CreateEnum
CREATE TYPE "McpToolSource" AS ENUM ('REMOTE', 'CREWAID_GIT');

-- CreateEnum
CREATE TYPE "GitCheckoutStatus" AS ENUM ('CREATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "GitPublicationStatus" AS ENUM ('PREPARED', 'SENDING', 'CONFIRMED', 'UNCERTAIN');

-- AlterTable
ALTER TABLE "McpTool" ADD COLUMN     "source" "McpToolSource" NOT NULL DEFAULT 'REMOTE';

-- CreateTable
CREATE TABLE "GitCheckout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" "GitCheckoutStatus" NOT NULL DEFAULT 'CREATING',
    "activeOperationId" TEXT,
    "activeUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitPublication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "targetRepository" TEXT NOT NULL,
    "targetRepositoryId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "intendedHead" TEXT NOT NULL,
    "tree" TEXT NOT NULL,
    "previousHead" TEXT,
    "confirmedHead" TEXT,
    "status" "GitPublicationStatus" NOT NULL DEFAULT 'PREPARED',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitRemoteWrite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "GitPublicationStatus" NOT NULL DEFAULT 'PREPARED',
    "reference" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitRemoteWrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitCheckout_userId_serverId_idx" ON "GitCheckout"("userId", "serverId");

-- CreateIndex
CREATE UNIQUE INDEX "GitCheckout_botId_path_key" ON "GitCheckout"("botId", "path");

-- CreateIndex
CREATE INDEX "GitPublication_userId_botId_idx" ON "GitPublication"("userId", "botId");

-- CreateIndex
CREATE UNIQUE INDEX "GitPublication_checkoutId_targetRepositoryId_branch_key" ON "GitPublication"("checkoutId", "targetRepositoryId", "branch");

-- CreateIndex
CREATE INDEX "GitRemoteWrite_userId_botId_idx" ON "GitRemoteWrite"("userId", "botId");

-- CreateIndex
CREATE UNIQUE INDEX "GitRemoteWrite_botId_serverId_toolName_argsHash_key" ON "GitRemoteWrite"("botId", "serverId", "toolName", "argsHash");

-- AddForeignKey
ALTER TABLE "GitCheckout" ADD CONSTRAINT "GitCheckout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitCheckout" ADD CONSTRAINT "GitCheckout_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitCheckout" ADD CONSTRAINT "GitCheckout_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitPublication" ADD CONSTRAINT "GitPublication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitPublication" ADD CONSTRAINT "GitPublication_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitPublication" ADD CONSTRAINT "GitPublication_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "GitCheckout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitRemoteWrite" ADD CONSTRAINT "GitRemoteWrite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitRemoteWrite" ADD CONSTRAINT "GitRemoteWrite_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitRemoteWrite" ADD CONSTRAINT "GitRemoteWrite_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

