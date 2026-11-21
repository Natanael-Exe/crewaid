-- CreateEnum
CREATE TYPE "McpBackend" AS ENUM ('DIRECT', 'COMPOSIO');

-- AlterTable
ALTER TABLE "McpServer" ADD COLUMN     "backend" "McpBackend" NOT NULL DEFAULT 'DIRECT',
ALTER COLUMN "transport" DROP NOT NULL,
ALTER COLUMN "url" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ComposioConnection" (
    "serverId" TEXT NOT NULL,
    "toolkit" TEXT NOT NULL,
    "authConfigId" TEXT NOT NULL,
    "accountId" TEXT,
    "pendingAccountId" TEXT,
    "pendingExpiresAt" TIMESTAMP(3),
    "sessionId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "removing" BOOLEAN NOT NULL DEFAULT false,
    "cleanupAccounts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cleanupSessions" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ComposioConnection_pkey" PRIMARY KEY ("serverId")
);

-- AddForeignKey
ALTER TABLE "ComposioConnection" ADD CONSTRAINT "ComposioConnection_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backend shape is also enforced for non-HTTP writers.
ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_backend_shape" CHECK (
  ("backend" = 'DIRECT' AND "url" IS NOT NULL AND "transport" IS NOT NULL) OR
  ("backend" = 'COMPOSIO' AND "url" IS NULL AND "transport" IS NULL
    AND "isPrivate" = false AND "authType" = 'OAUTH2')
);
