# Validation report: deploy (simulation)

> **This is a simulation, not the outside-operator run that #42 asks for.** The script was run by an AI agent (Claude Code) on throwaway virtual machines on a laptop, with local stand-ins for DNS, certificates, SMTP and S3. The agent did not write `docs/deploy.md`, but it has worked on this repository, so it is not an independent operator (rule 1 of the script). Use it as evidence that the guide and the scripts work end to end, not as the report that closes the second criterion of #42.

- Guide validated: commit `ca28e07` of `docs/deploy.md`, repository `romulospl/stellytics` (local clone of `main`)
- Script: commit `ca28e07` of `docs/validation/deploy.md`
- Operator: AI agent (Claude Code), supervised by the maintainer; knows the repository
- VPS, monitoring host and bucket: three OrbStack Debian 12 (bookworm) arm64 machines on one macOS laptop: `vps` (production), `mon` (monitoring) and `ext` (stand-in providers: Mailpit as SMTP, SeaweedFS 4.48 as S3, a small HTTP receiver as heartbeat service)
- Period: 2026-11-19 22:35 UTC to 22:58 UTC
- Observer: none (the agent logged its own steps)

## What was simulated

| Real requirement | Stand-in | Effect on the result |
|---|---|---|
| Public DNS (D2) | `/etc/hosts` on the outside machine; `extra_hosts` for the blackbox container | DNS setup is not validated |
| Let's Encrypt certificates (D14) | `*.internal` hostnames, so Caddy issued certificates from its internal CA without changing the Caddyfile; the monitor trusted that CA through `SSL_CERT_FILE` in a `compose.override.yaml` | Certificate issuance by ACME is not validated |
| Real SMTP provider (D15, D20) | Mailpit, `SMTP_URL=smtp://<ext>:1025`, `SMTP_REQUIRE_TLS=false` on the monitor | Delivery, SPF, DKIM and DMARC are not validated |
| S3-compatible bucket at a provider | SeaweedFS on the outside machine, path style, HTTP | Backup to a real provider is not validated |
| Provider firewall | None; only Caddy publishes ports, so only 80 and 443 answered | The firewall itself is not validated |
| Browser on the internet | Chromium (Playwright) going out through a SOCKS tunnel via the outside machine; the test page was served on `localhost` | None for the product flow |
| SSH as root (D7) | OrbStack's SSH proxy (`root@vps@orb`); `admin-tunnel.sh` worked unchanged with that host | No fallback for disabled root login was tested |

## Result

| Required steps | OK | OK with help | Failed | Simulated only |
|---|---|---|---|---|
| D1 to D20, plus E1 and E2 | 18 | 2 (D9, D19) | 0 | 2 (D2, D14) |

Conclusion: **validated with caveats, as a simulation.** Every required step that could run locally passed; two needed a workaround that the guide does not give (findings 1 and 2). Under section 8 of the script this does not meet the criterion: D2 and D14 were not real and the operator was not independent.

Total time until the first dashboard data: **13 min** (machines created at 22:35, visit on the site dashboard at 22:48). Build and first start (`deploy.sh`): 2 min 2 s.

## Steps

