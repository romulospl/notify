#!/usr/bin/env bash
# Production stack test (#14), locally and in the CI `prod-stack` job.
#
# Starts compose/prod.yaml with a local S3 (test/prod-test.yaml) and checks:
# 1. Caddy publishes the portal, only the gateway routes and only OTLP; Umami does not leak;
# 2. Caddy is the only public service; Postgres stays on loopback;
# 1b. the gateway's /healthz gives 503 with Umami down;
# 2b. an OTLP metric with an ingest key lands in
#    api_metric_1m in the key's tenant, and the rollup runs;
# 3. the base backup and the WAL go to S3, encrypted, and the stack check
#    (stack-check.py, /healthz/stack) only turns green with the backup done;
# 4. the restore, following docs/deploy.md, brings the database back, including
#    what was written AFTER the base backup (recovery from the archived WAL).
#
# Usage, from the repository root, with the images already built
# (docker compose build portal ingest-web collector rollup):
#   infra/compose/test/prod-stack-test.sh
# PORTAL_IMAGE, INGEST_WEB_IMAGE, COLLECTOR_IMAGE and ROLLUP_IMAGE change the
# images (default: those of the local environment).
set -euo pipefail

cd "$(dirname "$0")/.."
project=stellytics-prodtest
work=$(mktemp -d "${TMPDIR:-/tmp}/stellytics-prodtest.XXXXXX")
env_file="$work/.env"
rand() { openssl rand -hex "${1:-24}"; }

cat > "$env_file" <<EOF
POSTGRES_PASSWORD=$(rand)
UMAMI_DB_PASSWORD=$(rand)
STELLYTICS_DB_PASSWORD=$(rand)
STELLYTICS_INGEST_DB_PASSWORD=$(rand)
STELLYTICS_COLLECTOR_DB_PASSWORD=$(rand)
UMAMI_APP_SECRET=$(rand)
PORTAL_AUTH_SECRET=$(rand)
INGEST_PROOF_SECRET=$(rand)
WALG_S3_PREFIX=s3://stellytics-backup/test
WALG_S3_ENDPOINT=http://s3:8333
WALG_S3_REGION=us-east-1
WALG_S3_ACCESS_KEY=$(rand 10)
WALG_S3_SECRET_KEY=$(rand)
WALG_LIBSODIUM_KEY=$(rand 32)
PORTAL_IMAGE=${PORTAL_IMAGE:-stellytics-portal:dev}
INGEST_WEB_IMAGE=${INGEST_WEB_IMAGE:-stellytics-ingest-web:dev}
COLLECTOR_IMAGE=${COLLECTOR_IMAGE:-stellytics-collector:dev}
ROLLUP_IMAGE=${ROLLUP_IMAGE:-stellytics-rollup:dev}
PORTAL_HOST=portal.localhost
PORTAL_ALIAS_HOST=alias.localhost
INGEST_HOST=ingest.localhost
API_HOST=api.localhost
ACME_EMAIL=ops@example.org
STELLYTICS_DATA_DIR=$work/data
POSTGRES_ADMIN_PORT=15432
EOF

