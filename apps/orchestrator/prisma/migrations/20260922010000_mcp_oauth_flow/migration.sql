-- M6-BE-03: the row between "connect" and "the browser comes back".
--
-- The callback is a redirect from somebody else's authorization server into a
-- browser that carries no session, so the flow cannot be held in the process
-- that started it: the orchestrator may have restarted, and the state has to
-- outlive the request that minted it (D-018's rule — the table and the code
-- that reads it deploy together). `state` is unique because it is the whole
-- lookup; `codeVerifier` is the PKCE half that makes the code useless to
-- anyone else who sees it, and both are consumed by deleting the row.
--
-- `tokenEndpoint`, `clientId` and `redirectUri` are recorded at connect time.
-- Re-discovering them at callback time would be a second network round trip
-- against a server that is already mid-flow, and re-registering would mint a
-- client the authorization code was not issued to.
--
-- The server's own `status` is deliberately NOT touched by a flow: CONNECTING
-- is derived from a live row here, so a process that dies mid-flow cannot
-- leave a badge behind that nothing will ever clear.

-- CreateTable
CREATE TABLE "McpOAuthFlow" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "tokenEndpoint" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthFlow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthFlow_state_key" ON "McpOAuthFlow"("state");

-- CreateIndex
CREATE INDEX "McpOAuthFlow_serverId_idx" ON "McpOAuthFlow"("serverId");

-- AddForeignKey
ALTER TABLE "McpOAuthFlow" ADD CONSTRAINT "McpOAuthFlow_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
