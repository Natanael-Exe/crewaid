#!/bin/sh
# Install a self-hosted Crewaid server (D-155):
#   curl -fsSL https://downloads.crewaid.io/install.sh | sh
#   curl -fsSL https://downloads.crewaid.io/install.sh | sh -s -- --mode lan --port 3100
#
# Finds a way to run the `crewaid-selfhost` installer and hands over: with
# Node 18+ it runs `npx crewaid-selfhost init`; without Node it runs the same
# package inside a node container, with the install folder and the Docker
# socket mounted. One installer either way — this script only finds a runtime.
set -eu

VERSION="${CREWAID_INSTALLER_VERSION:-latest}"
DIR="${CREWAID_DIR:-$HOME/crewaid}"
# A `--dir` passed through (`sh -s -- --dir /srv/crewaid`) is the folder: it
# is what gets created and, without Node, mounted. The arguments themselves
# go on unchanged, so the installer sees the same --dir.
expect_dir=""
for arg in "$@"; do
  if [ -n "$expect_dir" ]; then DIR="$arg"; expect_dir=""; continue; fi
  case "$arg" in
    --dir) expect_dir=1 ;;
    --dir=*) DIR="${arg#--dir=}" ;;
  esac
done
case "$DIR" in "~"*) DIR="$HOME${DIR#\~}" ;; esac
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac
# What npx runs: the published package, or (for testing this script before a
# release) a local `npm pack` tarball. CREWAID_INSTALLER_RUNTIME=docker forces
# the no-Node path.
PACKAGE="${CREWAID_INSTALLER_PACKAGE:-crewaid-selfhost@$VERSION}"
RUNTIME="${CREWAID_INSTALLER_RUNTIME:-auto}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Crewaid runs on Docker. Install Docker Desktop (Mac, Windows) or Docker Engine (Linux):" >&2
  echo "  https://docs.docker.com/get-docker/" >&2
  exit 1
fi

# `curl … | sh` gives this script the pipe as stdin, so the installer's
# questions would read end-of-file. Answer them from the terminal instead,
# when there is one; without one the installer takes its defaults.
if [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; else TTY=/dev/null; fi

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$RUNTIME" != docker ] && command -v npx >/dev/null 2>&1 && [ "$(node_major)" -ge 18 ]; then
  # The resolved folder goes last: the installer takes the last --dir it sees.
  exec npx -y --package "$PACKAGE" crewaid-selfhost init "$@" --dir "$DIR" <"$TTY"
fi

echo "Node 18+ not found: running the installer in a container." >&2
mkdir -p "$DIR"
# From inside the container this machine's addresses and ports are not
# visible, so the host's LAN address is passed in and the port check skipped.
LAN_IP="$( (ipconfig getifaddr en0 || ipconfig getifaddr en1 || hostname -I 2>/dev/null | awk '{print $1}') 2>/dev/null | head -n1 || true)"
DOCKER_FLAGS="--rm -i"
[ "$TTY" = /dev/tty ] && DOCKER_FLAGS="--rm -it"
# A local tarball is mounted where the container can read it.
MOUNT_PACKAGE=""
if [ -f "$PACKAGE" ]; then
  PACKAGE_DIR="$(cd "$(dirname "$PACKAGE")" && pwd)"
  MOUNT_PACKAGE="-v $PACKAGE_DIR:/crewaid-installer:ro"
  PACKAGE="/crewaid-installer/$(basename "$PACKAGE")"
fi
# shellcheck disable=SC2086
exec docker run $DOCKER_FLAGS $MOUNT_PACKAGE \
  -v "$DIR:$DIR" -v /var/run/docker.sock:/var/run/docker.sock \
  -e CREWAID_IN_CONTAINER=1 -e "CREWAID_HOST_LAN_IP=$LAN_IP" -e "HOME=$HOME" \
  -e "CREWAID_HOST_UID=$(id -u)" -e "CREWAID_HOST_GID=$(id -g)" \
  node:22-alpine sh -c 'apk add --no-cache docker-cli docker-cli-compose >/dev/null || exit 1; d="$1"; shift; exec npx -y --package "$0" crewaid-selfhost init "$@" --dir "$d"' \
  "$PACKAGE" "$DIR" "$@" <"$TTY"
