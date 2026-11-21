# Host Isolation & Capacity Verification

These probes run against a provisioned Linux Docker host. They are separate
from CI because Docker Desktop cannot install or attest the daemon-host firewall
and a shared CI runner is not a multi-desktop capacity target.

Build the production sandbox image and create its dedicated network:

```sh
docker build -f infra/sandbox-image/Dockerfile -t crewaid/sandbox:dev .
docker network inspect agent-net >/dev/null 2>&1 || docker network create agent-net
python3 infra/compose/agent-egress.py --network agent-net
```

## Sandbox Isolation Probe

Start PostgreSQL with port 5432 reachable on the sandbox bridge gateway (the
normal compose deployment publishes the same port), then run the probe as root:

```sh
python3 infra/qa/deployed_sandbox_security.py
```

The probe refuses to run unless both IPv4 and IPv6 firewall hooks are installed
for the exact Docker bridge. It verifies the host listener first, then proves
from a production-constrained sandbox that `/var/run/docker.sock` is absent,
the host PostgreSQL port times out and increments the firewall DROP counter,
and public HTTPS plus Docker DNS remain usable. Its one container is always
removed.

## Multi-Desktop Resource Benchmark

```sh
python3 infra/qa/measure_sandbox_resources.py \
  --output /tmp/crewaid-resources.json
```

The measurement starts six desktops concurrently with production container limits
and one durable workspace each. Every Chrome instance loads `example.com` while
X11 clicks and screenshots exercise the visible desktop. The report includes
concurrent startup/restart latency, aggregate sampled CPU, peak RAM and PIDs,
image size, writable-layer/workspace disk growth, and total measured runtime.
All test containers and `crewaid-workspace-qa09-*` volumes are removed in a
`finally` block; leftover volumes turn an otherwise successful run into a
failure.
