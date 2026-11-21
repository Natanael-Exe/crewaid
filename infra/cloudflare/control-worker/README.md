# Cloudflare control Worker (Deprecated)

> **Deprecated:** This sandbox provider is legacy and superseded by [`@crewaid/sandbox-runtime`](../../../packages/sandbox-runtime) (managed) and [`@crewaid/sandbox-docker`](../../../packages/sandbox-docker) (self-hosted).

With `SANDBOX_PROVIDER=cloudflare`, computers run as Cloudflare
Containers. A container can only be started, run commands in, or
reached by the Durable Object that owns it, so this Worker is the control plane
the orchestrator talks to: one Durable Object per computer, a registry that
makes them listable, and a WebSocket tunnel to any port inside a computer.

A container's disk starts fresh from the image every time. A computer's
workspace is a tar of `/home/bot` in the `crewaid-workspaces` R2 bucket, which
the Worker restores before the desktop starts and saves on every stop, every 30
minutes while it runs, and before it stops a computer whose orchestrator has
gone quiet for 15 minutes. Open tabs and running programs do not survive a
stop; files and saved logins do.

## Automated releases

The `cloudflare-sandbox` job in `.github/workflows/release-images.yml` updates
the existing Worker on the newest stable `v*` tag (D-216). It compares the
Dockerfile, copied image inputs, executor bundler pin, Docker ignore rules and
Worker code/configuration against the fingerprint stored on the live Worker.
A version bump alone skips deployment. The first automated release deploys
because the existing Worker has no fingerprint yet; a failed deployment is
retried by the next eligible release.

These GitHub repository variables identify your deployment:

| Variable | Example |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `<your-cloudflare-account-id>` |
| `CLOUDFLARE_SANDBOX_WORKER_NAME` | `crewaid-computers` |
| `CLOUDFLARE_SANDBOX_APPLICATION_ID` | `<your-cloudflare-application-id>` |

The last ID belongs to the container application
`crewaid-computers-computer`, which is owned by the Worker's `COMPUTER`
Durable Object namespace. It is not a Cloudflare account ID or Worker name.

Store a dedicated account-scoped deployment token in the GitHub secret
`CLOUDFLARE_API_TOKEN`. It needs Workers Scripts edit and Workers Containers
write permissions, plus Workers R2 Storage read for the existing bucket. Do not
store a local Wrangler OAuth login token; it expires and cannot authenticate
future release jobs. No DNS, zone or API-token administration permissions are
needed by the release job.

Before deploying, the job verifies the Worker, selected application, registry,
workspace and control-secret bindings. An absent or different target fails
without provisioning a replacement. It preserves the existing R2 bindings,
computer sizes and secrets. It uses the successful AMD64 GHCR build by immutable
digest, runs the sandbox runtime smoke check, then copies that image into
Cloudflare's registry with pinned Wrangler. Failed builds or smoke checks stop
deployment; npm installer publication does not block this job.

Deployments are serialized and older releases cannot replace a newer one.
Running computers keep their image. The next normal start uses the updated
image and restores the saved workspace; releasing does not restart computers.
The separate downloads Worker continues to serve desktop installers.

## Initial deployment

Needs the Workers Paid plan, Docker, and Wrangler logged in to the account.

```sh
cd infra/cloudflare/control-worker
npx wrangler r2 bucket create crewaid-workspaces
openssl rand -hex 32            # the control secret; keep it for the orchestrator
npx wrangler deploy             # builds and pushes the sandbox image, then deploys
npx wrangler secret put CONTROL_SECRET
```

`wrangler deploy` builds `infra/sandbox-image` and pushes it to Cloudflare's
registry. The image is about 650 MB compressed; on a slow uplink the push
stalls (its registry credentials last 15 minutes). Push it from a machine with a
fast connection instead, then replace `images.base` in `wrangler.jsonc` with the
pinned digest:

```sh
npx wrangler containers registries credentials registry.cloudflare.com --push --expiration-minutes 60 --json
# on the fast machine: docker login registry.cloudflare.com, tag, push
```

Then give the orchestrator the Worker's URL and the secret:

```
SANDBOX_PROVIDER=cloudflare
SANDBOX_CF_CONTROL_URL=https://crewaid-computers.<subdomain>.workers.dev
SANDBOX_CF_CONTROL_SECRET=<the secret>
```

Redeploying the Worker with a new image changes nothing for existing computers
until their next start: every start is the current image plus the saved
workspace.

Do not delete the Worker and deploy it again under the same name. Cloudflare
kept a reference to the deleted Worker's container application, and every later
deploy under that name stopped with "could not finish applying its Durable
Object-managed Container application settings" (seen 2026-09-30). A new Worker
name deployed cleanly.

## Size and cost

`INSTANCE_VCPU`, `INSTANCE_MEMORY_MIB` and `INSTANCE_DISK_MB` set every
computer's size (at most 4 vCPU, 12 GiB, 20 GB; at least 3 GiB per vCPU).
Memory and disk are billed while a computer runs, whether used or not; CPU only
while busy; nothing while stopped except the R2 storage of its workspace.
