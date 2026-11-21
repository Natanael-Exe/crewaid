# Release Downloads Worker (`downloads.crewaid.io`)

Serves desktop installers, auto-update feeds, and the self-hosted install shim from an R2 bucket (`crewaid-downloads`). The release workflow
(`.github/workflows/release-desktop.yml`) uploads through it with a bearer
secret, so CI holds no Cloudflare API token, and it answers the download links
with a redirect to whatever the current feed names.

| URL | What it does |
|---|---|
| `/desktop/<edition>/mac-arm64`, `/mac-intel`, `/windows`, `/linux` | 302 to the installer the edition's current feed lists (`/mac` still answers, with Apple silicon) |
| `/desktop/<edition>/<file>` | the file (HEAD and `Range` work; the updater uses ranges for differential downloads) |
| `PUT /desktop/<edition>/<file>` | upload in one request, up to the zone's 100 MB body limit |
| `POST …?uploads`, `PUT …?uploadId=&partNumber=`, `POST …?uploadId=` | multipart upload, for anything larger |

A feed (`latest*.yml`) goes up in one `PUT` and is refused with 409 when its
`version` is older than the feed already published, so re-running an old
release cannot roll every app's updates back. A published feed also prunes its
edition's folder: installers, zips and blockmaps of anything but the five newest
versions are deleted (`KEEP_VERSIONS` in `worker.js`), and the publish log lists
them. Feeds, `install.sh` and the other edition are never touched.

The Worker is deployed by hand (below), not by CI — so a change to `worker.js`
is live only after `npx wrangler deploy`. R2 answers a multi-range request
with the whole file, which is why each build sets `useMultipleRangeRequest: false`.

`<edition>` is `cloud` or `selfhosted`. The electron-updater feed URL
baked into each app is `https://downloads.crewaid.io/desktop/<edition>`.

## Deploy

```sh
cd infra/cloudflare/downloads-worker
npx wrangler r2 bucket create crewaid-downloads
npx wrangler deploy                      # attaches downloads.crewaid.io (the zone must be on the account)
SECRET=$(openssl rand -hex 32)
printf '%s' "$SECRET" | npx wrangler secret put UPLOAD_SECRET
printf '%s' "$SECRET" | gh secret set DOWNLOADS_UPLOAD_SECRET
unset SECRET
```

Rotating the secret is the same three lines. A new Worker secret takes about
30 seconds to reach every location, so a publish started in that window can
see a 401.

## Why not a public bucket and the S3 API

- **No account token in CI.** An R2 token able to write one bucket is created in
  the dashboard and is easy to over-scope; a Worker secret can only do what
  this Worker allows: write under `desktop/`.
- **Cloudflare refuses request bodies over 100 MB at the edge** on this zone's
  plan, before any Worker runs, and a macOS installer is about
  125 MB. `apps/desktop/scripts/publish.mjs` therefore sends anything over
  90 MB as R2 multipart parts of 64 MB.
- **One source for "the current version".** The download link and the in-app
  updater both read the same `latest*.yml`, so they cannot disagree.
