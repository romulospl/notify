# E2: what was implemented

Record of the implementation of epic [E2 (#2)](https://github.com/romulospl/stellytics/issues/2), multi-tenant, sign-up and access control, done on **13 November 2026**. The contract these issues follow is in the [E2 spec](specs/e2-tenants-and-access-control.md) and in [ADR 0003](adr/0003-portal-isolation.md). This document records what was built, where it is, the choices made during implementation and what is missing.

## 1. Status

The 9 code issues of E2 are on `main` and closed (#57, the portal skeleton, already existed before). #21 was the last one: the case that depended on the collector's exporter (#31, E5) came in after it. Each PR was merged by rebase with green CI, so each issue has its own commit.

| Issue | What it is | PR | Commit |
|---|---|---|---|
| [#16 (2.1)](https://github.com/romulospl/stellytics/issues/16) | Tenant model, views and ingestion users | [#71](https://github.com/romulospl/stellytics/pull/71) | `4eb25c3` |
| [#58 (2.8)](https://github.com/romulospl/stellytics/issues/58) | Service account and provisioning in Umami | [#71](https://github.com/romulospl/stellytics/pull/71) | `4c3da83` |
| [#18 (2.3)](https://github.com/romulospl/stellytics/issues/18) | Single data access layer | [#72](https://github.com/romulospl/stellytics/pull/72) | `2f8a2d1` |
| [#59 (2.9)](https://github.com/romulospl/stellytics/issues/59) | API services and ingest keys | [#73](https://github.com/romulospl/stellytics/pull/73) | `9d33fdf` |
| [#60 (2.10)](https://github.com/romulospl/stellytics/issues/60) | Email confirmation and password recovery | [#76](https://github.com/romulospl/stellytics/pull/76) | `e037b11` |
| — | Fix for #59: repeated service name in simultaneous requests | [#76](https://github.com/romulospl/stellytics/pull/76) | `a6534fa` |
| [#17 (2.2)](https://github.com/romulospl/stellytics/issues/17) | Self-service project sign-up | [#77](https://github.com/romulospl/stellytics/pull/77) | `6f0a1cf` |
| [#19 (2.4)](https://github.com/romulospl/stellytics/issues/19) | SCF operator, admin command and seed | [#78](https://github.com/romulospl/stellytics/pull/78) | `b262905` |
| [#20 (2.5)](https://github.com/romulospl/stellytics/issues/20) | Project removal and reactivation (the collector, #30, refuses the key of a removed project; test of the transition on branch `test/e2-collector-isolation`) | [#88](https://github.com/romulospl/stellytics/pull/88) | `f83dc69` |
| — | Fix for #59: key actions with another tenant's ID answer 404 | [#88](https://github.com/romulospl/stellytics/pull/88) | `de177f7` |
| [#21 (2.6)](https://github.com/romulospl/stellytics/issues/21) | Isolation suite | [#88](https://github.com/romulospl/stellytics/pull/88) | `f867a3d` |
| [#21 (2.6)](https://github.com/romulospl/stellytics/issues/21) | Last case: key of A claiming to be B's, stored as A (collector e2e) | [#99](https://github.com/romulospl/stellytics/pull/99) | `3659ae7` |

The E2 spec and ADR 0003 came in together, in commit `75658a7`.

## 2. What already works

**For a Stellar project (tenant):**

1. `/sign-up`: creates the account. An email arrives with the confirmation link.
2. The link confirms the email, opens the session and leads to `/onboarding`.
3. `/onboarding`: names the project and becomes its owner.
4. `/sites`: registers the web sites. Each one is created in Umami, and the screen shows the site ID.
5. `/services`: registers the API services. Each one comes with its first ingest key, shown only once. At `/services/[serviceId]/keys` (the "Ingest keys" tab), creates and revokes keys; `/services/[serviceId]` is the API dashboard (#37).
6. `/forgot-password`: recovers the password through a 30-minute link.

**For the SCF operator:**

- `/operator` lists all projects, including removed ones, with counts of members, sites, services and active keys.
- `/operator/tenants/[tenantId]` shows a project's members, sites and services. Of the keys, only the prefix and the dates.
- On the same screen, removes the project (with a required reason) or reactivates it, and sees the status history: who, when and why (#20).
- An operator is only created by the admin command (`pnpm operator:create`).

**Do not exist yet:** the dashboards with web metrics (E4) and API metrics (E6), and the refusal of API ingestion from a removed project, which depends on the collector (#30).

## 3. What each issue delivered

### #16: tenant model

- **Tables** in `apps/portal/src/lib/db/schema.ts`, migration `drizzle/0001_tenant_model.sql`: `tenant`, `tenant_member`, `site`, `api_service`, `ingest_key` and `audit_log`, as in section 3 of the spec.
- **Rules in the database, beyond the spec:**
  - composite foreign key: `ingest_key.tenant_id` is always the tenant of the key's service;
  - the database checks the format of the key prefix (8 base32 characters) and the size of the hash (32 bytes);
  - `audit_log` only accepts inserts: a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`.
- **Views and ingestion users (D4)**, migration `drizzle/0002_ingest_views.sql`, written by hand:
  - `ingest_site` (for the web gateway): the site ID in Umami and whether it accepts ingestion now;
  - `ingest_key_active` (for the collector): only keys that are not revoked, of a service that is not archived and an active tenant;
  - `stellytics_ingest` and `stellytics_collector` read only their own view, no table.
- **The two database users are created outside the migrations**, because that requires a superuser: `infra/compose/postgres/init/02-ingest-roles.sh`. The migration stops with a clear message if they do not exist. CI runs the same script before the tests.
- The `stellytics` user can assume these two roles (`SET ROLE`, without inheriting anything), only for the permission tests.

### #58: Umami

- **Pending item of ADR 0001 resolved:** the Umami 3.4.1 API key is enough for the service account, without the administrator password. Checked in the Umami code and on the local Umami, and recorded in ADR 0001.
  - The service account is an **ordinary** Umami user (`stellytics-portal`, role `user`). It creates, lists, reads and deletes its own sites, and the user and admin routes refuse the key.
  - **Limit:** the key can also create teams in Umami. The portal does not use that route (ADR 0003).
- **Script** `pnpm umami:service-account`: uses the administrator password once, creates (or updates) the service user with a random password that nobody keeps, and prints a new key. With `--revoke-old`, it deletes the previous keys.
- **Single client** in `src/lib/umami/`:
  - `createSite` creates the site in Umami and then writes the row in `site`; if the write fails, it deletes the site in Umami;
  - `getSiteStats` only accepts the portal's site ID and checks that it belongs to the tenant before calling Umami;
  - `findUmamiInconsistencies` points out sites that disappeared from Umami and Umami sites without a link.
- The CI `compose` job tests the service account against the real Umami on every PR.

### #18: single data access layer

- **Contexts** in `src/lib/access.ts`, with branded types (only that file can create them, always from the session):
  - `requireTenantContext()` / `getTenantContext()` for tenant members;
  - `requireOperatorContext()` for operators;
  - `requireOnboardingContext()` for whoever is still going to create the project (came in #17).
- **Lint rule** (`eslint.config.mjs`):
  - only `src/lib/data/` imports the database client and the `postgres` driver;
  - only `src/lib/umami/` calls Umami;
  - the schema (`db/schema`) can be imported anywhere.
  - `test/lint-boundaries.test.ts` runs ESLint over example imports, so the rule does not break silently.
- **Another tenant's resource answers 404**: the `lib/data/` function returns null and the page calls `notFound()`. Tenant routes do not carry the tenant ID in the URL; only the `/operator` ones accept `tenantId`.

### #59: ingest keys

- **Format** in `src/lib/ingest-key.ts` (contract with the collector): `ntf_<prefix>_<secret>`, with an 8-character prefix and a 256-bit secret. The database stores only the prefix and the SHA-256 of the full key.
- **Functions** in `src/lib/data/api-services.ts`:
  - creating a service already generates the first key;
  - up to 5 active keys per service, guaranteed with a lock on the service row (holds with simultaneous requests);
  - creating and revoking go into the `audit_log` with the prefix only;
  - a removed project creates neither service nor key, but can still revoke.
- The full key appears once, in the creation response, and never goes to a log. There is a test that checks this.
- **Later fix** (`a6534fa`): Drizzle wraps the Postgres error in `cause`, so two simultaneous registrations with the same name gave a generic error. The race test failed only sometimes; after the fix, it passed in 15 runs in a row.

### #60: email confirmation and password recovery

- **Better Auth configuration** in `src/lib/auth.ts`:
  - open sign-up, with required email confirmation: without confirming, the person cannot sign in (and receives another link when they try);
  - the confirmation link is valid for 24 hours; the password one, 30 minutes, once only, and changing the password ends all sessions;
  - sign-up with an existing email and a password request for an email without an account receive the same response as the normal cases, without revealing who has an account;
  - log at the `warn` level, because the `info` level would record the email of whoever tries to sign up again.
- **Limits per IP** (in memory): sign in, 3 every 10 seconds (Better Auth default); sign up, 10 per hour; request a link, 5 per hour.
- **Email** in `src/lib/mail.ts`: plain text only, through SMTP (`SMTP_URL`), with `nodemailer` 10.3.1 (MIT-0 license, OSI-approved). Neither the recipient nor the link goes to the log.
- **Mailpit v1.32.0** in Compose: inbox at `http://127.0.0.1:8025` and SMTP at `127.0.0.1:1025`.
- **Screens:** `/sign-up`, `/forgot-password`, `/reset-password` and `/email-verified`.

### #17: self-service project sign-up

- `/onboarding` creates the `active` tenant, the `owner` member and the `tenant.created` entry in the `audit_log`, in one transaction (`src/lib/data/tenants.ts`).
- Only someone with a confirmed email, who is not an operator and does not have a project yet gets there. Whoever already has one goes to the dashboard.
- Whoever has no project and opens a tenant page is taken to `/onboarding`.
- Two requests at the same time from the same user create a single project (D1).
- The slug comes from the name; if it already exists, it gets a random suffix.
- `/sites` registers sites in Umami, and the dashboard shows the project name and shortcuts to sites and services.

### #19: SCF operator

- **Admin command** `scripts/operator.mjs` (`pnpm operator:create`, `operator:promote` and `operator:demote`): it is the only way to create or promote an operator (D3). Each change goes to the `audit_log` and ends the account's sessions. `pnpm user:create` no longer creates an operator.
- **D2 in the database** (migration `drizzle/0003_operator_not_member.sql`): a trigger refuses putting an operator in a tenant and promoting to operator someone who is already a member of one.
- **Global view** in `src/lib/data/operator/tenants.ts` and on the `/operator` and `/operator/tenants/[tenantId]` screens, read-only.
- **Development seed** (`pnpm db:seed`, password in `SEED_PASSWORD`): 2 test projects (each with an owner, a service and a key) and 1 operator. It can run more than once. With `UMAMI_API_KEY`, it also creates one site in Umami per project.

### #20: project removal and reactivation (portal part)

- **Functions** `removeTenant` and `reactivateTenant` in `src/lib/data/operator/tenants.ts`, the operator's only writes. They receive `OperatorContext`, lock the tenant row (`SELECT ... FOR UPDATE`) and write status, `status_changed_at`, `status_changed_by` and `status_reason`, plus one row in the `audit_log` (`tenant.removed` or `tenant.reactivated`, with the previous status and the reason).
- **Choices:**
  - the removal reason is required (3 to 500 characters), because the project sees it on the dashboard; the reactivation one is optional and stays only in the `audit_log` (the `status_reason` column goes back to null);
  - removing what is already removed, or reactivating what is not, writes nothing (returns `"unchanged"`); two operators at the same time produce a single record;
  - reactivating applies only to `removed`. A `pending` tenant is not approved here: that is done by `approveTenant` and `rejectTenant` (#49, [ADR 0007](adr/0007-sign-up-with-approval.md)).
- **Screens:** form and status history at `/operator/tenants/[tenantId]` (`status-form.tsx`, actions in `actions.ts`). The actions call `requireOperatorContext()` before anything else, so a tenant member gets 404.
- **Ingestion:** nothing changed in the gateway or in the views. `ingest_site` and `ingest_key_active` (migration 0002) already require `tenant.status = 'active'`, so the web gateway starts dropping the events within 1 minute (its cache). The test `services/ingest-web/e2e/tenant_status_test.go` checks this end to end, with the real Umami.
- **What already existed and still holds:** a member of a removed project can still sign in, sees the notice with the reason at `/dashboard` and cannot register a site, service or key (only revoke a key).
- **API ingestion:** the collector (#30) reads the same `ingest_key_active` view, so it refuses with `401` (HTTP) or `Unauthenticated` (gRPC) the key of a removed project, with a cache of at most 60 seconds. The test `services/collector/e2e/isolation_test.go` checks the transition: the accepted key starts being refused after the removal and is valid again after the reactivation.

### #21: isolation tests

- **Single suite** in `apps/portal/test/isolation.test.ts`, with the cases from section 8 of the spec: two tenants (A and B) with a site, a service and a key, an operator and a user without a project.
- The cases go through what the browser reaches (pages and server actions, with a simulated session, including Better Auth's `update-user`) and through what ingestion reads (the views, queried as `stellytics_ingest` and `stellytics_collector`).
- **The collector part** lives in its e2e: key of a removed tenant refused (`services/collector/e2e/e2e_test.go`, from #30) and key revoked or tenant removed **after** being accepted, refused within the cache time, with reactivation (`isolation_test.go`).
- **Key of A claiming to be B's** (`TestKeyOfAClaimingBIsStoredAsA`, in the collector e2e, because it needs the exporter from #31): the claim goes with B's real IDs in the resource, scope and point or span attributes, in two resources in the same request, over HTTP (metrics) and over gRPC (spans). Everything is stored as the key's owner, and B is left without any row in `api_metric_1m`.
- **Checked that the case catches failures:** with `tenantattr` honouring the tenant the client sends, or stamping only the first resource of the request, the test fails.
- **Checked that the suite catches failures:** removing the tenant filter from `getApiService` makes the URL case fail, and keeping the tenant active in the e2e makes the extra page view appear in Umami.
- Each new dashboard (#28 and #37) adds its own cases to this suite.
- The helper `test/helpers/as-role.ts` (queries as another database role) moved out of `tenant-model.test.ts` to be used by both suites.

## 4. How to run locally

At the repository root:

```bash
docker compose up -d --wait
```

It starts Postgres, Umami, Mailpit and the portal (`http://localhost:3000`). A Postgres volume created before #16 needs the ingestion users, without deleting the data:

```bash
docker compose exec -T postgres sh < infra/compose/postgres/init/02-ingest-roles.sh
```

Umami service account key (goes in `UMAMI_API_KEY` in the root `.env`; then `docker compose up -d portal`):

```bash
cd apps/portal
read -rs UMAMI_ADMIN_PASSWORD && export UMAMI_ADMIN_PASSWORD
# Umami only publishes the port with the development override (#62):
#   docker compose -f compose.yaml -f infra/compose/umami-port.yaml up -d
UMAMI_URL=http://127.0.0.1:3001 pnpm umami:service-account
```

Test data:

```bash
cd apps/portal
read -rs SEED_PASSWORD && export SEED_PASSWORD
pnpm db:seed
```

The portal's emails appear at `http://127.0.0.1:8025`. Use `127.0.0.1` instead of `localhost` for Umami: if another program listens on the same port on IPv6, `localhost` lands on it.

Details of each part are in the [portal README](../apps/portal/README.md).

## 5. Tests

107 tests in the portal, plus 3 pending on the collector (`pnpm test` at the root or in `apps/portal`), against a real Postgres; Umami is simulated (`test/fake-umami.ts`) and so is email sending.

| File | Covers |
|---|---|
| `tenant-model.test.ts` | Tables, constraints, insert-only `audit_log` and permissions of the ingestion users |
| `umami.test.ts` | Site creation, undo in Umami, reading statistics and consistency |
| `access.test.ts` | Tenant and operator contexts, with a simulated session |
| `lint-boundaries.test.ts` | Lint rule of the single layer |
| `ingest-keys.test.ts` | Format, limit with simultaneous requests, revocation, `audit_log` and key out of the logs |
| `email-flows.test.ts` | Sign-up, confirmation, password reset and attempt limits |
| `onboarding.test.ts` | Who can create a project, creation, slug and race |
| `operator.test.ts` | D2 trigger, admin command, seed, global view, removal and reactivation |
| `isolation.test.ts` | Isolation suite from section 8 of the spec (#21) |
| `auth.test.ts` | Login, session without IP and role never coming from the client |

The CI `compose` job, besides bringing up the environment, checks the permissions of the ingestion users, the service account in Umami, Mailpit and the sign-up screen, and runs the gateway's end-to-end tests, among them the removed-tenant one (`services/ingest-web/e2e/tenant_status_test.go`).

## 6. New environment variables

| Variable | Use |
|---|---|
| `UMAMI_URL` | Umami's internal address (default `http://127.0.0.1:3001`, which only exists with the `infra/compose/umami-port.yaml` override; in Compose, `http://umami:3000`) |
| `UMAMI_API_KEY` | Service account key. Without it, the portal starts, but does not create sites |
| `SMTP_URL` | SMTP server. Without it, the portal starts, but emails fail (the error goes to the log) |
| `MAIL_FROM` | Sender of the emails |
| `STELLYTICS_INGEST_DB_PASSWORD`, `STELLYTICS_COLLECTOR_DB_PASSWORD` | Passwords of the ingestion users in Compose |
| `MAILPIT_PORT`, `MAILPIT_SMTP_PORT` | Mailpit's local ports |

## 7. Limits and pending items

**Left for other epics:**

- The `INSERT` of `stellytics_collector` on the metric tables comes in E5, together with the tables.
- The production SMTP depends on the IaC (#14, E1).

**Known limits:**

- `ingest_key.last_used_on` is written by the collector (migration `0008_ingest_key_last_used.sql`): the `ingestkeyauth` extension calls, in the background, the function `ingest_key_touch(prefix)` on the first authentication of the day (UTC) of each key, once per key and day per process. The function is `SECURITY DEFINER`, only updates that column and only for a key that is in `ingest_key_active`; `stellytics_collector` has only `EXECUTE` on it and still has no access to the table. A failure only produces a warning in the log, with the name of the error type.
- The attempt limits stay in memory and use the IP from `X-Forwarded-For`. In production, the portal needs a single instance and Caddy in front.
- A site's domain is unique per tenant even after being archived, as the spec says: an archived domain cannot be registered again without unarchiving.
- The Umami API key can create teams; only the portal code prevents that.
- The integration tests leave rows in the `audit_log`, which only accepts inserts. In CI the database is discarded; in the local database they accumulate.
