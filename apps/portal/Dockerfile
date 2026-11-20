# syntax=docker/dockerfile:1
# Portal image. The build context is the repository root:
#   docker build -f apps/portal/Dockerfile .

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/portal/package.json apps/portal/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @stellytics/portal

FROM deps AS build
COPY apps/portal apps/portal
# Versions and SRI hashes of the tracking script, for the installation tag on
# each site's page (src/lib/tracker-snippet.ts).
COPY packages/tracker/published/sri.json packages/tracker/published/sri.json
# Guides rendered at /docs/[slug] (src/lib/docs-index.json): the build reads
# these Markdown files and prerenders one page each.
COPY docs docs
COPY SECURITY.md CONTRIBUTING.md ./
COPY examples/README.md examples/README.md
COPY examples/api-backend/README.md examples/api-backend/README.md
COPY packages/tracker/docs/ad-blockers.md packages/tracker/docs/ad-blockers.md
RUN pnpm --filter @stellytics/portal build
# Operator admin command bundled with its dependencies (ADR 0017).
RUN pnpm --filter @stellytics/portal build:operator
# The image optimizer is off: sharp and libvips are not shipped in the
# standalone output; caniuse-lite does not go into the image either. Remove the
# packages and the links to them; since libvips is the only native module
# expected, a second pass rejects any *.node binary: a structural net against
# pnpm/Next layout changes that escape the name patterns.
RUN find /repo/apps/portal/.next/standalone -depth \
    -path '*/node_modules/*' \( -name '@img+sharp-*' -o -name 'sharp-*' -o -name 'sharp@*' -o -name 'sharp' -o -name 'caniuse-lite' -o -name 'caniuse-lite@*' \) -exec rm -rf {} + \
    && find /repo/apps/portal/.next/standalone -depth -name '*.node' -exec rm -rf {} +

FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /repo/apps/portal/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/portal/.next/static ./apps/portal/.next/static
# Migrations applied at startup when RUN_MIGRATIONS=true (src/instrumentation.ts).
COPY --from=build --chown=app:app /repo/apps/portal/drizzle ./apps/portal/drizzle
# Operator admin command (#19, ADR 0017), run on the server with
# operator.sh at the repository root. It uses the container's DATABASE_URL, SMTP_URL,
# MAIL_FROM and BETTER_AUTH_URL, so no secret leaves the server. Bundled by
# scripts/build-operator.mjs: the standalone output has no node_modules for it.
COPY --from=build --chown=app:app /repo/apps/portal/dist/operator.mjs ./apps/portal/scripts/operator.mjs
USER app
WORKDIR /app/apps/portal
EXPOSE 3000
CMD ["node", "server.js"]

# Only for the development Compose (target: dev): adds the development
# accounts (known passwords), applied with SEED_DEV_DATA=true.
FROM runner AS dev
COPY --from=build --chown=app:app /repo/apps/portal/drizzle-dev ./drizzle-dev

# Production image: the last stage is the default target of the build and of
# release.yml, and does not carry drizzle-dev (test/dockerfile.test.ts).
FROM runner
