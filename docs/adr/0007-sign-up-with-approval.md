# 0007. Sign-up with prior approval

- **Status:** Accepted
- **Date:** 15/11/2026
- **Issue:** #49

## Context

Sign-up is open (#17, #60): whoever confirms their email creates an `active` project and can already send events. For the next milestones the SCF may want to control who gets in, for example to limit the platform to projects of the Stellar ecosystem. Issue #49 asks for a configurable mode in which new projects stay `pending` until an operator approves them, and for an approval screen.

The `tenant_status` enum has had the `pending` value since #16, and the `ingest_site` and `ingest_key_active` views (migration 0002) only accept an `active` tenant. The E2 spec (section 6) planned `pending` with empty dashboards and registration allowed, but marked the state as "not used in the MVP".

## Decision

- **`pending` state in the existing enum, with no new column and no migration.** The lifecycle is `pending` → `active` (approved) or `pending` → `removed` (rejected).
- **Mode set by the `SIGNUP_APPROVAL` environment variable** (`true` or `1` turns it on; off by default), read by `src/lib/env.ts` and used only in `createProject`. When off, the behaviour is the previous one, byte for byte (regression test in `test/onboarding.test.ts`). In Ansible it is `signup_approval` in `group_vars/all.yml`.
- **What the pending project sees:** only a waiting screen at `/dashboard`. `requireTenantContext()` redirects to it from any other tenant page or action (the screen asks for `allowPending`), and the data layer also refuses to create a site, service or key. This changes what the E2 spec said (pending with empty dashboards and registration allowed); the spec was updated.
- **Ingestion:** no change. The views already treat `pending` as not active, so the gateway and the collector reject it, and the approval takes effect within 1 minute (their cache).
- **Approve and reject:** functions `approveTenant` and `rejectTenant` in `src/lib/data/operator/tenants.ts`, which reuse the removal transaction with `SELECT ... FOR UPDATE`. They only apply to `pending` (from another status nothing is written). Each one writes a row to the `audit_log` (`tenant.approved`, `tenant.rejected`) with who, when, the previous status and the reason. The reason is mandatory on rejection, because the project sees it; on approval it is optional.
- **Rejecting is removing:** the rejected project becomes `removed` with the reason, sees the removed-project notice and the operator can reactivate it (D6).
- **Screen:** `/operator/approvals` lists the pending ones, from oldest to newest, with approve and reject on each. The project detail (`/operator/tenants/[tenantId]`) shows the same buttons when the status is `pending`, and `/operator` warns when there are pending ones.
- **No notification email in this issue.** The project finds out about the approval when it signs in again.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| New `pending` status in the enum (chosen) | The value already exists; views, SCF dashboards and listings already treat it as not active; no migration | Whoever reads the status has to remember that `pending` is not `removed` |
| `approved_at` column or a separate boolean | Separates approval from removal | Two fields for the same concept; the ingestion views would have to change, and forgetting one would leave an unapproved tenant sending data |
| Setting in the database, changed through an operator screen | Turns on and off without a restart | One more write and one administration screen (the E2 spec, D3, avoids that); the choice belongs to whoever operates the server |
| Pending with empty dashboards and registration allowed (original spec) | Less code in the portal | The pending project would already register sites in Umami and generate keys before any approval, and approval would come after the tenant had already caused work |
| Reject by erasing the tenant and its data | Cleans the database | Loses the history and the reason; it disappears from the `audit_log`, which references the tenant; irreversible. Removing is deactivation (E2 spec, section 6) |
| A dedicated `rejected` state | Distinguishes rejected from removed | Touches the enum and every `removed` check; the `audit_log` already distinguishes them (`tenant.rejected`) |
| Email to the operator and to the project | Nobody needs to open the screen | Requires a configured recipient and more email tests; left for later |

## Consequences

- With the mode off nothing changes; turning it on affects only new sign-ups. Projects already `active` stay active, and the `pending` ones remain in the queue if the mode is turned off later (the operator still resolves them).
- The portal now has two places that handle `pending` (`requireTenantContext` and the write functions in `data/`), so a new tenant page is covered from the start.
- Turning the mode off with tenants still `pending` keeps the queue full: they stay pending until the operator decides, and `/operator/approvals` warns that the mode is off.
- A rejected project is stuck: each user has only one project (D1) and only the operator reactivates it. Reactivating a rejected project makes it `active` without a new approval.
- `removeTenant` still accepts `pending` (previous behaviour). The interface only shows approve and reject for pending ones, on purpose.
- Changing the mode requires restarting the portal (environment variable).
- Without a notification, the SCF has to look at `/operator/approvals` (`/operator` shows the count). An email is the natural evolution, but it is outside this issue.
