#!/usr/bin/env bash
# Test of the data migration between operators (#54, docs/handover.md).
#
# Starts an ORIGIN stack (Postgres 17 with WAL-G, Umami and portal, with the
# production images and Compose), writes real data to both databases
# (including portal accounts and events in Umami), and migrates to empty
# DESTINATION stacks, with different passwords and backup key, in two ways:
#
#   A. logical: infra/scripts/db-export.sh and db-import.sh (pg_dump/pg_restore);
#   B. physical: WAL-G base backup and WAL copied to another operator's
#      bucket and restored with stellytics-restore.
#
# In each one, proves by query that the destination is identical (db-fingerprint.sh) and
# that the system works on it: portal up with the accounts and their passwords,
# Umami with the same statistics, ingest keys accepted by the views and
# audit_log still insert-only. Shows the time of each step.
#
# Usage, from the repository root, with the portal image already built:
#   PORTAL_IMAGE=stellytics-portal:dev infra/compose/test/data-migration-test.sh
# MODE=logical or MODE=physical runs only one of the two. KEEP=1 tears nothing down.
# Loopback ports: 13541-13543 (portal) and 18333-18335 (local S3); change them with
# PORT_BASE and S3_BASE.
set -euo pipefail

cd "$(dirname "$0")/.."
repo=$(cd ../.. && pwd)
PORTAL_IMAGE="${PORTAL_IMAGE:-stellytics-portal:dev}"
MODE="${MODE:-both}"
PORT_BASE="${PORT_BASE:-13541}"
S3_BASE="${S3_BASE:-18333}"
work=$(mktemp -d "${TMPDIR:-/tmp}/stellytics-migtest.XXXXXX")
rand() { openssl rand -hex "${1:-24}"; }
ALPINE='alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f'
RCLONE='rclone/rclone:1.73.0'

