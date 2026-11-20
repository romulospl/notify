# apps/portal

Next.js portal (App Router), with Drizzle ORM, Better Auth and Tailwind. In this version it is a **public, read-only site**: the demo dashboards, the public project card, the documentation and the SCF read API. It has no sign-up, no login and no signed-in pages.

It reads web statistics through the Umami API (with a service account, [#58](https://github.com/romulospl/stellytics/issues/58)) and API metrics directly from the `stellytics` database.

The interface is in English, because the audience is the Stellar ecosystem projects and the SCF.

## Pages and routes

| Route | What it is |
|---|---|
| `/` | Home page |
| `/demo` | The dashboards of the demo project: web traffic and API metrics |
| `/operator` | The SCF operator view of the demo project |
| `/p/<slug>` | Public card of the demo project (30-day totals only). Any other slug answers 404 before anything is read |
| `/docs`, `/docs/<slug>` | Documentation index and the guides of this repository, rendered from their Markdown files; `mermaid` blocks are drawn as diagrams |
| `/api/v1/projects`, `/api/v1/web`, `/api/v1/api` | Read-only API for the SCF, authenticated by a read key ([ADR 0006](../../docs/adr/0006-scf-read-api.md)) |
| `/api/health` | Answers `{"ok":true}` without reading the database or Umami; used by the container healthcheck and the external monitoring probe |

### What the demo shows

- With `DEMO_TENANT_SLUG` empty (the default), `/demo`, `/operator` and `/p/<slug>` show sample data from `src/lib/demo-sample.ts`. Nothing is read from the database or Umami.
- With `DEMO_TENANT_SLUG` set to a project's slug, they show that one project. An unknown or inactive project answers 404.
- No other project has a public page.

## What is in the library but has no page

The code under `src/lib/` still has the session, tenant and operator layer: Better Auth (`auth.ts`), the session contexts in `access.ts`, project creation, sites, API services and ingest keys, read keys, operator invites and erasure (`src/lib/data/`). The integration tests cover it. No page or route of this version calls the session-based part, so none of it is reachable from a browser.

Two consequences to know about:

- Operator invites are disabled: the page that accepted them (`/invite/<token>`) does not exist in this version, so `operator:invite` refuses and sends nothing. Use `operator:create`.
- Projects, sites, services and keys cannot be created from the portal. The development seed below creates test data.

## Running

With Docker Compose, at the repository root (applies the migrations at startup):

```bash
docker compose up -d --wait
```

The portal is at http://localhost:3000. To develop with automatic reload, start only the database and run `next dev`:

```bash
docker compose up -d --wait postgres
cd apps/portal
DATABASE_URL=postgresql://stellytics:stellytics@localhost:5432/stellytics \
BETTER_AUTH_SECRET=dev-only-portal-auth-secret-change-me \
pnpm db:migrate && pnpm dev
```

### Development seed ([#19](https://github.com/romulospl/stellytics/issues/19))

Creates 2 test projects (each with an owner, an API service and a key) and 1 SCF operator. It can run more than once; what already exists stays as it is. With `UMAMI_API_KEY` set, each project also gets a site in Umami.

```bash
cd apps/portal
read -rs SEED_PASSWORD && export SEED_PASSWORD
pnpm db:seed
```

To show one of the seeded projects in the demo, set `DEMO_TENANT_SLUG` to its slug and recreate the portal.

### Administration commands

Accounts are only created from the server, never from a screen. Every change goes to the `audit_log`.

```bash
cd apps/portal
read -rs OPERATOR_PASSWORD && export OPERATOR_PASSWORD
pnpm operator:create --email scf@example.org --name "Name"
pnpm operator:promote --email person@example.org
pnpm operator:demote --email person@example.org
pnpm operator:list
```

An operator is not a tenant member (D2): the database rejects putting an operator in a tenant and promoting a member to operator (`drizzle/0003_operator_not_member.sql`). In production the same command runs through `operator.sh` at the repository root.

## Umami ([#58](https://github.com/romulospl/stellytics/issues/58))

The portal talks to Umami only through `src/lib/umami/` (ESLint forbids importing `src/lib/umami/http.ts` from anywhere else). It creates only sites in Umami, never users or teams (ADR 0003).

### Service account

A regular Umami user (`stellytics-portal`, role `user`), authenticated by API key. The script below creates the user (or replaces its password with a random one, which nobody keeps) and prints a new key. The administrator password is only used here:

```bash
cd apps/portal
read -rs UMAMI_ADMIN_PASSWORD && export UMAMI_ADMIN_PASSWORD
UMAMI_URL=http://127.0.0.1:3001 pnpm umami:service-account
```

Umami is only at `127.0.0.1:3001` with the development override (`infra/compose/umami-port.yaml`, see the [root README](../../README.md#running-locally)).

Put the key in `UMAMI_API_KEY` (in the root `.env` for Compose) and recreate the portal (`docker compose up -d portal`). To rotate the key, run it again, update the portal and then run with `--revoke-old`, which leaves only the newest key.

Use `127.0.0.1`, not `localhost`: if another program listens on the same port over IPv6, `localhost` reaches it.

## Data access and isolation ([#18](https://github.com/romulospl/stellytics/issues/18))

- Every read goes through `src/lib/data/` (database) and `src/lib/umami/` (Umami), with a context as the first argument. The context types are branded, so only `src/lib/access.ts` can create them.
- The public pages use the demo context (`loadDemoContext()` and `requireDemoContext()`), which is read-only and tied to the one demo project. The read API uses the context of the read key (`authenticateReadKey()`).
- ESLint forbids importing the database client, the `postgres` driver and the Umami HTTP client outside these folders. The schema (`src/lib/db/schema.ts`) can be imported anywhere.
- A resource outside the context answers 404.

## Environment variables

| Variable | Required | Use |
|---|---|---|
| `DATABASE_URL` | Yes | Connection to the `stellytics` database |
| `BETTER_AUTH_SECRET` | Yes | Secret of the session layer (generate with `openssl rand -base64 32` in production) |
| `BETTER_AUTH_URL` | No | Public URL of the portal (default `http://localhost:3000`) |
| `DEMO_TENANT_SLUG` | No | Slug of the one project shown in the demo. Empty: sample data |
| `RUN_MIGRATIONS` | No | `true` applies the Drizzle migrations at server startup |
| `UMAMI_URL` | No | Internal Umami address (default `http://127.0.0.1:3001`, published only by `infra/compose/umami-port.yaml`; in Compose, `http://umami:3000`) |
| `UMAMI_API_KEY` | For real data | API key of the service account. Without it the portal starts, but reads no web statistics |
| `INGEST_URL` | No | Public gateway address used in the installation tag of the quickstart at `/docs` (default `http://localhost:3002`; `https://INGEST_HOST` in `prod.yaml`) |
| `COLLECTOR_URL` | No | Public OTLP address of the API collector, shown in the quickstart at `/docs` (default `http://127.0.0.1:4318`; `https://API_HOST` in `prod.yaml`) |
| `SMTP_URL` | No | SMTP server of the mail layer (operator invites, disabled in this version), e.g. `smtp://mailpit:1025` or `smtps://user:password@host:465` |
| `MAIL_FROM` | No | Sender (default `stellytics <no-reply@stellytics.localhost>`) |

## Database and migrations

- Schema in `src/lib/db/schema.ts`; versioned migrations in `drizzle/`.
- The tenant model (`tenant`, `tenant_member`, `site`, `api_service`, `ingest_key` and `audit_log`) follows section 3 of the [E2 spec](../../docs/specs/e2-tenants-and-access-control.md). The `audit_log` only accepts inserts (a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`); the one exception is replacing `actor_user_id` with the `[erased]` marker.
- The `ingest_site` (web gateway) and `ingest_key_active` (collector) views and the privileges of the `stellytics_ingest` and `stellytics_collector` users are in `drizzle/0002_ingest_views.sql`, written by hand. For SQL that Drizzle does not generate: `pnpm db:generate --custom --name <description>`.
- **The migrations require the `stellytics_ingest` and `stellytics_collector` users**, which only a superuser creates. In Compose, `infra/compose/postgres/init/02-ingest-roles.sh` runs with the volume empty. For a volume that already exists, without erasing the data:

  ```bash
  docker compose exec -T postgres sh < infra/compose/postgres/init/02-ingest-roles.sh
  ```

- After changing the schema: `pnpm db:generate --name <description>` and commit the generated SQL.
- `pnpm db:migrate` applies the migrations to the `DATABASE_URL` database.

## Tests

`pnpm test` runs the tests with Vitest. The integration tests use the `DATABASE_URL` Postgres (default: the local Compose one) and apply the migrations before running. The permission tests assume the ingest roles with `SET ROLE`, which is why the script above also gives the `stellytics` user the right to assume them (without inheriting anything from them). The Umami tests use a fake Umami (`test/fake-umami.ts`); the CI `compose` job checks the service account against the real Umami.
