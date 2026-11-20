#!/bin/sh
# stellytics-backup (#14, ADR 0004): Postgres base backup to Object Storage and
# cleanup of the old ones. WAL goes continuously through archive_command; the base
# backup gives the starting point of the restore. Runs once a day on the VM:
#   docker compose -f prod.yaml exec -T -u postgres postgres stellytics-backup
# Keeps the WALG_RETAIN_FULL (default 7) newest backups and the WAL between them.
set -eu
: "${PGDATA:?}"
wal-g backup-push "$PGDATA"
wal-g delete retain FULL "${WALG_RETAIN_FULL:-7}" --confirm
wal-g backup-list