compose() { docker compose -p "$project" --env-file "$env_file" -f prod.yaml -f test/prod-test.yaml "$@"; }
psql_stellytics() { compose exec -T -u postgres postgres psql -d stellytics -Atc "$1"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --tail 80 >&2 || true; fi
  docker rm -f "$project-nokey" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  # The data belongs to the Postgres user in the container; delete it through a container.
  docker run --rm -v "$work:/w" alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f rm -rf /w/data >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

fail() { echo "FAILED: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# The status folder belongs to stack-check; created beforehand, so it is not left owned by Docker's root.
mkdir -p "$work/data/status"
compose up -d s3 --wait
compose exec -T s3 sh -c 'echo "s3.bucket.create -name stellytics-backup" | weed shell -master=localhost:9333' >/dev/null
compose up -d --build --wait

# 1. Caddy routes (internal certificate for *.localhost).
get() { curl -sk -o /dev/null -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1$2"; }
[ "$(get portal.localhost /docs)" = 200 ] || fail "portal at /docs"
[ "$(get portal.localhost /api/health)" = 200 ] || fail "portal at /api/health"
# The optimizer is not used by the portal; no sharp/libvips library or
# caniuse-lite data package should be shipped in the standalone. The 404 has
# an empty body (proxy guard); Next's native 404 would come with HTML, so the
# response also checks that the guard was not removed. The trailing slash gets
# Next's own 308 normalization and, once the redirect is followed, the guard's
# 404; the percent-encoded path proves that the guard decodes (without
# that the request would pass the guard and get Next's own answer).
img404=$(curl -sk --resolve portal.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code} %{size_download}' "https://portal.localhost/_next/image?url=%2Ffavicon.ico&w=64&q=75")
[ "$img404" = "404 0" ] || fail "image optimizer should be off (returned \"$img404\", expected 404 with an empty body)"
img404=$(curl -sk --resolve portal.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code} %{size_download}' "https://portal.localhost/_next/%69mage?url=%2Ffavicon.ico&w=64&q=75")
[ "$img404" = "404 0" ] || fail "optimizer with a percent-encoded path should give the proxy guard's 404 (returned \"$img404\")"
img404=$(curl -skL --resolve portal.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code} %{size_download}' "https://portal.localhost/_next/image/?url=%2Ffavicon.ico&w=64&q=75")
[ "$img404" = "404 0" ] || fail "optimizer with a trailing slash should give 404 after Next's redirect (returned \"$img404\")"
license_files=$(compose exec -T portal sh -c 'find /app -path "*/node_modules/*" \( -name "@img+sharp-*" -o -name "sharp-*" -o -name "sharp@*" -o -name sharp -o -name "caniuse-lite" -o -name "caniuse-lite@*" \) -print; find /app -name "*.node" -print') || fail "could not inspect the portal image"
[ -z "$license_files" ] || fail "portal image contains removed dependencies: $license_files"

[ "$(get ingest.localhost /healthz)" = 200 ] || fail "gateway at /healthz"
for path in /api/send /api/heartbeat /api/websites /api/record /x; do
  [ "$(get ingest.localhost "$path")" = 404 ] || fail "ingestion host should give 404 at $path"
done
# The bare root sends a browser to the portal demo.
[ "$(curl -sk --resolve ingest.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code} %{redirect_url}' https://ingest.localhost/)" = "302 https://portal.localhost/demo" ] || fail "ingestion host root should redirect to /demo"
# On the portal host, /api/heartbeat belongs to Next (404), not Umami.
[ "$(curl -sk --resolve portal.localhost:443:127.0.0.1 https://portal.localhost/api/heartbeat)" != "ok" ] || fail "the portal host reaches Umami"
[ "$(curl -sk --resolve alias.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://alias.localhost/docs)" = 301 ] || fail "the portal alias does not redirect"
# /p/ (linked from the SCF submission) ends on the demo project's card, not a 404.
[ "$(curl -skL --resolve portal.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code} %{url_effective}' https://portal.localhost/p/)" = "200 https://portal.localhost/p/stellytics" ] || fail "/p/ should end on the demo card"

# API host (ADR 0012): only OTLP, and only with an ingest key.
post() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' \
  --resolve api.localhost:443:127.0.0.1 "https://api.localhost$1"; }
for path in /v1/traces /v1/metrics /v1/logs; do
  [ "$(post "$path")" = 401 ] || fail "OTLP without a key at $path should give 401"
done
for path in /healthz /e /api/send; do
  [ "$(get api.localhost "$path")" = 404 ] || fail "API host should give 404 on GET $path"
done
# A browser on an OTLP path gets 405 from Caddy, never the collector.
[ "$(get api.localhost /v1/metrics)" = 405 ] || fail "API host should give 405 on GET /v1/metrics"
# The bare root sends a browser to the portal operator view; a POST there stays 404.
[ "$(curl -sk --resolve api.localhost:443:127.0.0.1 -o /dev/null -w '%{http_code} %{redirect_url}' https://api.localhost/)" = "302 https://portal.localhost/operator" ] || fail "API host root should redirect to /operator"
[ "$(post /)" = 404 ] || fail "API host should give 404 on POST /"
[ "$(post /api/send)" = 404 ] || fail "API host reaches another route by POST"
# Local gRPC: without a key, the collector answers Unauthenticated (grpc-status 16).
# The body is an empty gRPC message (5 header bytes): the server reads the
# message before checking the key.
grpc_status=$(printf '\0\0\0\0\0' | curl -sk --http2 -o /dev/null -D - -X POST --data-binary @- \
  -H 'Content-Type: application/grpc' -H 'TE: trailers' \
  --resolve api.localhost:443:127.0.0.1 \
  https://api.localhost/opentelemetry.proto.collector.metrics.v1.MetricsService/Export |
  tr -d '\r' | awk 'tolower($1) == "grpc-status:" { print $2 }')
[ "$grpc_status" = 16 ] || fail "gRPC without a key should give grpc-status 16 and got '$grpc_status'"
ok "Caddy publishes the portal, only the gateway routes and only the collector's OTLP (HTTP and gRPC)"

# The logs must not keep IP, headers or URL, even on an upstream error.
marker="marker-$(rand 6)"
compose stop ingest-web >/dev/null
code=$(curl -sk -o /dev/null -w '%{http_code}' -H "X-Stellytics-Test: $marker" \
  --resolve ingest.localhost:443:127.0.0.1 "https://ingest.localhost/healthz?m=$marker")
[ "$code" = 502 ] || fail "with the gateway stopped, expected 502 and got $code"
caddy_logs=$(compose logs --no-color caddy)
grep -q '"status":502' <<<"$caddy_logs" || fail "Caddy did not log the 502 error (test has no effect)"
if grep -qE "$marker|remote_ip|client_ip" <<<"$caddy_logs"; then fail "the Caddy log keeps the request's IP, header or URL"; fi
compose up -d --wait ingest-web >/dev/null
ok "Caddy logs without IP, headers or URL"

# 1b. The gateway's /healthz measures ingestion: with Umami down, 503.
compose stop umami >/dev/null
for _ in $(seq 1 20); do
  code=$(get ingest.localhost /healthz)
  [ "$code" = 503 ] && break
  sleep 1
done
[ "$code" = 503 ] || fail "with Umami stopped, /healthz should give 503 and gave $code"
compose up -d --wait umami >/dev/null
for _ in $(seq 1 20); do
  code=$(get ingest.localhost /healthz)
  [ "$code" = 200 ] && break
  sleep 1
done
[ "$code" = 200 ] || fail "with Umami back, /healthz should give 200 and gave $code"
ok "the gateway's /healthz gives 503 without Umami and goes back to 200"

# Stack check (stellytics-check in production), with this test's Compose.
stack_check() {
  COMPOSE="docker compose -p $project --env-file $env_file -f prod.yaml -f test/prod-test.yaml" \
    STACK_CHECK_DISK_MAX_PERCENT=100 python3 ../scripts/stack-check.py "$work/data"
}
# No base backup yet: the check reports it and Caddy answers 503.
if out=$(stack_check); then fail "the stack check passed without a base backup: $out"; fi
grep -q "no base backup" <<<"$out" || fail "the check did not report the missing base backup: $out"
[ "$(get ingest.localhost /healthz/stack)" = 503 ] || fail "/healthz/stack without a green check should give 503"
ok "stack check fails without a base backup and /healthz/stack gives 503"

# 2. Only Caddy publishes public ports; Postgres stays on loopback.
bindings() { docker inspect -f '{{json .HostConfig.PortBindings}}' "$(compose ps -q "$1")"; }
for svc in umami portal ingest-web collector rollup s3; do
  b=$(bindings "$svc")
  [ "$b" = "{}" ] || [ "$b" = "null" ] || fail "$svc with a published port: $b"
done
caddy_bindings=$(bindings caddy)
grep -q '80/tcp' <<<"$caddy_bindings" && grep -q '443/tcp' <<<"$caddy_bindings" || fail "Caddy does not publish 80/443: $caddy_bindings"
pg_port=$(compose port postgres 5432)
case "$pg_port" in 127.0.0.1:*) ;; *) fail "Postgres published outside loopback: $pg_port" ;; esac
ok "Caddy is the only public service; Umami and rollup without a port; Postgres only on loopback"

# 2b. End-to-end OTLP ingestion through Caddy: the key sets the tenant.
suffix=$(rand 5)
prefix=$(LC_ALL=C tr -dc 'a-z2-7' </dev/urandom | head -c 8 || true)
key="ntf_${prefix}_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 43 || true)"
psql_stellytics "insert into \"user\" (id, name, email, email_verified)
  values ('prodtest-$suffix', 'prodtest', 'prodtest-$suffix@example.invalid', true)" >/dev/null
tenant=$(psql_stellytics "insert into tenant (name, slug, status) values ('prodtest-$suffix', 'prodtest-$suffix', 'active') returning id" | head -1)
service=$(psql_stellytics "insert into api_service (tenant_id, name) values ('$tenant', 'prodtest') returning id" | head -1)
psql_stellytics "insert into ingest_key (api_service_id, tenant_id, prefix, key_hash, created_by)
  values ('$service', '$tenant', '$prefix', sha256(convert_to('$key', 'UTF8')), 'prodtest-$suffix')" >/dev/null
now=$(date +%s)000000000
code=$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
  --resolve api.localhost:443:127.0.0.1 https://api.localhost/v1/traces \
  -d '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"GET","kind":2,"startTimeUnixNano":"'"$now"'","endTimeUnixNano":"'"$now"'","attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/prodtest/{id}"}},{"key":"http.response.status_code","value":{"intValue":"200"}}]}]}]}]}')
