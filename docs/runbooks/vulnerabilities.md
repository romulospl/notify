# Runbook: vulnerability response

Public policy, deadlines and scope in [`SECURITY.md`](../../SECURITY.md): private report through the GitHub **Security** tab (**Report a vulnerability**), acknowledgement within 3 business days, assessment of possible critical and high ones within 48 hours (the rest in 7 days), fix within 24 hours (critical), 7 calendar days (high) and 90 days (medium or low), counted from receipt or identification. Severity by CVSS 3.1. Supply chain context: [`docs/anti-bot-and-supply-chain.md`](../anti-bot-and-supply-chain.md).

## Symptoms

A private report arrived; a scanner or Renovate flagged a vulnerable dependency; a tenant says an ingest key leaked; suspicion that one tenant's data was seen by another; an operator or an account was compromised.

## 1. Receive and assess

1. Acknowledge receipt in the report itself (within 3 business days). Do not discuss it in a public issue.
2. Reproduce it in a local environment (`docker compose up -d --wait`). Classify it by CVSS 3.1 and record the deadline from `SECURITY.md`.
3. High priority, according to `SECURITY.md`: reading another tenant's data, bypassing the ingest key, persisting personal data (full IP) and inflating metrics. For isolation, look for the case in `apps/portal/test/isolation.test.ts` and in `services/collector/e2e/isolation_test.go`; the fix must leave a new test there.
4. Check whether it was exploited: `audit_log` (actions `ingest_key.created`, `ingest_key.revoked`, `tenant.removed`, `operator.*`) through the tunnel (`infra/scripts/admin-tunnel.sh`):

   ```bash
   psql 'postgresql://stellytics:<STELLYTICS_DB_PASSWORD>@127.0.0.1:15432/stellytics' \
     -c "select at, action, actor_user_id, tenant_id from audit_log order by at desc limit 50"
   ```

   (columns checked in `apps/portal/src/lib/db/schema.ts`; the query itself was not run). The service logs have neither the visitors' IP nor their headers, so exploitation from outside usually leaves no trace there.

## 2. Contain

