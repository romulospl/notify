# syntax=docker/dockerfile:1
# Imagem do portal. O contexto do build é a raiz do repositório:
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
RUN pnpm --filter @stellytics/portal build
# O otimizador de imagem está desligado: sharp e libvips não são distribuídos
# no standalone; caniuse-lite também não vai para a imagem. Remove os pacotes
# e os links para eles; como o libvips é o único módulo nativo esperado, um
# segundo passe recusa qualquer binário *.node — rede estrutural contra
# mudanças de layout do pnpm/Next que escapem dos padrões de nome.
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
# Migrações aplicadas na subida quando RUN_MIGRATIONS=true (src/instrumentation.ts).
COPY --from=build --chown=app:app /repo/apps/portal/drizzle ./apps/portal/drizzle
USER app
WORKDIR /app/apps/portal
EXPOSE 3000
CMD ["node", "server.js"]

# Só para o Compose de desenvolvimento (target: dev): acrescenta as contas de
# desenvolvimento (senhas conhecidas), aplicadas com SEED_DEV_DATA=true.
FROM runner AS dev
COPY --from=build --chown=app:app /repo/apps/portal/drizzle-dev ./drizzle-dev

# Imagem de produção: o último estágio é o alvo padrão do build e do release.yml,
# e não leva o drizzle-dev (test/dockerfile.test.ts).
FROM runner
