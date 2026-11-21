# GitHub repository work

A bot granted the curated **direct GitHub MCP** plugin can clone a private repository,
edit and test it with its existing computer tools, commit locally, publish a feature branch,
and open a draft PR. Composio's GitHub and GitHub MCP entries do not provide these computer
Git extensions. This works in both Crewaid editions.

## Administrator setup

1. Use the existing GitHub sign-in OAuth app, as selected for this implementation.
   Configure its `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on the orchestrator.
   Self-hosted deployments configure these settings even though their desktop sign-in
   uses email and password.
2. Add the exact `${BETTER_AUTH_URL}/api/v1/mcp/oauth/callback` URL to that app's allowed
   callback URLs, alongside the cloud sign-in callback. The plugin requests `repo`,
   `read:org`, `workflow` and `offline_access`, with S256 PKCE and account selection.
   GitHub may require organization approval or SSO authorization. See
   [GitHub's OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
   and [scope definitions](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).
3. Keep `CREDENTIAL_KEY` configured for the existing encrypted MCP credential store.
   Apply migrations with `pnpm db:deploy` and regenerate with `pnpm db:generate`.
4. Rebuild the sandbox image from `infra/sandbox-image/Dockerfile` and configure the
   deployment's image reference. The image packages `/opt/agent-bridge/git_helper.py`.
   Docker and DigitalOcean both use `ContainerSandboxSession.git` over the agent-bridge
   exec stream. Existing computers need the updated image; no extra inbound port is needed.
5. In Plugins, install the curated direct GitHub entry, connect the account, refresh its
   tools, and grant access to selected bots or all bots, with exclusions as needed.

The same GitHub connection authorizes Git transport and the GitHub MCP methods. Tokens,
refresh grants and the OAuth client secret stay on the server. Stored Git remotes use
ordinary credential-free GitHub URLs. Shell Git does not inherit authentication.

## Bot workflow

Load these names through `find_plugin_tools`:

| Tool | Input | Result |
| --- | --- | --- |
| `github__crewaid_git_clone` | `repository: "owner/repo"`, optional branch and relative directory | Owned checkout ID, computer path, repository, branch and HEAD |
| `github__crewaid_git_fetch` | `checkoutId` | Updated remote-tracking refs and current checkout details |
| `github__crewaid_git_push` | `checkoutId`, feature `branch`, optional `targetRepository` | Confirmed branch URL or an explicit refused/uncertain outcome |

Use existing computer tools to edit files, install dependencies, test, and commit. The
checkout respects configured Git authorship; if missing, clone initializes a local name
and noreply email from the connected account. Clone reserves a new directory and refuses
existing destinations; failed clones preserve partial work, so retry in a new directory.

When the account cannot push to the source, use the existing `github__fork_repository`
tool, then push with `targetRepository: "connected-account/repo"`. The destination must
be that account's verified fork of the source repository's network. A provider restriction
on forks remains a provider restriction.

Use `github__create_pull_request` with the source owner/repository and the published head
(e.g. `connected-account:fix`). An omitted `draft` becomes `true` before validation and
approval binding. An explicit `draft: false` requests a ready PR with normal approvals.
Merging is a separate user-directed action.

## Publishing and recovery

Clone/fetch are local drafts with read-only provider access. Push uses the existing
ASK/AUTO/FULL modes and deny rules, bound to the account, exact commit/tree, repository,
branch, expected remote head and connection/access revisions. The approval card shows
its destination and a bounded file/stat summary. Tags, deletions, default branches,
foreign existing branches and non-fast-forward updates are refused.

Each Git operation has a ten-minute deadline and a combined 1 GiB request/response limit.
Cancellation or stream loss terminates the helper and Git process group. Fetch does not
merge, reset or overwrite the working tree.

A lost push response is recorded as uncertain. The next preparation reads the remote
branch to reconcile it before another publish. Fork and PR receipts similarly reconcile
through read-only REST requests. Identical confirmed requests return the existing artifact;
an unresolved creation is not replayed. Reconnect and revoked bot grants invalidate old
approvals. Removing the plugin removes local grants/receipts and disables authentication;
local files and remote branches/PRs remain.

Initial support is GitHub.com and ordinary Git repositories. GitHub Enterprise, GitLab,
Git LFS, authenticated submodules, SSH and automatic shell authentication are deferred.

## Verification

`test/github-git.integration.test.ts` covers owned metadata, forks, approval modes,
revoked grants, changed HEAD, branch ownership and durable write recovery.
`test/github-git-auth.integration.test.ts` covers both editions, existing OAuth settings,
fixed destinations, refresh, scopes, failures, provenance and credential redaction.
`packages/sandbox-core/src/git-process.test.ts` runs real Git against a disposable local
smart-HTTP server, including binary history, forks, dirty fetch, non-fast-forward refusal,
branch races and cancellation. External writes in these suites are mocked or local.

Live verification requires a connected private test repository. Follow connect → clone →
edit → test → commit → publish → draft PR only after explicit authorization for test-repository
writes. Local tests do not claim that live GitHub or a deployed Docker/DO image was verified.
