# Development environment, CI and dependencies

## Toolchains

- **TypeScript:** pnpm workspaces (`apps/*`, `packages/*`, `examples/*`) and Turborepo. From the root: `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (all through `turbo run`).
- **Go:** one module in `services/` (`github.com/romulospl/stellytics/services`, Go 1.26). Run `go` from inside `services/`: `gofmt -l .`, `go mod tidy -diff`, `go vet -tags e2e ./...` and `go test -race ./...` (CI runs all four). End-to-end tests use the `e2e` tag and run in the `compose` job.
- **New versions:** `pnpm-workspace.yaml` sets `minimumReleaseAge: 20160` (14 days), so pnpm refuses newer releases. Pin exact versions in `package.json`.

## Local stack

- `docker compose up -d --wait` at the root starts PostgreSQL 17 (databases `umami` and `stellytics`, each with its own user) and Umami 3.4.1 only on the internal network (`http://umami:3000`, login `admin`/`umami`; no published port, #62).
- For the Umami UI, the service account script or the gateway e2e, add the override: `-f compose.yaml -f infra/compose/umami-port.yaml`. It publishes `127.0.0.1:3001` and is for development and CI only.
- The root `compose.yaml` only includes `infra/compose/dev.yaml`. Images are pinned by tag **and digest**.
- Scripts in `infra/compose/postgres/init/` only run on an empty volume; changes need `docker compose down -v`. `02-ingest-roles.sh` is idempotent and can be reapplied with `docker compose exec -T postgres sh < ...`.
- Portal migrations need the `stellytics_ingest` and `stellytics_collector` users created by that script; the CI `typescript` job runs it before the tests.
- Ports and passwords can be changed in `.env` (see `.env.example`). Each service joins `dev.yaml` in the issue that creates it. Current ports: portal 3000 (`RUN_MIGRATIONS=true`), `ingest-web` 3002, collector 4317 (gRPC) and 4318 (HTTP). Mail goes to Mailpit (`http://127.0.0.1:8025`).
- Prefer `127.0.0.1:3001` over `localhost:3001` for Umami: if another program listens on the port over IPv6, `localhost` reaches it instead.

## CI

- `.github/workflows/ci.yml`: jobs `typescript`, `go`, `compose`, `infra`, `monitoring` and the aggregator `ci`. A new job must be added to the `needs` of `ci`. `main` has no branch protection by Romulo's decision; if enabled, require only `ci`.
- Integration tests use the job's Postgres through `DATABASE_URL` (`postgresql://stellytics:stellytics@localhost:5432/stellytics`).
- Actions are always pinned by SHA with the tag in a comment, and only releases at least 14 days old.
- Validate workflow changes with `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`.
- Outside the `ci` aggregator: `.github/workflows/adblock.yml` (see [tracker](tracker.md)) and `.github/workflows/dependencies.yml` (PR #129): reachable `govulncheck`, `pnpm audit --prod` (lookup failure is exit 2), and licenses against `scripts/licenses/allowed.json` (dated exceptions of at most 183 days). `govulncheck` stays red until the Dockerfiles move to `golang:1.26.11` (eligible on 2026-11-16 under the 14-day rule).

## Release and dependencies

- `.github/workflows/release.yml` runs when a release is published: it generates an SBOM and publishes, signs (cosign keyless) and attests one image per `Dockerfile` in `apps/*/` or `services/*/`. The image name is the folder name and the build context is the repository root.
- `renovate.json` enforces the 14-day wait, requires Dependency Dashboard approval for major versions and treats Umami separately; the `docker-compose` manager reads `infra/compose/*.yaml`. Validate with `npx --yes --package renovate -- renovate-config-validator --strict renovate.json`.
- TypeScript is pinned to 6.0 and ESLint to 9, because the `eslint-config-next` plugins do not accept TypeScript 7 or ESLint 10 yet.