| ID | Result | Notes and time (UTC) |
|---|---|---|
| D1 ● | OK | Everything on the list prepared with stand-ins (see above). Nothing had to be guessed. |
| D2 ● | Simulated | `/etc/hosts` mapping of the four names. |
| D3 ● | OK | 22:39. `git` was not installed on the fresh Debian image; installed before cloning. `init.sh` took 10 s; `.env.production` created with mode `0600`. |
| D4 ● | OK | Hosts, `ACME_EMAIL`, `SMTP_URL`, `MAIL_FROM` and `WALG_S3_*` filled in. |
| D5 ● | OK | `WALG_LIBSODIUM_KEY` copied to a `0600` file outside the VPS (stand-in for the vault), deleted at teardown. |
| D6 ● | OK | 22:39:57 to 22:42:02 (2 min 2 s). Images built, all services healthy, `stellytics-backup.timer` and `stellytics-check.timer` installed, first base backup started in the background. |
| D7 ● | OK | Tunnel opened with `infra/scripts/admin-tunnel.sh`; Umami password changed; the old password then returned 401. |
| D8 ● | OK | `umami:service-account` printed the key once; `deploy.sh` again took 8 s and the portal came back with the key. The script also works in a fresh clone without `pnpm install` (gap in section 6 answered). Sites were created later through the portal, so the key works. |
| D9 ● | OK with help | `operator:create` fails in a fresh clone without `pnpm install` (`Cannot find package 'better-auth'`). Ran from a clone with dependencies installed. Finding 1. |
| D10 ● | OK | `wal-g backup-list` showed `base_000000010000000000000003` at 22:42:00, started by `deploy.sh`. |
| D11 ● | OK | From the outside machine: portal `{"ok":true}`; `/healthz` `ok`; `/healthz/stack` `ok` (200); `/c` returned a challenge with `"d":12`; `/api/send` 404; `POST /v1/metrics` without a key 401. |
| D12 ● | OK | 443 and 80 open; 5432, 3000, 8080 and 4318 refused. |
| D13 ● | OK | All seven services up (six with a healthcheck, all healthy); `compose port postgres 5432` showed `127.0.0.1:5432`; both timers listed; `journalctl -u stellytics-check` printed `stack ok`. |
| D14 ● | Simulated | One certificate per name, issued by "Caddy Local Authority". The alias answered 301 to the portal and port 80 answered 308 to HTTPS. |
| D15 ● | OK | 22:48:19. Sign-up, the confirmation e-mail arrived in under 1 s with a link to the portal host, then the project and the site were created. The site page showed the `v1.5.0` script tag with SRI ready to copy. |
| D16 ● | OK | The copied tag was put on two pages and visited at 22:48:46; at 22:48:57 the site dashboard showed 2 page views and 1 visitor. |
| D17 ● | OK | `/operator` listed "1 project, 1 active", with 1 member, 1 website, 1 API service and 1 active key. |
| D18 ● | OK | Service and ingest key created in `/services`; an OTLP/HTTP `http.server.request.duration` histogram sent at 22:50:00; at 22:50:07 the service dashboard showed 55 requests, 5.5% 5xx, p50 38 ms and p95 49 ms, routes `GET /accounts/{id}` and `GET /ledgers`. |
| D19 ● | OK with help | With `umask 077` (used to create `monitoring.env` as `0600`), Alertmanager crash-looped with `permission denied` on `alertmanager.yml`. Regenerated with umask 022, the stack was healthy in 11 s. `probe_success` was 1 for portal, ingest-web, ingest-api (HTTP 401) and stack. Finding 2. Local ports 9090 and 9093 were taken, so the tunnel used 19090 and 19093. |
| D20 ● | OK | `ingest-web` stopped at 22:51:32; `[FIRING:1] EndpointDown ingest-web` e-mail at 22:53:20 (111 s); started again; `[RESOLVED]` e-mail 56 s later. |
| D21 | OK | `DEADMAN_URL` set, `configure.sh` and `SIGHUP` run as the guide says; the Watchdog webhook arrived immediately. |
| D22 | OK | 22:54:46 to 22:55:23 (37 s), the guide's commands verbatim. The account, site and service created after the base backup were restored (WAL replay; timeline 2); a new base backup was taken; both dashboards showed the same data. No alert fired (the outage was shorter than 1 minute). |
| D23 | OK | Base backup (2 s), checkout of the previous commit `4bac25f` and `deploy.sh` (12 s), then back to `main` and `deploy.sh` (9 s). Portal and gateway 200 after each. Finding 5 on the rollback. |
| D24 | Done | The three machines and the temporary secrets were deleted. The guide has no teardown section. Finding 4. |

## Checks at the end

| ID | Result | Notes |
|---|---|---|
| E1 ● | OK | In the simulation all data stayed on the laptop. The production declaration is in `docs/privacy.md` (section 6). |
| E2 ● | OK | `git status` clean on the VPS; `.env.production` ignored by `.gitignore`. On the monitor, `monitoring.env` was outside the repository. Generated monitor files are untracked but not ignored (finding 3). |
| E3 | Empty | The agent knew every term. |
| E4 | OK | Site dashboard (2 page views), service dashboard (55 requests) and operator view checked, before and after the restore. |

## Findings in the guide

