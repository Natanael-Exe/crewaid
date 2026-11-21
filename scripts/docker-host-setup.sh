#!/usr/bin/env bash
# M5-QA host setup — make a bare Ubuntu box able to run the gated suites.
#
# WHY THIS FILE EXISTS. The repository's most valuable tests are gated, and the
# gates are not equal:
#
#   - DATABASE_URL-gated suites run in CI (postgres + redis services in
#     .github/workflows/ci.yml), so a box without Postgres can still LAND them
#     and have CI prove them.
#   - CREWAID_DOCKER_TESTS-gated suites run NOWHERE in CI — no workflow sets the
#     variable — so the only proof they ever get is on a machine someone
#     provisioned by hand.
#
# Two agents on two boxes hit this during M5: one had Docker and Postgres, the
# other had neither, and the difference was discovered mid-conversation rather
# than before the work was split. This script removes the accident. It takes a
# fresh Debian/Ubuntu box to the point where the same commands the evidence
# scripts already use will run.
#
# WHAT IT DOES
#   1. installs docker.io, docker-buildx, docker-compose-v2
#   2. enables the daemon and adds the invoking user to the docker group
#   3. copies infra/compose/.env.example -> infra/compose/.env when absent
#   4. brings up Postgres 16 + Redis 7 from infra/compose and waits for health
#   5. builds the sandbox image from THIS TREE. The image bundles the skill
#      runner, so a stale image replays a runtime the branch does not ship.
#   6. prints the env block the gated suites need, plus a hardware warning when
#      this box cannot run one of them
#
# WHAT IT DOES NOT DO
#   - install the §7.3 sandbox egress policy. That is a host firewall change
#     with its own installer and ordering: infra/compose/README.md.
#   - migrate or seed the database. Both are one command each and belong to the
#     caller: `pnpm db:deploy` then `pnpm db:seed`.
#   - lift a hardware ceiling. Docker refuses a container that asks for more
#     CPUs or memory than the box has, so some suites are simply unavailable on
#     a small box no matter what is installed. Today the only one that asks for
#     more than a sane box has is seat-docker.integration.test.ts (--cpus 4);
#     a 2-vCPU box fails it at `docker run`, before any assertion.
#
# USAGE
#   bash scripts/docker-host-setup.sh [image-tag]     # default crewaid/sandbox:dev
#
# Afterwards, a gated run looks like this — `sg docker -c` only while the
# docker group is not live in your current shell (a new login carries it):
#
#   sg docker -c 'DATABASE_URL=postgresql://crewaid:crewaid@localhost:5432/crewaid?schema=public \
#     REDIS_URL=redis://:<REDIS_PASSWORD from infra/compose/.env>@localhost:6379 CREWAID_DOCKER_TESTS=1 SANDBOX_IMAGE=crewaid/sandbox:dev \
#     pnpm --filter @crewaid/orchestrator exec vitest run test/seat-docker.integration.test.ts'
#
# If a suite still needs `sg docker`, remember it while importing is not a
# substitute for being in the group: `sg` runs the command with the docker
# group added for that invocation only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-${SANDBOX_IMAGE:-crewaid/sandbox:dev}}"

info() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v apt-get >/dev/null || die "apt-get not found — this script targets Debian/Ubuntu hosts"
command -v systemctl >/dev/null || die "systemd not found — start the daemon yourself and rerun with the group already live"

# ── 1. packages ─────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  info "docker present: $(docker --version 2>/dev/null || echo 'cli only')"
else
  info "installing docker.io docker-buildx docker-compose-v2"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-buildx docker-compose-v2
fi

# ── 2. daemon and group ─────────────────────────────────────────────────────
sudo systemctl enable --now docker >/dev/null
if id -nG "$USER" | grep -qw docker; then
  info "$USER is in the docker group"
else
  sudo usermod -aG docker "$USER"
  info "added $USER to the docker group — a NEW login shell carries it, this one does not"
fi

# The group is read at login, so the shell that ran `usermod` cannot use it.
# Re-exec the rest under `sg` rather than making the caller remember.
if ! docker info >/dev/null 2>&1; then
  info "docker group not live in this shell — re-running the rest via sg docker"
  exec sg docker -c "$(printf '%q ' "$0" "$@")"
fi

# ── 3. compose env ──────────────────────────────────────────────────────────
if [[ ! -f "$ROOT/infra/compose/.env" ]]; then
  cp "$ROOT/infra/compose/.env.example" "$ROOT/infra/compose/.env"
  info "created infra/compose/.env from the example (secrets blank — fill in to run the orchestrator)"
fi
# Compose refuses to start Redis without a password, so a blank one is filled
# here: hex, so it needs no percent-encoding in REDIS_URL.
if ! grep -q '^REDIS_PASSWORD=.\+' "$ROOT/infra/compose/.env"; then
  REDIS_PASSWORD="$(openssl rand -hex 24)"
  sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$REDIS_PASSWORD|; s|<REDIS_PASSWORD>|$REDIS_PASSWORD|" \
    "$ROOT/infra/compose/.env"
  info "generated REDIS_PASSWORD in infra/compose/.env"
fi
REDIS_URL_LINE="$(grep '^REDIS_URL=' "$ROOT/infra/compose/.env" | tail -1)"

# ── 4. Postgres + Redis ─────────────────────────────────────────────────────
COMPOSE=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
"${COMPOSE[@]}" up -d >/dev/null
for _ in $(seq 1 30); do
  pending="$("${COMPOSE[@]}" ps --format '{{.Health}}' | grep -cv 'healthy' || true)"
  [[ "$pending" == "0" ]] && break
  sleep 2
done
"${COMPOSE[@]}" ps --format 'table {{.Name}}\t{{.Status}}'

# ── 5. the sandbox image, from this tree ────────────────────────────────────
info "building $IMAGE from $(git -C "$ROOT" rev-parse --short HEAD)"
docker buildx build --load -f "$ROOT/infra/sandbox-image/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null

# ── 6. what this box is and what it can run ─────────────────────────────────
CPUS="$(nproc)"
MEM_GIB="$(( $(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo) / 1024 / 1024 ))"
DIGEST="$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null | cut -c1-19 || echo unknown)"

cat <<EOF

── this box ────────────────────────────────────────────────────────────
commit:        $(git -C "$ROOT" rev-parse HEAD)
SANDBOX_IMAGE: $IMAGE  $DIGEST
docker:        $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)
cpus:          $CPUS
memory:        ${MEM_GIB} GiB

gated-suite env:
  DATABASE_URL=postgresql://crewaid:crewaid@localhost:5432/crewaid?schema=public
  $REDIS_URL_LINE
  CREWAID_DOCKER_TESTS=1
  SANDBOX_IMAGE=$IMAGE

next steps:
  pnpm db:deploy && pnpm db:seed     # DB-backed suites assume schema + singleton user
  sg docker -c '<the env above> pnpm test'   # only while the group is not live
EOF

if (( CPUS < 4 )); then
  cat <<EOF

warning: seat-docker.integration.test.ts starts its container with --cpus 4 and
this box has $CPUS. Docker refuses it before any assertion runs, so that suite
belongs on a 4-vCPU box (or its flag needs relaxing) — installing packages
cannot change this.
EOF
fi
