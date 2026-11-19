# Portal (`apps/portal`)

Next.js 16 (App Router, `src/proxy.ts` instead of the old `middleware.ts`), Better Auth with Drizzle, Tailwind 4, Vitest. UI, comments and docs in English. Read [ADR 0003](../adr/) and `docs/specs/e2-tenants-e-controle-de-acesso.md` before touching data access.

## Access and isolation (ADR 0003, #18, #21)

- Every private page gets a context from `src/lib/access.ts`: `requireTenantContext()` (or `getTenantContext()`, which returns null for users without a project) or `requireOperatorContext()`. `requireSession()` (`src/lib/session.ts`) is only for the session's own data, such as the email in the header. `proxy.ts` is only an optimistic redirect and does **not** replace this check.
- The tenant always comes from the session, never from a client value. All database access lives in `src/lib/data/` (operator functions in `src/lib/data/operator/`) and all Umami access in `src/lib/umami/`, always receiving a context (a branded type that only `access.ts` creates).
- ESLint forbids importing the database client, the driver and the Umami HTTP client outside those folders (`eslint.config.mjs`, tested in `test/lint-boundaries.test.ts`); the schema (`db/schema`) is allowed.
- Another tenant's resource answers 404: the `data/` function returns null and the page calls `notFound()`. The same applies to another tenant's ID in a server action.
- Tenant routes never carry the tenant ID in the URL; only `/operator` routes accept `tenantId`.
- The isolation suite (spec section 8) is `test/isolation.test.ts`: pages and server actions with a simulated session, plus the views read as `stellytics_ingest`/`stellytics_collector` through `test/helpers/as-role.ts`. Every new dashboard adds cases there. The collector part is in `services/collector/e2e/isolation_test.go`.

## Configuration and database

- Variables are read by `src/lib/env.ts`; during `next build` it uses inert values, so never touch the database at build time.
- Schema in `src/lib/db/schema.ts` (snake_case columns). After changing it, run `pnpm db:generate --name <description>` and commit the SQL in `drizzle/`. Views, GRANTs and triggers go in hand-written migrations (`pnpm db:generate --custom --name <description>`), like `0002_ingest_views.sql`.
- The session does not store the IP (`databaseHooks` in `src/lib/auth.ts`); Better Auth and Next telemetry are off.

## Umami (#58, #62)

- Only `src/lib/umami/` calls Umami. The service account is a regular Umami user with an API key in `UMAMI_API_KEY`, created by `pnpm umami:service-account` (the admin password is used only by that script). The portal creates only sites in Umami, never users or teams.
- Umami is closed: no published port, no Caddy route; session recording and heatmaps are off (the portal never sends `replayConfig`, the gateway does not relay `/api/record`). Details and the test in `docs/umami.md`. Umami runs unpatched; any patch is documented there.
- In tests, `server-only` is replaced by a stub in `vitest.config.ts` and Umami is fake (`test/fake-umami.ts`, answers `/stats`, `/pageviews`, `/metrics` and `/event-data/values`, with `down` to simulate failure).

## Dashboards

