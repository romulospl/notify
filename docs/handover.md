# Handover to a community operator

Plan and procedure for passing the operation of stellytics to a community operator (for example, the SCF itself or a team it appoints): repository, images, infrastructure, domain, data and responsibilities ([#54](https://github.com/romulospl/stellytics/issues/54), epic [E9](https://github.com/romulospl/stellytics/issues/9)).

> **Status.** The **plan** is written from what the repository has today (`docs/deploy.md`, `docs/runbooks/`, `release.yml`, `infra/`). The **data migration procedure was actually executed, locally**, with the scripts and the result described in [Data migration](#data-migration-tested). **Nothing else was executed:** no transfer of a repository, domain or real account, no restore against a real S3 bucket, no `init.sh` or `deploy.sh` on a real VPS. The full list is in [What was not tested](#what-was-not-tested). By the issue's criterion, **#54 only closes when the new operator runs the system on its own** ([Acceptance criteria](#acceptance-criteria-for-the-handover)); this document does not fulfil that.
>
> **Production has not been applied yet** (`docs/deploy.md`, `docs/privacy.md`). That is an advantage: the choices that are expensive to undo later (the domain and who owns it, the [ingestion host](#decision-domain-and-ingestion-host)) can still be made with the final owner already in place. If the first deploy is done by the community operator itself, a good part of this document becomes just the list of what it must have from the start.

## What changes hands

"Today" is what the repository assumes (`romulospl/stellytics`, one person operating). Each row says what needs to change and where.

| What | What happens | Where it is in the repository |
|---|---|---|
| **GitHub repository** (code, issues, releases, tags, `SECURITY.md`) | Transfer in *Settings → Danger Zone → Transfer* to the new operator's organization. GitHub keeps a redirect of the repository URLs and carries issues, releases and tags. It **does not carry** the Project `romulospl/projects/1` (it belongs to the user) nor the security settings: re-enable private vulnerability reporting (*Security → Report a vulnerability*) and check the maintainers. The `https://github.com/romulospl/stellytics/...` links in the documentation keep working through the redirect; change them later, with no hurry | `.github/ISSUE_TEMPLATE/config.yml`, `SECURITY.md`, `README.md`, `CONTRIBUTING.md`, `docs/` |
| **GitHub Actions and secrets** | Turn Actions on in the new organization. Today no workflow uses a repository secret other than `GITHUB_TOKEN` (checked: there is no `secrets.` other than it in `.github/workflows/`), so **there is no Actions secret to migrate**. `release.yml` publishes to GHCR with that token and signs through OIDC; `adblock.yml` runs by `cron` (`17 6 * * *`) and continues after the transfer | `.github/workflows/` |
| **Organization, GHCR packages and images** | `release.yml` publishes to `ghcr.io/${{ github.repository }}/<name>`, so **the first release made in the new repository publishes to the new namespace** (`ghcr.io/<new-org>/stellytics/portal` etc.). The old images **stay** at `ghcr.io/romulospl/stellytics/...`: do not assume that the repository transfer moves the packages (check, and, if needed, transfer each package from its own page). New packages are created **private**. By default `deploy.sh` builds the images from the checkout and does not use GHCR; whoever prefers the release images passes them by digest (`PORTAL_IMAGE`, `INGEST_WEB_IMAGE`, `COLLECTOR_IMAGE`, `ROLLUP_IMAGE` in `.env.production`) and needs to make the packages public, otherwise the VPS cannot pull them | `.github/workflows/release.yml`, `infra/compose/prod.yaml` |
| **cosign identity** | The signature is keyless and carries the path of the workflow that generated it (today `^https://github.com/romulospl/stellytics/\.github/workflows/release\.yml@refs/tags/v`); the images of the new repository's releases carry the new organization's identity. **The deploy does not check the signature**: `deploy.sh` builds from the checkout by default, and images passed by digest are not verified automatically. Whoever wants to check runs the `cosign verify` of Phase 1 by hand | `.github/workflows/release.yml` |
| **Renovate app** | Renovate is a GitHub app installed on the owner's account: the new owner installs the app in the organization and enables the repository. `renovate.json` (14-day wait, approval in the Dependency Dashboard for major versions, Umami handled separately) goes along with the code. The Dependency Dashboard is an issue and comes with the repository | `renovate.json`, `docs/runbooks/umami-upgrade.md` |
| **Domain and DNS** | Four names: alias and portal, web ingestion and API ingestion. **This is the part that binds the most**: the scripts installed on the tenants' sites carry the ingestion host (see [Decision](#decision-domain-and-ingestion-host)). The records are created by hand ([ADR 0016](decisions.md#0016-production-on-a-vps)), so nothing in the repository moves them | `docs/deploy.md` step 2 |
| **VPS and provider** | The new operator chooses its **own provider** and prepares a VPS with `init.sh` and `deploy.sh` (`docs/deploy.md`). Infrastructure is not transferred; it is recreated and **the data** is migrated (below). The old VPS stays on until the end of the rollback period | `init.sh`, `deploy.sh`, `infra/compose/prod.yaml` |
| **S3 storage and backup bucket** | New bucket, in the new account, with new S3 credentials (`WALG_S3_PREFIX`, `WALG_S3_ENDPOINT`, `WALG_S3_REGION`, `WALG_S3_ACCESS_KEY`, `WALG_S3_SECRET_KEY`). The old operator's backups **are not migrated on the recommended path**: the new operator starts its own line of backups with `systemctl start stellytics-backup` right after the migration. The old bucket is kept for the rollback period and then erased, together with the old encryption key | `docs/runbooks/backup-and-restore.md` |
| **`WALG_LIBSODIUM_KEY`** | On the **logical** path (recommended), the new operator **generates a new key** and the old key **does not change hands**: whoever has it can read the old backups, which contain all the data (including password hashes and portal sessions), so it goes away with the old bucket. On the **physical** path (WAL-G), the old key is needed to read the copied bucket and must be delivered over a secure channel; after the migration, start a new bucket and a new key and discard the old one. It is **not rotatable** (`docs/runbooks/secret-rotation.md`), which is why the change of operator is the natural opportunity to generate another | `.env.production.example` |
| **SMTP** | The new operator contracts its own provider and adjusts `SMTP_URL`, `MAIL_FROM` and the SPF, DKIM and DMARC of the sender's domain. Without SMTP nobody signs up (a confirmed email is mandatory), and password recovery also depends on it | `docs/deploy.md` ("What you need") |
| **Secrets in `.env.production`** | Table below: almost all are **generated again** (`init.sh` generates the empty ones), three deserve care | `.env.production.example` |
| **SCF operator accounts** | The accounts exist in the database (`user.role = 'operator'`) and **migrate with the data**. The new operator creates its own with `pnpm operator:create` (or `operator:promote`) and demotes the old ones with `operator:demote` (it writes to the `audit_log` and ends the sessions). The **SCF read keys** (`/api/v1`, table `operator_api_key`) also migrate and stay valid: whoever uses them needs to know, and the new operator decides whether to revoke and reissue them | `apps/portal/scripts/operator.mjs`, `docs/decisions.md#0006-scf-read-api` |
| **Umami `admin` password** | **Migrates with the database** (the `admin` user is in the `umami` database; checked in the test). Whoever operated before knows it: the new operator changes the password through the tunnel **before anything else** after the migration | `docs/deploy.md` step 5 |
| **External monitoring** | The new operator brings up its own monitoring host (`infra/monitoring/configure.sh` and `docker compose up -d --wait`), with its own `ALERT_EMAIL`, alert SMTP and `DEADMAN_URL`. Turn the old one off only afterwards | `infra/monitoring/` |
| **SSH keys and provider access** | The new operator's, in the new account. The old operator loses access when it erases its own resources; on the old VPS and monitoring host, revoke the keys at the end of the rollback period | `docs/runbooks/secret-rotation.md` |
| **Tenant ingest keys (`ntf_...`)** | They migrate with the database (it stores only the prefix and SHA-256) and **stay valid**: no tenant needs to change its key | `apps/portal/src/lib/ingest-key.ts` |
| **Legal entity, DPA and privacy notice** | Whoever operates is the **controller** of the account data and the **processor** of the tenants' data (`docs/privacy.md`). The change of operator changes that contract: it needs a legal definition and a notice to the tenants **before** the window. Not resolved here | `docs/privacy.md` |
| **Go module path** (`github.com/romulospl/stellytics/services`) | **Does not need to change**: the module is only used inside the repository, and `go.mod` does not depend on the owner to compile. Renaming is optional and touches dozens of files | `services/go.mod` |

### Secrets in `.env.production`

| Secret | In the migration |
|---|---|
| `POSTGRES_PASSWORD`, `UMAMI_DB_PASSWORD`, `STELLYTICS_DB_PASSWORD`, `STELLYTICS_INGEST_DB_PASSWORD`, `STELLYTICS_COLLECTOR_DB_PASSWORD` | **Generate again.** On the logical path the roles of the new database are created by the scripts in `infra/compose/postgres/init/` with the new passwords; the test used passwords different from the source's for all of them |
| `PORTAL_AUTH_SECRET` | **Keep it** if you want users to stay logged in and the email links in progress to remain valid: in the test, the session created at the source stayed valid at the destination with the same value. Changing it drops all sessions (expected effect, `secret-rotation.md`); changing the value was **not tested** in the migration |
| `UMAMI_APP_SECRET` | **Keep it.** Umami 3.4.1 derives the visitor salt from this secret and the start of the month (`SALT_ROTATION`, default `month`), so a new value makes every returning visitor count again as unique for the rest of the month. Only the same value was tested. Changing it also drops the Umami sessions and may invalidate the API key (`secret-rotation.md`) |
| `UMAMI_API_KEY` | **Check it.** If the key lives in the Umami database, it migrates and stays valid; **this was not tested** (the test did not create the service account). If the portal gets 401 from Umami, generate another (`docs/deploy.md`, step 5, item 3) |
| `INGEST_PROOF_SECRET` | **Generate again** (the challenges last minutes; some events may be dropped at the switchover) |
| `SMTP_URL`, and the monitoring's `SMTP_PASSWORD` and `DEADMAN_URL` | The new operator's |
| `WALG_S3_ACCESS_KEY`, `WALG_S3_SECRET_KEY`, `WALG_LIBSODIUM_KEY` | **New** (logical path); see the key's row above |

## Decision: domain and ingestion host

The tracking script is installed on third-party sites with `src="https://<ingestion host>/s/vX.Y.Z/n.js"` and **sends the events back to the origin it was loaded from** (`POST /e`, `CLAUDE.md`). The `v1.x` files are immutable, with SRI, and the gateway must keep answering for them. Changing the ingestion host requires **each tenant to edit the HTML of its own sites**; forgetting one site means losing its data silently. So the rule is: **the name of the ingestion host cannot change.**

| Option | What it is | When it fits |
|---|---|---|
| **A. The domain changes owner** (recommended) | Transfer the domain registration (or at least the DNS zone) to the new operator. The names stay the same and **no tenant does anything** | Whenever the domain belongs to the project and not to a person |
| **B. The domain stays with the old operator** | It only repoints the A and AAAA records to the new IP | **Only as a transitional phase.** It contradicts the criterion "the new operator runs on its own": if the domain owner disappears, ingestion goes down |
| **C. New domain** | Permanent redirect of the portal and a long transition of ingestion | Last resort. The **redirect** serves the portal (browsers on `GET`), **not** ingestion: a cross-origin `fetch` `POST` must not depend on a redirect. The old host needs to **keep serving the gateway for a long time** |

**Option C requires a change the repository does not have yet.** The Caddyfile (`infra/caddy/Caddyfile`) knows one ingestion host and keeps no legacy alias for it. For the transition it would be necessary to serve the gateway on both names for long enough, redirect the old portal and update certificates, DNS and `.env.production`. **This is a proposal; it is neither implemented nor tested**; if option C is the one chosen, open an issue and implement it before the window. Changing the portal host also drops the sessions (the cookie belongs to the host) and changes `BETTER_AUTH_URL`.

**Neutral host** ([`packages/tracker/docs/ad-blockers.md`](../packages/tracker/docs/ad-blockers.md)): the ingestion host must be short and neutral (`e.<domain>` or `gw.<domain>`), without `analytics`, `track`, `tracking`, `collect`, `umami`, `stats`, `metrics` or `telemetry`, and the blocking check must run with it (`pnpm --filter @stellytics/tracker check:adblock <host>`). Since the host is practically permanent, **decide the domain and the final owner before the first deploy**: if production has not been applied yet, register the domain directly in the account of the project or of the entity that will operate, and option A stops being a transfer and becomes just a change of administrative contact.

## What the new operator needs to have and know

**Have (before Phase 1):**

- a GitHub organization with permission to publish releases, Actions turned on and GHCR enabled;
- an account with a VPS provider (Debian or Ubuntu) and S3-compatible storage for the backups, with its credentials;
- the domain, or control of its DNS (option A), and an email for Let's Encrypt;
- an SMTP provider with authenticated sending and the sender's domain configured;
- a team password vault (`.env.production` and `WALG_LIBSODIUM_KEY` live there, **outside the VPS and the repository**; without the key, no backup is restorable);
- at least **two people** with administrative access to everything above (a single person is the risk this handover exists to remove);
- the tools from `docs/deploy.md` ("What you need"): `git`, `ssh`, `openssl`, Docker, `jq`, Node 24 and pnpm 10.34.5.

**Know (read in order):**

1. [`docs/architecture.md`](architecture.md) and the ADRs [0001](decisions.md#0001-base-tool), [0002](decisions.md#0002-architecture-and-stack), [0003](decisions.md#0003-portal-isolation) (isolation between tenants: never weaken it), [0005](decisions.md#0005-external-monitoring), [0006](decisions.md#0006-scf-read-api), [0007](decisions.md#0007-sign-up-with-approval) and [0016](decisions.md#0016-production-on-a-vps);
2. [`docs/deploy.md`](deploy.md): from zero to production, updating, changing a secret, restoring;
3. the [runbooks](runbooks/README.md): incidents, backup and restore, secret rotation, Umami upgrade, vulnerabilities. All of them carry the caveat that they **have never been exercised on a real production**: the new operator is the one who will correct them the first time;
4. [`docs/privacy.md`](privacy.md) and [`docs/umami.md`](umami.md): the full IP is never persisted; Umami is never exposed; any patch to Umami is documented;
5. the constraints in `CLAUDE.md` ("Non-obvious constraints"): Umami pinned, OSI-approved licenses, `tenant.id` always comes from the ingest key, script immutable per version.

**Known pending items the new operator inherits** (`docs/deploy.md`, "Not covered yet"): the API collector and the `rollup` are **not in production** yet; the SCF read API has no per-IP limit in Caddy; it is a single VPS, with no high availability; the restore against the real bucket has never been rehearsed.

## Order and maintenance window

Dates relative to the day of the window (`T`). Each step is done by the new operator, **with the old one alongside**; the idea is that in the window the old one only runs the source steps.

### Phase 0: decisions and contracts (T-30 to T-14)

1. Decide the domain and owner (option A, B or C above) and the neutral host; run the ad blocker check with the host.
2. Define the operating legal entity, the DPA with the tenants and the privacy notice (`docs/privacy.md`).
3. **Notify the tenants** ([Communication](#communication-to-the-tenants)): date of the window, what does not change and what happens to the data in the interval.
4. The new operator creates the accounts from the previous section and reads the documentation.

### Phase 1: repository and images (T-14)

Before touching the data, because the destination comes up from the new repository (from the checkout or from its release images).

1. Transfer the repository; re-enable private vulnerability reporting; install Renovate; turn Actions on.
2. **The new operator publishes a release** (`vX.Y.Z`) in the new repository, follows `release.yml` to the end and, if it is going to use the release images instead of building from the checkout, makes the packages public. This is already the first test that it can publish on its own.
3. Check the signature with the new identity (by hand: the deploy does not do this by itself):

   ```bash
   cosign verify ghcr.io/<new-org>/stellytics/portal@sha256:<digest> \
     --certificate-identity-regexp '^https://github.com/<new-org>/stellytics/\.github/workflows/release\.yml@refs/tags/v' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

4. Check that the published script is the same one the tenants use: the `v1.0.0`, `v1.1.0` and `v1.2.0` files in the new gateway image must match the hash in `packages/tracker/published/sri.json` (`curl -fsS https://<host>/s/v1.2.0/n.js | openssl dgst -sha384 -binary | openssl base64 -A`, prefixed with `sha384-`). The published files are immutable: if the hash changes, the SRI on the tenants' sites breaks and the script stops loading.
5. If using the release images, put the new digests in `PORTAL_IMAGE`, `INGEST_WEB_IMAGE`, `COLLECTOR_IMAGE` and `ROLLUP_IMAGE` in the new `.env.production`; otherwise, `deploy.sh` builds from the checkout of the new repository.

### Phase 2: new infrastructure and rehearsal (T-14 to T-1)

1. In the new account: prepare the VPS with `init.sh` and `deploy.sh` (`docs/deploy.md`), with **rehearsal** DNS on a domain of the new operator (Caddy obtains the certificate after the DNS switchover), and the monitoring. The DNS must point to the new VPS and ports 80/443 must be reachable for Caddy to issue the certificates; to test with the definitive names, they must point to the new VPS during the rehearsal.
2. **Migration rehearsal**, to measure the time and check the procedure with real data before the window: restore the old operator's most recent backup on a throwaway VPS (`docs/deploy.md`, "Restore the database"; it is also the first restore rehearsal that `backup-and-restore.md` marks as "never performed"), and run on it and on the new VPS the procedure in [Data migration](#data-migration-tested) from start to finish. Write down the time.
3. **Lower the TTL** of the portal and ingestion records to 300 s at least one old TTL before the window (T-2 if the TTL is 24 h).

### Phase 3: the window (T)

Suggested window: the time of lowest traffic on the tenants' sites, **far from the 03:00 UTC base backup** and from the old operator's timer (turn the old timer off in step 2). Size: that of the rehearsal times, plus DNS propagation and certificate issuance. With the volumes of the local test (small, see the times below) the data work takes seconds, but **with real data the time has not been measured**; reserve some slack.

**Recorded decision: long window, ingestion stopped from step 1 to the DNS switchover.** The old gateway is stopped in step 1 and the new one only serves after the switchover; everything that arrives in the interval is lost. Chosen for simplicity and because a consistent dump requires Umami stopped. **Untested alternative:** switch the DNS **before** the backup (the new gateway, still without sites, drops with `204` in the same way, but the loss interval becomes only the time of dump, transfer and restore, and the traffic already reaches the new Caddy with a valid certificate). It is only worth it if the new gateway is healthy and the loss is accepted; it has not been rehearsed.

During the window, the portal is down (nobody signs in or creates anything) and **web ingestion stops: the events that arrive between the stop of the old gateway and the new gateway serving are dropped** (the script's `fetch` fails silently) and **are not recovered**. The dashboards will have a gap of that size. Tell the tenants about this.

On the **old** VPS, as root, in the checkout folder (updated to this version of the repository, which has the scripts in `infra/scripts/`). As in the runbooks, `docker compose -f prod.yaml` below abbreviates `docker compose --env-file .env.production -f infra/compose/prod.yaml`, and the scripts receive the same command in `COMPOSE`:

1. `docker compose -f prod.yaml stop caddy portal ingest-web collector rollup umami` (ingestion stops here).
2. `systemctl stop stellytics-backup.timer`.
3. `COMPOSE='docker compose --env-file .env.production -f infra/compose/prod.yaml' infra/scripts/db-export.sh /root/migration`. It generates `stellytics.dump`, `umami.dump`, `fingerprint.txt` and `sha256sums` (permission 600).
4. Copy the folder to the new VPS without going through an intermediate disk, through the administrator's machine:

   ```bash
   ssh root@<old-vps> 'tar -C /root -cf - migration' | ssh root@<new-vps> 'tar -C /root -xf -'
   ```

On the **new** VPS, as root, in the checkout folder, with Postgres up and the other services stopped:

5. Bring up only the database with `docker compose -f prod.yaml up -d --wait postgres` and run `COMPOSE='docker compose --env-file .env.production -f infra/compose/prod.yaml' infra/scripts/db-import.sh --yes /root/migration`. **Before erasing anything** it checks that `sha256sums` lists `stellytics.dump` and `umami.dump` and matches, that both dumps open (`pg_restore -l`), that **no service other than Postgres is running** (it does not stop them) and that the destination has **0 tenants** (`--force-nonempty` only on purpose: without this, running the script on the source VPS by mistake would erase production). It restores into temporary databases (`stellytics_new`, `umami_new`) and only then swaps them for the real ones, reapplies `02-ingest-roles.sh` and compares the fingerprint with the source's. It only prints `OK` if it is identical; any difference aborts and you **do not bring up the application**.
6. After the `OK`, `docker compose -f prod.yaml up -d --wait`.
7. **Change the Umami `admin` password** through the tunnel (`infra/scripts/admin-tunnel.sh <new-vps-ip>`, `http://127.0.0.1:13001`): it came from the database and the old operator knows it.
8. `systemctl start stellytics-backup` (the first base backup of the new line, in the new bucket) and check with `backup-list`.
**DNS switchover** (with the new gateway already healthy by IP):

10. Point the four names (portal/alias, web ingestion and API; A and AAAA) to the IPs of the new VPS. With a TTL of 300 s the switchover takes a few minutes; Caddy issues the certificates when the names reach the new VPS.
11. Check from outside, with the commands of step 3 ("Check production") of `docs/deploy.md`; sign in to the portal with a tenant account and open a site's dashboard; open `/operator`; install the script on a test site and see the visit in the dashboard.
12. If the portal gets 401 from Umami, generate the service key again (`docs/deploy.md`, step 2, "First start") and update `UMAMI_API_KEY`.
13. **Only after validating** (steps 11 and 12), erase the **dumps** (`stellytics.dump`, `umami.dump`; they contain password hashes and sessions) from the new VPS and the old one: `rm -f /root/migration/*.dump`. Leave `fingerprint.txt` and `sha256sums` until the end of the rollback period. Until then the dumps are the fastest way to redo the migration: keep them only if the decision is explicit, and erase them at the end.

### Phase 4: afterwards (T to T+30)

1. **SCF operators:** the new operator creates its accounts (`operator:create` or `operator:promote`, with `DATABASE_URL` through the tunnel) and demotes the old ones (`operator:demote`). It decides about the SCF read keys (`/operator/api`): reissue and revoke the old ones.
2. **Rotate** what the old operator knew and that migrated: the Umami password (already done), `PORTAL_AUTH_SECRET` (drops sessions; warn users) and the SMTP credentials if they were shared. Rotate `UMAMI_APP_SECRET` only on the first day of a month (UTC): it is part of the visitor salt, so changing it mid-month inflates that month's unique visitors.
3. Monitor: the new monitoring watching the new production, `pg_stat_archiver`, `backup-list` with one backup per day.
4. **Rollback period: 30 days** (proposal). The old operator keeps the infrastructure **on, but not receiving traffic** (application stopped, DNS on the new one), and the old bucket and the old key kept.
5. At the end: the old operator erases the VPS, the monitoring host, the bucket and the credentials; **destroys the old `WALG_LIBSODIUM_KEY`** and the old `.env.production`; revokes the access it had (GitHub organization, DNS, domain).

## Communication to the tenants

Ingestion **cannot stop permanently**: third-party sites have the script installed and will not change by themselves.

| When | What to say |
|---|---|
| T-30 | Who takes over the operation, the date and time of the window, the expected duration (the rehearsal time) and what happens: portal unavailable and **events from the interval are not recovered** |
| T-30 | **What does not change:** the script host and the `src` on the pages (option A), the `v1.x` versions of the script, the `ntf_...` ingest keys, the accounts and the projects |
| T-30 | **What changes:** who the operator is, the legal entity and the privacy notice (`docs/privacy.md`); the tenants need to be informed and, if the law requires it, agree to the new DPA |
| T-1 | Reminder |
| T | Start and end of the window (a channel that does not depend on the portal) |
| T+1 | Portal back; if the portal domain changed (option C), whoever was logged in signs in again |
| Option C only | Instruction to change the script host on each site, the deadline, and the guarantee that the old host keeps serving until the deadline ends. Without the deadline being met, do **not** turn the old host off |

Neutral host decision: if option A is possible, the tenants do nothing. If the host has to change, the text above is already the communication, and the new host must be a neutral name (previous section).

## Acceptance criteria for the handover

The handover **only counts as complete when the new operator runs the system on its own**, without the old operator connected to anything. #54 closes with **all** the items below, each with a date and who did it:

1. Plan approved by both parties (this document, with the Phase 0 decisions recorded, and a new section in `docs/decisions.md` if the domain changes).
2. Repository, Renovate and GHCR in the new organization; **a release made by it**, with images signed under the new identity, and production deployed from the new repository.
3. Production on a VPS and a bucket of **its own**, with its own secrets (none shared with the old operator, except the linking ones listed above, already rotated).
4. Data migration complete with an identical fingerprint (`db-import.sh` ended with `OK`) and the check of step 11 of the window.
5. Ingestion arriving: a visit from a real tenant site shows up in the dashboard **after 7 days**, and no tenant reported loss.
6. Its daily backups in its bucket (`backup-list`) and **a restore rehearsal from it**, on a throwaway VPS, with the date recorded in `backup-and-restore.md`.
7. Its monitoring alerting by email (test alert received) and the heartbeat signal configured.
8. It executed on its own, without help: an application update (Renovate PR or its own release, `docs/deploy.md`, "Update the application"), a secret rotation (`secret-rotation.md`), the creation and demotion of an operator and the revocation of a test ingest key.
9. The old operator no longer has access to anything (checked list: GitHub, VPS provider, DNS and domain, SMTP, vault, VPS, bucket) and has destroyed the old encryption key and the dumps.
10. Documentation updated: images, contacts and repository links; `CLAUDE.md` and `docs/progress.md` record the new operator.

## Rollback plan

Until the end of the rollback period (30 days) the old operator keeps everything it needs to go back.

| At what point | How to go back |
|---|---|
| **Before the DNS switchover** (steps 1 to 8 of the window) | Aborting is safe: on the old VPS, `docker compose -f prod.yaml up -d --wait` and `systemctl start stellytics-backup.timer`. Ingestion comes back; the events from the window's interval are already lost. The data on the old VPS was not changed (`db-export.sh` only reads) |
| **After the switchover** | Point the DNS back to the old IP (TTL of 300 s) and bring up the old stack (command above). **What the new operator wrote since the switchover is lost**, unless it is brought back: stop the new application, run `db-export.sh` on it and `db-import.sh --yes` on the old one. The scripts are the same, **but this direction has not been tested** |
| **Images** | The old stack comes back with the old operator's checkout and `.env.production`; do not mix the two `.env.production` files |
| **Repository** | Transferring back is another transfer on GitHub; it does not need to be reverted to operate again |
| **Domain** | In option A, the return depends on the new operator cooperating: record in the Phase 0 agreement who decides and how quickly |

If the problem shows up after the 30 days, the rollback stops being a plan and becomes a backup restore (`docs/deploy.md`, "Restore the database").

## Data migration (tested)

Procedure for moving the `stellytics` and `umami` databases from one stack to another, with **three scripts** and a test that runs both paths end to end.

| File | Role |
|---|---|
| [`infra/scripts/db-export.sh`](../infra/scripts/db-export.sh) | At the source, with **everything stopped except Postgres**: `pg_dump -Fc` of each database, checks that the file opens, writes the fingerprint and the `sha256sums` |
| [`infra/scripts/db-import.sh`](../infra/scripts/db-import.sh) | At the destination: checks the `sha256sums`, requires the application stopped and the destination without tenants, restores into temporary databases, swaps them for the real ones, reapplies `02-ingest-roles.sh` and compares the fingerprint. **Destructive** (`--yes`) |
| [`infra/scripts/db-fingerprint.sh`](../infra/scripts/db-fingerprint.sh) | Prints, with nobody's data and no passwords, the rows and a checksum of **each table** (partitions included), the sequences, the schema hash (`pg_dump --schema-only`), the extensions, the roles, the memberships and the ACLs of the databases and the permissions of `stellytics_ingest` and `stellytics_collector` |
| [`infra/compose/test/data-migration-test.sh`](../infra/compose/test/data-migration-test.sh) | The test: brings up source and destinations with the production images (production Compose on top of `prod.yaml`), writes data, migrates and checks |

The scripts are already in the VPS checkout (`infra/scripts/`).

### Two paths

- **A. Logical (`pg_dump`/`pg_restore`), the recommended one.** It works between accounts, does not depend on the old encryption key, leaves the destination with its **own passwords, backup key and bucket** and does not carry the source's database roles (the destination creates its own). The cost is a window proportional to the size of the data.
- **B. Physical (WAL-G).** It copies the backup bucket to the new operator's and restores with `stellytics-restore` (`docs/deploy.md`, "Restore the database"). It fits if the data volume is so large that the dump does not fit in the window. It requires the **old encryption key** in the new operator's hands and **brings the source's roles, with the source's passwords** (finding below). A final base backup plus the archived WAL close the difference up to the stop.

**Steps of path B** (the ones the test executed, in order), with the destination stack **without Postgres started** and the destination's `.env` with the source's `WALG_LIBSODIUM_KEY` and the new bucket's `WALG_S3_PREFIX`:

1. Source, window open: `docker compose -f prod.yaml stop caddy portal ingest-web collector rollup umami`; `docker compose -f prod.yaml exec -T -u postgres postgres stellytics-backup`; switch the WAL segment (`select pg_switch_wal()`) and wait for `pg_stat_archiver` to archive it.
2. Copy the prefix of the old bucket to the new one (the test used `rclone sync --checksum` between two S3 endpoints and checked the count and size of the objects).
3. Destination: `docs/deploy.md`, "Restore the database", with the data folder empty (`stellytics-restore LATEST`), and bring up Postgres.
4. Align the role passwords with the destination's `.env` (finding 4 below) and reapply `02-ingest-roles.sh`.
5. Compare `db-fingerprint.sh` with the source's and bring up the application.

### What the test did

Run on 15 November 2026, on the development machine, with the production Compose and the real images: Postgres 17.11 with WAL-G 3.0.9, Umami 3.4.1 (digest from `prod.yaml`) and the portal built from this tree (migrations 0000 to 0007, the current ones). Caddy and the gateway are not included (the gateway is only a reader of `ingest_site`; see "What was not tested").

**Source** stack with real data:

- two users created through the portal's sign-up API (password with the Better Auth hash), one of them an operator, and a **session** for Alice;
- 3 tenants (`active`, `removed`, `pending`), 3 sites, 3 API services (one archived), 4 ingest keys (active, revoked, of an archived service, of a removed tenant; **only the active one** shows up in `ingest_key_active`);
- **34,567 rows** in `api_metric_1m` (4 days of 1-minute points on 3 routes and 2 statuses), plus 60 points from 40 days ago (which fall into the `default` partition, because only the current month and the next two have a partition) and 1 point in the following month; a real `api_metric_maintain` generated **576 rows in 1h and 30 in 1d**; 3 rows in the `audit_log`;
- in Umami: a site created through its API and **60 events** sent through `/api/send`, as the gateway does (18 visitors, 18 sessions). The `umami` database has 26 Prisma migrations, the `pgcrypto` extension and 27 tables.

Each **destination** stack comes up empty, with the production Compose, **different passwords and backup key** (the session secrets of the portal and of Umami are the same, on purpose).

Path **A**, as in the window: complete, empty destination stack up (the portal migrated the empty database and Umami created its schema), `db-export.sh` at the source, `db-import.sh --yes` at the destination, then the application comes up on the migrated data.

Path **B**: base backup and WAL of the source on the local S3 (SeaweedFS, the same one as the CI `infra` job), **copy of the bucket to the bucket of another S3** (rclone, with different credentials; 22 objects, 16.98 MB, same count and size on both sides), `stellytics-restore LATEST` into an empty folder, Postgres brought up, passwords adjusted, application on top.

### Results

On both paths, the destination's `db-fingerprint.sh` came out **identical to the source's**: **27 tables per database with the same row count and the same checksum** (including the 15 metric tables: the parent, the `default` with the 60 rows and the month partitions, at each of the three granularities), the Drizzle sequence (`__drizzle_migrations_id_seq` at 8), the same schema hash (10 functions, 4 triggers, 2 views, 36 inheritance links between partitions, tables and indexes, GRANTs and owners), the same extensions, the same roles and the same ACLs. The fingerprint was checked to cover **all** the tables (the test compares with `pg_class`).

Afterwards, with the application running at the destination:

- **the portal is up on the migrated database** and the **accounts keep the source's password hashes**;
- Umami (without a fork) opened the migrated database and returned **the same statistics** (`/stats`: 60 page views, 18 visitors), and the `admin` login migrated along;
- the **original ingest key** (SHA-256 of 32 bytes) is still accepted by `ingest_key_active`, and the other three stay out of it;
- the `audit_log` **is still insert-only**: `UPDATE`, `DELETE` and `TRUNCATE` are refused by the triggers and `INSERT` passes;
- `stellytics_ingest` and `stellytics_collector` **connect over the network with the new passwords** and read only `ingest_site` and `ingest_key_active`; `stellytics_ingest` does **not** read `tenant`; `stellytics_collector` inserts into `api_metric_1m`;
- `api_metric_ensure_partitions(2)` runs, and the partitions exist;
- `db-import.sh` **refuses**, without touching the destination's databases (same OIDs before and after), each of these cases: application running, tampered dump, truncated dump with a regenerated `sha256sums`, `sha256sums` without the dumps, and the source itself as the destination (it has tenants).

**Times** (a development machine, small data: `stellytics.dump` with 224 KB and `umami.dump` with 68 KB; **do not extrapolate to real data**):

| Step | Time |
|---|---|
| Empty destination up (Postgres, portal and Umami starting and migrating) | 32 s |
| A: `db-export.sh` (two dumps + fingerprint) | 2 to 6 s |
| A: `db-import.sh` (checks, recreates, restores, fingerprint) | 2 to 7 s |
| A: application up on the migrated data | 17 s |
| B: final base backup and last WAL at the source | 4 to 8 s (the first time, 63 s) |
| B: copy of the bucket between two S3 (17 MB) | 6 to 13 s |
| B: `stellytics-restore LATEST` and Postgres applying the WAL and opening | 1 s and 11 to 12 s |
| B: application up on the restored data | 18 to 23 s |

### What went wrong, and what changed in the procedure

1. **`pg_dump --schema-only` never gives the same hash twice.** `pg_dump` 17 writes a `\restrict <random token>` line (and `\unrestrict`) in every output. The first schema comparison failed on both databases because of that **alone** (checked with a `diff` of the two schemas). `db-fingerprint.sh` now strips those lines.
2. **The fingerprint only checked the first table.** `docker compose exec -T` reads standard input and, inside `while read`, it swallowed the list of tables; the test passed with the destination "identical" while looking at one table per database. Fixed (`< /dev/null`), and the test now **compares the number of tables in the fingerprint with that of `pg_class`** so that this does not come back silently. **The results above are from the run after the fix.**
3. **The database password cannot be tested from inside the Postgres container.** In the official image, the local socket and `127.0.0.1` are `trust`: any password gets in. The first version of the test "proved" the passwords that way, proving nothing. Now the test connects **over the Compose network**, from a separate container (`pg_net`).
4. **Finding on path B: the role passwords come from the source.** The physical restore brings the whole catalog, including the password hashes of `postgres`, `stellytics`, `umami`, `stellytics_ingest` and `stellytics_collector`. With the destination's `.env` (different passwords), the test confirmed that **`stellytics` cannot connect** with the destination's password. The path B procedure gained the alignment step: `ALTER ROLE postgres|stellytics|umami PASSWORD '<from the .env>'` (reading the password without echo, as in `secret-rotation.md`) and reapplying `02-ingest-roles.sh`. That is what the test did, and the fingerprint passed after that. If the destination reused the same passwords as the source, the step would not be needed; but then the old passwords would stay with the new operator.
5. **What does not go in the dump, by construction, and how the procedure covers it:**
   - **roles and passwords:** `pg_dump` does not carry them; the destination creates them in the init scripts (`01` and `02`) with its own passwords;
   - **`CONNECT` permission on the databases** (`stellytics_ingest` and `stellytics_collector`): it is a database ACL, does not go in the dump and vanishes on `DROP`/`CREATE DATABASE`; that is why `db-import.sh` reapplies `02-ingest-roles.sh` (idempotent) and the fingerprint compares the database ACL. The failure without this reapplication was not observed; it is by construction;
   - **extensions:** they go in the dump (Umami's `pgcrypto`) and the restore recreates them as superuser (`postgres`); it worked;
   - **sequences:** only the Drizzle one exists in the two databases (the IDs are `uuid`), and the value migrated;
   - **the Drizzle journal** (`drizzle.__drizzle_migrations`, 8 rows) comes in the `stellytics` dump: the new portal does not reapply migrations (the portal log says only "migrations applied" at startup);
   - **TLS certificates** (`/srv/stellytics/caddy`): they are not migrated; Caddy on the new VPS issues certificates automatically after the DNS switchover;
   - **WAL-G backup history and Prometheus data:** they do not migrate; the destination starts new lines (`systemctl start stellytics-backup` after the migration).
6. **Destination version.** `db-import.sh` checks the fingerprint **before** the application comes up, so it only matches if the destination restored exactly what the source had. If the destination's images are **newer** and bring a migration, the portal applies it at startup (normal `RUN_MIGRATIONS` behavior; **not tested in the migration**). Never bring up a version **older** than the source's on the data: migrations only move forward (`docs/deploy.md`, "Update the application").
7. **The destination must be empty of data, not of structure.** If `deploy.sh` has already brought up the portal and Umami, they created empty tables, and the restore would collide with them (not attempted). That is why `db-import.sh` requires the application stopped, restores into temporary databases and swaps them for the real ones (it is the tested path). It **refuses** a destination with tenants (the source, for example) without `--force-nonempty`; with the option, it erases that data: check the host first.
8. **Failures and re-running.** `db-import.sh` can be run again. A failure **before** the swap (checksum that does not match, dump that does not open, restore that fails, application running, destination not empty) leaves the destination **as it was** (tested: the databases' OIDs do not change). A failure **after** the swap (different fingerprint) leaves the destination with the restored data and **the application stopped**: investigate or run it again; do not bring up the application. If `db-import.sh` is forcibly interrupted (machine crash) midway, `stellytics_new` or `umami_new` may be left over, and the next run erases them.
9. **`sha256sums` proves integrity, not authenticity.** Whoever can alter the folder can also alter the checksum; authenticity comes from the channel (ssh between the two VPSs, through the administrator's machine). `db-export.sh` refuses an output folder that is not empty: after an interrupted export, erase the partial folder (`rm -rf`) before repeating.

### Re-running the test

From the repository root, with the portal image built and Docker with Compose v2:

```bash
docker compose build portal   # or the image of a release
PORTAL_IMAGE=stellytics-portal:dev infra/compose/test/data-migration-test.sh
```

It runs the source and the two destinations side by side (project names `stellytics54-*`, loopback ports `13541`–`13543`, `18333`–`18335` and `13641`–`13643`; change them with `PORT_BASE` and `S3_BASE`), tears everything down and erases the volumes at the end. `MODE=logical` or `MODE=physical` runs only one path; `KEEP=1` does not tear down. The test uses container images pulled on the spot (`rclone/rclone`, `alpine`) and **is not in CI** (it takes a few minutes and needs the portal image): wiring it into the `infra` job is a next step.

## What was not tested

The criterion "data migration procedure tested" holds **only for what is listed in "What the test did"**. Not executed:

- **Real transfer of repository, organization, GHCR packages, Renovate, domain, DNS, accounts, SMTP and VPS provider.** The GitHub behaviors described here (redirect, what the transfer carries and does not carry, visibility of the new packages) follow the documentation of those tools and may be wrong or may have changed; **check when doing it**.
- **`cosign verify` against real images with the new identity.** No release has been published anywhere yet.
- **`init.sh`, `deploy.sh` and certificate issuance** on a real VPS.
- **WAL-G restore against a real S3 bucket.** Path B used a local S3 (SeaweedFS).
- **Real data volume.** Umami had **60 events** and the API metrics 34,567 rows. Dump, restore and copy time and disk usage with millions of events **were not measured**, and `db-fingerprint.sh` aggregates the text of each table's rows inside Postgres, which can get heavy on large tables (the hash is per row, but it walks through everything).
- **Changing `portal_auth_secret` or `umami_app_secret` at the destination.** The test used the same values (the old session staying valid depends on that). The effect of changing them, including on Umami's visitor IDs, **was not measured**.
- **The Umami API key** (`umami_api_key`): the test did not create the service account, so it is not known whether the key survives the migration.
- **Caddy on the host and the gateway `ingest-web` and collector/`rollup` services** as services. The gateway did not come up; what it reads (the `ingest_site` view, as `stellytics_ingest`) was checked through SQL. The collector and the `rollup` are not in production; their tables and functions migrated (partitions, `api_metric_ensure_partitions`, GRANT of `stellytics_collector`).
- **The rollback** (`db-export.sh` on the new stack and `db-import.sh` on the old one), option C of the domain and the Caddy aliases it requires.
- **Postgres major version** difference between source and destination (the test uses 17.11 on both sides).
- **The real time and losses of the window**, and DNS propagation.
- **The communication to the tenants** and the legal aspects (DPA, legal entity, sub-processors): it is proposed text, not validated.
