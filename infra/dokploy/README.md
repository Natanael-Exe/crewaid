# One-VPS Dokploy deployment with Neon

This is an **opt-in production deployment**. Local development still uses
`infra/compose/docker-compose.yml`, local Postgres, and sandbox ports published
on `127.0.0.1`. Do not point local `DATABASE_URL` at the production Neon branch.

To run computers on [Runtime](https://withruntime.com) instead of this VPS, use
`compose.runtime.yml` and follow the Runtime section in place of steps 2–5.
The legacy `compose.digitalocean.yml` and `compose.cloudflare.yml` topologies
are deprecated.

## Before deploying

1. Use a dedicated Linux VPS with Dokploy. Select **Docker Compose**, not Docker
   Stack. Set the Compose path to `infra/dokploy/compose.yml` and the orchestrator
   as the domain's service on container port `3000`. Dokploy's Traefik owns
   HTTPS and WebSockets; do not publish the orchestrator's port to the host.
2. Keep a checkout of this release under `/opt/crewaid` on the VPS. Build the
   sandbox image there, from the repository root:

   ```sh
   docker build -f infra/sandbox-image/Dockerfile -t crewaid/sandbox:dev .
   ```

   Set `SANDBOX_IMAGE` to the exact tag you built. Rebuild and retag it with
   each release that changes the sandbox or skill runtime.
3. Install the egress firewall on the **host** with this directory's drop-in.
   The base unit is `infra/compose/crewaid-agent-egress.service` (see
   `infra/compose/README.md` for prerequisites); adjust `/opt/crewaid` in both
   files if the checkout lives elsewhere. Do not install the base README's
   `crewaid-orchestrator.service.d` drop-in: there is no systemd orchestrator.

   ```sh
   sudo install -m 644 infra/compose/crewaid-agent-egress.service /etc/systemd/system/
   sudo mkdir -p /etc/systemd/system/crewaid-agent-egress.service.d
   sudo install -m 644 infra/dokploy/crewaid-agent-egress.service.d/dokploy.conf \
     /etc/systemd/system/crewaid-agent-egress.service.d/
   sudo systemctl daemon-reload
   sudo systemctl enable --now crewaid-agent-egress.service
   ```

   The drop-in does three things the base unit does not:

   - **Creates `crewaid-control`**, a bridge (`crewaid-ctl0`) that only the
     orchestrator joins. Sandbox ports are published on its gateway.
   - **Passes `--control-interface crewaid-ctl0`**, so that interface is the only
     one allowed to open a connection into `agent-net`. Screen (VNC) and
     DevTools ports have no password of their own. Without this, any container
     on the host (through `docker-proxy`), and a neighbour on the provider's
     network routing to the bridge address, reaches them; a newer Docker does
     not prevent that.
   - **Writes `/run/crewaid/egress-ready`** after the policy is installed. The
     orchestrator container waits for that file before starting, because Docker
     restarts it on boot before this unit runs. If the unit fails, the
     orchestrator stays in "Waiting for crewaid-agent-egress.service" in its logs.

4. Close the ports Dokploy leaves open on the uplink. Docker Swarm's manager,
   gossip and VXLAN ports (2377, 7946, 4789) listen on every interface, and
   Dokploy's UI is published on 3000 in host mode; a one-node install needs
   none of them from outside. The unit drops them only on the uplink, so
   Traefik, containers and loopback are untouched, and re-applies itself when
   Docker restarts. Reach the UI through Traefik or `ssh -L 3000:127.0.0.1:3000`.
   Close the same ports in the provider's firewall as well.

   ```sh
   sudo install -m 644 infra/dokploy/crewaid-host-uplink-firewall.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now crewaid-host-uplink-firewall.service
   ```

5. Set `SANDBOX_PUBLISH_ON` to the `crewaid-control` gateway:

   ```sh
   docker network inspect crewaid-control -f '{{(index .IPAM.Config 0).Gateway}}'
   ```

   The sandbox supervisor (the one service with the Docker socket, D-200)
   binds each sandbox port to this address and returns it to the
   orchestrator. It refuses `0.0.0.0` and public addresses at startup. Do not
   attach any other service to `crewaid-control`: joining it is what grants
   access to every bot's screen.

## Dokploy environment

Enter the keys in `.env.example` in Dokploy's Environment tab, plus one sign-in
method from `infra/compose/.env.example`. Dokploy writes `.env` beside this
Compose file. `DATABASE_URL` is the Neon **pooled** URL used by the application;
`MIGRATION_DATABASE_URL` is Neon's **direct** URL, used for migrations at start. Use the
connection strings from Neon, including TLS settings. The two URLs must point
to the **same database and branch**. The direct URL is optional for local
development; Prisma CLI falls back to `DATABASE_URL` when it is absent.

The orchestrator gets Redis at `redis://redis:6379`, authenticated with
`REDIS_PASSWORD` (`openssl rand -hex 24`: hex, so it needs no escaping in the
URL), stores attachments and
recordings in the R2 bucket named by the four `ARTIFACT_R2_*` keys (D-220;
nothing is written to the host), and asks the `sandbox-supervisor`
service to create sandbox containers. Only the supervisor holds the
host Docker socket, and it answers only signed requests for the sandbox image,
network and workspace volumes. Still give this Dokploy deployment its own VPS:
the socket can control the host, including Dokploy and other containers.

The default sandbox cap is 4 CPUs and 8 GiB, so Docker refuses to create it on
a 2-vCPU host. For a small one-computer deployment on a 2-vCPU / 8-GB VPS, set
`SANDBOX_CPUS=2`, `SANDBOX_MEMORY_MIB=5120`, and `SANDBOX_MAX_RUNNING=1` in
Dokploy. These lower caps leave room for Dokploy and the orchestrator, but a
browser-heavy computer may be slower or run out of memory. The two resource
overrides can only lower the default limits; swap remains disabled.

## Migrate, start, and verify

Build/deploy the Compose app in Dokploy after the host policy and sandbox image
are ready. The orchestrator container applies pending migrations each time it
starts, through `MIGRATION_DATABASE_URL`, before it serves anything
(`orchestrator-entrypoint.sh`). It refuses a pooled Neon URL there, and a failed
migration stops the container, so check its logs if it restarts in a loop. Do
**not** run `db:seed` against the production branch: it creates a development
fixture account.

Check `/health` and inspect its JSON body: it returns HTTP 200 even when a
dependency is down. Then sign in from the desktop, start one bot, open its
screen, run one tool, restart the orchestrator, and confirm the saved workspace
is present. Then check the policy did what it says:

```sh
# Both hooks present, and the ingress chain admits only crewaid-ctl0.
sudo iptables -t mangle -S | grep CREWAID
# A container that is not on crewaid-control must time out.
P=$(docker port "$(docker ps -qf label=crewaid.managedBy=crewaid-orchestrator | head -1)" 5900)
docker run --rm busybox nc -w 3 ${P%:*} ${P#*:} </dev/null && echo EXPOSED || echo blocked
```

Reboot once before relying on it: after the reboot the orchestrator logs should
show it waited for the egress unit, and the checks above should still hold.

Configure Neon backup and restore separately; Dokploy's database backup UI is
for databases it manages, not this external connection. Dokploy's named volume
backup can cover this Compose app's `artifacts` and `redis-data` volumes.
Bot workspaces (`crewaid-workspace-*`) are created dynamically by the provider,
not mounted on the Dokploy Compose service, so back them up with a separate
host procedure and test a restore. Keep credential keys outside database
backups, and keep a copy of `CREWAID_CREDENTIAL_KEYRING` somewhere other than
Dokploy: messages are sealed under it, so a database restored without
it is unreadable. Do not enable a cleanup job that prunes unused **named** Docker
volumes: a stopped or newly provisioned bot can have an intentionally unattached
workspace volume.

## Staging and promotion

Merging to `main` must never change what paying users run. Contributor pull
requests land on `main` after CI, the CLA and review; from there they reach a
**staging** deployment automatically, and reach **production** only when the
maintainer tags a release that has already run on staging.

### Staging: a second Compose app that tracks `main`

Create a second Docker Compose app in Dokploy from the same repository and the
same Compose file as production, with **Autodeploy** on and its branch set to
`main`, so Dokploy's Git webhook redeploys it on every merge. Give it its own
domain, and set `CREWAID_RELEASE_TAG=staging` in its environment. The value is
accepted wherever the release identity is checked (`/health`,
`apps/orchestrator/scripts/runtime-readiness.mjs` and the
`compose.instabox.yml` healthcheck reject only `dev` or a mismatch), but it
names no commit: read the deployed revision from Dokploy's deployment log.

Staging shares **nothing stateful** with production. Give it its own:

- **Postgres**: a separate Neon branch or project, with its own pooled
  `DATABASE_URL` and direct `MIGRATION_DATABASE_URL`. Migrations from `main`
  run against staging first, which is the point.
- **Stripe**: test-mode keys, prices and webhook secret, with a webhook
  endpoint at the staging domain. Never put live keys on staging.
- **Runtime or Instabox**: a separate project or account and credential.
  Crewaid reconciles every Crewaid computer its credential can see, so a shared
  inventory lets staging pause, stop or delete production computers.
- **R2**: a separate bucket and `ARTIFACT_R2_*` keys. The readiness check
  writes an object there and the artifact reaper deletes objects, so a shared
  bucket lets staging delete production attachments and recordings.
- **Secrets**: its own `BETTER_AUTH_SECRET`, `CREDENTIAL_KEY`,
  `CREWAID_CREDENTIAL_KEYRING`, `REDIS_PASSWORD` and OAuth apps, so a staging
  session or stored key can never open anything on production.

Point a desktop build at staging only through an unpackaged or locally
packaged app (`CREWAID_ORCHESTRATOR_URL`); the released cloud app has the
production address compiled in.

### Production: only a stable tag that ran on staging

1. Pick a commit on `main` that staging has been running, with no open
   regressions from it.
2. Bump `apps/desktop/package.json` to the new version, merge, and tag that
   merge commit `vX.Y.Z` (`git tag vX.Y.Z && git push origin vX.Y.Z`). The tag
   publishes the desktop apps, the self-hosted images and the installer.
3. In the production app, set `CREWAID_RELEASE_TAG=vX.Y.Z`, select that same
   Git revision, and deploy. Then follow the release verification for your
   topology (for Runtime, "Runtime release verification" below).
4. To roll back, deploy the previous tag the same way. Migrations only move
   forward, so a release whose migration is not backwards compatible needs its
   own rollback plan before it is tagged.

**Do not push prerelease tags** (`v1.2.0-rc.1` and the like). Every `v*` tag
triggers the release workflows: it publishes the self-hosted installer to npm,
imports the sandbox image into the production Runtime account, and builds
desktop apps pointed at the production orchestrator. Staging tracks `main`, so
a release candidate needs no tag.

## Computers on DigitalOcean instead of this VPS (Deprecated)

With `compose.digitalocean.yml` as the Compose path, each computer runs as a
DigitalOcean Harness Runtime session and the VPS runs only the orchestrator
and Redis. Steps 2–5 above do not apply: there is no sandbox image to
build here, no egress unit, no `crewaid-control` network and no Docker socket
mount, so a small VPS is enough. Everything else — Neon, the sign-in method,
migrations at start, the domain — is the same.

1. Build the sandbox image for `linux/amd64` and push it to your DigitalOcean
   Container Registry (`doctl registry login` first):

   ```sh
   docker build --platform linux/amd64 -f infra/sandbox-image/Dockerfile \
     -t registry.digitalocean.com/<registry>/crewaid-sandbox:<release> .
   docker push registry.digitalocean.com/<registry>/crewaid-sandbox:<release>
   ```

2. Turn it into a custom template. The base template's adapter must match
   `SANDBOX_DO_BASE_ADAPTER` (`coding-opencode` ↔ `opencode`, the default):

   ```sh
   doctl harness-runtime template create --name crewaid-sandbox-<release> \
     --base-template coding-opencode \
     --source-oci-ref registry.digitalocean.com/<registry>/crewaid-sandbox:<release>
   ```

   Wait until `doctl harness-runtime template list` shows it ready. A template
   is a snapshot of one image: a release that changes the sandbox needs a new
   template and a new `SANDBOX_DO_TEMPLATE`. Existing computers keep the
   template they were created from.

3. In Dokploy's Environment tab, add the DigitalOcean keys from `.env.example`
   alongside the shared ones. `SANDBOX_PROVIDER` is fixed by the Compose file.
   The token needs read and write access to Harness Runtime (a Full Access
   token works); it stays in the orchestrator and is never passed into a
   machine. Leave out the `SANDBOX_IMAGE`/`SANDBOX_PUBLISH_ON`/`SANDBOX_CPUS`
   group: nothing reads it here, and the machine size is `SANDBOX_DO_SIZE`.

The orchestrator refuses to boot without the token or the template rather than
falling back to Docker. After the first sign-in, start a bot and check
`doctl harness-runtime list` shows one session named `crewaid-<id>`.

A paused session **is** that computer's workspace — its files, and a browser
that stays logged in. Do not delete `crewaid-*` sessions from the DigitalOcean
console; the orchestrator pauses idle computers itself and deletes one only
when retention expires.

## Computers on Cloudflare instead of this VPS (Deprecated)

With `compose.cloudflare.yml` as the Compose path, each computer runs as a
Cloudflare Container and the VPS runs only the orchestrator and Redis.
As with DigitalOcean, steps 2–5 above do not apply.

1. Deploy the control Worker and create its R2 bucket and secret:
   `infra/cloudflare/control-worker/README.md`. It builds and pushes the sandbox
   image itself; the image must include the agent-bridge's `BridgeServer`, which
   Cloudflare's 64-character hostnames need.
2. In Dokploy's Environment tab, add `SANDBOX_CF_CONTROL_URL` (the Worker's
   `https://` URL) and `SANDBOX_CF_CONTROL_SECRET` alongside the shared keys.
   `SANDBOX_PROVIDER` is fixed by the Compose file.