- **Installation tag:** `/sites/[siteId]` shows the tag to copy (`install-script.tsx`), built by `src/lib/tracker-snippet.ts` from `INGEST_URL` (`https://INGEST_HOST` in `prod.yaml`) and the newest version in `packages/tracker/published/sri.json`, which the Dockerfile copies into the build. It is open while the period has no page views. After **Add website**, the form opens that page.
- **Tenant web (#28):** `/sites/[siteId]`, read by `getSiteDashboard` (`src/lib/umami/stats.ts`), which checks the tenant's site before calling Umami. Fixed UTC periods in `src/lib/period.ts` (an unknown URL value becomes 7 days), formatting in `src/lib/format.ts`. In Umami 3.4.1 `/metrics`, `y` counts visitors, not views. Pages handle `UmamiError` by importing from `umami/stats` (lint forbids `umami/http` and `umami/read`, which reads by Umami ID without checking the tenant). Since #50 (ADR 0015) the page also has **Custom events** (`/metrics?type=event`, where `y` counts events) and **Wallet connections** (`/event-data/values` of `wallet_selected`/`wallet`, plus the `wallet_disconnected` total); `/operator/web` and `/api/v1/web` do not show events yet.
- **SCF web (#29):** `/operator/web`, read by `getWebOverview` and `compareProjects` (`src/lib/umami/overview.ts`), with sites from `listActiveTenantSites` (active projects only; URL IDs never reach Umami without passing through that list). Only `/stats` per site in the table, at most 8 concurrent calls. All state in the URL (GET).
- **Tenant API (#37):** `/services/[serviceId]` (keys on `/services/[serviceId]/keys`), read by `getServiceDashboard` (`src/lib/data/api-metrics.ts`), filtering by `tenant_id` and `api_service_id`. `metricSources` picks the table per range: the 1h/1m cutoff is the earlier of the current hour minus one and the end of the tenant's last rolled-up hour; whole days before the cutoff come from 1d; hourly periods never read 1d. One query with `GROUPING SETS` (series, endpoints, status, total); percentiles via `api_metric_quantile(api_metric_sum_buckets(...))`. Dates go to the driver as ISO text with `::timestamptz`. Column chart shared with the web dashboard in `src/components/column-chart.tsx`. Details in `docs/e6-implementacao.md`.
- **SCF API (#38):** `/operator/api`, read by `getApiOverview` (`src/lib/data/operator/api.ts`): one row per active project, summing non-archived services, with the same `metricSources` ranges (sent to the database as JSON via `json_to_recordset`). The test checks that the numbers match the sum of the service dashboards; change one rule, change the other. State in the URL.

## Keys

- **Ingest keys (#59):** format and hash in `src/lib/ingest-key.ts` (contract with the collector), functions in `src/lib/data/api-services.ts`, screens in `/services`. The full key exists only in the creation response: never in logs, the database or error messages. "Last used" is written by the collector once per key per UTC day through `ingest_key_touch(text)` (migration 0008, `SECURITY DEFINER`, `EXECUTE` only for `stellytics_collector`).
- **SCF read keys (#48, ADR 0006):** `nrk_` keys (`src/lib/read-key.ts`, table `operator_api_key`, migrations 0006 and 0007, screens in `/operator/keys`, functions in `src/lib/data/operator/api-keys.ts`) and the read-only API `GET /api/v1/projects|web|api?period=`, authenticated by `authenticateReadKey` in `access.ts`, which returns an `OperatorContext`. Identical 401 for every failure, no CORS, `no-store`. In-memory limits: 60/min per key and 120/min per truncated IP before the database query; Caddy does not rate-limit by IP.
- Integration tests leave rows in `audit_log`, which only accepts inserts.

## Sign-up, operators and tenants

- **Self-service (#17, #60):** open sign-up at `/sign-up` with mandatory email confirmation → `/onboarding` (creates the tenant and the `owner`, `src/lib/data/tenants.ts`, context `requireOnboardingContext()`) → `/sites` and `/services`. `requireTenantContext()` sends users without a project to `/onboarding`. Password reset at `/forgot-password` (30-minute single-use link, ends sessions). Per-IP limits in `customRules` of `src/lib/auth.ts`. Plain-text email only, through `src/lib/mail.ts` and `SMTP_URL`. In tests, `vi.mock("@/lib/mail")` captures messages.
- **Approval mode (#49, ADR 0007):** `SIGNUP_APPROVAL=true|1` (off by default) makes `createProject` create a `pending` tenant. `requireTenantContext({ allowPending: true })` is used only on `/dashboard` (waiting screen); everything else redirects there and `data/` refuses. Operators approve or reject (reason required; reject = `removed`, can be reactivated) through `approveTenant`/`rejectTenant`, at `/operator/approvals` or the project detail; `audit_log` gets `tenant.approved` and `tenant.rejected`. No notification email.
- **SCF operators (#19):** created only by `pnpm operator:create|promote|demote` (`scripts/operator.mjs`, writes to `audit_log`); `pnpm user:create` creates regular users only (password in `PORTAL_USER_PASSWORD`). Also enforced by a database trigger (migration 0003). Screens in `/operator` and `/operator/tenants/[tenantId]`. Seed: `pnpm db:seed` (password in `SEED_PASSWORD`).
- **Project removal (#20):** `removeTenant`/`reactivateTenant` in `src/lib/data/operator/tenants.ts` record status, who, reason and an `audit_log` row. Ingestion needs no change: the `ingest_site` and `ingest_key_active` views already require an `active` tenant.
- **Development accounts:** `apps/portal/drizzle-dev/` (own migration, table `drizzle.__dev_seed_migrations`, applied by `runDevSeed` only with `SEED_DEV_DATA=true`, set only in `infra/compose/dev.yaml`) creates `admin@example.com` (password `admin321admin`, no project) and the operator `scf@example.org` (password `scf-admin-12345`). Never set `SEED_DEV_DATA` in production or put that SQL in `drizzle/`.

## Data erasure (#154)

`audit_log` only accepts replacing `actor_user_id` with the `[apagado]` marker (migration `0009_erasure.sql`), never DELETE. Account deletion removes the owner's project (Umami sites, metrics, rows) and anonymizes history. Umami web event retention (183 days) is done by `services/rollup` with `UMAMI_DATABASE_URL`.
