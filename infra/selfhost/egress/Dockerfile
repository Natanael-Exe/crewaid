# The sandbox egress fence as a container (D-155), for self-hosted installs.
#
# The same policy as infra/compose/agent-egress.py's systemd unit, but run in
# the Docker daemon's own network namespace (`network_mode: host`): the Linux
# host on Linux, and the VM on Docker Desktop — which is where the sandbox
# bridge actually lives, so the fence now applies on Mac and Windows too.
# Build context: the repository root.
FROM alpine:3.22.2

RUN apk add --no-cache python3 iptables ip6tables iptables-legacy iproute2

COPY infra/compose/agent-egress.py /usr/local/lib/crewaid/agent-egress.py
COPY infra/selfhost/egress/run.sh /usr/local/bin/crewaid-egress

ENTRYPOINT ["/usr/local/bin/crewaid-egress"]