[ "$code" = 200 ] || fail "OTLP with a valid key answered $code"
for _ in $(seq 1 30); do
  n=$(psql_stellytics "select count(*) from api_metric_1m where route = '/prodtest/{id}' and tenant_id = '$tenant' and api_service_id = '$service'")
  [ "$n" -ge 1 ] && break
  sleep 2
done
[ "$n" -ge 1 ] || fail "the metric sent through the collector did not reach api_metric_1m"
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer ntf_aaaaaaaa_invalid' -H 'Content-Type: application/json' -d '{}' \
  --resolve api.localhost:443:127.0.0.1 https://api.localhost/v1/traces)" = 401 ] || fail "an invalid key should give 401"
if compose logs --no-color collector | grep -q "$key"; then fail "the ingest key appeared in a log"; fi
# The rollup created the month's partitions (api_metric_maintain) on startup.
[ "$(psql_stellytics "select count(*) from pg_class where relname = 'api_metric_1h_p$(date -u +%Y%m)'")" = 1 ] ||
  fail "the rollup did not create the month's partition in api_metric_1h"
ok "OTLP writes to api_metric_1m in the key's tenant; rollup up"

# 3. Base backup and WAL in S3.
psql_stellytics "create table restore_check (note text primary key)"
psql_stellytics "insert into restore_check values ('before-backup')"
compose exec -T -u postgres postgres stellytics-backup >/dev/null
psql_stellytics "insert into restore_check values ('after-backup')"
wal=$(psql_stellytics "select pg_walfile_name(pg_switch_wal())")
for _ in $(seq 1 60); do
  archived=$(psql_stellytics "select coalesce(last_archived_wal, '') from pg_stat_archiver")
  [[ "$archived" > "$wal" || "$archived" == "$wal" ]] && break
  sleep 1
