# syntax=docker/dockerfile:1
# Imagem do portal. O contexto do build é a raiz do repositório:
#   docker build -f apps/portal/Dockerfile .

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/portal/package.json apps/portal/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @notify/portal

FROM deps AS build
COPY apps/portal apps/portal
RUN pnpm --filter @notify/portal build

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /repo/apps/portal/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/portal/.next/static ./apps/portal/.next/static
# Migrações aplicadas na subida quando RUN_MIGRATIONS=true (src/instrumentation.ts).
COPY --from=build --chown=app:app /repo/apps/portal/drizzle ./apps/portal/drizzle
USER app
WORKDIR /app/apps/portal
EXPOSE 3000
CMD ["node", "server.js"]
