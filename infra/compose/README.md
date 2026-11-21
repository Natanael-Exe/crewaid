# infra/compose

Postgres 16 and Redis 7 for local development and for the VPS deployment
(PRD §2.3, M0-05).

## Usage

    cp .env.example .env      # then fill in the secrets, including REDIS_PASSWORD
    docker compose up -d
    docker compose ps         # both services should report (healthy)

From the repo root, once the database is up:

    pnpm db:deploy            # prisma migrate deploy
    pnpm db:seed              # seeds exactly one User row (PRD §3, R7)

## Network topology (PRD §7.3)

Two networks, deliberately kept apart:

- `crewaid-internal` — Postgres and Redis. Created by this compose file.
- `agent-net` — the bot sandbox bridge. **Not defined here.** It is created by
  `DockerSandboxProvider` in M2, and bot containers attach to it and nothing
  else.

A separate bridge alone does **not** isolate published ports: a sandbox can
reach the host's Postgres/Redis mappings through its own default gateway.
Both are now published on 127.0.0.1 only, and Redis requires `REDIS_PASSWORD`,
which narrows that path; the host firewall below is still what supplies the
boundary required by §7.3. Per
`docs/DECISIONS.md`, iptables is primary; the harness's optional
`setNetworkPolicy()` is not an enforcement mechanism in this provider.

## Install the sandbox egress policy (Linux daemon host)

Install before starting any sandboxes. Stop existing sandboxes during the first
installation: attaching the IPv4 and IPv6 hooks is not a cross-family atomic
operation. Existing hooked chains are replaced atomically on subsequent runs.
Run on the **Docker daemon host**, including when the orchestrator uses a remote
`DOCKER_HOST`. The orchestrator and sandbox containers need no firewall privileges.

Prerequisites: Python 3, Docker CLI, iptables/ip6tables and their `*-restore`
commands, iproute2, `sysctl`, and `br_netfilter` (with `modprobe` if not loaded). Use Docker's
**iptables firewall backend** (iptables-nft is supported); Docker's native nftables
backend is not covered by this deployment. Keep this network dedicated to bots.

Assuming the repository is installed at `/opt/crewaid`:

```sh
sudo install -m 644 infra/compose/crewaid-agent-egress.service /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/crewaid-orchestrator.service.d
sudo install -m 644 infra/compose/crewaid-orchestrator.service.d/egress.conf /etc/systemd/system/crewaid-orchestrator.service.d/
sudo systemctl daemon-reload
sudo systemctl enable --now crewaid-agent-egress.service
sudo systemctl restart crewaid-orchestrator.service
```

The orchestrator service name is a deployment example: install the drop-in under
your actual unit name and adjust `Before=` if it differs. Adjust the repository
path in `ExecStart`/`ExecReload` as needed. The dependency prevents orchestrator
startup when policy installation fails. The firewall unit restarts with Docker
and never removes the rules on stop. No sandbox uses an automatic restart policy.
If using another process supervisor, enforce the same ordering: Docker → network
creation → successful firewall installation → orchestrator/sandbox start.

`--control-interface <iface>` restricts who may open a connection INTO the
sandbox bridge to that one interface. A port published on a non-loopback
address is otherwise reachable from every container on the host and from
anything that can route to that address, by two paths: Docker DNATs a packet
from outside its bridges straight to the sandbox (refused on `FORWARD`), and
answers a packet from another Docker bridge with `docker-proxy`, a host process
that dials the sandbox itself and never crosses `FORWARD` (refused on `INPUT`,
at the interface's own addresses, for everything but the interface and `lo`).
Leave it unset when the orchestrator is a host process publishing on
`127.0.0.1`; set it to the orchestrator's bridge (`infra/dokploy/`) or tunnel
interface when it is not. The interface must exist when the unit runs, and a
recreated interface with a new address needs a reload. Removing the flag and
reloading empties both chains again.

For a custom `SANDBOX_NETWORK`, replace `agent-net` in `ExecStartPre`, and append
`--network YOUR_NETWORK` to both Python commands. The installer discovers the
bridge interface from Docker inspect, including custom bridge names. It validates
that it is a local Linux bridge. To apply manually after provisioning the network:

```sh
sudo python3 infra/compose/agent-egress.py --network agent-net
```

Reapply after deleting/recreating the network, any firewall flush, or a host
firewall reload that discards these rules; stop sandboxes until it succeeds.
Do not add earlier mangle rules that bypass this hook. This is host-managed
infrastructure: provider `ensureNetwork()` does not install or attest firewall
rules. Starting the provider outside the supervised deployment requires the same
provisioning step. A network name or Docker label is not proof of enforcement.

### What the rules enforce

- A bridge-scoped mangle `PREROUTING` chain filters before DNAT, covering traffic
  to the host itself, published ports, routed destinations, and same-bridge peers.
  Bridge netfilter is enabled for IPv4 and IPv6. No Docker chains are flushed.
- IPv4 permits sandbox-originated TCP 80/443 only to public, non-host destinations.
  RFC1918, loopback, link-local/metadata, shared address space, multicast, and
  reserved high addresses and the bridge’s own IPv4 subnets are denied before that allowance. All other traffic
  is dropped, including arbitrary UDP, direct DNS, ICMP, and QUIC.
- IPv6 sandbox-originated traffic is denied entirely, including link-local peer
  traffic, so IPv6 cannot bypass the IPv4 policy. Browser connections use IPv4.
- Established **reply-direction** packets are allowed so orchestrator-initiated
  RFB/CDP/agent-bridge connections receive replies. An existing sandbox-originated
  forbidden connection does not get an established-state exemption.
- Docker's embedded resolver at `127.0.0.11` remains available: its upstream DNS
  forwarding runs in the daemon host namespace and does not enter this bridge
  hook. Direct external DNS is denied. DNS tunneling through the trusted resolver
  and application traffic over allowed HTTPS are outside this port-based policy.

These rules do not expose sandbox ports or change §5.1 resource limits, capability
drops, no-new-privileges, mount restrictions, or loopback port publishing.
Docker Desktop runs its daemon in a VM; running this installer on macOS does not
protect that VM. Use a Linux daemon deployment for enforcement. The isolated
kernel test below also runs on Docker Desktop without changing its host firewall.

References: [Docker iptables packet traversal](https://docs.docker.com/engine/network/firewall-iptables/)
and [published-port behavior](https://docs.docker.com/engine/network/port-publishing/).

### Verification

```sh
python3 -m unittest discover -s infra/compose/tests -v
docker build -t crewaid/egress-test -f infra/compose/tests/Dockerfile .
# On Linux, load the host kernel module before starting the test container:
# sudo modprobe br_netfilter
docker run --rm --privileged crewaid/egress-test
```

The privileged test container has its **own network namespace**, no host networking,
no host mounts and no Docker socket. It builds disposable bridges/namespaces and
proves services are reachable before installing the real rules, then blocked
afterwards. It checks gateway databases, gateway HTTP, DNAT published ports,
peer RFB/CDP/bridge/HTTP, forbidden public ports, IPv6, permitted HTTP/HTTPS,
control replies, existing forbidden connections, public-addressed peers, and repeated installation without duplicate hooks.

On the deployment host, also run the real sandbox security acceptance test
(M2-QA-06) and confirm public hostname browsing through Docker DNS. Inspect
`sudo iptables -t mangle -S` and `sudo ip6tables -t mangle -S` for the
`CREWAID-<bridge>` hooks and counters with `-nvL`. Do not infer successful isolation
from a missing service or a timed-out public endpoint: negative probes need a
reachable positive control.