done
[[ "$archived" > "$wal" || "$archived" == "$wal" ]] || fail "WAL $wal was not archived (last: $archived)"
ok "base backup and WAL $wal in S3"

out=$(stack_check) || fail "the stack check failed with everything up: $out"
[ "$(get ingest.localhost /healthz/stack)" = 200 ] || fail "/healthz/stack with a green check should give 200"
compose stop rollup >/dev/null
if out=$(stack_check); then fail "the stack check passed with the rollup stopped: $out"; fi
grep -q "rollup: exited" <<<"$out" || fail "the check did not report the stopped rollup: $out"
[ "$(get ingest.localhost /healthz/stack)" = 503 ] || fail "/healthz/stack with the rollup stopped should give 503"
compose up -d --wait rollup >/dev/null
ok "stack check green with backup and WAL up to date; reports a stopped service"

# Encrypted on the client: without the key, the backup is useless. WAL-G
# retries the download forever (with a low WALG_DOWNLOAD_FILE_RETRIES, the
# counter goes negative and it does not stop; seen in v3.0.9), so the attempt
# runs in the background and the test only waits for the extraction error.
image=$(compose images -q postgres | head -1)
network="${project}_internal"
get_env() { grep "^$1=" "$env_file" | cut -d= -f2-; }
cat > "$work/nokey.env" <<EOF2
WALG_S3_PREFIX=$(get_env WALG_S3_PREFIX)
WALG_COMPRESSION_METHOD=brotli
AWS_S3_FORCE_PATH_STYLE=true
AWS_ENDPOINT=http://s3:8333
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=$(get_env WALG_S3_ACCESS_KEY)
AWS_SECRET_ACCESS_KEY=$(get_env WALG_S3_SECRET_KEY)
POSTGRES_PASSWORD=unused
PGDATA=/var/lib/postgresql/data
EOF2
mkdir -p "$work/data/nokey"
docker run -d --name "$project-nokey" --network "$network" -v "$work/data/nokey:/var/lib/postgresql/data" \
  --env-file "$work/nokey.env" --entrypoint sh "$image" \
  -c 'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "stellytics-restore"' >/dev/null
