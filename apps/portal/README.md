# apps/portal

Next.js portal (App Router), with Drizzle ORM, Better Auth and Tailwind. It is the platform's only entry point: self-service sign-up, login, tenant dashboards and global SCF dashboards.

It reads web statistics through the Umami API (with a service account, [#58](https://github.com/romulospl/stellytics/issues/58)) and API metrics directly from the `stellytics` database. Tenant isolation on reads is the portal's responsibility: the tenant always comes from the session ([#18](https://github.com/romulospl/stellytics/issues/18)).

## What already exists ([#57](https://github.com/romulospl/stellytics/issues/57))

- Login by e-mail and password with a server-side session (Better Auth, tables in the `stellytics` database).
- Private routes: `/dashboard` (tenant area) and `/operator` (SCF operator area, only for the `operator` role; others get 404).
- `proxy.ts` redirects anyone without a session cookie to `/sign-in`; the real validation happens on the server (`src/lib/access.ts`).
- Open sign-up with e-mail confirmation and password recovery ([#60](https://github.com/romulospl/stellytics/issues/60)); see the "Sign-up and e-mail" section.
- The IP of whoever signs in to the portal is not stored in the session; it is only used in memory for the attempt limit.

The interface is in English, because the audience is the Stellar ecosystem projects and the SCF.

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

### Create a user

The password comes from the `PORTAL_USER_PASSWORD` variable (minimum of 12 characters), so it does not stay in the shell history:

```bash
cd apps/portal
read -rs PORTAL_USER_PASSWORD && export PORTAL_USER_PASSWORD
pnpm user:create --email you@example.com --name "Your name"
```

The user is created with a confirmed e-mail and no project; on sign-in, they land on `/onboarding`. This script does not create an operator.

### Development seed ([#19](https://github.com/romulospl/stellytics/issues/19))

Creates 2 test projects (each with an owner, an API service and a key) and 1 SCF operator. It can run more than once; what already exists stays as it is. With `UMAMI_API_KEY` set, each project also gets a site in Umami.

```bash
cd apps/portal
read -rs SEED_PASSWORD && export SEED_PASSWORD
pnpm db:seed
```

Accounts, all with the `SEED_PASSWORD` password: `owner-a@seed.stellytics.localhost`, `owner-b@seed.stellytics.localhost` and `operator@seed.stellytics.localhost`. The integration tests run the seed with their own test password, so the local database ends up with these accounts.

## SCF operator ([#19](https://github.com/romulospl/stellytics/issues/19))

- Reads all projects, including removed ones: `/operator` lists the projects with counts and `/operator/tenants/[tenantId]` shows members, sites and services. Of the ingest keys, only the prefix and the dates are shown.
- Is not a tenant member (D2). The database rejects putting an operator in a tenant and promoting a member to operator (`drizzle/0003_operator_not_member.sql`); someone from the SCF who has a project uses two accounts.
- Is only created by the administration command (D3), never by the sign-up screen, where the role sent by the client is ignored. Every change goes to the `audit_log` and ends the account's sessions:

```bash
cd apps/portal
read -rs OPERATOR_PASSWORD && export OPERATOR_PASSWORD
pnpm operator:create --email scf@example.org --name "Name"
pnpm operator:promote --email person@example.org
pnpm operator:demote --email person@example.org
```

## Umami ([#58](https://github.com/romulospl/stellytics/issues/58))

The portal talks to Umami only through `src/lib/umami/` (ESLint forbids importing `src/lib/umami/http.ts` from anywhere else):

- `createSite(ctx, …)` in `src/lib/data/sites.ts` creates the site in Umami and then writes the row in `site`; if the write fails, it deletes the site in Umami.
- `getSiteStats(ctx, siteId, …)` takes the portal's site ID, checks that it belongs to the context's tenant and only then calls Umami with the `umami_website_id`. Another tenant's site returns null with no call to Umami.
- `findUmamiInconsistencies()` lists portal sites that disappeared from Umami and Umami sites with no row in `site`.

The portal creates only sites in Umami, never users or teams (ADR 0003).

## Tenant isolation ([#18](https://github.com/romulospl/stellytics/issues/18))

- `src/lib/access.ts` creates the contexts from the session: `requireTenantContext()` / `getTenantContext()` for tenant members and `requireOperatorContext()` for operators. The types are branded, so only that file can create them.
- Every read and write goes through `src/lib/data/` (database) and `src/lib/umami/` (Umami), with the context as the first argument. Operator functions live in `src/lib/data/operator/`.
- ESLint forbids importing the database client, the `postgres` driver and the Umami HTTP client outside these folders. The schema (`src/lib/db/schema.ts`) can be imported anywhere.
- Whoever has no access gets 404: an operator on `/dashboard` is taken to `/operator`, a tenant member on `/operator` gets 404, and a user with no project sees a notice until the self-service sign-up ([#17](https://github.com/romulospl/stellytics/issues/17)).

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

## API services and ingest keys ([#59](https://github.com/romulospl/stellytics/issues/59))

- Screens: `/services` (list and creation of services) and `/services/[serviceId]` (the service's keys: create and revoke).
- Key format and hash in `src/lib/ingest-key.ts`: `ntf_<prefix>_<secret>`, an 8-character base32 prefix and a 32-byte secret in base64url. The database stores only the prefix and the SHA-256 of the full key; this is the contract with the collector ([#30](https://github.com/romulospl/stellytics/issues/30)), which reads the `ingest_key_active` view.
- Functions in `src/lib/data/api-services.ts`. Creating a service already generates the first key. Limit of 5 active keys per service, enforced with a lock on the service row. Creating and revoking a key go to the `audit_log` with the prefix only.
- The full key appears only once, in the server action's return value, and is never logged. Revoking removes the key from the collector's view immediately; the collector's cache makes it effective within 60 seconds.

## Self-service sign-up ([#17](https://github.com/romulospl/stellytics/issues/17))

A Stellar project joins on its own, without help from the SCF:

1. `/sign-up`: creates the account and confirms the e-mail through the link (see the next section).
2. `/onboarding`: names the project. The portal creates the `active` tenant and makes the person `owner`, in the same transaction, and records `tenant.created` in the `audit_log`. Only someone with a confirmed e-mail and no project yet gets here (`requireOnboardingContext()`); whoever already has one goes to the dashboard.
3. `/sites`: registers the web sites; each one becomes a site in Umami and shows the ID the tracking script uses.
4. `/services`: registers the API services; each one already comes with the first ingest key.

Whoever has no project yet and opens a tenant page is taken to `/onboarding`. The project slug comes from the name; if it already exists, it gets a random suffix.

## Sign-up and e-mail ([#60](https://github.com/romulospl/stellytics/issues/60))

- `/sign-up` creates the account and sends the confirmation link (valid for 24 hours). Without confirming, the person cannot sign in, so they create no project; when they try to sign in, they get another link.
- The confirmation link opens the session and leads to `/dashboard`. An expired or invalid link leads to `/email-verified`, which explains what to do.
- `/forgot-password` sends a reset link that is valid for 30 minutes and only once. Changing the password ends all sessions.
- Sign-up with an existing e-mail and a reset request for an e-mail with no account get the same response as the normal cases, without revealing who has an account.
- Limits per IP (in memory, per instance): sign in, 3 every 10 seconds; sign up, 10 per hour; request a reset or a new confirmation link, 5 per hour. Behind the proxy, the IP comes from `X-Forwarded-For`, so the portal must not be exposed without Caddy in front.
- The e-mails are text only (`src/lib/mail.ts`), with no HTML, and neither the recipient nor the link goes to the log.
- In Compose, the e-mails go to Mailpit: inbox at http://127.0.0.1:8025 and SMTP at `127.0.0.1:1025` (for `next dev`, use `SMTP_URL=smtp://127.0.0.1:1025`). In production, SMTP comes from the IaC ([#14](https://github.com/romulospl/stellytics/issues/14)).

## Environment variables

| Variable | Required | Use |
|---|---|---|
| `DATABASE_URL` | Yes | Connection to the `stellytics` database |
| `BETTER_AUTH_SECRET` | Yes | Session secret (generate with `openssl rand -base64 32` in production) |
| `SMTP_URL` | For e-mail | SMTP server, e.g. `smtp://mailpit:1025` or `smtps://user:password@host:465`. Without it, the portal starts, but the confirmation and password e-mails fail (the error goes to the log) |
| `MAIL_FROM` | No | Sender (default `stellytics <no-reply@stellytics.localhost>`) |
| `BETTER_AUTH_URL` | No | Public URL of the portal (default `http://localhost:3000`) |
| `RUN_MIGRATIONS` | No | `true` applies the Drizzle migrations at server startup |
| `UMAMI_URL` | No | Internal Umami address (default `http://127.0.0.1:3001`, published only by `infra/compose/umami-port.yaml`; in Compose, `http://umami:3000`) |
| `INGEST_URL` | No | Public gateway address used in the installation tag on each site's page (default `http://localhost:3002`; `https://INGEST_HOST` in `prod.yaml`) |
| `COLLECTOR_URL` | No | Public OTLP address of the API collector, shown with each service's ingest keys (default `http://127.0.0.1:4318`; `https://API_HOST` in `prod.yaml`) |
| `UMAMI_API_KEY` | For sites | API key of the service account. Without it the portal starts, but does not create sites or read statistics |

## Database and migrations

- Schema in `src/lib/db/schema.ts`; versioned migrations in `drizzle/`.
- The tenant model (`tenant`, `tenant_member`, `site`, `api_service`, `ingest_key` and `audit_log`) follows section 3 of the [E2 spec](../../docs/specs/e2-tenants-and-access-control.md). The `audit_log` only accepts inserts (a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`).
- The `ingest_site` (web gateway) and `ingest_key_active` (collector) views and the privileges of the `stellytics_ingest` and `stellytics_collector` users are in `drizzle/0002_ingest_views.sql`, written by hand. For SQL that Drizzle does not generate: `pnpm db:generate --custom --name <description>`.
- **The migrations require the `stellytics_ingest` and `stellytics_collector` users**, which only a superuser creates. In Compose, `infra/compose/postgres/init/02-ingest-roles.sh` runs with the volume empty. For a volume that already exists, without erasing the data:

  ```bash
  docker compose exec -T postgres sh < infra/compose/postgres/init/02-ingest-roles.sh
  ```

- After changing the schema: `pnpm db:generate --name <description>` and commit the generated SQL.
- `pnpm db:migrate` applies the migrations to the `DATABASE_URL` database.

## Tests

`pnpm test` runs the tests with Vitest. The integration ones (`test/auth.test.ts`, `test/tenant-model.test.ts`, `test/umami.test.ts`, `test/access.test.ts` and `test/ingest-keys.test.ts` and `test/email-flows.test.ts`) use the `DATABASE_URL` Postgres (default: the local Compose one) and apply the migrations before running. The permission tests assume the ingest roles with `SET ROLE`, which is why the script above also gives the `stellytics` user the right to assume them (without inheriting anything from them). The Umami tests use a fake Umami (`test/fake-umami.ts`); the CI `compose` job checks the service account against the real Umami.
