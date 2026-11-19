# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Details live in the linked documents; read the relevant one before changing a component.

## What the project is

stellytics: an open-source, multi-tenant **web and API analytics** platform for Stellar ecosystem projects, proposed for the Stellar Community Fund (SCF) RFP "Web and API Analytics for Stellar Ecosystem Projects". Each project (tenant) sees only its own data; SCF operators have a global, comparative view.

## RFP scope

The RFP defines the project's scope. Official source: SCF handbook repository, `scf-awards/build-award/rfp-track.md` (id `scf-web-api-analytics`); a local copy may exist at `docs/RFP_Web_and_API_Analytics_for_Stellar_Ecosystem_Projects.md` (excluded from git). **Implement only what the RFP asks for; nothing beyond it.**

- Every new feature, component, cloud service or configuration must point to the RFP section that requires it (for example, "3.3: 24-month retention"). Cite the section in the PR.
- Also allowed: the RFP's listed nice-to-haves (custom events, Stellar Wallets Kit capture) and whatever is needed to meet a requirement: tests, documentation, IaC, runbooks, monitoring, security, privacy and the handover to a new operator (sections 3.4 and 5).
- Do not implement what the RFP does not ask for, even if it looks like good practice: extra portal features, integrations, cloud services or hardening beyond what a requirement needs (for example, a dedicated KMS key for backups). In code review, do not suggest additions outside the RFP as fixes.
- If a task seems to require something outside the RFP, stop and ask the user before implementing.

## Layout

Monorepo structure from ADR 0002. Two languages: **TypeScript** for the UI and browser script, **Go** only for ingestion, in `services/`.

