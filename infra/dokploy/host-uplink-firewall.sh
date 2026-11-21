#!/bin/sh
# Close the ports a one-node Dokploy install leaves open on the host's uplink.
#
# Dokploy runs Docker Swarm, whose manager (2377/tcp), gossip (7946/tcp+udp)
# and VXLAN (4789/udp) ports listen on every interface. A single node never
# needs them from outside itself: its own traffic to its advertise address is
# delivered over `lo`. Dokploy's UI is published on 3000 in host mode, which
# Docker DNATs from any interface; Traefik reaches it over the overlay network
# and an operator over an SSH tunnel, neither through the uplink.
#
# Only packets arriving on the uplink are dropped, so container, overlay and
# loopback traffic is untouched. Dokploy's 3000 is refused in DOCKER-USER
# because a DNATed packet is forwarded, never delivered to INPUT.
set -eu

uplink="${1:-$(ip -o route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p')}"
case "$uplink" in
  '' | *[!A-Za-z0-9_.-]*) echo "cannot determine the uplink interface: '$uplink'" >&2; exit 1 ;;
esac

for binary in iptables ip6tables; do
  "$binary-restore" --wait 10 --noflush <<RULES
*filter
:CREWAID-UPLINK - [0:0]
:CREWAID-UPLINK-FWD - [0:0]
-F CREWAID-UPLINK
-F CREWAID-UPLINK-FWD
-A CREWAID-UPLINK -i $uplink -p tcp -m multiport --dports 2377,7946 -j DROP
-A CREWAID-UPLINK -i $uplink -p udp -m multiport --dports 4789,7946 -j DROP
-A CREWAID-UPLINK-FWD -i $uplink -m conntrack --ctstate NEW --ctproto tcp --ctorigdstport 3000 -j DROP
COMMIT
RULES
  "$binary" -w 10 -C INPUT -j CREWAID-UPLINK 2>/dev/null ||
    "$binary" -w 10 -I INPUT -j CREWAID-UPLINK
  "$binary" -w 10 -N DOCKER-USER 2>/dev/null || true
  "$binary" -w 10 -C DOCKER-USER -j CREWAID-UPLINK-FWD 2>/dev/null ||
    "$binary" -w 10 -I DOCKER-USER -j CREWAID-UPLINK-FWD
done
echo "uplink $uplink: swarm ports and Dokploy's 3000 closed"
