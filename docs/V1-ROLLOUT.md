# V1 rollout checklist

Provider settings and accounts (V1-01 … V1-17). Read this before rolling a
deployment forward, and before believing a green test run.

---

## 1. There is no upgrade path, and that is the decision

A database that predates V1 is not stale so much as unreadable:

- `Bot.modelId` held a composed `provider:model` key. D-082 made it a
  `ProviderModel` row id, and no such rows exist.
- Provider keys lived in the orchestrator's environment. D-083 made them
  per-user rows in a vault, and there is nobody to own them.

Both could be migrated with a guess. The guess is **which user owns a key that
was configured for a whole deployment**, and that is the question V1 exists to
stop answering by accident. So:

```bash
pnpm db:reset
```

It drops every row, re-applies every migration, seeds the development account
and regenerates the Prisma client. It refuses a host that is not local, a
database whose name contains `prod`/`live`/`staging`, and `NODE_ENV=production`
— and it asks you to type the database name back rather than "yes", so it is a
decision about one database rather than a reflex. For a script, set
`CREWAID_DB_RESET_YES=<database name>`; naming it is the point, because an
inherited variable cannot then wipe a different one.

**No credentials are imported.** Nothing reads `OPENAI_API_KEY` or its siblings
into the vault. An imported key would be attributed to whichever account was
seeded first, and every turn anyone ran would spend it — silently, and
correctly as far as any code could tell.

---

## 2. Regenerate before believing anything

```bash
pnpm db:generate && pnpm --filter @crewaid/shared build
```

V1 crosses both the Prisma schema and the `@crewaid/shared` boundary. Stale
generated artifacts surface as **about thirty type errors in files nobody
touched**, which reads as a broken checkout rather than as a missing
`generate`. `db:reset` does the Prisma half for you; the shared build is
separate.

---

## 3. Environment

New in V1 (`infra/compose/.env.example` has the full text):

| Variable | Required | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | **yes** | `openssl rand -base64 32`. Separate from every other secret (D-083). |
| `BETTER_AUTH_URL` | **yes** | The public origin. OAuth callbacks are built from it. |
| `CREWAID_CREDENTIAL_KEYRING` | **yes** | JSON `{"1":"<64 hex chars>"}`. `openssl rand -hex 32`. |
| `CREWAID_CREDENTIAL_KEY_ACTIVE` | only with 2+ keys | Which version new writes use. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | optional | A provider with a blank pair is **not registered**, so the sign-in page simply omits the button. |
| `GITHUB_CLIENT_ID` / `_SECRET` | optional | Same. |
| `RESEND_API_KEY` + `MAGIC_LINK_FROM` | optional | Both, or the email form is hidden. |

Register each OAuth redirect URI as
`$BETTER_AUTH_URL/api/v1/auth/callback/<provider>`. The `/api/v1` prefix is
easy to leave off, and the **provider** reports the mismatch — so the failure
appears on Google's screen and never in a Crewaid log.

⚠️ `CREWAID_CREDENTIAL_KEYRING` belongs in deployment secrets, **not** in the
database and not in database backups. A backup holding both the ciphertext and
the key is a backup holding the keys.

---

## 4. The gate, with a live database

```bash
cd infra/compose && docker compose up -d --wait && cd ../..
export DATABASE_URL="postgresql://crewaid:crewaid@localhost:5432/crewaid?schema=public"
export ARTIFACT_DIR=/tmp/crewaid-artifacts
pnpm db:deploy
pnpm pre-review
```

⚠️ **Without `DATABASE_URL`, 85 of the orchestrator's integration tests skip
and the run still reports green.** Every integration suite is
`describe.skipIf`-gated. A green run that never touched Postgres has told you
nothing about V1, whose whole subject is rows.

`ARTIFACT_DIR` is required too — without it three suites fail with a 500 whose
cause appears only in the Nest error log and reads exactly like an
attachment-code regression.

---

## 5. First run, in order

1. Start the orchestrator. It refuses to boot without `BETTER_AUTH_SECRET` and
   `BETTER_AUTH_URL` — deliberately, so misconfiguration fails at boot rather
   than at the first request.
2. In the desktop app: **Settings → General**, set the orchestrator address.
3. **Sign in with browser.** The orchestrator serves the sign-in page and
   offers only what it is configured for. If the OS did not register `crewaid://`
   — an unpackaged build on macOS registers the scheme to the Electron binary —
   the page prints a code to paste into Settings instead.
4. **Settings → Connections**: add a provider connection and its key. The key
   is write-only: nothing sends it back, and there is no masked field standing
   in for it.
5. **Settings → Model** or the composer picker: choose a model. A model whose
   connection has no key is listed and disabled with the reason attached.

Until step 4 there is nothing for a bot to send a turn to, and the app says so
rather than failing at send.

---

## 6. What V1 does not include

Out of scope, and deliberately absent rather than stubbed — **no empty tables,
no unused dependencies, no placeholder settings**:

- billing and subscriptions
- organizations, teams and invitations (V1 is personal accounts only)
- subscription-backed connection adapters (`ConnectionAuthKind` accepts
  `api_key` and nothing else, D-084 — the enum is on the wire so a second kind
  arrives as a versioned contract change rather than a nullable column nobody
  branches on)
- runtime hosting and managed deployment

⚠️ **§9's hosted-launch isolation work still gates public deployment.** V1 makes
the product multi-user; it does not make it multi-tenant-safe to host for
strangers.

---

## 7. Known gaps, written down rather than implied

- **Packaging and the custom scheme.** `crewaid://` is registered at runtime via
  `setAsDefaultProtocolClient`. A packaged macOS build needs
  `CFBundleURLTypes` in its `Info.plist`; there is no packaging config yet, so
  the paste-the-code path is the supported route for a packaged app.
- **Custom provider key formats.** Log redaction catches the shapes the three
  built-in vendors issue (`sk-…`). A custom connection's key format is not
  guessable, so the bar on storing vendor text in the transcript (D-006)
  remains the primary defence there.
- **Magic link across browsers.** The link must be opened in the browser that
  requested it; the transfer cookie lives there. Opening it elsewhere signs you
  in on the web but hands nothing back to the desktop.
- **`GET /bots/:id/turns`** is served (`agent/turns.controller.ts`, §4.1's
  shape, 404 for a bot that is not the caller's). The desktop does not call it
  yet; it is there for a usage or history view.
