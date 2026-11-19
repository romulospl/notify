# Production deployment

Production is one Debian or Ubuntu VPS running Docker Compose ([ADR 0016](adr/0016-producao-em-vps.md)): Caddy, portal, web ingestion gateway, API collector, rollup job, Umami and Postgres with continuous encrypted backup, plus external monitoring on a second host. Files are in [`infra/`](../infra/README.md).

> **Scope.** [#42](https://github.com/romulospl/stellytics/issues/42) is not done yet: its acceptance criterion (someone outside the team deploys by following only this guide) needs a real account.

## What you need

- A VPS with root access, reachable on ports 22, 80 and 443 only (set the firewall at the provider). Keep `/srv/stellytics` (`STELLYTICS_DATA_DIR`) on a disk that survives the VPS if the provider offers one.
- Four DNS names pointing to the VPS (A and, if available, AAAA): `PORTAL_HOST`, `PORTAL_ALIAS_HOST`, `INGEST_HOST` and `API_HOST`.
- An S3-compatible bucket for the Postgres backup, with an access key that can read and write it.
- A real SMTP service for sign-up confirmation and password reset (SPF, DKIM and DMARC of the `MAIL_FROM` domain are up to you).
- A second, small host for monitoring, ideally with another provider or region.

The VPS and bucket region is the data residency that must be declared ([`privacidade.md`](privacidade.md)).

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
- `deploy.sh` validates the file, builds the portal, gateway, collector and rollup images from the checkout, starts [`infra/compose/prod.yaml`](../infra/compose/prod.yaml) and installs the daily backup timer. Postgres, Umami and Caddy use pinned images. To run the signed release images instead, set `PORTAL_IMAGE`, `INGEST_WEB_IMAGE`, `COLLECTOR_IMAGE` and `ROLLUP_IMAGE` to their digests; `deploy.sh` does not verify signatures, so run `cosign verify` yourself first ([`release.yml`](../.github/workflows/release.yml)).

Only Caddy publishes ports. Postgres listens on loopback only and Umami only on the internal network. `docker compose down` keeps the data; never use `down -v`.

In the commands below, `compose` means, from the repository root:

```bash
docker compose --env-file .env.production -f infra/compose/prod.yaml
```

## 2. First start

1. Open a tunnel to Umami and change its initial password (`admin`/`umami`): `infra/scripts/admin-tunnel.sh <vps-ip>`.
2. Create the Umami service account key so the portal can create sites. In a clone with Node 24, with the tunnel open:

   ```bash
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

   Further operators come from `operator:promote` with the same `DATABASE_URL`.
4. Run a first base backup: `systemctl start stellytics-backup`.

## 3. Check production

From any machine, without logging in:

```bash
curl -fsS https://<portal_host>/api/auth/ok            # portal: {"ok":true}
curl -fsS https://<ingest_host>/healthz                # gateway: ok
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

## Update the application

1. Run a base backup first (`systemctl start stellytics-backup`): migrations only move forward.
2. `git pull` (or check out the release tag) and `sudo ./deploy.sh`. Portal migrations run on start (`RUN_MIGRATIONS=true`).
3. Repeat step 3.

**Rollback.** Check out the previous version and run `deploy.sh` again. That reverts the code, **not the database**: if the new version brought a migration, restore the backup taken before the update (below) before starting the old version. Published tracking script versions stay available at `/s/`.

**Rotating a secret.** Database users are created once, on an empty volume, and keep their old password. In order: edit `.env.production`; run `deploy.sh` (services may stay unhealthy until the next step); update the password in the database (`compose exec -T postgres sh < infra/compose/postgres/init/02-ingest-roles.sh` for the ingest and collector users; `compose exec -T postgres psql -U postgres -c "ALTER ROLE <role> PASSWORD '<new>'"` for `stellytics`, `umami` and `postgres`); then `compose restart portal umami ingest-web`. Events received in between are dropped. Other secrets: `PORTAL_AUTH_SECRET` ends all portal sessions; `UMAMI_APP_SECRET` ends Umami sessions (create a new service account key if the portal gets 401); `INGEST_PROOF_SECRET` invalidates pending challenges for up to 5 minutes. `WALG_LIBSODIUM_KEY` cannot be changed. Details in [`runbooks/rotacao-de-segredos.md`](runbooks/rotacao-de-segredos.md).

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

A second host checks the portal and ingestion from outside every 15 seconds and sends email when something is down ([ADR 0005](adr/0005-monitoramento-externo.md)). Set it up after production and DNS, or it starts alerting.

1. Install Docker on the monitoring host and clone the repository.
2. Create `monitoring.env` (mode `0600`, outside git) with the variables listed at the top of [`infra/monitoring/configure.sh`](../infra/monitoring/configure.sh): the hosts, `API_URL=https://<api_host>/v1/metrics`, the alert email and SMTP. **Recommended:** a `DEADMAN_URL` from an external heartbeat service, so you learn when the monitor itself is down.
3. Run:

   ```bash
   infra/monitoring/configure.sh monitoring.env
   cd infra/monitoring && docker compose up -d --wait
   ```

   After changing `monitoring.env`, run `configure.sh` again and `docker compose kill -s SIGHUP prometheus alertmanager`.

| Alert | When |
|---|---|
| `EndpointDown` | Portal, web gateway or API ingestion without the expected answer for 1 minute |
| `TLSCertificateExpiringSoon` | Certificate expiring in less than 14 days |
| `ProbeFailing` | Prometheus cannot ask the blackbox to probe a target |
| `ProberDown` | The blackbox exporter is down |

Prometheus and Alertmanager listen on loopback only: `ssh -N -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 root@<monitor-ip>`, then `http://127.0.0.1:9090` (`probe_success` must be `1` for every component). The API probe only confirms that the collector requires a key (401).

## Not covered yet

- **High availability:** one VPS; if it fails, the service is down until a new VPS is restored (ADR 0016).
- **Provisioning:** the VPS, firewall, DNS and bucket are created by hand.
- **Rate limits:** Caddy does not limit by IP and the collector does not limit by key; the collector's memory cap is `COLLECTOR_MEM_LIMIT` (default `512m`). The SCF read API limit is in the portal's memory ([ADR 0006](adr/0006-api-de-leitura-do-scf.md)).
- **Restore in production:** tested in CI with a local S3, not against the real bucket. Rehearse on a throwaway VPS before you need it.
- **Umami and Postgres upgrades:** by PR only (images pinned by digest); there is no major Postgres upgrade guide.
- **Handover:** plan and tested data migration in [`transferencia.md`](transferencia.md) ([#54](https://github.com/romulospl/stellytics/issues/54)).

## How this guide was checked

Without a real VPS, DNS or SMTP: `prod.yaml` with a generated `.env`, routes, ports, an API metric, the encrypted backup and the restore are checked by `infra/compose/test/prod-stack-test.sh` (CI `infra` job), and the monitoring configuration and alerts by `infra/monitoring/test/monitoring-test.sh`. Not checked: `init.sh` and `deploy.sh` on a real VPS, certificate issuance, email delivery and backup to a real bucket.
