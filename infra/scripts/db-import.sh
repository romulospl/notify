#!/usr/bin/env bash
# Imports the db-export.sh dumps into the DESTINATION Postgres (#54, docs/handover.md).
#
# The destination has already gone through `site.yml` (Postgres with the roles created by the
# init scripts). This script STOPS the application, DROPS and recreates the
# stellytics and umami databases (the new app, on startup, created empty tables and the restore
# would collide with them), restores the dumps, reapplies 02-ingest-roles.sh and checks the
# fingerprint against the origin's. Only after that start the application.
#
#   docker compose --env-file .env.production -f infra/compose/prod.yaml stop caddy portal ingest-web collector rollup umami   # before
#   infra/scripts/db-import.sh --yes [--force-nonempty] /root/migration
#
# Protections, all BEFORE dropping anything: sha256sums must list
# stellytics.dump and umami.dump and match; both dumps must open (`pg_restore -l`);
# no service other than Postgres may be running (the script does not stop them);
# and the destination must have 0 tenants (use --force-nonempty only if it is on purpose:
# without it, running the script on the origin VM by mistake would erase production).
# The dumps are restored into temporary databases (stellytics_new and umami_new); only
# when both restore are the old databases swapped for them. A
# restore failure leaves the destination as it was.

# Run on the destination VM as root, at the root of the clone. Destructive:
# requires --yes.
set -euo pipefail

yes=0 force=0 dir=""
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --force-nonempty) force=1 ;;
    -*) echo "db-import: unknown option: $arg" >&2; exit 2 ;;
    *) dir="$arg" ;;
  esac
done
if [ "$yes" != 1 ] || [ -z "$dir" ]; then
  echo "usage: db-import.sh --yes [--force-nonempty] <folder-with-the-dumps>  (DROPS the destination's stellytics and umami databases)" >&2
  exit 2
fi
COMPOSE="${COMPOSE:-docker compose --env-file .env.production -f infra/compose/prod.yaml}"
here="$(cd "$(dirname "$0")" && pwd)"
pg() { $COMPOSE exec -T -u postgres postgres "$@"; }
abort() { echo "db-import: $*" >&2; exit 1; }

# 1. Integrity: sha256sums must list both dumps (a sha256sums with only
# the fingerprint must not pass). It proves integrity, not authenticity:
# authenticity comes from the channel (ssh) through which the folder arrived.
for f in stellytics.dump umami.dump fingerprint.txt; do
  grep -q "  $f\$" "$dir/sha256sums" || abort "$dir/sha256sums does not list $f"
done
(cd "$dir" && sha256sum -c sha256sums) || abort "sha256sums does not match"

# 2. Do the dumps open? Failing here costs nothing; failing after the DROP would cost the database.
for db in stellytics umami; do
  pg pg_restore -l < "$dir/$db.dump" > /dev/null || abort "$db.dump does not open (truncated or corrupted?)"
done

# 3. Nothing running besides Postgres (and the test's S3).
# A failing `ps` (wrong directory or COMPOSE) must abort, not pass as "nothing running".
services=$($COMPOSE ps --status running --services) || abort "could not list the services (COMPOSE=$COMPOSE; are you at the root of the clone?)"
running=$(printf '%s\n' "$services" | grep -v -E '^(postgres|s3)$' || true)
if [ -n "$running" ]; then
  abort "stop first: $(echo "$running" | tr '\n' ' ')(docker compose --env-file .env.production -f infra/compose/prod.yaml stop ...)"
fi

# 4. Is the destination empty? (no table, or 0 tenants)
# If psql fails, abort: treating a failure as "0 tenants" would let the origin through.
tenants=$(pg psql -X -At -d stellytics -c "select case when to_regclass('public.tenant') is null then 0 else (select count(*) from tenant) end") || abort "could not query the destination (is Postgres up? does the stellytics database exist?)"
if [ "$tenants" != 0 ] && [ "$force" != 1 ]; then
  abort "the destination has $tenants tenant(s): this does not look like an empty destination (is it the origin?). Use --force-nonempty if it is on purpose."
fi

# Restores into temporary databases; the real ones only change afterwards.
pg psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DROP DATABASE IF EXISTS umami_new WITH (FORCE);
DROP DATABASE IF EXISTS stellytics_new WITH (FORCE);
CREATE DATABASE umami_new OWNER umami;
CREATE DATABASE stellytics_new OWNER stellytics;
SQL
for db in stellytics umami; do
  echo "importing $db..."
  if ! pg pg_restore --no-password --exit-on-error -d "${db}_new" < "$dir/$db.dump"; then
    pg psql -X -d postgres -c "DROP DATABASE IF EXISTS umami_new WITH (FORCE)" -c "DROP DATABASE IF EXISTS stellytics_new WITH (FORCE)" >/dev/null || true
    abort "the restore of $db failed; the destination was NOT changed."
  fi
done

# Swap. Same commands as 01-databases.sh regarding owner and REVOKE. From
# here on the old databases no longer exist.
pg psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DROP DATABASE IF EXISTS umami WITH (FORCE);
DROP DATABASE IF EXISTS stellytics WITH (FORCE);
ALTER DATABASE umami_new RENAME TO umami;
ALTER DATABASE stellytics_new RENAME TO stellytics;
REVOKE ALL ON DATABASE umami FROM PUBLIC;
REVOKE ALL ON DATABASE stellytics FROM PUBLIC;
SQL

# CONNECT for the gateway and collector users is a database privilege, which the dump
# does not carry. The script is idempotent.
$COMPOSE exec -T postgres sh < "$here/../compose/postgres/init/02-ingest-roles.sh"

echo "checking against the origin..."
"$here/db-fingerprint.sh" > "$dir/fingerprint-destination.txt"
# Roles and database ACLs can differ only if someone changed them; the rest must be identical.
if diff -u "$dir/fingerprint.txt" "$dir/fingerprint-destination.txt"; then
  echo "OK: destination identical to the origin. You can start the application."
else
  echo "FAILED: the destination differs from the origin (diff above). Do NOT start the application." >&2
  exit 1
fi
