# Composio integrations

Crewaid uses `@composio/core` **0.22.0** with Node **>=22.22.3**. Both cloud and
self-hosted editions use the same integration code. TanStack AI owns the agent
loop and tool decisions; Composio supplies app authentication and execution.

## Server setup

Set `COMPOSIO_API_KEY` in the orchestrator's server environment. For Compose,
put it in `infra/compose/.env`; for Dokploy, set the deployment environment.
Restart the orchestrator after changing it. Cloud uses Crewaid's project;
self-hosted administrators use their own Composio project.

For a scoped project key, grant these permissions:

| Permission area | Access |
| --- | --- |
| Auth configs | Read and write |
| Connected accounts | Read and write |
| Session management | Read and write |
| Session tool execution | Write only |
| Tools | Read only |
| Toolkits | Read only |

Connected accounts **write** creates Connect Links and revokes connections on
uninstall. Session permissions allow creating, reading and cleaning up sessions,
and executing approved app tools. These project-key permissions are separate from
the Gmail/Calendar/Slack OAuth scopes and bot access controls.

Scoped-key permissions cannot be edited. Create a replacement key in Composio
Dashboard → Platform → your project → Settings → API Keys, update
`COMPOSIO_API_KEY`, and restart the orchestrator. A read-only connected-accounts
key produces `APIKey_InsufficientPermissions` (HTTP 403) before browser sign-in.
See [Composio scoped-key permissions](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions).

The Plugins directory loads the project's live toolkit catalog, filtered to
toolkits with Composio-managed OAuth2. Crewaid creates or reuses an enabled
managed OAuth auth config when an app is installed and stores its ID server-side.
No per-app auth-config environment variables are required (D-204).
API-key and unauthenticated toolkits, and selection of custom OAuth applications,
are outside this implementation. Direct custom MCP servers remain available.

Use a fresh database, with the committed migration history:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:deploy
pnpm --filter @crewaid/shared build
```

## Connect and choose bot access

1. Open Settings → Plugins and install an app.
2. Choose Connect and finish the provider's consent screen in the system browser.
   Plugins polls through the authenticated server; completion also recovers after
   a server restart. Abandoned links expire after ten minutes.
3. Open **Bot access**. **Selected bots** grants only the chosen bots. **All bots**
   includes current and future bots, with checked bots under **Except these bots**
   excluded. New installations grant access to nobody.
4. Save access. A bot's approval mode and rules still apply to its tool calls.

One connected account is selected per installed app and Crewaid account. Tools
execute with that exact account and session. Reconnect changes the connection
revision and invalidates pending approvals. Access edits invalidate approvals too.
The SDK verifies the session's single-account pin before execution; it omits the
multi-account-only per-call `account` option. Project multi-account mode is not needed.
Uninstall immediately removes local access and deletes remote sessions/accounts.
If remote deletion fails, the app stays disabled and reports the failure; retry
Uninstall to finish cleanup.

## Permissions and tools

Bot access controls **which bots** can use a connection. OAuth scopes control
**what the provider permits** that connection to do. Administrators manage scopes
on the Composio auth config; changes apply to new connections. Reconnect existing
accounts after changing scopes. The client never changes a shared deployment's
auth config on behalf of one account.
See [Composio scope controls](https://docs.composio.dev/docs/authentication/controlling-scopes).

Gmail, Google Calendar, and Slack retain reviewed tool allowlists and read/write
classification. Gmail supports reads, drafts, sending and replies; Calendar
supports reads, availability and event create/update/cancel; Slack supports reads,
search, user lookup, posting and threaded replies. Other managed OAuth toolkits
use their toolkit's tools, excluding deprecated tools and Composio management
helpers. Vendor `readOnlyHint` tags classify reads; untagged tools use the normal
external-action approval policy. Model discovery stays within the plugin bridge's
token budget even when the directory contains hundreds of apps.

Provider tokens stay with Composio, and the project key stays on the server.
Session management helpers, generic execution/proxy tools and Composio's sandbox
are disabled. Arguments are validated before SDK dispatch. SDK retries are disabled;
after a cancelled or uncertain write, check the app before retrying manually.

In-chat connection initiation, event triggers, Jev, and sandbox-provider changes
remain deferred. Connections start from Plugins.

## Verification

Automated tests use a real disposable PostgreSQL database and a fake Composio
port. They cover schemas, account and bot isolation, approval modes, cancellation,
connection expiry/recovery/reconnect, uninstall failures, and credential redaction.
SDK serialization tests check the actual pinned SDK's session/account restrictions.

Live project/catalog/schema reads are recorded separately from the mocked lifecycle
and writes. A working project key verifies access to Composio; provider account
sign-in is still needed to verify a Gmail, Calendar, Slack or other app tool live.