Choose what applies; all of them take effect immediately or within 1 minute on ingestion (the gateway's `ingest_site` cache: at most 1 minute; the key cache in the collector: at most 60 s).

### Leaked ingest key

The tenant itself revokes it at `/services` (the action writes `ingest_key.revoked`). The collector starts refusing with 401. The tenant is the one who creates the new key; the full key only appears at creation. If the tenant cannot do it, the operator does not revoke through the screen (the operator's only writes are removing and reactivating a project): use the project removal below or, through the tunnel, the SQL below as the `stellytics` user (owner of the tables; it is the role the portal uses for the same writes; **not tested**). Replace `<prefix>` (8 characters, the public part of the key `ntf_<prefix>_...`); never put the full key in an issue, log or message:

```sql
BEGIN;
UPDATE ingest_key SET revoked_at = now() WHERE prefix = '<prefix>' AND revoked_at IS NULL;
-- Check for "UPDATE 1". If you get UPDATE 0, ROLLBACK and investigate.
INSERT INTO audit_log (actor_user_id, action, tenant_id, details)
SELECT NULL, 'ingest_key.revoked', tenant_id,
       jsonb_build_object('apiServiceId', api_service_id, 'prefix', prefix, 'manual', true)
FROM ingest_key WHERE prefix = '<prefix>';
COMMIT;
```

`audit_log` is insert-only (a trigger blocks UPDATE and DELETE), so an error in the INSERT cannot be corrected afterwards: check before `COMMIT`. `actor_user_id` is null because the action is manual; record in writing who did it.

### Project (tenant) to block

Sign in as an operator at `/operator`, open `/operator/tenants/<tenantId>` and use the project removal (reason required; it writes `tenant.removed` to `audit_log`). Effect: the `ingest_site` and `ingest_key_active` views require an `active` tenant, so the gateway starts dropping events (cache of up to 1 minute) and the keys stop working; the tenant's dashboard disappears. Reactivation is on the same screen (`tenant.reactivated`). No data is erased.

### Compromised operator

Run this on the **administrator's machine**, in a repository checkout with `pnpm install` and Node 24 (not on the VPS, which has the checkout but neither Node nor pnpm), with the `infra/scripts/admin-tunnel.sh` tunnel open:

```bash
DATABASE_URL='postgresql://stellytics:<STELLYTICS_DB_PASSWORD>@127.0.0.1:15432/stellytics' \
  pnpm --filter @stellytics/portal operator:demote --email <email>
```

This demotes the account to a regular user, deletes its sessions and writes `operator.demoted` to `audit_log`. **Limits:** it does not cover a compromised tenant account (for that, remove or review the project and use password recovery); and it does not prevent a new promotion by someone who has access to the database (`operator:promote` with the same `DATABASE_URL`): if the attacker has the database or the VPS, the problem is an infrastructure one. Change the account's password through the portal's recovery flow if it is still legitimate and review `audit_log` for the operator's actions. If what leaked was access to the server, follow [secret rotation](secret-rotation.md) in full.

### Leaked secret or infrastructure access

[Secret rotation](secret-rotation.md). For the VPS, change the SSH key and, if in doubt, recreate the VPS (`init.sh` and `deploy.sh`, `docs/deploy.md`) with new secrets, carrying over the data in `STELLYTICS_DATA_DIR` or restoring the backup ([backup and restore](backup-and-restore.md)).

### Tampered or flawed tracking script

Published versions are immutable (`packages/tracker/published/vX.Y.Z/n.js`, hash in `published/sri.json`). The normal fix ships in a new version: bump the `version` in `package.json` and run `pnpm --filter @stellytics/tracker release`; tell the tenants to change the URL and the SRI (snippets in `examples/README.md`).

**Withdrawing a vulnerable version is not just deleting the folder.** Removing `published/vX.Y.Z/` breaks `packages/tracker/test/published.test.ts` (which requires an entry in `sri.json` for each folder and vice versa, and checks the hash) and goes against the immutability rule. To really withdraw it you would need, in the same PR: to delete the folder, remove the entry from `sri.json`, and record the exception to the policy (a new ADR or a note in `docs/anti-bot-and-supply-chain.md`), and to deploy a new `ingest-web` image (the image copies `published/` to `/scripts`). This breaks the tenants that do not migrate (the script disappears, without warning). An alternative to evaluate, which **does not exist today**: the gateway answering `410 Gone` for a list of revoked versions, without deleting the file from the repository; it would require new code and tests in `services/ingest-web`. None of this has been tested.

## 3. Fix and publish

1. Fix it on a private branch or in a GitHub security fork (**Security** tab, private advisory), with a test that failed before.
2. PR with a commit in English, Conventional Commits (`fix(...)`). CI (`ci`) must pass.
3. Publish a **release** (`vX.Y.Z`): `release.yml` generates the SBOM and publishes to GHCR the images signed with cosign (keyless) with an SBOM attestation.
4. Deploy: update the checkout on the VPS and run `sudo ./deploy.sh`, which by default builds the images from the checkout's code. The signed release images can be used by digest (`PORTAL_IMAGE` etc. in `.env.production`), but **nothing checks the signature automatically** on deploy; it is a weaker control than verifying the signature before bringing it up. Before that, `systemctl start stellytics-backup` if the version has a migration. Details: `docs/deploy.md`, "Update the application".
5. Vulnerable dependency: check the upstream fix and follow the exception below when the version is less than 14 days old. Renovate is not installed yet and the GitHub alerts need to be enabled; do not depend on it to detect the vulnerability. For Umami, see [Umami upgrade](umami-upgrade.md).

### Exception to the 14-day wait

For a confirmed critical or high vulnerability, the maintainer may use a fix version before the 14 days when waiting would bring a greater risk. Record in the private advisory or PR the vulnerability identifier, impact and reach, exact package and version, publication date, assessment of provenance and integrity, reason for the exception, person responsible and removal date. Review, tests, CI and the release signature are still required. With no upstream fix, contain and communicate the risk; do not classify containment as a fix.

For a pnpm package, temporarily add to `pnpm-workspace.yaml` a `minimumReleaseAgeExclude` entry with the **name and exact version** (for example `package@1.2.3`), update the lockfile and review the diff. Do not turn off the wait globally or exclude all versions of a package. Remove the entry once the version reaches 14 days and confirm CI. For Go and images, update only the fixed version and, for images, pin tag and digest; record the same justification in the PR. If the fix requires several young dependencies, record and assess each exception.

[Renovate](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts) can raise PRs for security alerts without the wait, but it depends on the app and on the GitHub alerts; in the current state it is not installed. pnpm keeps its own age control, even when Renovate proposes an update; see [`minimumReleaseAgeExclude` in pnpm 10](https://pnpm.io/10.x/settings#minimumreleaseageexclude).

## 4. Verify

- The test that reproduced the problem passes; the isolation suite passes (`pnpm --filter @stellytics/portal test` and the CI `compose` job).
- Step 3 ("Check production") of `docs/deploy.md` in production; the version live is the one from the fixed commit.
- The containment measure was undone only when the fix is live (reactivate the project, if applicable).

## 5. Disclose

After the fix is published, publish the GitHub advisory and credit whoever reported it, if the person wants that (`SECURITY.md`). If personal data of tenants or visitors was exposed, the roles (controller and processor) are in section 2 of [`docs/privacy.md`](../privacy.md), and the legal gaps, in sections 7 and 9; the data incident notification procedure **is not written** anywhere in the repository: define it with legal counsel before the first real incident).

## When to escalate

- Critical or high severity, including data exposure between tenants: treat it as an incident immediately; contain as soon as you confirm it; fix within 24 hours (critical) or 7 calendar days (high) from receipt or identification.
- A `SECURITY.md` deadline at risk, or a vulnerability in the provider's own infrastructure, in Umami, in Caddy or in Postgres: report it to the upstream project and to the provider's support. To stop the main proxy use `docker compose -f prod.yaml stop caddy`; for the other services use `docker compose -f prod.yaml stop <service>`. Stopping `ingest-web` drops the events received in that interval.

## Not tested

None of this has been exercised: neither a revocation or removal in production, nor `operator:demote` against the VPS database, nor the release with signed images (there is no published release yet), nor the withdrawal of a script version.
