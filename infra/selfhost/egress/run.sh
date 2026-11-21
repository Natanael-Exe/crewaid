#!/bin/sh
# Install the sandbox egress policy, say so, and keep it installed (D-155).
#
# Runs in the Docker daemon's network namespace. Every 30 s it re-applies the
# policy (idempotent: chains are replaced, hooks checked before insertion), so
# a Docker restart that rebuilt its own chains cannot leave sandboxes unfenced
# for longer than that. The marker in $CREWAID_EGRESS_STATE is what the
# orchestrator waits for before it starts; it lives on a tmpfs volume, so a
# daemon or VM restart empties it and the orchestrator waits again.
set -eu

SANDBOX_BRIDGE="${CREWAID_SANDBOX_BRIDGE:?set the sandbox bridge interface}"
# The orchestrator's address ON the sandbox bridge: the only thing that may
# open connections to a computer (nothing is published), and not itself fenced.
TRUSTED_SOURCE="${CREWAID_TRUSTED_SOURCE:?set the orchestrator's address on the sandbox network}"
STATE="${CREWAID_EGRESS_STATE:-/run/crewaid}"
INTERVAL="${CREWAID_EGRESS_INTERVAL:-30}"

# Use the iptables backend Docker itself uses. Rules written to the other one
# would sit in a table the kernel does not consult for Docker's traffic: the
# backend holding Docker's chains is the one in force.
count() { "$1" 2>/dev/null | grep -c '^:DOCKER' || true; }
mkdir -p /usr/local/crewaid-bin
if [ "$(count iptables-legacy-save)" -gt "$(count iptables-nft-save)" ]; then backend=legacy; else backend=nft; fi
# xtables names the restore/save tools <family>-<backend>-<verb>.
for family in iptables ip6tables; do
  for verb in restore save; do
    ln -sf "$(command -v "$family-$backend-$verb")" "/usr/local/crewaid-bin/$family-$verb"
  done
  ln -sf "$(command -v "$family-$backend")" "/usr/local/crewaid-bin/$family"
done
export PATH="/usr/local/crewaid-bin:$PATH"
echo "crewaid-egress: using the iptables-$backend backend"

apply() {
  python3 /usr/local/lib/crewaid/agent-egress.py \
    --bridge "$SANDBOX_BRIDGE" --trusted-source "$TRUSTED_SOURCE"
}

mkdir -p "$STATE"
rm -f "$STATE/egress-ready"
# The bridges exist once compose has created the networks, which can trail
# this container's start by a moment; wait rather than fail.
until [ -d "/sys/class/net/$SANDBOX_BRIDGE/bridge" ]; do
  echo "crewaid-egress: waiting for $SANDBOX_BRIDGE"
  sleep 2
done
apply
touch "$STATE/egress-ready"
echo "crewaid-egress: policy installed on $SANDBOX_BRIDGE (trusted: $TRUSTED_SOURCE)"

while sleep "$INTERVAL"; do
  if ! apply; then
    # The fence could not be re-applied: say so loudly, and withdraw the
    # marker so an orchestrator restarting now waits instead of starting
    # sandboxes behind a policy nobody can vouch for.
    rm -f "$STATE/egress-ready"
    echo "crewaid-egress: re-applying the policy FAILED" >&2
  else
    touch "$STATE/egress-ready"
  fi
done
