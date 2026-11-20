# Runbook: secret rotation

The exact order for changing a secret (edit `.env.production`, run `sudo ./deploy.sh`, update the password in the database, restart) is in [`docs/deploy.md`](../deploy.md), section "Update the application", block **Rotating a secret**. Follow it; do **not** change only `.env.production`: the database users keep the old password. This runbook says what each secret affects and how to check.

## When to rotate

- Suspected or confirmed leak (log, repository, the administrator's machine, former collaborator): rotate right away, before investigating.
- Someone with access to `.env.production` or to the VPS leaves.
- Routine: there is no schedule defined in the repository; define one (for example, yearly) and record it here.

## The secrets and the effect of each change

The production ones are in `.env.production` (template in `.env.production.example`); the monitoring ones, in the file passed to `infra/monitoring/configure.sh`.

| Secret | Effect of the change | Extra step beyond `docs/deploy.md` |
|---|---|---|
| `POSTGRES_PASSWORD`, `STELLYTICS_DB_PASSWORD`, `UMAMI_DB_PASSWORD` | Postgres is recreated; the portal, Umami and the gateway are left without a database until the `ALTER ROLE` | `ALTER ROLE ... PASSWORD` and `restart portal umami ingest-web` (in the guide). **Do not type the password on the command line**: it would go to the shell history and, if `log_statement` is on, to the Postgres log. Read the password without echo (`read -rs NEW`), turn off the session history (`unset HISTFILE`) and pass the command through `psql` reading from standard input, for example `printf "ALTER ROLE stellytics PASSWORD '%s'
" "$NEW" \| docker compose -f prod.yaml exec -T postgres psql -U postgres` (not tested). The web events in the interval are dropped: do it off-peak |
| `STELLYTICS_INGEST_DB_PASSWORD`, `STELLYTICS_COLLECTOR_DB_PASSWORD` | Same for the gateway | Reapply `02-ingest-roles.sh` (idempotent), as in the guide |
| `PORTAL_AUTH_SECRET` | All portal sessions end, and the email confirmation and password recovery links in progress also stop working (expected effect) | Warn the users |
| `UMAMI_APP_SECRET` | Umami sessions end; the API key may stop working; the visitor salt changes, so returning visitors count again as unique until the month ends (rotate on the 1st, UTC) | If the portal gets 401 from Umami, generate a new one with the tunnel open: `UMAMI_URL=http://127.0.0.1:13001 pnpm --filter @stellytics/portal umami:service-account` (admin password in `UMAMI_ADMIN_PASSWORD`; the script uses `127.0.0.1:3001` by default, hence the variable) and put it in `UMAMI_API_KEY`. With `--revoke-old` the script deletes the service user's other keys |
| `UMAMI_API_KEY` | The portal uses the new key when it is recreated | Run `sudo ./deploy.sh` again; revoke the old one with `--revoke-old` (above) or through the Umami interface (tunnel) |
| Umami `admin` password | Only used through the interface, through the tunnel | Change it through the interface; it is never kept in `.env.production` |
| `INGEST_PROOF_SECRET` | The challenges in circulation become invalid; browsers request a new one at `GET /c` on the next event | No action (minimum of 32 characters) |
| `SMTP_URL` | Email confirmation and password recovery depend on it | Test with a sign-up or `/forgot-password` afterwards |
| `WALG_S3_ACCESS_KEY`, `WALG_S3_SECRET_KEY` | WAL archiving and the backup use the new credential when Postgres is recreated | Create the new credential at the S3 provider first, run `sudo ./deploy.sh` and confirm `backup-list`; only then revoke the old one ([backup and restore](backup-and-restore.md)) |
| `WALG_LIBSODIUM_KEY` | **Cannot be rotated**: `docs/deploy.md` says it cannot be changed, because the old backups would no longer open (`prod.yaml` accepts a single key) | Do not change it as a routine. If it leaks, see "Encryption key" in [backup and restore](backup-and-restore.md) |
| Monitoring `SMTP_PASSWORD` | Email alerts | `infra/monitoring/configure.sh <env-file>`, restart `alertmanager` and test an alert (see `docs/deploy.md`, "Monitoring") |
| Administration SSH key | Access to the VPS and to the monitoring host | Procedure (not tested): 1) add the new key to `authorized_keys` on the VPS **and** on the monitoring host; 2) test the login with the new one on both, in another session; 3) remove the old one from both `authorized_keys`; 4) if the provider stores SSH keys for new machines, change it there too |
| Tenant ingest keys (`ntf_...`) | They stay with the tenant | [Vulnerabilities: leaked ingest key](vulnerabilities.md#leaked-ingest-key) |

## Diagnosis after the change

```bash
# on the VPS, in the checkout folder
docker compose -f prod.yaml ps
docker compose -f prod.yaml logs --tail 100 portal ingest-web umami
```

Database authentication errors (`password authentication failed`) indicate that the `ALTER ROLE` or `02-ingest-roles.sh` did not run or used a different value.

## Verification

Step 3 ("Check production") of `docs/deploy.md` (curls from outside and `docker compose ps`), signing in to the portal, opening a site's dashboard, receiving a confirmation email, and `wal-g backup-list` if the backup credential changed.

## When to escalate

- Postgres does not come back with the new password: restore the previous `.env.production` (keep a copy beforehand) and repeat calmly.
- A leaked credential that gives access to the backup bucket: treat it as a security incident ([vulnerabilities](vulnerabilities.md)) in addition to rotating.

## Not tested

No change has been made in production. The "Rotating a secret" section of `docs/deploy.md` was written from the infra files, not run; the behaviour of `UMAMI_API_KEY` after changing `UMAMI_APP_SECRET` was not observed either.
