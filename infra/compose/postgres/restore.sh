#!/bin/sh
# stellytics-restore (#14, ADR 0004): fetches a backup from Object Storage into an
# EMPTY data folder and prepares the recovery. On the next start, Postgres
# applies the archived WAL and opens the database.
#
#   stellytics-restore [BACKUP] [TARGET]
#   BACKUP: base backup name (default LATEST; `wal-g backup-list` shows the names)
#   TARGET: time to recover up to, such as '2026-11-14 10:00:00+00'
#           (default: up to the last archived WAL)
#
# Step by step on the VM in docs/deploy.md ("Restore the database").
set -eu
: "${PGDATA:?}"
backup="${1:-LATEST}"
target="${2:-}"

if [ -n "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
  echo "stellytics-restore: $PGDATA is not empty; move the current data first." >&2
  exit 1
fi

wal-g backup-fetch "$PGDATA" "$backup"
# The backup brings the postgresql.auto.conf of its time: if it came from an earlier
# restore, it has a restore_command and maybe an old recovery_target_*, which
# would make this restore stop at the wrong time. Remove them all before writing.
conf="$PGDATA/postgresql.auto.conf"
if [ -f "$conf" ]; then
  sed -i -E '/^[[:space:]]*(restore_command|recovery_target[a-z_]*)[[:space:]]*=/d' "$conf"
fi
{
  echo "restore_command = 'wal-g wal-fetch %f %p'"
  if [ -n "$target" ]; then
    echo "recovery_target_time = '$target'"
    echo "recovery_target_action = 'promote'"
  fi
} >> "$PGDATA/postgresql.auto.conf"
touch "$PGDATA/recovery.signal"
echo "stellytics-restore: backup $backup ready in $PGDATA. Start Postgres to apply the WAL."
