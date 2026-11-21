#!/bin/sh
# Applies pending migrations, then becomes the orchestrator.
#
# Here rather than in the image build: the build runs while the previous
# release is still serving, can fail after a migration has already landed, and
# is cached by its inputs rather than by the database's state. At start, the
# schema and the code that needs it go live together or not at all, and a
# restart with nothing pending is a no-op. A failed migration exits non-zero,
# so the new code never serves against the old schema.
set -eu

# Default to DATABASE_URL on hosts without a separate pooled/direct split
# (Docker, Railway, Render, Fly.io, DigitalOcean); refuse Neon pooler URLs.
MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-${DATABASE_URL:?Set DATABASE_URL (or MIGRATION_DATABASE_URL)}}"

# Prisma's schema engine needs a session the pooler does not keep, and fails
# there in ways that read as a broken migration.
case "$MIGRATION_DATABASE_URL" in
  *-pooler.*)
    echo 'MIGRATION_DATABASE_URL must be the direct Neon URL, not the pooled one' >&2
    exit 1
    ;;
esac

# A Neon branch suspended between deploys can take longer to wake than
# Prisma's default connect timeout.
case "$MIGRATION_DATABASE_URL" in
  *connect_timeout=*) ;;
  *\?*) MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL}&connect_timeout=30" ;;
  *) MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL}?connect_timeout=30" ;;
esac
export MIGRATION_DATABASE_URL

echo 'Applying database migrations' >&2
pnpm --filter @crewaid/orchestrator exec prisma migrate deploy

exec node apps/orchestrator/dist/main.js