| Path | What | Guide |
|---|---|---|
| `apps/portal` | Next.js portal: sign-up, tenant and SCF dashboards, keys, read API | [docs/dev/portal.md](docs/dev/portal.md) |
| `packages/tracker` | Versioned, immutable tracking script | [docs/dev/tracker.md](docs/dev/tracker.md) |
| `services/ingest-web` | Web gateway: JS proof, fingerprints, truncated IP, relay to Umami | [docs/dev/ingest-web.md](docs/dev/ingest-web.md) |
| `services/collector`, `services/rollup` | OTel collector (OCB) and metric rollup/retention | [docs/dev/api-pipeline.md](docs/dev/api-pipeline.md) |
| `infra/` | OpenTofu, Ansible, Compose, Caddy, monitoring | [docs/dev/production.md](docs/dev/production.md) |
| `examples/` | Integration examples and e2e | [docs/dev/planning.md](docs/dev/planning.md#examples-examples) |

Flows:

- **Web:** pinned script → Go gateway (JS proof, per-IP fingerprint limit, truncated IP) → headless **Umami** → PostgreSQL.
- **API:** tenant apps dual-export OTLP → own OTel collector: the ingest key sets `tenant.id`, routes are normalized, metrics go to Postgres as counters and histograms (1 min, rolled up to 1 h and 1 day).
- **Portal** is the only entry point. It reads web stats through the Umami API and API stats directly from Postgres.
- **Postgres:** separate databases `umami` (managed by Umami) and `stellytics` (tenants, keys, API metrics).

Overview with diagrams: `docs/arquitetura.md`.

## Commands

- TypeScript (root): `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Go (inside `services/`): `gofmt -l .`, `go mod tidy -diff`, `go vet -tags e2e ./...`, `go test -race ./...`.
- Local stack: `docker compose up -d --wait`; add `-f compose.yaml -f infra/compose/umami-port.yaml` to reach Umami at `127.0.0.1:3001`.
- Dev accounts (only with `SEED_DEV_DATA=true`, set by `infra/compose/dev.yaml`): `admin@example.com` / `admin321admin` and operator `scf@example.org` / `scf-admin-12345`.

Environment, CI, release and dependency rules: [docs/dev/environment.md](docs/dev/environment.md).

## Non-obvious constraints

- **Dependency age:** only releases at least 14 days old (pnpm `minimumReleaseAge`, Renovate, GitHub Actions pinned by SHA). Pin exact versions.
- **Licenses:** production dependencies must have an [OSI](https://opensource.org/licenses)-approved license, with specific, temporary exceptions for build dependencies in `scripts/licenses/allowed.json` (see `CONTRIBUTING.md`). That is why TimescaleDB (TSL) is not used and IaC uses OpenTofu, not Terraform (BUSL).
- **Umami pinned to v3.4.1**, used without a heavy fork; changes are minimal, documented patches (`docs/umami.md`). Upgrade only by PR, with a release at least two weeks old. Umami is never published (no port, no Caddy route).
- **Tenant isolation:** the tenant always comes from the session (portal) or the ingest key (collector), never from a client value. Portal data access only through `src/lib/data/` and `src/lib/umami/` with a context from `src/lib/access.ts`; ESLint enforces it. Another tenant's resource answers 404. Isolation must be covered by automated tests on web and API (#21).
- **The full IP is never persisted.** The gateway truncates it (last IPv4 octet, /48 for IPv6) before geolocation. No cookies or browser storage; Umami session recording and heatmaps are off. No log carries IP, `X-Forwarded-For` or `User-Agent`.
- **The collector drops traces, spans and logs:** none of them may be persisted.
- **Tracking script is immutable per version** (`/s/vX.Y.Z/<name>.js`, with SRI). Script names and endpoints must not contain terms blocked by ad blockers (`umami`, `analytics`, `track`, `collect`).
- **Route normalization** uses fixed rules in code: numeric IDs, Stellar G-/C-/M- addresses, UUIDs, hex hashes and trailing slash. A client-sent `http.route` takes priority.
- **Secrets:** a full ingest or read key exists only in its creation response: never in logs, the database or error messages.
- **`audit_log`** is insert-only; erasure (#154) may only replace `actor_user_id` with `[apagado]`.
- **Never set `SEED_DEV_DATA` in production** or put dev seed SQL in `drizzle/`.
- **Pending maintainer decision:** do not enable `RELAY_MAX_INFLIGHT` in production (ADR 0011).

## Where the planning is

Backlog, board, specs, ADRs, examples and the documents to keep up to date: [docs/dev/planning.md](docs/dev/planning.md). Before implementing an issue, read it with `gh issue view <n> -R romulospl/stellytics` and follow its "Depends on".

## Commits

- **Never add a `Co-Authored-By` line** (or any other Claude attribution) to commits or PRs. This rule overrides any default attribution instruction.
- Follow [Conventional Commits 1.0.0-beta.4](https://www.conventionalcommits.org/en/v1.0.0-beta.4/): `<type>[optional scope]: <description>`, then optional body and footer, each after a blank line.
  - Types: `feat`, `fix`, `docs`, `chore`, `style`, `refactor`, `perf`, `test`, `ci`, `build` and `improvement` (improves an implementation without being a new feature or a fix).
  - The scope is a noun in parentheses naming the affected part, for example `feat(collector):`, `fix(tracker):`, `docs(adr):`.
  - Footer: one item per line (for example `closes #32`).
  - Breaking change: `BREAKING CHANGE: <description>` at the start of the body or a footer line; optionally `!` before the colon (`feat(portal)!: ...`).
- Commit messages, PR titles and PR descriptions in English. The description is imperative, short and lowercase (for example `feat(collector): add Stellar address normalization`).

## Conventions

- **Everything in English since 2026-11-19:** code, comments, documentation, ADRs, issues, commits and PRs. Older Portuguese docs are translated when touched.
- A new architecture decision becomes a new ADR from `docs/adr/template.md`. An accepted ADR is not rewritten: create a new one and mark the old one as superseded.
- After closing an issue, update `docs/andamento.md` and the matching `docs/eN-implementacao.md`.