for _ in $(seq 1 60); do
  docker logs "$project-nokey" 2>&1 | grep -q "Extraction error" && break
  sleep 1
done
docker logs "$project-nokey" 2>&1 | grep -q "Extraction error" || fail "without the key, WAL-G gave no extraction error"
docker rm -f "$project-nokey" >/dev/null
[ ! -e "$work/data/nokey/PG_VERSION" ] || fail "the backup was restored without the WALG_LIBSODIUM_KEY key"
ok "encrypted backup: without the key, the restore fails"

# 4. Restore, with the same commands as docs/deploy.md ("Restore the
# database"): keeps the current data, restores into an empty folder and starts again.
restore_db() {
  compose stop caddy portal ingest-web collector rollup umami postgres >/dev/null
  docker run --rm -v "$work/data:/d" alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f \
    sh -c "mv /d/postgres /d/postgres.before-$1 && mkdir /d/postgres"
  compose run --rm --no-deps -e BACKUP="$2" -e TARGET="${3:-}" --entrypoint sh postgres -c \
    'chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA" && su postgres -c "stellytics-restore \"$BACKUP\" \"$TARGET\""' >/dev/null
  compose up -d --wait >/dev/null
  [ "$(psql_stellytics "select pg_is_in_recovery()")" = f ] || fail "the restored database stayed in recovery"
}
notes() { psql_stellytics "select string_agg(note, ',' order by note) from restore_check"; }
archive_now() {
  local wal archived
  wal=$(psql_stellytics "select pg_walfile_name(pg_switch_wal())")
  for _ in $(seq 1 60); do
    archived=$(psql_stellytics "select coalesce(last_archived_wal, '') from pg_stat_archiver")
    [[ "$archived" > "$wal" || "$archived" == "$wal" ]] && return 0
    sleep 1
  done
  fail "WAL $wal was not archived"
}

# 4a. Up to a point in time: after the two rows, before the third.
target=$(psql_stellytics "select now()")
sleep 1
psql_stellytics "insert into restore_check values ('after-target')"
archive_now
restore_db 1 LATEST "$target"
[ "$(notes)" = "after-backup,before-backup" ] || fail "restore up to $target brought '$(notes)'"
ok "restore up to a point in time: base backup, WAL up to the target and nothing after it"

# 4b. New backup after the restore and a full restore: the target of the
# previous restore comes inside the backup and must not apply again.
compose exec -T -u postgres postgres stellytics-backup >/dev/null
psql_stellytics "insert into restore_check values ('after-second-backup')"
archive_now
restore_db 2 LATEST
[ "$(notes)" = "after-backup,after-second-backup,before-backup" ] || fail "second restore brought '$(notes)'"
ok "full restore after another restore recovers all the WAL"

echo "production stack: all good"
