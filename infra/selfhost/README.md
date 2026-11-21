# Self-hosted Crewaid

Run the Crewaid server on your own machine or server, and use it from the
**Crewaid Self-Hosted** desktop app. Accounts are email and
password, models are your own provider keys, and there is no billing.

The easy way is the installer, which writes the two files below, generates every
secret, starts the stack and tells you what to type into the app:

```sh
curl -fsSL https://downloads.crewaid.io/install.sh | sh     # macOS, Linux
npx crewaid-selfhost init                                   # anywhere with Node 18+
```

This page is the manual path, and what the installer does underneath.

## What runs

| Service | Image | Role |
|---|---|---|
| `orchestrator` | `ghcr.io/natanael-exe/crewaid-orchestrator` | The server the app talks to. Applies database migrations on start. |
| `sandbox-supervisor` | `ghcr.io/natanael-exe/crewaid-orchestrator` | Signed lifecycle requests on the private control network; the only service with the Docker socket. |
| `postgres` | `postgres:16` | Accounts, bots, conversations. Volume `postgres-data`. |
| `redis` | `redis:7` | Queues (routines, bot-to-bot messages). Volume `redis-data`. |
| `egress` | `ghcr.io/natanael-exe/crewaid-egress` | The sandbox fence: computers reach the internet on 80/443 and nothing else. |
| `networks-ready` | `ghcr.io/natanael-exe/crewaid-sandbox` | Runs once: creates the computers' network and makes sure their image is here. |
| `caddy` | `caddy:2` | Only with `--profile https`: HTTPS for a domain, certificates automatic. |

Each bot's computer is a container started from `crewaid-sandbox` on the
`crewaid-sandboxes` network. All images are published for `linux/amd64` and
`linux/arm64`, so Apple silicon and ARM servers run them natively.

## Requirements

- **Docker Desktop** (macOS, Windows), or **Docker Engine + Compose v2** (Linux).
- About **2 CPUs and 4 GB of memory per running computer**, on top of a few
  hundred MB for the server. `SANDBOX_MAX_RUNNING` caps how many run at once.
- About 5 GB of disk for the images, plus your bots' files.
- Linux only: the bridge netfilter module, which most distributions load with
  Docker. If the `egress` service logs a `br_netfilter` error:
  `sudo modprobe br_netfilter && echo br_netfilter | sudo tee /etc/modules-load.d/crewaid.conf`

## Install by hand

```sh
mkdir -p ~/crewaid && cd ~/crewaid
# copy compose.yml and .env.example from this directory, then:
cp .env.example .env && chmod 600 .env    # fill in every value; the comments say how
docker compose up -d
docker compose logs -f orchestrator       # wait for "listening"
```

Then download **Crewaid Self-Hosted**
([macOS](https://downloads.crewaid.io/desktop/selfhosted/mac),
[Windows](https://downloads.crewaid.io/desktop/selfhosted/windows)), open it,
enter the address from `BETTER_AUTH_URL`, and create your account.

## How it is reached

- **This computer only** (default): `BETTER_AUTH_URL=http://localhost:3000`,
  `CREWAID_BIND=127.0.0.1`.
- **A local network**: `BETTER_AUTH_URL=http://<this machine's LAN address>:3000`,
  `CREWAID_BIND=0.0.0.0`. Plain http: passwords and sessions cross the network
  unencrypted, and the server warns about it at start. Fine on a network you trust.
- **The internet**: point a domain at this machine, open ports 80 and 443, set
  `CREWAID_DOMAIN` and `BETTER_AUTH_URL=https://<domain>`, and start with
  `docker compose --profile https up -d`.

## The sandbox fence

A bot's computer runs a real browser on the open web, so it must not be able to
reach anything private. The `egress` service installs, in the Docker daemon's own
network namespace, a policy on the computers' bridge (`crewaid-sbx0`), the same
script as the Linux systemd unit in `infra/compose/`:

- **out:** TCP 80 and 443 to public addresses; nothing to this machine, the local
  network, other computers, the orchestrator, or cloud metadata (169.254.169.254);
- **in:** nothing is published. The orchestrator joins the computers' network at a
  fixed address (`10.231.0.2`) and connects to each computer's screen and DevTools
  directly; that address is the only one the fence lets open a connection.

On Docker Desktop the "host" is Docker's VM, which is where the computers'
bridge lives, so the fence protects macOS and Windows installs too. The
orchestrator starts only once the fence has said it is installed, including
after a reboot, and the fence re-applies itself every 30 seconds.

## Everyday

```sh
npx crewaid-selfhost update             # newest release: rewrites compose.yml, pulls, restarts
npx crewaid-selfhost reset-password you@example.com
docker compose ps                       # what is running
docker compose logs -f orchestrator
```

Without the installer, `update` is: set `CREWAID_VERSION` in `.env`, then
`docker compose pull && docker compose up -d`. A release from before the sandbox
supervisor also needs `SANDBOX_SUPERVISOR_SECRET=$(openssl rand -hex 32)` added
to `.env` (the installer adds it for you). `reset-password` is:

```sh
docker compose exec orchestrator node apps/orchestrator/dist/cli/reset-password.js you@example.com
```

It asks for the new password twice (or reads one line from a pipe) and signs that
account out everywhere.

## Who holds the Docker socket

Only `sandbox-supervisor`. It starts, stops and removes computers for
the orchestrator and refuses everything else: any image but the sandbox image,
any network but `crewaid-sandboxes`, any mount but a bot's own workspace volume,
looser limits, and anything it did not create. It is reachable only on the
internal `control` network, every request is signed with
`SANDBOX_SUPERVISOR_SECRET` and refused if replayed, and each action is logged
(`docker compose logs sandbox-supervisor`, `"event":"supervisor.action"`). The
orchestrator has no socket: a fault in it cannot reach the host's Docker.

Ownership also includes the sandbox network. Workspace volumes carry the
supervisor-written `crewaid.supervisorNetwork` label; another deployment's
volumes and old unscoped volumes are omitted from retention inventory and
refused by mutations. Each deployment must use its own sandbox network. This
pre-launch change requires fresh setup rather than adopting old volumes.

If the supervisor stops, computers cannot start or stop, `/health` reports
`docker: false`. A request whose response was lost may already have completed;
reconciliation checks actual container state when the supervisor is back.

To rotate the secret without stopping computers:

1. In `.env`, move the current value to `SANDBOX_SUPERVISOR_SECRET_PREVIOUS` and
   set `SANDBOX_SUPERVISOR_SECRET` to a new `openssl rand -hex 32`.
2. `docker compose up -d` — the supervisor accepts both while the orchestrator
   restarts on the new one.
3. Remove the `SANDBOX_SUPERVISOR_SECRET_PREVIOUS` line and
   `docker compose up -d` again.

## Backups

Everything worth keeping is in these volumes and one file:

- `crewaid_postgres-data`: accounts, bots, conversations, encrypted provider keys;
- `crewaid_artifacts`: files attached in chat and the recordings skills are taught from;
- the bots' workspaces, the `crewaid-workspace-*` volumes;
- `.env`: **the keys that decrypt the provider keys.** Keep it with the backup,
  but never inside the database backup itself.

```sh
docker compose exec -T postgres pg_dump -U crewaid crewaid | gzip > crewaid-$(date +%F).sql.gz
```
