-- D-241 Step 5: opt-in standalone local connectors (`crewaid-connect`)
-- and additive ACP/connector metadata columns on CodingRun.

CREATE TYPE "LocalConnectorStatus" AS ENUM ('ONLINE', 'OFFLINE', 'REVOKED');

CREATE TABLE "LocalConnector" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "status" "LocalConnectorStatus" NOT NULL DEFAULT 'OFFLINE',
    "reportMode" TEXT NOT NULL DEFAULT 'summary',
    "workspaceName" TEXT,
    "hostName" TEXT,
    "harnesses" JSONB NOT NULL DEFAULT '[]',
    "defaultHarness" TEXT,
    "connectedInstanceId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalConnector_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocalConnector_tokenHash_key" ON "LocalConnector"("tokenHash");
CREATE INDEX "LocalConnector_userId_status_idx" ON "LocalConnector"("userId", "status");

ALTER TABLE "LocalConnector"
ADD CONSTRAINT "LocalConnector_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodingRun"
ADD COLUMN "connectorId" TEXT,
ADD COLUMN "acpSessionId" TEXT,
ADD COLUMN "payloadHash" TEXT,
ADD COLUMN "reportMode" TEXT;

CREATE INDEX "CodingRun_connectorId_idx" ON "CodingRun"("connectorId");

ALTER TABLE "CodingRun"
ADD CONSTRAINT "CodingRun_connectorId_fkey"
FOREIGN KEY ("connectorId") REFERENCES "LocalConnector"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