| # | Step | Guide excerpt | Problem | Severity | Proposed fix |
|---|---|---|---|---|---|
| 1 | D9 | "In a clone with Node 24, with the tunnel open" | `operator:create` imports `better-auth` and `postgres`, so it fails in a fresh clone without `pnpm install`. `umami:service-account` has no dependencies and works. | Medium | Add `pnpm install --frozen-lockfile` (Node 24 and pnpm from `corepack enable`) before the two commands in "2. First start". |
| 2 | D19 | "Create `monitoring.env` (mode `0600`, outside git)" / `configure.sh` | `configure.sh` writes the Prometheus targets and `alertmanager.yml` with the caller's umask. With `umask 077` (a common hardening, and an easy way to get the `0600` the guide asks for) Alertmanager, which runs as `nobody`, cannot read `alertmanager.yml` and crash-loops. The targets file was also `0600` in a `0700` folder, so Prometheus (also `nobody`) would not read it either; that part was not observed, because the stack was regenerated first. | Medium | In `configure.sh`, `chmod` the generated config explicitly (`a+rX` on `prometheus/targets` and `alertmanager.yml`), as it already does for `secrets/`. |
| 3 | E2 | Monitoring, step 3 | `configure.sh` writes `alertmanager/secrets/smtp_password` and `deadman_url` inside the clone, and they are not in `.gitignore`. A `git add -A` on the monitor host would commit the SMTP password. | Low | Add `infra/monitoring/alertmanager/` and `infra/monitoring/prometheus/targets/` (except a placeholder) to `.gitignore`. |
| 4 | D24 | (none) | No teardown steps. The script already expected this. | Low | A short "Remove a deployment" section: back up if needed, `compose down` (never `-v` unless you mean it), delete the VPS, monitor host, bucket and DNS records, and revoke the SMTP and bucket keys. |
| 5 | D23 | "Rollback. Check out the previous version and run `deploy.sh` again." | Rolling back to a version older than #172 leaves `stellytics-check.timer` installed, calling a script the old checkout does not have; `/healthz/stack` answers 404, so `StackUnhealthy` would fire after 5 minutes. | Low | One sentence in "Rollback": units installed by a newer `deploy.sh` stay; disable them (`systemctl disable --now stellytics-check.timer`) when going back past the version that added them. |
| 6 | D3, monitoring step 1 | "On the VPS, in a clone of the repository" / "Install Docker on the monitoring host" | A minimal Debian image has no `git`. Debian's own `docker.io` package does not include `docker compose`, which step 3 of Monitoring needs. | Low | Say "install `git`" in "What you need", and point the monitor host to Docker's repository (the same one `init.sh` uses). |

All six findings were fixed after this run. Finding 1 was fixed in #176, which a separate team rehearsal produced; the rest in the same change as this report: `docs/deploy.md` (findings 4, 5 and 6, and a note on finding 3), `infra/monitoring/configure.sh` with a check in `infra/monitoring/test/monitoring-test.sh` (finding 2) and `.gitignore` (finding 3). The fixes were not re-run on virtual machines.

Not in the guide, noted for the maintainers: `init.sh`, `deploy.sh`, `umami-service-account.mjs` and `operator.mjs` print messages in Portuguese, and the project has been English-only since 2026-11-19.

## Help received

| Step | What the operator needed | What was done | Already in the guide? |
|---|---|---|---|
| D9 | Dependencies for `operator:create` | Ran from a clone with `pnpm install` done | No (finding 1) |
| D19 | Alertmanager could not read its config | Regenerated with umask 022 | No (finding 2) |

## Evidence

Kept by the agent outside the repository (screenshots of the sign-up, site, site dashboard, operator view and service dashboard). Text evidence is in the step table above. No secret, key or password is in this report; the hosts were throwaway machines that no longer exist.

## Section 6 gaps answered

- D8: `umami:service-account` works in a fresh clone without `pnpm install`; `operator:create` does not (finding 1).
- D7 and D9: not answered; the simulation logged in as root through OrbStack.
- D24: confirmed, no teardown steps (finding 4).

## What a real run still has to show

D2 (real DNS), D14 (Let's Encrypt certificates), real SMTP delivery of the confirmation and alert e-mails, backup and restore against the real bucket, the provider firewall, and an operator from outside the team (rule 1).
