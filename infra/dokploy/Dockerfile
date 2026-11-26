FROM node:22.23.2-bookworm-slim

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

# Install from manifests before copying sources, so a source-only deploy can
# reuse the dependency layer. The build context is the repository root.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY packages/acp-core/package.json packages/acp-core/package.json
COPY packages/brand/package.json packages/brand/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/sandbox-cloudflare/package.json packages/sandbox-cloudflare/package.json
COPY packages/sandbox-core/package.json packages/sandbox-core/package.json
COPY packages/sandbox-digitalocean/package.json packages/sandbox-digitalocean/package.json
COPY packages/sandbox-docker/package.json packages/sandbox-docker/package.json
COPY packages/sandbox-instabox/package.json packages/sandbox-instabox/package.json
COPY packages/sandbox-runtime/package.json packages/sandbox-runtime/package.json
COPY packages/sandbox-supervisor/package.json packages/sandbox-supervisor/package.json
COPY packages/screen-gateway/package.json packages/screen-gateway/package.json
COPY packages/screen-stream/package.json packages/screen-stream/package.json
COPY packages/selfhost-cli/package.json packages/selfhost-cli/package.json
COPY packages/skill-runtime/package.json packages/skill-runtime/package.json
RUN pnpm install --frozen-lockfile

# Prisma's Linux engine needs OpenSSL at generation and runtime. The slim Node
# image omits the CLI, so Prisma otherwise guesses an obsolete libssl version.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Prisma Client and the runtime workspace packages are built in the image.
COPY . .

# D-238: the Enterprise modules (apps/orchestrator/src/ee) are licensed apart
# from the AGPL core and run only on Crewaid Cloud. Every image is built
# without them unless asked: the GHCR image and the one-click PaaS templates
# are pure AGPL builds, and only the hosted Dokploy compose files pass 1.
# Declared after the dependency layers so both variants share them.
ARG CREWAID_BUILD_EE=0
RUN if [ "$CREWAID_BUILD_EE" != "1" ]; then \
      rm -rf apps/orchestrator/src/ee apps/orchestrator/test/ee; \
    fi
RUN pnpm db:generate \
    && pnpm exec turbo run build --filter=@crewaid/orchestrator... --filter=@crewaid/sandbox-supervisor...

ENV NODE_ENV=production
# Reported by GET /health so desktop clients can detect an older server.
# Set by the release workflow; local builds report `dev`. `auto` takes the
# release from apps/desktop/package.json, which a deploy-on-tag build needs:
# nothing passes it the tag, and the release workflow refuses any `v*` tag that
# differs from that file, so on a tagged commit the two are the same.
# The resolved value is written to /app/.crewaid-version, which the entrypoint
# and the healthchecks read, because ENV cannot hold a value computed here.
ARG CREWAID_VERSION=dev
RUN if [ "$CREWAID_VERSION" = auto ]; then \
      node -p "require('./apps/desktop/package.json').version" > .crewaid-version; \
    else \
      printf '%s\n' "$CREWAID_VERSION" > .crewaid-version; \
    fi
ENV CREWAID_VERSION=${CREWAID_VERSION}
LABEL org.opencontainers.image.version=${CREWAID_VERSION}
EXPOSE 3000
# Migrates, then execs the orchestrator (see the script for why not here).
CMD ["infra/dokploy/orchestrator-entrypoint.sh"]
