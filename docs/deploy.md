# Production deployment

Production is one Debian or Ubuntu VPS running Docker Compose ([ADR 0016](adr/0016-production-on-a-vps.md)): Caddy, portal, web ingestion gateway, API collector, rollup job, Umami and Postgres with continuous encrypted backup, plus external monitoring on a second host. Files are in [`infra/`](../infra/README.md).

> **Status.** [#42](https://github.com/romulospl/stellytics/issues/42) is closed: the guide was followed end to end on 2026-11-19 with local stand-ins for DNS, certificates, SMTP and S3 (see "How this guide was checked"). Not yet done: a run on a real account by an operator from outside the team, and the backup of the current production ([#182](https://github.com/romulospl/stellytics/issues/182)).

## What you need

- A VPS with root access, reachable on ports 22, 80 and 443 only (set the firewall at the provider). Keep `/srv/stellytics` (`STELLYTICS_DATA_DIR`) on a disk that survives the VPS if the provider offers one.
- Four DNS names pointing to the VPS (A and, if available, AAAA): `PORTAL_HOST`, `PORTAL_ALIAS_HOST`, `INGEST_HOST` and `API_HOST`.
- An S3-compatible bucket for the Postgres backup, with an access key that can read and write it.
- A real SMTP service for sign-up confirmation and password reset (SPF, DKIM and DMARC of the `MAIL_FROM` domain are up to you).
- A second, small host for monitoring, ideally with another provider or region.
- `git` on both hosts, to clone the repository (minimal Debian images do not include it: `apt-get install -y git`).
- On your own machine, for the first start: SSH, `git`, Node 24 and pnpm (`corepack enable` picks the version pinned in `package.json`).

The VPS and bucket region is the data residency that must be declared ([`privacy.md`](privacy.md)).

## 1. Install

On the VPS, in a clone of the repository:

```bash
sudo ./init.sh
sudo nano .env.production
sudo ./deploy.sh
```

- `init.sh` installs Docker and Compose from Docker's repository, applies the Docker settings the stack needs (`userland-proxy` off, so Caddy sees the real client IP) and creates `.env.production` with random secrets and mode `0600`.
- In `.env.production`, fill in the four hosts, `ACME_EMAIL`, `SMTP_URL`, `MAIL_FROM` and the backup bucket (`WALG_S3_PREFIX`, `WALG_S3_ENDPOINT`, `WALG_S3_REGION`, `WALG_S3_ACCESS_KEY`, `WALG_S3_SECRET_KEY`). Do not change the generated secrets. URL-encode special characters in the SMTP password.
- **Copy `WALG_LIBSODIUM_KEY` to the team's password vault, outside the VPS.** Without it no backup can be restored, and it cannot be rotated.
- `deploy.sh` validates the file, builds the portal, gateway, collector and rollup images from the checkout, starts [`infra/compose/prod.yaml`](../infra/compose/prod.yaml) and installs the daily backup timer. Postgres, Umami and Caddy use pinned images. To run the signed release images instead, set all four of `PORTAL_IMAGE`, `INGEST_WEB_IMAGE`, `COLLECTOR_IMAGE` and `ROLLUP_IMAGE` to their digests: `deploy.sh` pulls those instead of building them (Postgres is still built). It does not verify signatures, so run `cosign verify` yourself first ([`release.yml`](../.github/workflows/release.yml)).

Only Caddy publishes ports. Postgres listens on loopback only and Umami only on the internal network. `docker compose down` keeps the data; never use `down -v`.

In the commands below, `compose` means, from the repository root:

```bash
docker compose --env-file .env.production -f infra/compose/prod.yaml
```

## 2. First start

1. Open a tunnel to Umami and change its initial password (`admin`/`umami`): run `infra/scripts/admin-tunnel.sh <vps-ip>` on your machine, sign in at `http://127.0.0.1:13001` and change the password in the Umami profile settings. Keep the tunnel open for items 2 and 3.

   The script signs in as `root`. If root SSH login is disabled on the VPS, open the same tunnel as your own user (port forwarding does not need root):

   ```bash
   ssh -N -L 127.0.0.1:15432:127.0.0.1:5432 -L 127.0.0.1:13001:172.30.0.20:3000 <user>@<vps-ip>
   ```
2. Create the Umami service account key so the portal can create sites. In a clone with Node 24 on your machine (not the VPS), with the tunnel open:

   ```bash
   corepack enable && pnpm install --frozen-lockfile   # once per clone; this step and the next need it
   read -rs UMAMI_ADMIN_PASSWORD && export UMAMI_ADMIN_PASSWORD
   UMAMI_URL=http://127.0.0.1:13001 pnpm --filter @stellytics/portal umami:service-account
   ```

   The script prints the key once. Put it in `UMAMI_API_KEY` in `.env.production` and run `sudo ./deploy.sh` again.
3. Create the first SCF operator (global view; email already confirmed), with the tunnel open (Postgres at `127.0.0.1:15432`):

   ```bash
   read -rs OPERATOR_PASSWORD && export OPERATOR_PASSWORD   # at least 12 characters
   DATABASE_URL='postgresql://stellytics:<STELLYTICS_DB_PASSWORD>@127.0.0.1:15432/stellytics' \
     pnpm --filter @stellytics/portal operator:create --email <email> --name "<name>"
   ```

   Further operators get an invite (ADR 0017). On the server, from the repository folder:

   ```bash
   sudo ./operator.sh invite
   ```

   It runs the admin command inside the portal container, which already has the database, SMTP and portal address, so there is no tunnel and no secret leaves the server. It asks for the email twice and emails a link valid for 3 days; the invited person picks their own name and password at `/invite/...`. `operator.sh list` shows operators and pending invites, `operator.sh uninvite --email <email>` cancels one, `operator.sh demote --email <email>` removes the role, and `operator.sh promote --email <email>` still works for an existing account without a project. The portal has no screen for any of this (D3): whoever can SSH into the server with sudo controls who is an operator, so give each person their own SSH key and remove the key to remove the person.
4. The first base backup starts by itself: when the bucket has none, `deploy.sh` starts `stellytics-backup` in the background. If it cannot list the backups within 2 minutes, it stops with an error after the stack is up: check `WALG_S3_*` and run it again. Check the backup with `docker compose --env-file .env.production -f infra/compose/prod.yaml exec -T -u postgres postgres wal-g backup-list`.

## 3. Check production

From any machine, without logging in:

```bash
curl -fsS https://<portal_host>/api/auth/ok            # portal: {"ok":true}
curl -fsS https://<ingest_host>/healthz                # gateway: ok (503 when Postgres or Umami is down)
curl -fsS https://<ingest_host>/healthz/stack          # stack check: ok (503 until the first base backup exists)
curl -fsS "https://<ingest_host>/c?s=00000000-0000-4000-8000-000000000000"  # challenge {"t":...,"d":12}
curl -s -o /dev/null -w '%{http_code}\n' https://<ingest_host>/api/send    # 404: Umami has no public route
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://<api_host>/v1/metrics  # 401: the collector requires an ingest key
nc -vz -w3 <vps-ip> 443    # open (Caddy)
nc -vz -w3 <vps-ip> 5432   # closed (Postgres only on loopback)
```

On the VPS: `compose ps`, `compose port postgres 5432` (must show `127.0.0.1`) and `systemctl list-timers stellytics-backup.timer`.

In a browser:

1. At `https://<portal_host>/sign-up`, create an account, confirm it through the email link (if no email arrives, check `SMTP_URL`/`MAIL_FROM` and `compose logs portal`), create the project at `/onboarding` and add a site at `/sites`.
2. Install the script on the site (served at `https://<ingest_host>/s/v<version>/n.js`; versions and SRI hashes in [`sri.json`](../packages/tracker/published/sri.json); snippets in [`examples/README.md`](../examples/README.md)), open a page and see the visit in the site dashboard within minutes.
3. Log in as the operator at `/operator` and check that the project appears.
4. At `/services`, create a service and an ingest key, point a backend at `https://<api_host>` (OTLP/HTTP; [`examples/api-backend/README.md`](../examples/api-backend/README.md)) and see requests in the service dashboard within a minute or two.

Logs: `compose logs <service>` (caddy, portal, ingest-web, collector, rollup, umami, postgres).

### Optional: public demo with real data

`/demo` and `/demo/operator` work without sign-in. Out of the box they show **sample data** (made-up numbers; only the home page says so). To show a real project instead, use one you own: everything in it becomes public.

1. Sign up and create the project (for example "Stellytics"). At `/sites`, add a website whose domain is exactly `<portal_host>`; at `/services`, create a service and an ingest key and point a backend at `https://<api_host>` (for example [`examples/api-backend`](../examples/api-backend/README.md), with `STELLYTICS_OTLP_ENDPOINT` and `STELLYTICS_INGEST_KEY`).
2. Put the project's slug in `DEMO_TENANT_SLUG` in `.env.production` (the SCF operator sees the slug in `/operator`) and run `sudo ./deploy.sh`.
3. Check: `curl -s https://<portal_host>/ | grep data-site` shows the tracker tag with the hash of the newest version in `packages/tracker/published/sri.json`, and `/demo` and `/demo/operator` open in a private window.

Leave `DEMO_TENANT_SLUG` empty to go back to the sample data.

## Update the application

1. Run a base backup first (`systemctl start stellytics-backup`): migrations only move forward.
2. `git pull` (or check out the release tag) and `sudo ./deploy.sh`. Portal migrations run on start (`RUN_MIGRATIONS=true`).
3. Repeat step 3.

**Rollback.** Check out the previous version and run `deploy.sh` again. That reverts the code, **not the database**: if the new version brought a migration, restore the backup taken before the update (below) before starting the old version. Published tracking script versions stay available at `/s/`. The systemd units that a newer `deploy.sh` installed stay in place: when going back past the version that added `stellytics-check.timer` (#172), run `systemctl disable --now stellytics-check.timer`, or the monitor raises `StackUnhealthy` after 5 minutes; the next `deploy.sh` of a newer version enables it again.

**Rotating a secret.** Database users are created once, on an empty volume, and keep their old password. In order: edit `.env.production`; run `deploy.sh` (services may stay unhealthy until the next step); update the password in the database (`compose exec -T postgres sh < infra/compose/postgres/init/02-ingest-roles.sh` for the ingest and collector users; `compose exec -T postgres psql -U postgres -c "ALTER ROLE <role> PASSWORD '<new>'"` for `stellytics`, `umami` and `postgres`); then `compose restart portal umami ingest-web`. Events received in between are dropped. Other secrets: `PORTAL_AUTH_SECRET` ends all portal sessions; `UMAMI_APP_SECRET` ends Umami sessions (create a new service account key if the portal gets 401); `INGEST_PROOF_SECRET` invalidates pending challenges for up to 5 minutes. `WALG_LIBSODIUM_KEY` cannot be changed. Details in [`runbooks/secret-rotation.md`](runbooks/secret-rotation.md).

## Backup

- **Continuous WAL:** Postgres sends each WAL segment to the bucket through `archive_command`, at most 60 seconds after the write, encrypted on the VPS.
- **Daily base backup** at 03:00 UTC by `stellytics-backup.timer`, keeping the newest `WALG_RETAIN_FULL` (default 7).
- **List backups:** `compose exec -u postgres postgres wal-g backup-list`.
- Restore is tested on every PR by the CI `infra` job (`infra/compose/test/prod-stack-test.sh`), including data written after the base backup.

## Restore the database

**Maintenance window:** restoring stops the portal, ingestion (events are dropped) and Umami. The old data stays next to the new one, so check free space (`df -h /srv/stellytics`) first. As root, from the repository root:

```bash
systemctl stop stellytics-backup.timer
compose stop portal ingest-web collector rollup umami postgres

# Keep the current data (do not delete it until the restore is checked).
mv /srv/stellytics/postgres /srv/stellytics/postgres.before-$(date +%F-%H%M)
mkdir /srv/stellytics/postgres

# Fetch the newest backup and all WAL after it.
compose run --rm --no-deps --entrypoint sh postgres -c \
  'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "stellytics-restore LATEST"'

compose up -d --wait
systemctl start stellytics-backup.timer
systemctl start stellytics-backup   # new base backup right after the restore
```

**Back to a point in time** (for example before a mistake at 02:00): start from a base backup that **finished before** that time:

```bash
compose run --rm --no-deps postgres wal-g backup-list --detail

# Instead of stellytics-restore LATEST above:
compose run --rm --no-deps \
  -e BACKUP=<backup-name> -e TARGET='2026-11-14 01:59:00+00' --entrypoint sh postgres -c \
  'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "stellytics-restore \"$BACKUP\" \"$TARGET\""'
```

**Losing the VPS:** create a new VPS, clone the repository, restore `.env.production` (with the same `WALG_*` values) from the vault, run `init.sh`, restore the database as above, then `deploy.sh`, and point DNS to the new IP.

## Monitoring

A second host checks the portal and ingestion from outside every 15 seconds and sends email when something is down ([ADR 0005](adr/0005-external-monitoring.md)). Set it up after production and DNS, or it starts alerting.

What cannot be seen from outside is checked on the VPS: `deploy.sh` installs `stellytics-check.timer`, which runs [`infra/scripts/stack-check.py`](../infra/scripts/stack-check.py) every minute. It checks that every container is running and healthy (rollup turns unhealthy when the rollup stops), that Postgres is archiving WAL, that the newest base backup is at most 26 hours old and that the data disk is below 90% (`STACK_CHECK_DISK_MAX_PERCENT`). Caddy answers `https://<ingest_host>/healthz/stack` with 200 while the check passes and 503 otherwise (status code only); the monitor probes it. The reasons are in `journalctl -u stellytics-check -n 20`.

1. Install Docker Engine with the Compose plugin on the monitoring host from Docker's repository ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/), the same repository `init.sh` uses; Debian's own `docker.io` package has no `docker compose`), then clone the repository.
2. Create `monitoring.env` (mode `0600`, outside git) with the variables listed at the top of [`infra/monitoring/configure.sh`](../infra/monitoring/configure.sh): the hosts, `API_URL=https://<api_host>/v1/metrics`, the alert email and SMTP. **Recommended:** a `DEADMAN_URL` from an external heartbeat service, so you learn when the monitor itself is down.
3. Run:

   ```bash
   infra/monitoring/configure.sh monitoring.env
   cd infra/monitoring && docker compose up -d --wait
   ```

   `configure.sh` writes the Prometheus targets and `alertmanager.yml` (including `alertmanager/secrets/` with the SMTP password) inside the clone; `.gitignore` excludes them. After changing `monitoring.env`, run `configure.sh` again and `docker compose kill -s SIGHUP prometheus alertmanager`.

| Alert | When |
|---|---|
| `EndpointDown` | Portal, web gateway or API ingestion without the expected answer for 1 minute. The gateway answers 2xx only while Postgres and Umami respond |
| `StackUnhealthy` | The stack check on the VPS has failed for 5 minutes: a container stopped or unhealthy, WAL not archived, base backup older than 26 hours or disk above the limit |
| `TLSCertificateExpiringSoon` | Certificate expiring in less than 14 days |
| `ProbeFailing` | Prometheus cannot ask the blackbox to probe a target |
| `ProberDown` | The blackbox exporter is down |

Prometheus and Alertmanager listen on loopback only: `ssh -N -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 root@<monitor-ip>`, then `http://127.0.0.1:9090` (`probe_success` must be `1` for every component). The API probe only confirms that the collector requires a key (401).

## Remove a deployment

For a test deploy, or after a handover ([`handover.md`](handover.md)) once the new operator has confirmed their copy. Removing the VPS disk and the bucket deletes the data and every backup for good.

1. Decide what to keep. To keep the data, take a base backup (`systemctl start stellytics-backup`) and keep the bucket and `WALG_LIBSODIUM_KEY`, or export it as in `handover.md`.
2. On the monitoring host first, so removing production does not raise alerts: `cd infra/monitoring && docker compose down -v`. Remove or pause the check at the heartbeat service (`DEADMAN_URL`), which would otherwise report the monitor as down.
3. On the VPS: `systemctl disable --now stellytics-backup.timer stellytics-check.timer`, then `compose down`.
4. At the providers: delete the VPS with its data disk (`/srv/stellytics`), the monitoring host, the DNS records, and, unless you kept it in step 1, the bucket. Revoke the bucket access key and the SMTP credentials used by the portal and by the monitor.

## Not covered yet

- **High availability:** one VPS; if it fails, the service is down until a new VPS is restored (ADR 0016).
- **Provisioning:** the VPS, firewall, DNS and bucket are created by hand.
- **Rate limits:** Caddy does not limit by IP and the collector does not limit by key; the collector's memory cap is `COLLECTOR_MEM_LIMIT` (default `512m`). The SCF read API limit is in the portal's memory ([ADR 0006](adr/0006-scf-read-api.md)).
- **Restore in production:** tested in CI with a local S3, not against the real bucket. Rehearse on a throwaway VPS before you need it.
- **Umami and Postgres upgrades:** by PR only (images pinned by digest); there is no major Postgres upgrade guide.
- **Handover:** plan and tested data migration in [`handover.md`](handover.md) ([#54](https://github.com/romulospl/stellytics/issues/54)).

## How this guide was checked

Without a real VPS, DNS or SMTP: `prod.yaml` with a generated `.env`, routes, ports, an API metric, the gateway `/healthz` with Umami down, the stack check before and after the first backup and with a stopped service, the encrypted backup and the restore are checked by `infra/compose/test/prod-stack-test.sh` (CI `infra` job), and the monitoring configuration and alerts by `infra/monitoring/test/monitoring-test.sh`.

On 2026-11-19 the team rehearsed sections 1 to 3 at commit `ca28e07` in a clean Ubuntu 24.04 container with systemd standing in for the VPS, a local S3 (SeaweedFS), a local SMTP (Mailpit), `*.localhost` names with Caddy's internal CA and a second container as the operator's machine. `init.sh`, `deploy.sh`, both systemd timers, the first base backup, the tunnel, the Umami service account, `operator:create`, every `curl` and `nc` check, sign-up with the email link, a site visit with the pinned script, OTLP metrics with an ingest key and the tenant and operator dashboards all worked. The only gap found, the missing `pnpm install`, is fixed above. Details in [#42](https://github.com/romulospl/stellytics/issues/42).

The same day the whole validation script was also run, as a simulation by an AI agent, on three throwaway Debian virtual machines (VPS, monitoring host and stand-in providers) with the same kind of local stand-ins ([report](validation/reports/deploy-2026-11-19-simulation.md)). Beyond sections 1 to 3, it covered the external monitoring with the `EndpointDown` and resolved e-mails, the dead-man heartbeat, the restore on the deployed VM, an update and a rollback, and the teardown. Its findings are fixed in this guide, `infra/monitoring/configure.sh` and `.gitignore`.

Not checked: a real VPS, DNS and certificate issuance, delivery through a real SMTP service, backup to a real bucket, and a run by an operator from outside the team, which #42 asks for.
