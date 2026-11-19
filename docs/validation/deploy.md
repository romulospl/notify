# Validation script for the deploy guide (#42)

This script has not been run yet. It was written from [`docs/deploy.md`](../deploy.md) after the move to a single VPS ([ADR 0016](../adr/0016-producao-em-vps.md)), issue #42 and the repository. Its companion for the onboarding guide is [`onboarding-de-tenant.md`](onboarding-de-tenant.md).

## What it is for

Issue [#42](https://github.com/romulospl/stellytics/issues/42) has two acceptance criteria:

1. Document region, prerequisites, secrets configuration, DNS, TLS, backup, restore and monitoring.
2. "An operator who did not write the guide can deploy the application and verify ingestion, dashboards and alerts by following the document."

The first is a reading check (the guide has a section for each item). The second needs someone outside to run it. This script is what that person fills in, and the report in section 7 is the evidence that stays in the repository.

Section references below point to the sections of the guide: What you need, 1. Install, 2. First start, 3. Check production, Update the application, Backup, Restore the database and Monitoring.

## 1. Rules for running it

1. The operator must **not have written the guide** and must not work on the project. They follow **only the guide**. The observer takes notes and does not explain or fix anything live. Any help is recorded (step, what was said, how long it took).
2. Record the **guide commit** (`git rev-parse HEAD`) and the exact repository or fork used. The result only holds for that version.
3. Mark each step: **OK** (no help), **OK with help** (becomes a finding), **Failed** (could not do it even with help) or **N/A**.
4. Note the **UTC time** of each step and of each wait (certificate, image build, first start, data in the dashboard, alert email). The guide gives few time limits; the script measures them.
5. **Secrets stay out of the report.** Never paste `.env.production`, `monitoring.env`, access keys, passwords, `WALG_LIBSODIUM_KEY`, the Umami API key or ingest keys. Mask IPs and domains unless the operator agrees to publish them.
6. Steps marked ● are **required**; the rest are optional.
7. **Cost and cleanup.** The run needs a VPS, a second small host for monitoring and an S3-compatible bucket. Use throwaway hosts and a throwaway bucket, and note what was created. The guide does not describe teardown; step D24 records how the operator handled it.
8. **Destructive steps** are marked "(disruptive)". They stop a service or touch data. Run them only on the new, empty deploy, never on a real production.

## 2. Before starting (for whoever runs the script)

| Item | Value |
|---|---|
| Guide commit and repository or fork | |
| Operator (role and experience, no name if they prefer) | |
| VPS provider, plan and region | |
| Monitoring host provider and region | |
| Bucket provider and region | |
| Domain and DNS provider | |
| SMTP provider | |
| Start date and time (UTC) | |

## 3. Steps

| ID | What to do (guide section) | Expected result | Result | Notes and time (UTC) |
|---|---|---|---|---|
| D1 ● | Read "What you need" and prepare everything: VPS with root and ports 22, 80 and 443 only, four DNS names, S3-compatible bucket and key, real SMTP, monitoring host | Nothing missing on the list; note anything the operator had to guess (for example what `PORTAL_ALIAS_HOST` is) | | |
| D2 ● | Create the four DNS records (A and, if available, AAAA) pointing to the VPS (What you need) | The four names resolve to the VPS | | |
| D3 ● | Clone the repository on the VPS and run `sudo ./init.sh` (1. Install) | Docker and Compose installed; `.env.production` created with random secrets and mode `0600` | | |
| D4 ● | Fill in `.env.production`: the four hosts, `ACME_EMAIL`, `SMTP_URL`, `MAIL_FROM` and the `WALG_S3_*` bucket values (1. Install) | The operator knows the `SMTP_URL` format and URL-encodes special characters in the password | | |
| D5 ● | Copy `WALG_LIBSODIUM_KEY` to a vault outside the VPS (1. Install) | The operator understands that no backup can be restored without it | | |
| D6 ● | `sudo ./deploy.sh`. Note the build time (1. Install) | Images built, stack up, backup timer installed | | |
| D7 ● | Open the tunnel with `infra/scripts/admin-tunnel.sh <vps-ip>` and change the Umami password (2. First start, item 1) | The operator understands where each command runs (own machine vs VPS) and that the tunnel logs in as `root` | | |
| D8 ● | Create the Umami service account key with Node 24, put it in `UMAMI_API_KEY`, run `sudo ./deploy.sh` again (2. First start, item 2) | The script prints the key once; the portal can create sites. Note whether `pnpm install` was needed first | | |
| D9 ● | Create the first SCF operator with `operator:create` through the tunnel (2. First start, item 3) | Operator account exists with a confirmed e-mail | | |
| D10 ● | First base backup: `systemctl start stellytics-backup`, then list it (2. First start, item 4; Backup) | `wal-g backup-list` shows one backup | | |
| D11 ● | Run the `curl` block from any machine (3. Check production) | portal `{"ok":true}`; gateway `/healthz` ok; `/c` returns a challenge; `/api/send` 404; `POST /v1/metrics` without a key 401 | | |
| D12 ● | Run the `nc` block from outside the VPS (3. Check production) | 443 open; 5432 closed | | |
| D13 ● | On the VPS: `compose ps`, `compose port postgres 5432`, `systemctl list-timers stellytics-backup.timer` (3. Check production) | All services running; Postgres on `127.0.0.1` only; timer listed | | |
| D14 ● | TLS: open the four hostnames in a browser | Valid certificates for all four; the alias leads to the portal | | |
| D15 ● | Browser test: sign up, confirm the e-mail, create the project, register a site (3. Check production, item 1) | Confirmation e-mail arrives; project and site created. If the e-mail does not arrive, the guide points to `SMTP_URL`/`MAIL_FROM` and the portal logs | | |
| D16 ● | Install the script on a test page and visit it; look at the site dashboard (3. Check production, item 2) | Visit shows in the dashboard "within minutes"; note the time | | |
| D17 ● | Sign in as the operator at `/operator` (3. Check production, item 3) | The project from D15 is listed | | |
| D18 ● | Create a service and an ingest key, send OTLP metrics to `https://<api_host>`, look at the service dashboard (3. Check production, item 4; `examples/api-backend/README.md`) | Requests show within 1 to 2 minutes | | |
| D19 ● | Monitoring: on the second host, create `monitoring.env`, run `configure.sh` and `docker compose up -d --wait`, then check `probe_success` through the SSH tunnel (Monitoring) | `probe_success` equals 1 for portal, gateway and API ingestion | | |
| D20 ● | Alerts (disruptive, only on the new empty deploy): stop `ingest-web` for about 2 minutes, wait for the `EndpointDown` e-mail, start it again | E-mail arrives; service recovers; note the delay | | |
| D21 | Dead-man URL: set `DEADMAN_URL` (Monitoring, item 2) | The operator understands why it is recommended | | |
| D22 | Restore rehearsal on the new, empty deploy, following "Restore the database" (disruptive) | Database restored; the account and site from D15 still exist; note the time | | |
| D23 | Update and rollback: base backup, `git pull` or a newer tag, `sudo ./deploy.sh`, repeat step 3; then roll back (Update the application) | Containers recreated; rollback restores code but not the database, as the guide warns | | |
| D24 | Teardown: how did the operator remove the VPS, the monitoring host, the bucket and the DNS records? | Record what they did; the guide has no teardown steps, so note whether that is a finding | | |

## 4. Checks at the end

| ID | What to check | Expected result | Result | Notes |
|---|---|---|---|---|
| E1 ● | Data residency: where do the data live? (What you need) | The VPS and bucket regions, which the operator can name and declare ([`privacidade.md`](../privacidade.md)) | | |
| E2 ● | Secrets: is any secret in a file tracked by git? (`git status` on the VPS and the monitoring host) | `.env.production` and `monitoring.env` are not tracked | | |
| E3 | Terms: list every word, acronym or tool the operator did not understand | A list, even if empty | | |
| E4 | Dashboards: the operator checked the tenant dashboards (site and service) and the operator view | They show the data from D16 and D18 | | |

## 5. Total time and effort

Record the time from "started reading" to the first dashboard data, hands-on time vs waiting time, the number of times the operator left the guide (search, asking someone), and what they searched for.

## 6. Gaps to watch

Not confirmed, from reading the guide:

- D8: whether `pnpm --filter … umami:service-account` works in a fresh clone without `pnpm install`.
- D7 and D9: the tunnel logs in as `root`; the guide has no fallback when root SSH login is disabled.
- D24: the guide has no teardown steps.

## 7. Report template

Copy to `docs/validation/reports/deploy-<YYYY-MM-DD>.md` or to a comment on issue #42. Fill in only what the operator agreed to publish.

```markdown
# Validation report: deploy

- Guide validated: commit <sha> of docs/deploy.md, repository or fork <name>
- Script: commit <sha> of docs/validation/deploy.md
- Operator: <role and experience, or "anonymous">
- VPS, monitoring host and bucket: <providers, plans and regions>
- Period: <start UTC> to <end UTC>
- Observer: <name>

## Result

| Required steps | OK | OK with help | Failed |
|---|---|---|---|
| D1 to D20, plus E1 and E2 | n | n | n |

Conclusion: validated | validated with caveats | not validated
Total time until the first dashboard data: <hh:mm>

## Steps

(Paste the filled step table, without secrets, IPs or domains.)

## Findings in the guide

| # | Step | Guide excerpt | Problem | Severity (high, medium, low) | Proposed fix |
|---|---|---|---|---|---|

## Help received

| Step | What the operator asked | What was answered | Already in the guide? |
|---|---|---|---|

## Evidence

- Output of the `curl` and `nc` checks, with domains and IPs masked
- Screenshot of a tenant dashboard with the test visit and of the service dashboard with the test requests
- Screenshot or text of the `EndpointDown` alert e-mail, headers masked
- `wal-g backup-list` output
- Information the operator agreed to publish: <list>

## Operator's opinion

- Guide clarity, from 1 to 5:
- Where they got stuck or doubtful:
- A term they did not understand:
- What was missing:
- What they would not do alone in production:
```

## 8. How the result feeds the #42 criterion

Proposal, for the maintainers to confirm:

1. The second criterion counts as met when there is at least one report with every required step (●) marked **OK**, including the alert test (D20).
2. A step marked **OK with help** counts as a guide failure: it becomes a finding, a fix PR, and the step is repeated before it counts.
3. Reports stay in the repository, so #42 and epic #7 can point to the evidence.

## 9. Known limits

- No step has been executed. The "expected results" come from the text of the guide and the files; the guide's own "How this guide was checked" section lists what was never run on a real VPS (`init.sh`, `deploy.sh`, certificate issuance, e-mail delivery, backup to a real bucket).
