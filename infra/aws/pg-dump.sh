#!/usr/bin/env bash
# Daily logical dump of the stellytics and umami databases on the EC2 host, so
# the AWS Backup snapshot (03:00 UTC, ec2-recovery.yaml) carries a consistent
# copy instead of relying only on a crash-consistent copy of the running data
# directory. Run as root from the repository root, before the snapshot:
#
#   30 2 * * * root cd /opt/stellytics && infra/aws/pg-dump.sh >> /var/log/stellytics-pg-dump.log 2>&1
#
# Each dump is consistent on its own; the two databases may be a few seconds
# apart. Dumps contain password hashes and portal sessions: they stay 600, in
# DUMP_DIR, which must be on an EBS volume covered by the backup.
set -euo pipefail

DUMP_DIR="${DUMP_DIR:-/var/backups/stellytics}"
KEEP_DAYS="${KEEP_DAYS:-7}"
COMPOSE="${COMPOSE:-docker compose --env-file .env.production -f infra/compose/prod-vps.yaml}"

umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$DUMP_DIR/$stamp"
mkdir -p "$out"

for db in stellytics umami; do
  # --no-password: the container's local socket is trusted for postgres.
  $COMPOSE exec -T -u postgres postgres pg_dump --no-password -Fc -d "$db" > "$out/$db.dump"
  # Make sure the file is readable before trusting it.
  $COMPOSE exec -T -u postgres postgres pg_restore -l < "$out/$db.dump" > /dev/null
done
(cd "$out" && sha256sum stellytics.dump umami.dump > sha256sums)

find "$DUMP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} +
echo "pg-dump: $out"