fail() { echo "FAILED: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
t0=$(date +%s)
lap() { echo "time: $1 in $(( $(date +%s) - t0 ))s"; t0=$(date +%s); }

# --- one stack = Compose project + .env file + data folder -------------------
# stack <name> <index> [libsodium] [auth_secret] [umami_secret]
mkenv() {
  local name=$1 idx=$2 libsodium=$3 auth=$4 umami=$5
  mkdir -p "$work/$name-data"
  cat > "$work/$name.env" <<EOT
POSTGRES_PASSWORD=$(rand)
UMAMI_DB_PASSWORD=$(rand)
STELLYTICS_DB_PASSWORD=$(rand)
STELLYTICS_INGEST_DB_PASSWORD=$(rand)
STELLYTICS_COLLECTOR_DB_PASSWORD=$(rand)
UMAMI_APP_SECRET=$umami
PORTAL_AUTH_SECRET=$auth
INGEST_PROOF_SECRET=$(rand)
WALG_S3_PREFIX=s3://stellytics-backup-$name/pg
WALG_S3_ENDPOINT=http://s3:8333
WALG_S3_REGION=us-east-1
WALG_S3_ACCESS_KEY=$(rand 10)
WALG_S3_SECRET_KEY=$(rand)
WALG_LIBSODIUM_KEY=$libsodium
PORTAL_IMAGE=$PORTAL_IMAGE
INGEST_WEB_IMAGE=unused:none
COLLECTOR_IMAGE=unused:none
ROLLUP_IMAGE=unused:none
PORTAL_HOST=portal.localhost
PORTAL_ALIAS_HOST=alias.localhost
INGEST_HOST=ingest.localhost
API_HOST=api.localhost
ACME_EMAIL=ops@example.org
SMTP_URL=smtp://127.0.0.1:25
MAIL_FROM=stellytics <no-reply@example.org>
STELLYTICS_DATA_DIR=$work/$name-data
PORTAL_PORT=$((PORT_BASE + idx))
S3_PORT=$((S3_BASE + idx))
POSTGRES_ADMIN_PORT=$((PORT_BASE + 100 + idx))
EOT
}
stacks=()
use() { P=stellytics54-$1; ENVF=$work/$1.env; NAME=$1; }
compose() { docker compose -p "$P" --env-file "$ENVF" -f prod.yaml -f test/prod-test.yaml -f test/migration-test.yaml "$@"; }
envval() { grep "^$1=" "$ENVF" | cut -d= -f2-; }
pgsql() { compose exec -T -u postgres postgres psql -X -At -v ON_ERROR_STOP=1 -d "$1" "${@:2}"; }
portal_url() { echo "http://127.0.0.1:$(envval PORTAL_PORT)"; }
# Connects as a role OVER THE Compose NETWORK, with a password. From inside the Postgres
# container the socket and 127.0.0.1 are `trust` (official image) and do not prove the
# password; so the test starts a separate container (same image, only psql).
pg_net() { # role password database sql
  compose run --rm --no-deps -T -e PGHOST=postgres -e PGUSER="$1" -e PGPASSWORD="$2" --entrypoint psql postgres -X -At -d "$3" -c "$4"
}
umami_curl() { compose exec -T umami curl -fsS "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for s in "${stacks[@]}"; do use "$s"; compose logs --tail 40 postgres portal umami >&2 || true; done
  fi
  if [ "${KEEP:-0}" != 1 ]; then
    for s in "${stacks[@]}"; do use "$s"; compose down -v --remove-orphans >/dev/null 2>&1 || true; done
    docker run --rm -v "$work:/w" "$ALPINE" sh -c 'rm -rf /w/*-data /w/migration*' >/dev/null 2>&1 || true
    rm -rf "$work"
  else
    echo "KEEP=1: stacks and $work kept."
  fi
  exit "$status"
}
trap cleanup EXIT

new_stack() { # name index libsodium auth umami
  mkenv "$@"; stacks+=("$1"); use "$1"
  compose up -d s3 --wait
  compose exec -T s3 sh -c "echo 's3.bucket.create -name stellytics-backup-$1' | weed shell -master=localhost:9333" >/dev/null
  compose up -d postgres umami portal --wait
}

# 1. ORIGIN -------------------------------------------------------------------
auth_secret=$(rand 32); umami_secret=$(rand 32); libsodium_origin=$(rand 32)
echo "== origin"
new_stack origin 0 "$libsodium_origin" "$auth_secret" "$umami_secret"
lap "origin up (portal applied the migrations; Umami created its schema)"
o_url=$(portal_url)

# Two users through the portal's administration command (the password becomes
# the Better Auth hash). The portal has no sign-up or sign-in; Alice is created
# as an operator and demoted, which leaves a regular user with a verified email.
password="test-password-$(rand 4)"
create_user() { # email name
  compose exec -T -e OPERATOR_PASSWORD="$password" portal node scripts/operator.mjs create --email "$1" --name "$2" >/dev/null
}
create_user alice@example.org Alice; create_user operator@example.org Operator
compose exec -T portal node scripts/operator.mjs demote --email alice@example.org >/dev/null
portal_code() { curl -s -o /dev/null -w '%{http_code}' "$1$2"; } # url path
accounts() { pgsql stellytics -c "select string_agg(u.email || ':' || a.password, ',' order by u.email) from \"user\" u join account a on a.user_id = u.id where a.password is not null"; }
accounts_origin=$(accounts)
[ "$(echo "$accounts_origin" | tr ',' '\n' | grep -c .)" = 2 ] || fail "expected two accounts with a password on the origin"
[ "$(portal_code "$o_url" /api/health)" = 200 ] || fail "the portal does not answer on the origin"
ok "users created by the portal's administration command; portal up on the origin"

# Umami: a site and real events, through the same /api/send the gateway uses.
token=$(umami_curl -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"umami"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
umami_site=$(umami_curl -X POST http://localhost:3000/api/websites -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' -d '{"name":"Alpha site","domain":"alpha.example"}' |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
[ -n "$umami_site" ] || fail "Umami did not create the site"
for i in $(seq 1 60); do
  ua="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 v$((i % 6))"
  umami_curl -o /dev/null -X POST http://localhost:3000/api/send -H 'Content-Type: application/json' \
    -H "User-Agent: $ua" -H "x-stellytics-client-ip: 203.0.113.$((i % 9)).0" \
    -d "{\"type\":\"event\",\"payload\":{\"website\":\"$umami_site\",\"hostname\":\"alpha.example\",\"url\":\"/p$((i % 7))\",\"title\":\"p\",\"language\":\"en-US\",\"screen\":\"1920x1080\"}}" ||
    fail "Umami refused event $i"
done
events=$(pgsql umami -c "select count(*) from website_event")
[ "$events" -ge 50 ] || fail "too few events in Umami: $events"
umami_stats() { # compose already in use; token -> JSON from /stats
  umami_curl "http://localhost:3000/api/websites/$umami_site/stats?startAt=0&endAt=4102444800000" -H "Authorization: Bearer $1"
}
stats_origin=$(umami_stats "$token")
ok "Umami with $events events: $stats_origin"

rk() { echo "ntf_$(openssl rand -hex 5 | xxd -r -p | base32 | tr '[:upper:]' '[:lower:]' | tr -d '=' | cut -c1-8)_$(openssl rand -base64 33 | tr '+/' '-_' | tr -d '=\n' | cut -c1-43)"; }
key_active=$(rk); key_revoked=$(rk); key_archived=$(rk); key_removed=$(rk)
pgsql stellytics -v alice_email=alice@example.org -v operator_email=operator@example.org -v umami_site="$umami_site" \
  -v key_active="$key_active" -v key_revoked="$key_revoked" -v key_archived="$key_archived" -v key_removed="$key_removed" \
  < test/migration-seed.sql > /dev/null
[ "$(pgsql stellytics -c 'select count(*) from ingest_key_active')" = 1 ] || fail "expected 1 active key on the origin"
ok "sample data: $(pgsql stellytics -c "select (select count(*) from tenant) || ' tenants, ' || (select count(*) from api_metric_1m) || ' rows in 1m, ' || (select count(*) from api_metric_1h) || ' in 1h, ' || (select count(*) from api_metric_1d) || ' in 1d, ' || (select count(*) from audit_log) || ' in audit_log'")"
lap "data written"

# Base backup on the origin before the window (the physical path starts from it).
if [ "$MODE" != logical ]; then compose exec -T -u postgres postgres stellytics-backup >/dev/null; lap "origin base backup"; fi

# --- maintenance window: application stopped, only Postgres up ---------------
compose stop portal umami >/dev/null
lap "maintenance window open (portal and Umami stopped)"
fp_origin="$work/fp-origin.txt"
COMPOSE="docker compose -p $P --env-file $ENVF -f prod.yaml -f test/prod-test.yaml -f test/migration-test.yaml" \
  "$repo/infra/scripts/db-fingerprint.sh" > "$fp_origin"
# The fingerprint must cover ALL tables (a bug once made it stop at the first one).
for db in stellytics umami; do
  expected=$(pgsql "$db" -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'")
  got=$(awk -v db="$db" '$0 == "== database " db {f = 1; next} /^== / {f = 0} f' "$fp_origin" | grep -c -E ' [0-9]+ [0-9a-f]{32}$| 0 empty$' || true)
  [ "$expected" = "$got" ] || fail "the fingerprint covers $got of $expected tables of the $db database"
  ok "fingerprint covers the $got tables of the $db database"
done
lap "origin fingerprint ($(wc -l < "$fp_origin") lines)"
cp "$ENVF" "$work/origin.env.bak"

verify_destination() { # name: the system works on the destination
  local url token2 stats_dest
  url=$(portal_url)
  [ "$(portal_code "$url" /api/health)" = 200 ] || fail "[$NAME] the portal does not answer"
  [ "$(portal_code "$url" /docs)" = 200 ] || fail "[$NAME] the portal does not serve /docs"
  ok "[$NAME] the portal is up on the migrated database"
  [ "$(accounts)" = "$accounts_origin" ] || fail "[$NAME] the accounts or their password hashes differ from the origin"
  ok "[$NAME] the accounts keep the origin's password hashes"
  token2=$(umami_curl -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"umami"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  stats_dest=$(umami_stats "$token2")
  [ "$stats_dest" = "$stats_origin" ] || fail "[$NAME] Umami stats differ: $stats_dest"
  ok "[$NAME] Umami (no fork) opened the migrated database and gives the same statistics"
  [ "$(pgsql stellytics -c 'select count(*) from ingest_key_active')" = 1 ] || fail "[$NAME] active keys"
  [ "$(pgsql stellytics -c "select count(*) from ingest_key_active where prefix = '$(echo "$key_active" | cut -c5-12)' and key_hash = sha256(convert_to('$key_active', 'UTF8'))")" = 1 ] ||
    fail "[$NAME] the active key's hash does not match the original key"
  ok "[$NAME] the original ingest key is still valid (prefix and SHA-256)"
  for stmt in "update audit_log set action = 'x'" "delete from audit_log" "truncate audit_log"; do
    if pgsql stellytics -c "$stmt" 2>/dev/null; then fail "[$NAME] audit_log accepted: $stmt"; fi
  done
  pgsql stellytics -c "insert into audit_log (action) values ('test.post-migration')" >/dev/null
  ok "[$NAME] audit_log refuses UPDATE, DELETE and TRUNCATE and accepts INSERT (triggers active)"
  [ "$(pg_net stellytics_ingest "$(envval STELLYTICS_INGEST_DB_PASSWORD)" stellytics "select accepts_ingest from ingest_site where umami_website_id = '$umami_site'")" = t ] ||
    fail "[$NAME] stellytics_ingest cannot read ingest_site with the new password"
  [ "$(pg_net stellytics_collector "$(envval STELLYTICS_COLLECTOR_DB_PASSWORD)" stellytics "select count(*) from ingest_key_active")" = 1 ] ||
    fail "[$NAME] stellytics_collector cannot read ingest_key_active with the new password"
  if pg_net stellytics_ingest "$(envval STELLYTICS_INGEST_DB_PASSWORD)" stellytics "select count(*) from tenant" >/dev/null 2>&1; then
    fail "[$NAME] stellytics_ingest read the tenant table (extra GRANT)"
  fi
  ok "[$NAME] stellytics_ingest and stellytics_collector log in with the destination's passwords and read the views"
  pgsql stellytics -c "select api_metric_ensure_partitions(2)" >/dev/null
  [ "$(pgsql stellytics -c "select count(*) from api_metric_1m where route = '/future' and tableoid::regclass::text like 'api_metric_1m_p%'")" = 1 ] || fail "[$NAME] partitions"
  ok "[$NAME] api_metric_ensure_partitions runs and the partitions exist"
  # Writes as the collector, to prove the INSERT/UPDATE GRANT on api_metric_1m.
  pg_net stellytics_collector "$(envval STELLYTICS_COLLECTOR_DB_PASSWORD)" stellytics \
    "insert into api_metric_1m values (date_trunc('minute', now()), 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', '/after', 'GET', 200, 1, 0.1, array[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0]::bigint[])" >/dev/null ||
    fail "[$NAME] stellytics_collector cannot write to api_metric_1m"
  pgsql stellytics -c "delete from api_metric_1m where route = '/after'" >/dev/null
  ok "[$NAME] stellytics_collector writes to api_metric_1m"
  # Undoes the two test writes (the audit_log one cannot be deleted: 1 extra row remains).
}

# 2A. LOGICAL -----------------------------------------------------------------
if [ "$MODE" != physical ]; then
  echo "== A. logical migration (pg_dump)"
  use origin
  dump="$work/migration"
  COMPOSE="docker compose -p $P --env-file $ENVF -f prod.yaml -f test/prod-test.yaml -f test/migration-test.yaml" \
    "$repo/infra/scripts/db-export.sh" "$dump" >/dev/null
  lap "export (pg_dump -Fc of both databases + fingerprint)"
  cfiles="-f prod.yaml -f test/prod-test.yaml -f test/migration-test.yaml"
  imp() { COMPOSE="docker compose -p $P --env-file $ENVF $cfiles" "$repo/infra/scripts/db-import.sh" "$@"; }
  dboids() { pgsql postgres -c "select string_agg(datname || ':' || oid, ',' order by datname) from pg_database where datname in ('stellytics','umami')"; }
  # Importing into the ORIGIN itself (which has tenants) must be refused without --force-nonempty.
  oids=$(dboids)
  if imp --yes "$dump" >/dev/null 2>&1; then fail "db-import ran on a stack with tenants"; fi
  [ "$(dboids)" = "$oids" ] || fail "the refusal for a non-empty destination touched the databases"
  ok "[A] db-import refuses a destination with tenants (the origin) without --force-nonempty"

  du -h "$dump"/*.dump | sed 's/^/     /'

  # Destination: `site.yml` has already run (full stack, empty, with portal and Umami
  # migrating the empty databases), with the SAME session keys and other passwords.
  new_stack dest-logical 1 "$(rand 32)" "$auth_secret" "$umami_secret"
  lap "logical destination up and empty"
  [ "$(pgsql stellytics -c 'select count(*) from tenant')" = 0 ] || fail "destination is not empty"
  # Import protections, all BEFORE any DROP: the destination databases
  # (OIDs) must stay the same after each refusal.
  oids=$(dboids)
  refuse() { # description, folder
    if imp --yes "$2" >/dev/null 2>&1; then fail "[A] db-import accepted: $1"; fi
    [ "$(dboids)" = "$oids" ] || fail "[A] the refusal of '$1' touched the destination databases"
    ok "[A] db-import refuses $1 and leaves the destination intact"
  }
  refuse "with the application running" "$dump"
  compose stop portal umami >/dev/null
  cp -r "$dump" "$work/migration-tampered" && printf x >> "$work/migration-tampered/stellytics.dump"
  refuse "a tampered dump (sha256sums does not match)" "$work/migration-tampered"
  cp -r "$dump" "$work/migration-truncated" && head -c 1000 "$dump/stellytics.dump" > "$work/migration-truncated/stellytics.dump"
  (cd "$work/migration-truncated" && sha256sum stellytics.dump umami.dump fingerprint.txt > sha256sums)
  refuse "a truncated dump with regenerated sha256sums (pg_restore -l fails)" "$work/migration-truncated"
  cp -r "$dump" "$work/migration-nosum" && (cd "$work/migration-nosum" && sha256sum fingerprint.txt > sha256sums)
  refuse "a sha256sums that does not list the dumps" "$work/migration-nosum"
  imp --yes "$dump" | tail -4
  lap "import + verification (db-import.sh)"
  diff -u "$fp_origin" "$dump/fingerprint-destination.txt" > /dev/null || fail "destination fingerprint differs"
  ok "[A] identical fingerprint (rows and checksum per table, sequences, schema, roles, ACLs)"
  compose up -d --wait portal umami >/dev/null
  lap "destination application up on the migrated data"
  verify_destination

fi

# 2B. PHYSICAL (WAL-G) --------------------------------------------------------
if [ "$MODE" != logical ]; then
  echo "== B. physical migration (WAL-G)"
  use origin
  # Closes the origin's WAL and confirms archiving; final base backup.
  compose exec -T -u postgres postgres stellytics-backup >/dev/null
  wal=$(pgsql stellytics -c "select pg_walfile_name(pg_switch_wal())")
  for _ in $(seq 1 60); do
    archived=$(pgsql stellytics -c "select coalesce(last_archived_wal, '') from pg_stat_archiver")
    [[ "$archived" > "$wal" || "$archived" == "$wal" ]] && break
    sleep 1
  done
  [[ "$archived" > "$wal" || "$archived" == "$wal" ]] || fail "WAL $wal not archived"
  lap "final base backup and WAL $wal archived on the origin"
  src_key=$(envval WALG_S3_ACCESS_KEY); src_secret=$(envval WALG_S3_SECRET_KEY); src_bucket=stellytics-backup-origin

  # Destination: own bucket (own credentials), SAME walg_libsodium_key, Postgres not started yet.
  mkenv dest-physical 2 "$libsodium_origin" "$auth_secret" "$umami_secret"
  stacks+=(dest-physical); use dest-physical
  compose up -d s3 --wait
  compose exec -T s3 sh -c "echo 's3.bucket.create -name stellytics-backup-dest-physical' | weed shell -master=localhost:9333" >/dev/null
  dst_key=$(envval WALG_S3_ACCESS_KEY); dst_secret=$(envval WALG_S3_SECRET_KEY)
  # Bucket copy between operators (rclone between two S3 endpoints).
  docker run --rm --network host \
    -e RCLONE_CONFIG_SRC_TYPE=s3 -e RCLONE_CONFIG_SRC_PROVIDER=Other -e RCLONE_CONFIG_SRC_ENDPOINT="http://127.0.0.1:$((S3_BASE + 0))" \
    -e RCLONE_CONFIG_SRC_ACCESS_KEY_ID="$src_key" -e RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$src_secret" -e RCLONE_CONFIG_SRC_REGION=us-east-1 \
    -e RCLONE_CONFIG_DST_TYPE=s3 -e RCLONE_CONFIG_DST_PROVIDER=Other -e RCLONE_CONFIG_DST_ENDPOINT="http://127.0.0.1:$((S3_BASE + 2))" \
    -e RCLONE_CONFIG_DST_ACCESS_KEY_ID="$dst_key" -e RCLONE_CONFIG_DST_SECRET_ACCESS_KEY="$dst_secret" -e RCLONE_CONFIG_DST_REGION=us-east-1 \
    "$RCLONE" sync --checksum --s3-no-check-bucket "SRC:$src_bucket/pg" "DST:stellytics-backup-dest-physical/pg" -v 2>&1 | tail -4
  objs_src=$(docker run --rm --network host -e RCLONE_CONFIG_S_TYPE=s3 -e RCLONE_CONFIG_S_PROVIDER=Other -e RCLONE_CONFIG_S_ENDPOINT="http://127.0.0.1:$S3_BASE" -e RCLONE_CONFIG_S_ACCESS_KEY_ID="$src_key" -e RCLONE_CONFIG_S_SECRET_ACCESS_KEY="$src_secret" "$RCLONE" size S:$src_bucket/pg --json)
  objs_dst=$(docker run --rm --network host -e RCLONE_CONFIG_S_TYPE=s3 -e RCLONE_CONFIG_S_PROVIDER=Other -e RCLONE_CONFIG_S_ENDPOINT="http://127.0.0.1:$((S3_BASE + 2))" -e RCLONE_CONFIG_S_ACCESS_KEY_ID="$dst_key" -e RCLONE_CONFIG_S_SECRET_ACCESS_KEY="$dst_secret" "$RCLONE" size S:stellytics-backup-dest-physical/pg --json)
  [ "$objs_src" = "$objs_dst" ] || fail "the copied bucket differs: $objs_src x $objs_dst"
  ok "[B] bucket copied: $objs_dst"
  lap "backup bucket copied between operators"

  # Restore, as in docs/deploy.md ("Restore the database"), into an empty folder.
  mkdir -p "$work/dest-physical-data/postgres"
  # shellcheck disable=SC2016 # the variables belong to the container, not this shell
  compose run --rm --no-deps --entrypoint sh postgres -c \
    'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "stellytics-restore LATEST"' >/dev/null
  lap "stellytics-restore LATEST"
  compose up -d postgres --wait >/dev/null
  [ "$(pgsql stellytics -c 'select pg_is_in_recovery()')" = f ] || fail "restored database in recovery"
  lap "Postgres applied the WAL and opened"
  # The physical path also brings the roles, with the ORIGIN's passwords: the destination's .env does not match.
  if pg_net stellytics "$(envval STELLYTICS_DB_PASSWORD)" stellytics 'select 1' >/dev/null 2>&1; then
    fail "[B] expected the destination's password NOT to log in after the physical restore"
  else
    ok "[B] FINDING: after the physical restore, the destination's STELLYTICS_DB_PASSWORD password does NOT log in (the role passwords came from the origin)"
  fi
  # Procedure fix: align the role passwords with the destination's .env.
  for r in postgres:POSTGRES_PASSWORD stellytics:STELLYTICS_DB_PASSWORD umami:UMAMI_DB_PASSWORD; do
    printf "ALTER ROLE %s PASSWORD '%s'\n" "${r%%:*}" "$(envval "${r##*:}")" | compose exec -T -u postgres postgres psql -X -v ON_ERROR_STOP=1 -d postgres >/dev/null
  done
  compose exec -T postgres sh < "$repo/infra/compose/postgres/init/02-ingest-roles.sh" >/dev/null
  ok "[B] ALTER ROLE (postgres, stellytics, umami) and 02-ingest-roles.sh aligned the passwords with the destination's .env"
  fp_phys="$work/fp-physical.txt"
  COMPOSE="docker compose -p $P --env-file $ENVF -f prod.yaml -f test/prod-test.yaml -f test/migration-test.yaml" \
    "$repo/infra/scripts/db-fingerprint.sh" > "$fp_phys"
  diff -u "$fp_origin" "$fp_phys" > /dev/null || { diff -u "$fp_origin" "$fp_phys" | head -30; fail "physical destination fingerprint differs"; }
  ok "[B] identical fingerprint"
  compose up -d --wait portal umami >/dev/null
  lap "physical destination application up"
  verify_destination
fi
echo "data migration: all good"