A stopped Cloudflare computer keeps its files and saved logins, as a tar in R2,
but not its open tabs: every start is a fresh container with the workspace
restored. Do not empty the `crewaid-workspaces` bucket; the orchestrator deletes
a computer's workspace itself when retention expires.

## Computers on Runtime instead of this VPS

With `compose.runtime.yml` as the Compose path, each computer runs as a
[Runtime](https://withruntime.com) sandbox and the VPS runs only the
orchestrator and Redis. As with DigitalOcean, steps 2–5 above do not apply, and
there is nothing else to deploy: Runtime builds the image and hosts the
machines.

1. Create an API key on a Runtime account **with credit**. Without it the
   orchestrator refuses to create computers, because Runtime would delete a
   paused one after seven days; credit also lifts the 2 vCPU / 4 GiB cap.
   Store a `read:packages` GHCR token in Runtime once, so it can pull the
   release images (`runtime images registry set ghcr.io --username <user>`).
   **From then on each release puts its sandbox image on Runtime itself:** the
   release workflow imports the image it pushed to GHCR, tags it with the
   release, and moves `crewaid-sandbox:latest` to the newest one. That job
   needs the `RUNTIME_API_KEY` Actions secret on the repository. Before the
   first such release, or for a build of your own, put an image there by hand
   (GHCR tags drop the `v`; nothing is built locally):

   ```sh
   RUNTIME_API_KEY=… pnpm --filter @crewaid/sandbox-runtime build-image <release> \
     --from ghcr.io/natanael-exe/crewaid-sandbox:<release without v> --latest
   ```

   With `SANDBOX_RUNTIME_IMAGE=crewaid-sandbox:latest`, computers follow
   releases: one on an older version is switched to the newest the
   next time it starts from paused or stopped. Runtime keeps a sandbox's
   `/workspace` across a switch and discards the rest of its disk, which is
   why the home lives in `/workspace/.crewaid-home`, bound over `/home/bot`.
   If Runtime reports `image_on_another_host`, Crewaid migrates the home and
   workspace into a verified replacement on the new image. The logical
   computer stays the same; its old sandbox remains paused for the workspace
   retention grace period. A transfer or readiness failure preserves the source
   and reports the upgrade failure. A computer already running keeps its version
   until it next starts. A fixed
   tag instead of `latest` pins every computer to that version.

2. In Dokploy's Environment tab, add `RUNTIME_API_KEY` and
   `SANDBOX_RUNTIME_IMAGE=crewaid-sandbox:latest`, and optionally the
   `SANDBOX_RUNTIME_*` size keys, alongside the shared ones. `SANDBOX_PROVIDER`
   is fixed by the Compose file. The key stays in the orchestrator and is
   never passed into a machine.

The orchestrator refuses to boot without the key or the image rather than
falling back to Docker. After the first sign-in, start a bot and check
`npx withruntime sandboxes ls` shows one sandbox named `crewaid-<id>`.

A paused sandbox **is** that computer's workspace — its files, its open windows
and a browser that stays logged in. Do not delete `crewaid-*` sandboxes from
Runtime's console; the orchestrator pauses idle computers itself and deletes
one only when retention expires.

### Runtime release verification

1. Set `CREWAID_RELEASE_TAG` to the immutable release tag and select the matching
   Git revision in Dokploy. Keep one orchestrator active. Drain recordings,
   skill runs and pending work before replacing it. Use the fixed auth build for
   any fallback release. Reissue outstanding magic links and restart OAuth
   flows begun before the upgrade. Review sessions issued while the affected
   build was live and revoke any the review identifies as suspicious.
2. Confirm that the container's image digest and `/health` version match the
   release. Check the migration log and the container's health status.
   `node apps/orchestrator/scripts/runtime-readiness.mjs`, run inside the same
   container, checks database and Redis connectivity, Runtime inventory and
   image resolution, and access to a dedicated R2 object. It creates that object
   if absent. Docker's healthcheck runs the same script with `--liveness`,
   which checks only the release identity: Traefik stops routing to an
   unhealthy container, so a Runtime, R2 or Redis outage must not fail it. Run
   the full check by hand after each deploy and after rotating a credential.
3. In staging with the same key scopes, resolve the pinned sandbox image using
   the actual orchestrator credential. It needs image read access (including
   `images:get`) in the correct Runtime project and permissions for the
   computer lifecycle, tunnels and private previews. Use a separate credential
   for image publishing. Keep production and staging computer inventories
   isolated, since Crewaid reconciles every Crewaid computer visible to its
   credential.
4. Use disposable accounts to complete Google and email-link sign-in through
   the shipped desktop app, then complete checkout, apply a signed Stripe
   webhook and confirm the resulting plan in the app. Verify the key, prices and
   webhook belong to the same intended Stripe mode. A production cloud
   orchestrator requires Stripe configuration at startup.
5. Confirm bot creation and refused plan admission leave inventory unchanged.
   Start an admitted account's computer, check the bridge and screen, and record
   the configured image and idle policy. Pause and resume it and read a file
   written before pause. Test a failed wake in staging and compare the final VM
   state with the occupied-slot count. Use the current sandbox image to verify
   direct screen access. Older images use the orchestrator relay. Before
   relying on the viewing limit, close old direct viewers by draining and
   pausing any computers still serving streams opened before the release. With
   two test logins watching one computer, revoke one and check that it stops
   receiving new pixels within 60 seconds while the other reconnects.
6. Upload and delete a synthetic attachment. Confirm its R2 object is absent
   and the deletion record clears. Check that periodic artifact reaping is
   enabled and that a temporary staging storage failure leaves a deletion
   record that clears after credentials are restored.

### Runtime recovery drill

Keep Neon recovery points, the Redis volume backup, the R2 objects and the
credential keyring off the Dokploy host. Maintain a recoverable map of logical
computer IDs to verified off-server Runtime snapshots or exported workspaces.
The files on a paused machine live on its own disk, and the backup retained
during an image switch serves only that upgrade. Confirm off-server completion
and retention in [Runtime's storage controls](https://withruntime.com/docs/storage).
The [Dokploy volume backup](https://docs.dokploy.com/docs/core/volume-backups)
in this topology covers the Redis volume.

Restore a test account into an isolated deployment with a separate Runtime
inventory. Verify one decrypted conversation, a usable encrypted test
credential, a downloadable attachment, the workspace file after resuming, and
a pending job that runs once. Record the recovery time and how far the restored
state lags the last known good write.
