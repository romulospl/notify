# Runbook: backup and restore

The full description (continuous WAL, daily backup at 03:00 UTC by the `stellytics-backup.timer` that `deploy.sh` installs, retention of `WALG_RETAIN_FULL` (default 7), the step-by-step restore and going back to a point in time) is in [`docs/deploy.md`](../deploy.md), sections "Backup" and "Restore the database", and the decision is in [ADR 0016](../adr/0016-production-on-a-vps.md). **Do not repeat the command blocks from here: use the ones there.** This runbook says when to act, how to diagnose and how to check.

The scripts are in [`infra/compose/postgres/`](../../infra/compose/postgres/): `backup.sh` becomes `stellytics-backup` and `restore.sh` becomes `stellytics-restore` inside the Postgres image (`Dockerfile`).

## Symptoms

- `StackUnhealthy` alert with `backup:` or `postgres: WAL archiving` in `journalctl -u stellytics-check -n 20` ([incidents](incidents.md#stackunhealthy)).
- There is no recent backup in `backup-list`, or `stellytics-backup.service` failed.
- WAL archiving stopped (the `archive_command` fails and the Postgres disk fills up with pending WAL).
- Loss or corruption of data, or of the VPS and the disk (a restore is needed).
- Before an update with a new migration (preventive backup).

## Diagnosis

On the VPS, in the checkout folder:

```bash
systemctl status stellytics-backup.service stellytics-backup.timer
systemctl list-timers stellytics-backup.timer
journalctl -u stellytics-backup.service -n 100 --no-pager
docker compose -f prod.yaml exec -u postgres postgres wal-g backup-list
docker compose -f prod.yaml exec -u postgres postgres wal-g backup-list --detail
docker compose -f prod.yaml logs --tail 200 postgres | grep -i -E 'archive|wal-g'
docker compose -f prod.yaml exec -u postgres postgres psql -c 'select * from pg_stat_archiver'
df -h /srv/stellytics   # STELLYTICS_DATA_DIR
```

Common causes: invalid or expired S3 storage credential (`WALG_S3_ACCESS_KEY` and `WALG_S3_SECRET_KEY` in `.env.production`), wrong endpoint, region or prefix (`WALG_S3_ENDPOINT`, `WALG_S3_REGION`, `WALG_S3_PREFIX`), bucket removed, network, a `WALG_LIBSODIUM_KEY` different from the one used in the old backups (see "Encryption key" below), full disk.

## Action

- **Base backup now:** `systemctl start stellytics-backup` (runs `stellytics-backup`: `wal-g backup-push`, then `wal-g delete retain FULL "$WALG_RETAIN_FULL" --confirm` and `backup-list`).
- **Credential changed:** follow [secret rotation](secret-rotation.md) and check with `backup-list`.
- **Restore:** follow "Restore the database" in `docs/deploy.md`. Note: it takes down the portal, ingestion (events dropped) and Umami until it finishes; it requires `systemctl stop stellytics-backup.timer` beforehand (and `start` afterwards) and free space for two sets of data (`df -h /srv/stellytics`), because the old data stays in `postgres.before-*`. Also follow the maintenance window, the `mv` of the old data to `postgres.before-*` and the "Back to a point in time" step (`stellytics-restore <backup> '<time>'`). To choose between restoring the latest or a point in time: a logical error (bad migration, wrongful removal) calls for the time before the error, with a base backup finished before it; disk loss calls for `LATEST`.
- **Loss of the VPS and the data disk:** prepare a new VPS with `init.sh` and `deploy.sh` ([`docs/deploy.md`](../deploy.md)) using the **same** `.env.production` (in particular `WALG_LIBSODIUM_KEY` and the bucket credentials) and restore right after. The backups survive as long as the bucket exists; nothing in the repository prevents it from being deleted at the provider.

## Encryption key

Backups are encrypted on the client with `WALG_LIBSODIUM_KEY` (libsodium, 64 hexadecimal characters). **Without this key there is no way to read any backup, and it cannot be changed as a routine**: `docs/deploy.md` is explicit, and `prod.yaml` has a single key, so restoring an old backup requires the old key. Keep a copy of `.env.production` in the password vault, outside the VPS and the repository.

If the key **leaks**, the response (still **not tested**) is: create a new bucket or prefix (`WALG_S3_PREFIX`), generate a new key, apply it (`deploy.sh`) and run `systemctl start stellytics-backup` for a new base backup, and **keep the old prefix, with the old key stored**, for as long as there is useful retention in it. Whoever has the leaked key and access to the old bucket can read those backups: restrict the old bucket's credentials ([rotation](secret-rotation.md)).

## Verification

- `wal-g backup-list` shows a recent backup (today's date after `stellytics-backup`).
- `pg_stat_archiver` with a `last_archived_time` a few minutes old and `failed_count` not growing.
- After a restore: `docker compose -f prod.yaml ps` all `healthy`, the checks in step 3 ("Check production") of `docs/deploy.md`, signing in to the portal and opening a site's dashboard, and a new `systemctl start stellytics-backup`. Only delete `postgres.before-*` after that.
- **Rehearsal:** the restore is tested on every PR by the CI `infra` job (`infra/compose/test/prod-stack-test.sh`, with a local S3). Against the real bucket, rehearse on a throwaway VPS before you need it (pending item recorded in `docs/deploy.md`); record the date of the first rehearsal here: **never done**.

## When to escalate

- `backup-list` empty or with no new backup for more than 2 days and the cause is not credentials or network.
- Postgres does not open after the restore (log of the `postgres` container).
- Provider support for S3 storage that is down or a corrupted disk.
- Loss of `WALG_LIBSODIUM_KEY` (or a leak of it: see "Encryption key"): the backups are not recoverable; treat it as total loss of history.

## Not tested

A restore against a real S3 bucket, `journalctl` and the units on a real VPS, `pg_stat_archiver` in the production environment and changing the encryption key.
