#!/usr/bin/env bash
# Exports the stellytics and umami databases to a folder (#54, docs/handover.md).
#
# Generates stellytics.dump and umami.dump (pg_dump custom format, compressed), the
# origin's fingerprint (fingerprint.txt) and sha256sums. Run on the origin
# VM as root, at the root of the clone, in the maintenance window and
# with the portal, the gateway and Umami stopped (otherwise the two databases may end up
# at different points in time):
#
#   docker compose --env-file .env.production -f infra/compose/prod.yaml stop caddy portal ingest-web collector rollup umami
#   infra/scripts/db-export.sh /root/migration
#
# The dumps contain password hashes and portal sessions: they get permission 600 and
# must be deleted afterwards (and never go to the repository).
set -euo pipefail

dir="${1:?usage: db-export.sh <output-folder>}"
COMPOSE="${COMPOSE:-docker compose --env-file .env.production -f infra/compose/prod.yaml}"
here="$(cd "$(dirname "$0")" && pwd)"

umask 077
mkdir -p "$dir"
if [ -n "$(ls -A "$dir")" ]; then echo "db-export: $dir is not empty." >&2; exit 1; fi

running=$($COMPOSE ps --status running --services | grep -v -E '^(postgres|s3)$' || true)
if [ -n "$running" ]; then
  echo "db-export: stop first: $(echo "$running" | tr '\n' ' ')" >&2
  exit 1
fi

for db in stellytics umami; do
  echo "exporting $db..."
  # --no-password: the container's local socket is trusted for postgres.
  $COMPOSE exec -T -u postgres postgres pg_dump --no-password -Fc -d "$db" > "$dir/$db.dump"
  # Checks that the file is readable before trusting it.
  $COMPOSE exec -T -u postgres postgres pg_restore -l < "$dir/$db.dump" > /dev/null
done
"$here/db-fingerprint.sh" > "$dir/fingerprint.txt"
(cd "$dir" && sha256sum stellytics.dump umami.dump fingerprint.txt > sha256sums)
echo "ready in $dir:"; ls -l "$dir"
